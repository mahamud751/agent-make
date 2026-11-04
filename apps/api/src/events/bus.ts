import { prisma } from "../lib/prisma";
import { enqueue } from "../jobs/queues";
import { publish, rooms } from "../realtime/publisher";
import { logger } from "../lib/logger";

export type EventType =
  | "order.created"
  | "order.status_changed"
  | "order.updated"
  | "order.refunded"
  | "conversation.created"
  | "conversation.escalated"
  | "conversation.resolved"
  | "message.created"
  | "action.pending"
  | "action.decided";

export const ALL_EVENTS: EventType[] = [
  "order.created",
  "order.status_changed",
  "order.updated",
  "order.refunded",
  "conversation.created",
  "conversation.escalated",
  "conversation.resolved",
  "message.created",
  "action.pending",
  "action.decided",
];

/**
 * Domain event fan-out:
 *   1. realtime push to the tenant's dashboards
 *   2. outbound webhooks to the tenant's subscribed endpoints (signed, retried)
 *   3. automation rules (e.g. "when order ships, message the customer")
 */
export async function emitEvent(tenantId: string, type: EventType, data: Record<string, unknown>) {
  try {
    await publish(rooms.tenant(tenantId), type, data);

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { tenantId, active: true, OR: [{ events: { has: type } }, { events: { has: "*" } }] },
    });
    for (const ep of endpoints) {
      const d = await prisma.webhookDelivery.create({
        data: { endpointId: ep.id, event: type, payload: { id: crypto.randomUUID(), type, createdAt: new Date().toISOString(), data } as object },
      });
      await enqueue("webhook.deliver", { deliveryId: d.id });
    }

    if (type !== "message.created") {
      const hasRules = await prisma.automationRule.count({ where: { tenantId, event: type, active: true } });
      if (hasRules) await enqueue("automation.run", { tenantId, event: type, data });
    }
  } catch (err) {
    // events must never break the request that produced them
    logger.error({ err, type, tenantId }, "emitEvent failed");
  }
}
