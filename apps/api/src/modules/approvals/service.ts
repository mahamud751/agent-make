import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { getConnector } from "../../connectors";
import { runTool } from "../../agent/tools";
import type { Guardrails } from "../../agent/tools/types";
import { conversationService } from "../conversations/service";
import { emitEvent } from "../../events/bus";

export const approvalService = {
  list(tenantId: string, status?: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED") {
    return prisma.pendingAction.findMany({ where: { tenantId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 100 });
  },

  /** Human approves → tool runs with the verified identity captured at request time. */
  async approve(tenantId: string, id: string, userId: string) {
    const action = await prisma.pendingAction.findFirst({ where: { tenantId, id } });
    if (!action) throw notFound("Action");
    // atomic claim so two reviewers can't execute the same action twice
    const claimed = await prisma.pendingAction.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "APPROVED", decidedById: userId, decidedAt: new Date() },
    });
    if (!claimed.count) throw badRequest(`Action already ${action.status.toLowerCase()}`);

    const conv = action.conversationId ? await prisma.conversation.findUnique({ where: { id: action.conversationId }, include: { agent: true } }) : null;
    const { _verifiedEmail, ...input } = action.input as Record<string, unknown>;
    let outcome: { ok: boolean; message: string; data?: unknown };
    if (!conv?.agent) {
      outcome = { ok: false, message: "Conversation or agent no longer exists" };
    } else {
      const result = await runTool(
        {
          tenantId,
          agent: conv.agent,
          conversation: { ...conv, verifiedEmail: (_verifiedEmail as string | null) ?? conv.verifiedEmail },
          connector: await getConnector(tenantId),
          actor: `user:${userId}`,
          guardrails: (conv.agent.guardrails ?? {}) as Guardrails,
          approved: true,
        },
        action.tool,
        input,
      );
      outcome = result.ok
        ? { ok: true, message: result.customerNotice ?? "Your request has been approved and completed.", data: result.data }
        : { ok: false, message: result.error };
    }

    const updated = await prisma.pendingAction.update({
      where: { id },
      data: { status: outcome.ok ? "EXECUTED" : "FAILED", result: outcome as unknown as Prisma.InputJsonValue },
    });
    if (conv) {
      await conversationService.addMessage(
        conv,
        "AGENT",
        outcome.ok ? `Update: ${outcome.message}` : "Update: our team reviewed your request but couldn't complete it automatically. A teammate will follow up here.",
        { metadata: { actionId: id } },
      );
    }
    await emitEvent(tenantId, "action.decided", { action: updated });
    return updated;
  },

  async reject(tenantId: string, id: string, userId: string, note?: string) {
    const action = await prisma.pendingAction.findFirst({ where: { tenantId, id } });
    if (!action) throw notFound("Action");
    const claimed = await prisma.pendingAction.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "REJECTED", decidedById: userId, decidedAt: new Date(), result: { note: note ?? null } },
    });
    if (!claimed.count) throw badRequest(`Action already ${action.status.toLowerCase()}`);
    if (action.conversationId) {
      const conv = await prisma.conversation.findUnique({ where: { id: action.conversationId } });
      if (conv) {
        await conversationService.addMessage(conv, "HUMAN", note?.trim() || "Our team reviewed your request and wasn't able to approve it. Reply here if you have any questions.", { authorUserId: userId });
      }
    }
    const updated = await prisma.pendingAction.findUniqueOrThrow({ where: { id } });
    await emitEvent(tenantId, "action.decided", { action: updated });
    return updated;
  },
};
