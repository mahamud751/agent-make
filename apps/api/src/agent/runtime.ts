import type Anthropic from "@anthropic-ai/sdk";
import type { ActionPolicy, Message, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { getRedis } from "../lib/redis";
import { getConnector } from "../connectors";
import { conversationService } from "../modules/conversations/service";
import { canSendAiReply, incrementUsage } from "../modules/billing/usage";
import { emitEvent } from "../events/bus";
import { callLLM } from "./llm";
import { buildSystemPrompt, buildTurnContext } from "./prompt";
import { TOOLS, TOOL_MAP, effectivePolicy, runTool } from "./tools";
import type { Guardrails, ToolContext, ToolResult } from "./tools/types";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

export const MAX_TOOL_ITERATIONS = 8;
const HISTORY_LIMIT = 40;
const FALLBACK_REPLY = "Thanks for your message! I've passed this to our team and someone will get back to you here shortly.";

export interface TurnResult {
  replied: boolean;
  skipped?: string;
  messageId?: string;
  toolCalls?: { name: string; input: unknown; ok: boolean; pendingActionId?: string }[];
}

/** Convert stored chat history into Messages API turns (user/assistant alternation is merged by the API). */
export function toModelMessages(history: Message[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of history) {
    if (m.role === "SYSTEM") continue;
    if (m.role === "CUSTOMER") out.push({ role: "user", content: m.content });
    else out.push({ role: "assistant", content: m.role === "HUMAN" ? `[Reply from a human teammate] ${m.content}` : m.content });
  }
  while (out.length && out[0].role !== "user") out.shift(); // must start with user (drops greeting)
  return out;
}

async function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T | null> {
  if (env.INLINE_JOBS || env.NODE_ENV === "test") return fn();
  const redis = getRedis();
  const key = `lock:conv:${conversationId}`;
  const token = crypto.randomUUID();
  const got = await redis.set(key, token, "PX", 120_000, "NX");
  if (!got) return null; // another worker is replying; it will see the new message in history
  try {
    return await fn();
  } finally {
    const v = await redis.get(key);
    if (v === token) await redis.del(key);
  }
}

/**
 * One AI turn for a conversation: called by the `agent.reply` job after a customer message.
 * Runs the Claude tool-use loop with tenant-scoped tools and posts the final reply.
 */
export async function runAgentTurn(conversationId: string, triggerMessageId?: string): Promise<TurnResult> {
  const result = await withConversationLock(conversationId, () => runTurnLocked(conversationId, triggerMessageId));
  return result ?? { replied: false, skipped: "locked" };
}

async function runTurnLocked(conversationId: string, triggerMessageId?: string): Promise<TurnResult> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { agent: true, tenant: true, customer: true },
  });
  if (!conv) return { replied: false, skipped: "not_found" };
  const { agent, tenant } = conv;
  if (!agent) return { replied: false, skipped: "no_agent" };
  if (!agent.autoReply) return { replied: false, skipped: "auto_reply_off" };
  if (conv.status !== "OPEN") return { replied: false, skipped: `status_${conv.status}` };

  const history = (
    await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "desc" }, take: HISTORY_LIMIT })
  ).reverse();
  const last = history[history.length - 1];
  if (!last || last.role !== "CUSTOMER") return { replied: false, skipped: "nothing_to_answer" };
  // Debounce bursts: if the customer sent more messages after the trigger, the newest job answers all.
  if (triggerMessageId && last.id !== triggerMessageId) return { replied: false, skipped: "superseded" };

  const guardrails = (agent.guardrails ?? {}) as Guardrails;

  if (!(await canSendAiReply(tenant.id))) {
    await conversationService.escalate(conv, "AI reply quota reached for this billing period");
    await conversationService.addMessage(conv, "AGENT", FALLBACK_REPLY, { metadata: { quota: true } });
    return { replied: true, skipped: "quota" };
  }

  const kw = guardrails.handoffKeywords?.find((k) => last.content.toLowerCase().includes(k.toLowerCase()));
  if (kw) {
    await conversationService.escalate(conv, `Handoff keyword: "${kw}"`);
    const msg = await conversationService.addMessage(conv, "AGENT", "I'm connecting you with a member of our team — they'll reply here shortly.");
    return { replied: true, messageId: msg.id };
  }

  const policies = (agent.toolPolicies ?? {}) as Record<string, ActionPolicy>;
  const enabled = TOOLS.filter((t) => effectivePolicy(t.name, policies) !== "DISABLED");
  // Deterministic tool order keeps the prompt-cache prefix stable.
  const tools: Anthropic.Beta.BetaTool[] = enabled.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    strict: true,
  }));

  const ctx: ToolContext = {
    tenantId: tenant.id,
    agent,
    conversation: conv,
    connector: await getConnector(tenant.id),
    actor: `agent:${agent.id}`,
    guardrails,
  };

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: buildSystemPrompt(tenant, agent), cache_control: { type: "ephemeral" } },
  ];
  const messages: BetaMessageParam[] = [
    ...toModelMessages(history),
    // volatile per-turn facts go after the cached prefix, as an operator (system) message
    { role: "system", content: buildTurnContext(conv) },
  ];

  const started = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const toolLog: NonNullable<TurnResult["toolCalls"]> = [];
  const notices: string[] = [];
  let finalText = "";
  let stopReason: string | null = null;

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await callLLM({
        model: agent.model || env.DEFAULT_MODEL,
        max_tokens: 16000,
        system,
        tools,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: (agent.effort as "low" | "medium" | "high") ?? "medium" },
        // route safety-classifier refusals to Anthropic's recommended fallback model
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      usage.input += response.usage.input_tokens ?? 0;
      usage.output += response.usage.output_tokens ?? 0;
      usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      stopReason = response.stop_reason;

      if (response.stop_reason === "refusal") {
        finalText = FALLBACK_REPLY;
        await conversationService.escalate(conv, "AI declined to answer this request");
        ctx.conversation.status = "PENDING_HUMAN";
        break;
      }

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const toolUses = response.content.filter((b: BetaContentBlock): b is BetaToolUseBlock => b.type === "tool_use");

      if (response.stop_reason !== "tool_use" || !toolUses.length) {
        finalText = text;
        break;
      }

      messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
      // run tool calls of one turn concurrently; return all results in a single user message
      const results = await Promise.all(toolUses.map((tu) => executeToolCall(ctx, policies, tu, toolLog, notices)));
      messages.push({ role: "user", content: results });
      if (i === MAX_TOOL_ITERATIONS - 1) finalText = text || FALLBACK_REPLY;
    }
  } catch (err) {
    await prisma.agentRun.create({
      data: { tenantId: tenant.id, conversationId, model: agent.model, inputTokens: usage.input, outputTokens: usage.output, toolCalls: toolLog as unknown as Prisma.InputJsonValue, error: (err as Error).message, latencyMs: Date.now() - started },
    });
    throw err; // job retries with backoff
  }

  if (!finalText) finalText = ctx.conversation.status === "PENDING_HUMAN" ? "I've passed this to our team — someone will reply here shortly." : FALLBACK_REPLY;

  const run = await prisma.agentRun.create({
    data: {
      tenantId: tenant.id,
      conversationId,
      model: agent.model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      toolCalls: toolLog as unknown as Prisma.InputJsonValue,
      stopReason,
      latencyMs: Date.now() - started,
    },
  });
  const fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  const msg = await conversationService.addMessage(fresh, "AGENT", finalText, { metadata: { runId: run.id, toolCalls: toolLog.map((t) => t.name) } });
  await Promise.all([
    incrementUsage(tenant.id, "ai_replies", 1),
    incrementUsage(tenant.id, "input_tokens", usage.input),
    incrementUsage(tenant.id, "output_tokens", usage.output),
  ]);
  logger.info({ conversationId, runId: run.id, tools: toolLog.length, ms: Date.now() - started }, "agent replied");
  return { replied: true, messageId: msg.id, toolCalls: toolLog };
}

async function executeToolCall(
  ctx: ToolContext,
  policies: Record<string, ActionPolicy>,
  tu: BetaToolUseBlock,
  log: NonNullable<TurnResult["toolCalls"]>,
  notices: string[],
): Promise<BetaToolResultBlockParam> {
  const tool = TOOL_MAP.get(tu.name);
  const policy = effectivePolicy(tu.name, policies);
  let result: ToolResult;
  let pendingActionId: string | undefined;

  if (!tool || policy === "DISABLED") {
    result = { ok: false, error: `Tool ${tu.name} is not available.` };
  } else {
    const parsed = tool.schema.safeParse(tu.input);
    const needsApproval = parsed.success && (policy === "APPROVAL" || tool.forceApproval?.(ctx, parsed.data) === true);
    if (needsApproval && parsed.success) {
      const blocker = tool.precheck ? await tool.precheck(ctx, parsed.data) : null;
      if (blocker) {
        result = { ok: false, error: blocker };
      } else {
        const action = await prisma.pendingAction.create({
          data: {
            tenantId: ctx.tenantId,
            conversationId: ctx.conversation.id,
            tool: tu.name,
            input: { ...(parsed.data as object), _verifiedEmail: ctx.conversation.verifiedEmail } as Prisma.InputJsonValue,
            reason: (parsed.data as { reason?: string }).reason,
          },
        });
        pendingActionId = action.id;
        await emitEvent(ctx.tenantId, "action.pending", { action });
        result = { ok: true, data: { status: "submitted_for_review", reference: action.id.slice(-8), note: "A staff member will review this shortly; the customer will be updated in this conversation." } };
      }
    } else {
      result = await runTool(ctx, tu.name, tu.input);
      if (result.ok && result.customerNotice) notices.push(result.customerNotice);
    }
  }

  log.push({ name: tu.name, input: tu.input, ok: result.ok, pendingActionId });
  return {
    type: "tool_result",
    tool_use_id: tu.id,
    content: JSON.stringify(result.ok ? result.data : { error: result.error }),
    is_error: !result.ok,
  };
}

/** All retries failed (model outage, bad credentials…): never leave the customer hanging. */
export async function handleAgentFailure(conversationId: string) {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv || conv.status !== "OPEN") return;
  const last = await prisma.message.findFirst({ where: { conversationId }, orderBy: { createdAt: "desc" } });
  if (last?.role !== "CUSTOMER") return;
  await conversationService.escalate(conv, "AI agent unavailable (reply failed after retries)");
  await conversationService.addMessage(conv, "AGENT", FALLBACK_REPLY, { metadata: { failure: true } });
}
