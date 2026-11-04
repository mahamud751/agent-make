import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";

/**
 * Outbound email. Pluggable: set tenant.settings.email = { provider: "postmark"|"sendgrid"|"resend",
 * apiKey, from }. Without a provider configured messages are logged (dev mode).
 */
export async function sendEmail(job: { tenantId: string; to: string; subject: string; text: string; conversationId?: string }) {
  const tenant = await prisma.tenant.findUnique({ where: { id: job.tenantId } });
  const cfg = ((tenant?.settings ?? {}) as { email?: { provider?: string; apiKey?: string; from?: string } }).email;
  const from = cfg?.from ?? `support@${tenant?.slug ?? "agentdesk"}.agentdesk.app`;
  const replyTo = job.conversationId ? `c+${job.conversationId}@inbound.agentdesk.app` : undefined;

  if (!cfg?.provider || !cfg.apiKey) {
    logger.info({ to: job.to, subject: job.subject }, "[email:dev] would send email");
    return;
  }
  const requests: Record<string, () => Promise<Response>> = {
    postmark: () =>
      fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Postmark-Server-Token": cfg.apiKey! },
        body: JSON.stringify({ From: from, To: job.to, Subject: job.subject, TextBody: job.text, ReplyTo: replyTo }),
      }),
    sendgrid: () =>
      fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ personalizations: [{ to: [{ email: job.to }] }], from: { email: from }, reply_to: replyTo ? { email: replyTo } : undefined, subject: job.subject, content: [{ type: "text/plain", value: job.text }] }),
      }),
    resend: () =>
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ from, to: job.to, subject: job.subject, text: job.text, reply_to: replyTo }),
      }),
  };
  const send = requests[cfg.provider];
  if (!send) throw new Error(`Unknown email provider ${cfg.provider}`);
  const res = await send();
  if (!res.ok) throw new Error(`email provider ${cfg.provider} responded ${res.status}`);
}
