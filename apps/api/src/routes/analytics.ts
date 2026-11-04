import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { query } from "../lib/http";
import { ctxOf, requireRole } from "../middleware/auth";

export const analyticsRouter = Router();

analyticsRouter.get("/analytics/overview", requireRole("VIEWER"), async (req, res) => {
  const { days } = query(req, z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }));
  const tenantId = ctxOf(req).tenantId;
  const since = new Date(Date.now() - days * 864e5);

  const [convByStatus, totalConvs, escalated, aiMsgs, humanMsgs, runs, orders, actions, daily] = await Promise.all([
    prisma.conversation.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
    prisma.conversation.count({ where: { tenantId, createdAt: { gte: since } } }),
    prisma.message.count({ where: { role: "SYSTEM", createdAt: { gte: since }, content: { startsWith: "Escalated to a human" }, conversation: { tenantId } } }),
    prisma.message.count({ where: { role: "AGENT", createdAt: { gte: since }, conversation: { tenantId } } }),
    prisma.message.count({ where: { role: "HUMAN", createdAt: { gte: since }, conversation: { tenantId } } }),
    prisma.agentRun.aggregate({ where: { tenantId, createdAt: { gte: since } }, _avg: { latencyMs: true }, _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true }, _count: true }),
    prisma.order.groupBy({ by: ["status"], where: { tenantId, placedAt: { gte: since } }, _count: true, _sum: { total: true } }),
    prisma.pendingAction.groupBy({ by: ["status"], where: { tenantId, createdAt: { gte: since } }, _count: true }),
    prisma.$queryRaw<{ day: Date; conversations: bigint }[]>`
      SELECT date_trunc('day', "createdAt") AS day, count(*) AS conversations
      FROM "Conversation" WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${since}
      GROUP BY 1 ORDER BY 1`,
  ]);

  const resolvedByAi = await prisma.conversation.count({
    where: { tenantId, createdAt: { gte: since }, status: "RESOLVED", messages: { none: { role: "HUMAN" } } },
  });
  const humanTouched = await prisma.conversation.count({ where: { tenantId, createdAt: { gte: since }, messages: { some: { role: "HUMAN" } } } });

  res.json({
    rangeDays: days,
    conversations: { total: totalConvs, byStatus: Object.fromEntries(convByStatus.map((r) => [r.status, r._count])), escalated, resolvedByAi, humanTouched },
    automationRate: totalConvs ? Math.round(((totalConvs - humanTouched) / totalConvs) * 1000) / 10 : 0,
    messages: { ai: aiMsgs, human: humanMsgs },
    ai: { runs: runs._count, avgLatencyMs: Math.round(runs._avg.latencyMs ?? 0), inputTokens: runs._sum.inputTokens ?? 0, outputTokens: runs._sum.outputTokens ?? 0, cacheReadTokens: runs._sum.cacheReadTokens ?? 0 },
    orders: orders.map((o) => ({ status: o.status, count: o._count, revenue: Number(o._sum.total ?? 0) })),
    approvals: Object.fromEntries(actions.map((a) => [a.status, a._count])),
    daily: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), conversations: Number(d.conversations) })),
  });
});
