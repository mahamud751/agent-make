import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { body, param } from "../lib/http";
import { forbidden } from "../lib/errors";
import { ctxOf } from "../middleware/auth";
import { currentPeriod } from "../lib/plans";

/** SaaS operator console: manage every tenant. Restricted to PLATFORM_ADMIN_EMAILS. */
export const platformRouter = Router();

const admins = () => (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

platformRouter.use(async (req: Request, _res: Response, next: NextFunction) => {
  const a = ctxOf(req).actor;
  if (a.type !== "user") throw forbidden();
  const u = await prisma.user.findUnique({ where: { id: a.id } });
  if (!u || !admins().includes(u.email)) throw forbidden("Platform admins only");
  next();
});

platformRouter.get("/tenants", async (_req, res) => {
  const period = currentPeriod();
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { _count: { select: { memberships: true, conversations: true, orders: true } }, usage: { where: { period, metric: "ai_replies" } } },
  });
  res.json(tenants.map(({ usage, ...t }) => ({ ...t, aiRepliesThisMonth: usage[0]?.quantity ?? 0 })));
});

platformRouter.patch("/tenants/:id", async (req, res) => {
  const input = body(req, z.object({ plan: z.enum(["FREE", "STARTER", "GROWTH", "ENTERPRISE"]).optional(), subscriptionStatus: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELED"]).optional() }));
  res.json(await prisma.tenant.update({ where: { id: param(req, "id") }, data: input }));
});
