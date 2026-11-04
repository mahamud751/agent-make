import type Anthropic from "@anthropic-ai/sdk";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { setLLM, type LLMParams } from "../src/agent/llm";
import { registerJobHandlers } from "../src/jobs/handlers";
import { drainInlineJobs } from "../src/jobs/queues";

registerJobHandlers();
export const app = createApp();
export const api = () => request(app);
export { prisma, drainInlineJobs };

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

let n = 0;
export async function signup(company = `Store ${++n}`) {
  const email = `owner${n}-${Date.now()}@test.dev`;
  const res = await api().post("/v1/auth/signup").send({ name: "Owner", email, password: "password123", company });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { token: res.body.token as string, tenantId: res.body.tenant.id as string, pk: res.body.publishableKey as string, email };
}

export async function secretKey(token: string) {
  const res = await api().post("/v1/api-keys").set("Authorization", `Bearer ${token}`).send({ name: "backend", kind: "SECRET" });
  return res.body.key as string;
}

// ── scripted model ──
type Block = Anthropic.Beta.BetaContentBlock;
let seq = 0;
export const toolUse = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `toolu_${++seq}`, name, input, caller: { type: "direct" } } as unknown as Block);
export const text = (t: string): Block => ({ type: "text", text: t, citations: null } as unknown as Block);

export function message(content: Block[], stop: Anthropic.Beta.BetaMessage["stop_reason"] = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn") {
  return {
    id: `msg_${++seq}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

/** Each step receives the request the runtime sent, and returns the next model response. */
export function scriptLLM(steps: ((p: LLMParams) => Anthropic.Beta.BetaMessage)[]) {
  const calls: LLMParams[] = [];
  setLLM(async (p) => {
    calls.push(structuredClone(p));
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`LLM called more times than scripted (${calls.length})`);
    return step(p);
  });
  return calls;
}

/** Pull the JSON tool_result for the latest call out of the messages the runtime sent. */
export function lastToolResults(p: LLMParams) {
  const last = p.messages[p.messages.length - 1];
  const content = Array.isArray(last.content) ? last.content : [];
  return content
    .filter((b): b is Anthropic.Beta.BetaToolResultBlockParam => (b as { type: string }).type === "tool_result")
    .map((b) => ({ isError: !!b.is_error, data: JSON.parse(String(b.content)) }));
}

export async function seedCatalog(tenantId: string) {
  await prisma.product.createMany({
    data: [
      { tenantId, sku: "MUG", name: "Ceramic Mug", price: 12, stock: 10 },
      { tenantId, sku: "TEE", name: "Logo T-Shirt", price: 25, stock: 5 },
    ],
  });
}
