import { prisma } from "../../lib/prisma";
import { decrypt, signPayload } from "../../lib/crypto";

/** Deliver one outbound webhook. Throws on failure so the queue retries with backoff. */
export async function deliverWebhook(deliveryId: string) {
  const d = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true } });
  if (!d || d.succeeded || !d.endpoint.active) return;
  const body = JSON.stringify(d.payload);
  let status: number | undefined;
  let error: string | undefined;
  try {
    const res = await fetch(d.endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "AgentDesk-Webhooks/1.0",
        "x-agentdesk-event": d.event,
        "x-agentdesk-delivery": d.id,
        "x-agentdesk-signature": signPayload(decrypt(d.endpoint.secret), body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message;
  }
  await prisma.webhookDelivery.update({
    where: { id: d.id },
    data: { attempts: { increment: 1 }, statusCode: status, succeeded: !error, lastError: error ?? null },
  });
  if (error) throw new Error(`webhook delivery failed: ${error}`);
}
