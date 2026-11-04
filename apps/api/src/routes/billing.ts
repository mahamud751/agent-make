import { Router, type Request } from "express";
import Stripe from "stripe";
import { z } from "zod";
import type { PlanTier } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { body } from "../lib/http";
import { badRequest } from "../lib/errors";
import { ctxOf, requireRole } from "../middleware/auth";
import { PLANS, currentPeriod } from "../lib/plans";
import { getUsage } from "../modules/billing/usage";
import { logger } from "../lib/logger";

export const billingRouter = Router();
export const stripeWebhookRouter = Router();

const stripe = () => {
  if (!env.STRIPE_SECRET_KEY) throw badRequest("Billing is not configured on this deployment");
  return new Stripe(env.STRIPE_SECRET_KEY);
};
const PRICE: Partial<Record<PlanTier, string | undefined>> = { STARTER: env.STRIPE_PRICE_STARTER, GROWTH: env.STRIPE_PRICE_GROWTH };

billingRouter.get("/billing", requireRole("VIEWER"), async (req, res) => {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: ctxOf(req).tenantId } });
  res.json({ plan: t.plan, status: t.subscriptionStatus, period: currentPeriod(), limits: PLANS[t.plan], usage: await getUsage(t.id), plans: PLANS });
});

billingRouter.post("/billing/checkout", requireRole("OWNER"), async (req, res) => {
  const ctx = ctxOf(req);
  const { plan } = body(req, z.object({ plan: z.enum(["STARTER", "GROWTH"]) }));
  const price = PRICE[plan];
  if (!price) throw badRequest(`No Stripe price configured for ${plan}`);
  const s = stripe();
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
  let customer = t.stripeCustomerId;
  if (!customer) {
    customer = (await s.customers.create({ name: t.name, metadata: { tenantId: t.id } })).id;
    await prisma.tenant.update({ where: { id: t.id }, data: { stripeCustomerId: customer } });
  }
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price, quantity: 1 }],
    success_url: `${env.DASHBOARD_URL}/settings/billing?success=1`,
    cancel_url: `${env.DASHBOARD_URL}/settings/billing`,
    metadata: { tenantId: t.id, plan },
    subscription_data: { metadata: { tenantId: t.id, plan } },
  });
  res.json({ url: session.url });
});

billingRouter.post("/billing/portal", requireRole("OWNER"), async (req, res) => {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: ctxOf(req).tenantId } });
  if (!t.stripeCustomerId) throw badRequest("No billing account yet");
  const session = await stripe().billingPortal.sessions.create({ customer: t.stripeCustomerId, return_url: `${env.DASHBOARD_URL}/settings/billing` });
  res.json({ url: session.url });
});

const STATUS: Record<string, "ACTIVE" | "PAST_DUE" | "CANCELED" | "TRIALING"> = { active: "ACTIVE", trialing: "TRIALING", past_due: "PAST_DUE", unpaid: "PAST_DUE", canceled: "CANCELED", incomplete_expired: "CANCELED" };

stripeWebhookRouter.post("/stripe", async (req: Request, res) => {
  if (!env.STRIPE_WEBHOOK_SECRET) return res.status(404).end();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(req.rawBody ?? "", req.headers["stripe-signature"] as string, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send("bad signature");
  }
  if (event.type.startsWith("customer.subscription.")) {
    const sub = event.data.object as Stripe.Subscription;
    const tenantId = sub.metadata?.tenantId;
    const plan = sub.metadata?.plan as PlanTier | undefined;
    if (tenantId) {
      const deleted = event.type === "customer.subscription.deleted";
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { stripeSubId: sub.id, subscriptionStatus: deleted ? "CANCELED" : STATUS[sub.status] ?? "ACTIVE", plan: deleted ? "FREE" : plan ?? undefined },
      });
      logger.info({ tenantId, type: event.type }, "subscription updated");
    }
  }
  res.json({ received: true });
});
