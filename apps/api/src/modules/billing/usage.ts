import { prisma } from "../../lib/prisma";
import { PLANS, currentPeriod } from "../../lib/plans";

export async function incrementUsage(tenantId: string, metric: string, quantity: number) {
  if (!quantity) return;
  const period = currentPeriod();
  await prisma.usageRecord.upsert({
    where: { tenantId_period_metric: { tenantId, period, metric } },
    create: { tenantId, period, metric, quantity },
    update: { quantity: { increment: quantity } },
  });
}

export async function getUsage(tenantId: string, period = currentPeriod()) {
  const rows = await prisma.usageRecord.findMany({ where: { tenantId, period } });
  return Object.fromEntries(rows.map((r) => [r.metric, r.quantity])) as Record<string, number>;
}

/** True if the tenant may send another AI reply this month. */
export async function canSendAiReply(tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (tenant.subscriptionStatus === "CANCELED") return false;
  const used = (await getUsage(tenantId)).ai_replies ?? 0;
  return used < PLANS[tenant.plan].aiRepliesPerMonth;
}
