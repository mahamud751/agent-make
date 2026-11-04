import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { body, param, query } from "../lib/http";
import { badRequest } from "../lib/errors";
import { ctxOf, requireRole } from "../middleware/auth";
import { conversationService } from "../modules/conversations/service";
import { enqueue } from "../jobs/queues";
import { runAgentTurn } from "../agent/runtime";
import { rateLimit } from "../middleware/rateLimit";

export const conversationsRouter = Router();

conversationsRouter.get("/conversations", requireRole("VIEWER"), async (req, res) => {
  const q = query(
    req,
    z.object({
      status: z.enum(["OPEN", "PENDING_HUMAN", "RESOLVED"]).optional(),
      channel: z.enum(["WEB_WIDGET", "EMAIL", "WHATSAPP", "MESSENGER", "SMS", "API"]).optional(),
      assignedToMe: z.coerce.boolean().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
  );
  const ctx = ctxOf(req);
  const where: Prisma.ConversationWhereInput = { tenantId: ctx.tenantId, status: q.status, channel: q.channel };
  if (q.assignedToMe && ctx.actor.type === "user") where.assignedUserId = ctx.actor.id;
  const rows = await prisma.conversation.findMany({
    where,
    include: { customer: true, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { lastMessageAt: "desc" },
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > q.limit;
  const data = rows.slice(0, q.limit).map(({ messages, visitorTokenHash: _v, ...c }) => ({ ...c, lastMessage: messages[0] ?? null }));
  res.json({ data, nextCursor: hasMore ? data[data.length - 1]?.id : null });
});

conversationsRouter.get("/conversations/:id", requireRole("VIEWER"), async (req, res) => {
  const ctx = ctxOf(req);
  const { visitorTokenHash: _v, ...c } = await conversationService.get(ctx.tenantId, param(req, "id"));
  const messages = await prisma.message.findMany({ where: { conversationId: c.id }, orderBy: { createdAt: "asc" }, take: 500 });
  const runs = await prisma.agentRun.findMany({ where: { conversationId: c.id }, orderBy: { createdAt: "desc" }, take: 20 });
  const actions = await prisma.pendingAction.findMany({ where: { conversationId: c.id }, orderBy: { createdAt: "desc" } });
  res.json({ ...c, messages, runs, actions });
});

/** Human teammate replies. Taking over pauses the AI until "resume-ai". */
conversationsRouter.post("/conversations/:id/messages", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, z.object({ content: z.string().min(1).max(10_000), internal: z.boolean().default(false), takeOver: z.boolean().default(true) }));
  const conv = await conversationService.get(ctx.tenantId, param(req, "id"));
  const userId = ctx.actor.type === "user" ? ctx.actor.id : undefined;
  if (input.internal) {
    return res.status(201).json(await conversationService.addMessage(conv, "SYSTEM", input.content, { authorUserId: userId, metadata: { internalNote: true } }));
  }
  if (input.takeOver && conv.status === "OPEN") {
    await prisma.conversation.update({ where: { id: conv.id }, data: { status: "PENDING_HUMAN", assignedUserId: userId } });
  }
  res.status(201).json(await conversationService.addMessage(conv, "HUMAN", input.content, { authorUserId: userId }));
});

conversationsRouter.post("/conversations/:id/assign", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  const { userId } = body(req, z.object({ userId: z.string().nullable() }));
  const conv = await conversationService.get(ctx.tenantId, param(req, "id"));
  if (userId && !(await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId: ctx.tenantId, userId } } }))) throw badRequest("User is not a member");
  res.json(await prisma.conversation.update({ where: { id: conv.id }, data: { assignedUserId: userId } }));
});

conversationsRouter.post("/conversations/:id/resume-ai", requireRole("SUPPORT"), async (req, res) => {
  const conv = await conversationService.get(ctxOf(req).tenantId, param(req, "id"));
  const updated = await prisma.conversation.update({ where: { id: conv.id }, data: { status: "OPEN" } });
  const last = await prisma.message.findFirst({ where: { conversationId: conv.id }, orderBy: { createdAt: "desc" } });
  if (last?.role === "CUSTOMER") await enqueue("agent.reply", { conversationId: conv.id, messageId: last.id });
  res.json(updated);
});

conversationsRouter.post("/conversations/:id/resolve", requireRole("SUPPORT"), async (req, res) => {
  const conv = await conversationService.get(ctxOf(req).tenantId, param(req, "id"));
  res.json(await conversationService.resolve(conv));
});

conversationsRouter.post("/conversations/:id/tags", requireRole("SUPPORT"), async (req, res) => {
  const { tags } = body(req, z.object({ tags: z.array(z.string().max(40)).max(20) }));
  const conv = await conversationService.get(ctxOf(req).tenantId, param(req, "id"));
  res.json(await prisma.conversation.update({ where: { id: conv.id }, data: { tags } }));
});

/**
 * Server-to-server messaging API: plug the agent into any channel or custom chat UI.
 * Conversations are keyed by your `threadId`. With `wait: true` the AI reply is returned inline.
 */
conversationsRouter.post("/messages", requireRole("SUPPORT"), rateLimit({ prefix: "api-msg", windowSec: 60, max: 600 }), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(
    req,
    z.object({
      threadId: z.string().min(1).max(200),
      content: z.string().min(1).max(10_000),
      channel: z.enum(["API", "WHATSAPP", "MESSENGER", "SMS", "EMAIL"]).default("API"),
      agentId: z.string().optional(),
      customer: z.object({ email: z.string().email().optional(), name: z.string().optional(), phone: z.string().optional(), externalId: z.string().optional() }).optional(),
      // Your backend already authenticated this user: trust their email for order lookups.
      customerVerified: z.boolean().default(false),
      wait: z.boolean().default(false),
    }),
  );
  const customer = input.customer ? await conversationService.findOrCreateCustomer(ctx.tenantId, input.customer) : null;
  let conv = await prisma.conversation.findFirst({ where: { tenantId: ctx.tenantId, externalThreadId: input.threadId } });
  const verifiedEmail = input.customerVerified && input.customer?.email ? input.customer.email.toLowerCase() : null;
  if (!conv) {
    conv = await conversationService.create(ctx.tenantId, { channel: input.channel, agentId: input.agentId, customerId: customer?.id, externalThreadId: input.threadId, verifiedEmail });
  } else if (verifiedEmail && conv.verifiedEmail !== verifiedEmail) {
    conv = await prisma.conversation.update({ where: { id: conv.id }, data: { verifiedEmail } });
  }
  const msg = await conversationService.addMessage(conv, "CUSTOMER", input.content, { skipAutoReply: input.wait });
  if (!input.wait) return res.status(202).json({ conversationId: conv.id, messageId: msg.id, status: "queued" });
  const turn = await runAgentTurn(conv.id, msg.id);
  const reply = turn.messageId ? await prisma.message.findUnique({ where: { id: turn.messageId } }) : null;
  const fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
  res.json({ conversationId: conv.id, status: fresh.status, reply: reply ? { id: reply.id, content: reply.content, createdAt: reply.createdAt } : null, skipped: turn.skipped });
});
