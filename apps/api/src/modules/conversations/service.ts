import type { Channel, Conversation, MessageRole, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { enqueue } from "../../jobs/queues";
import { emitEvent } from "../../events/bus";
import { publish, rooms } from "../../realtime/publisher";
import { notFound } from "../../lib/errors";

export const conversationService = {
  async findOrCreateCustomer(tenantId: string, c: { email?: string; name?: string; phone?: string; externalId?: string }) {
    if (c.externalId) {
      return prisma.customer.upsert({
        where: { tenantId_externalId: { tenantId, externalId: c.externalId } },
        create: { tenantId, externalId: c.externalId, email: c.email?.toLowerCase(), name: c.name, phone: c.phone },
        update: { email: c.email?.toLowerCase(), name: c.name, phone: c.phone },
      });
    }
    if (c.email) {
      const email = c.email.toLowerCase();
      return (await prisma.customer.findFirst({ where: { tenantId, email } })) ?? prisma.customer.create({ data: { tenantId, email, name: c.name, phone: c.phone } });
    }
    if (c.phone) {
      return (await prisma.customer.findFirst({ where: { tenantId, phone: c.phone } })) ?? prisma.customer.create({ data: { tenantId, phone: c.phone, name: c.name } });
    }
    return null;
  },

  async create(tenantId: string, input: { channel: Channel; agentId?: string; customerId?: string | null; subject?: string; visitorTokenHash?: string; externalThreadId?: string; verifiedEmail?: string | null }) {
    const agent = input.agentId
      ? await prisma.agent.findFirst({ where: { tenantId, id: input.agentId } })
      : await prisma.agent.findFirst({ where: { tenantId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
    const conv = await prisma.conversation.create({
      data: {
        tenantId,
        channel: input.channel,
        agentId: agent?.id,
        customerId: input.customerId ?? undefined,
        subject: input.subject,
        visitorTokenHash: input.visitorTokenHash,
        externalThreadId: input.externalThreadId,
        verifiedEmail: input.verifiedEmail ?? undefined,
      },
    });
    await emitEvent(tenantId, "conversation.created", { conversation: conv });
    return conv;
  },

  async get(tenantId: string, id: string) {
    const c = await prisma.conversation.findFirst({ where: { tenantId, id }, include: { customer: true, agent: true } });
    if (!c) throw notFound("Conversation");
    return c;
  },

  /**
   * Single entry point for every message. Persists, pushes realtime, fires webhooks, triggers the
   * AI reply for customer messages, and delivers outbound replies on non-web channels.
   */
  async addMessage(conv: Conversation, role: MessageRole, content: string, opts: { authorUserId?: string; metadata?: Prisma.InputJsonValue; skipAutoReply?: boolean } = {}) {
    const msg = await prisma.message.create({
      data: { conversationId: conv.id, role, content, authorUserId: opts.authorUserId, metadata: opts.metadata ?? {} },
    });
    const reopen = role === "CUSTOMER" && conv.status === "RESOLVED";
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: msg.createdAt, ...(reopen ? { status: "OPEN" } : {}) } });

    const visible = role !== "SYSTEM" || (opts.metadata as Record<string, unknown> | undefined)?.visibleToCustomer === true;
    if (visible) await publish(rooms.conversation(conv.id), "message", msg);
    await emitEvent(conv.tenantId, "message.created", { conversationId: conv.id, message: msg });

    if (role === "CUSTOMER" && !opts.skipAutoReply) {
      await enqueue("agent.reply", { conversationId: conv.id, messageId: msg.id }, { jobId: `reply-${msg.id}` });
    }
    if ((role === "AGENT" || role === "HUMAN") && conv.channel === "EMAIL") {
      const c = await prisma.conversation.findUnique({ where: { id: conv.id }, include: { customer: true } });
      if (c?.customer?.email) {
        await enqueue("email.send", { tenantId: conv.tenantId, to: c.customer.email, subject: `Re: ${c.subject ?? "Your request"}`, text: content, conversationId: conv.id });
      }
    }
    if ((role === "AGENT" || role === "HUMAN") && conv.channel === "WHATSAPP" && conv.externalThreadId) {
      await enqueue("whatsapp.send", { tenantId: conv.tenantId, to: conv.externalThreadId, text: content });
    }
    return msg;
  },

  async escalate(conv: Conversation, reason: string, summary?: string) {
    const updated = await prisma.conversation.update({ where: { id: conv.id }, data: { status: "PENDING_HUMAN" } });
    await prisma.message.create({ data: { conversationId: conv.id, role: "SYSTEM", content: `Escalated to a human: ${reason}${summary ? `\nSummary: ${summary}` : ""}` } });
    await emitEvent(conv.tenantId, "conversation.escalated", { conversation: updated, reason, summary });
    return updated;
  },

  async resolve(conv: Conversation) {
    const updated = await prisma.conversation.update({ where: { id: conv.id }, data: { status: "RESOLVED" } });
    await emitEvent(conv.tenantId, "conversation.resolved", { conversation: updated });
    return updated;
  },
};
