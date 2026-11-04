import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

/** Send a WhatsApp text via Meta Cloud API using the tenant's own business number. */
export async function sendWhatsApp(job: { tenantId: string; to: string; text: string }) {
  const tenant = await prisma.tenant.findUnique({ where: { id: job.tenantId } });
  const wa = (tenant?.settings as { whatsapp?: { phoneNumberId?: string; accessToken?: string } } | null)?.whatsapp;
  if (!wa?.phoneNumberId || !wa.accessToken) {
    logger.info({ to: job.to }, "[whatsapp:dev] would send message");
    return;
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${wa.phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${wa.accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: job.to, type: "text", text: { body: job.text.slice(0, 4096) } }),
  });
  if (!res.ok) throw new Error(`WhatsApp API responded ${res.status}`);
}
