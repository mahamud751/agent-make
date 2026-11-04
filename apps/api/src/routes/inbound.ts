import { Router, type Request } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { decryptJson, safeEqual } from "../lib/crypto";
import { forbidden, notFound, unauthorized } from "../lib/errors";
import { conversationService } from "../modules/conversations/service";
import { orderService } from "../modules/orders/service";
import { mapShopifyOrder, type ShopifyConfig } from "../connectors/shopify";
import { mapWooOrder, type WooConfig } from "../connectors/woocommerce";
import { logger } from "../lib/logger";
import { param } from "../lib/http";

/** Webhooks *into* AgentDesk from e-commerce platforms and messaging providers. */
export const inboundRouter = Router();

const raw = (req: Request) => req.rawBody ?? JSON.stringify(req.body ?? {});
const hmacB64 = (secret: string, data: string) => crypto.createHmac("sha256", secret).update(data, "utf8").digest("base64");

// ── Shopify: orders/create, orders/updated, orders/cancelled, fulfillments ──
inboundRouter.post("/shopify/:integrationId", async (req, res) => {
  const i = await prisma.integration.findUnique({ where: { id: param(req, "integrationId") } });
  if (!i || i.type !== "SHOPIFY" || !i.active) throw notFound("Integration");
  const cfg = decryptJson<ShopifyConfig>(i.configEncrypted);
  if (!cfg.webhookSecret) throw forbidden("Webhook secret not configured");
  const sig = req.headers["x-shopify-hmac-sha256"] as string | undefined;
  if (!sig || !safeEqual(sig, hmacB64(cfg.webhookSecret, raw(req)))) throw unauthorized("Bad signature");
  const topic = String(req.headers["x-shopify-topic"] ?? "");
  if (topic.startsWith("orders/")) await orderService.upsertExternal(i.tenantId, "SHOPIFY", mapShopifyOrder(req.body));
  await prisma.integration.update({ where: { id: i.id }, data: { lastSyncAt: new Date() } });
  res.json({ ok: true });
});

// ── WooCommerce: order.created / order.updated ──
inboundRouter.post("/woocommerce/:integrationId", async (req, res) => {
  const i = await prisma.integration.findUnique({ where: { id: param(req, "integrationId") } });
  if (!i || i.type !== "WOOCOMMERCE" || !i.active) throw notFound("Integration");
  const cfg = decryptJson<WooConfig>(i.configEncrypted);
  if (!req.body?.id) return res.json({ ok: true }); // Woo sends a ping on webhook creation
  if (!cfg.webhookSecret) throw forbidden("Webhook secret not configured");
  const sig = req.headers["x-wc-webhook-signature"] as string | undefined;
  if (!sig || !safeEqual(sig, hmacB64(cfg.webhookSecret, raw(req)))) throw unauthorized("Bad signature");
  await orderService.upsertExternal(i.tenantId, "WOOCOMMERCE", mapWooOrder(req.body));
  await prisma.integration.update({ where: { id: i.id }, data: { lastSyncAt: new Date() } });
  res.json({ ok: true });
});

// ── Email: normalised parse webhook (Postmark/SendGrid/Mailgun adapters map to this shape) ──
// To: "<tenant-slug>@inbound.agentdesk.app" (new thread) or "c+<conversationId>@inbound..." (reply)
inboundRouter.post("/email", async (req, res) => {
  const token = (req.headers["x-inbound-secret"] as string | undefined) ?? (req.query.secret as string | undefined);
  if (!env.INBOUND_EMAIL_SECRET || !token || !safeEqual(token, env.INBOUND_EMAIL_SECRET)) throw unauthorized();
  const input = z.object({ from: z.string().email(), fromName: z.string().optional(), to: z.string(), subject: z.string().default(""), text: z.string().min(1), messageId: z.string().optional(), inReplyTo: z.string().optional() }).parse(req.body);
  const local = input.to.split("@")[0]?.toLowerCase() ?? "";
  let conv = null;
  if (local.startsWith("c+")) conv = await prisma.conversation.findUnique({ where: { id: local.slice(2) } });
  const tenant = conv ? await prisma.tenant.findUnique({ where: { id: conv.tenantId } }) : await prisma.tenant.findUnique({ where: { slug: local } });
  if (!tenant) throw notFound("Mailbox");
  const from = input.from.toLowerCase();
  if (conv && conv.verifiedEmail && conv.verifiedEmail !== from) conv = null; // reply from someone else → new thread
  if (!conv) {
    const customer = await conversationService.findOrCreateCustomer(tenant.id, { email: from, name: input.fromName });
    // Email sender is treated as verified for orders under that address (SPF/DKIM checked by the provider).
    conv = await conversationService.create(tenant.id, { channel: "EMAIL", customerId: customer?.id, subject: input.subject, externalThreadId: input.messageId, verifiedEmail: from });
  }
  const text = input.text.split(/\n(?:On .+wrote:|-{2,}\s*Original Message)/)[0]!.trim(); // drop quoted history
  await conversationService.addMessage(conv, "CUSTOMER", text || input.text);
  res.json({ ok: true, conversationId: conv.id });
});

// ── WhatsApp Cloud API (Meta) ──
inboundRouter.get("/whatsapp/:tenantSlug", async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { slug: param(req, "tenantSlug") } });
  const wa = (tenant?.settings as { whatsapp?: { verifyToken?: string } } | null)?.whatsapp;
  if (req.query["hub.mode"] === "subscribe" && wa?.verifyToken && req.query["hub.verify_token"] === wa.verifyToken) {
    return res.send(String(req.query["hub.challenge"]));
  }
  res.status(403).end();
});

inboundRouter.post("/whatsapp/:tenantSlug", async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { slug: param(req, "tenantSlug") } });
  if (!tenant) throw notFound("Tenant");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const entries: any[] = req.body?.entry ?? [];
  for (const e of entries) {
    for (const ch of e.changes ?? []) {
      const contacts = ch.value?.contacts ?? [];
      for (const m of ch.value?.messages ?? []) {
        if (m.type !== "text") continue;
        const waId = String(m.from);
        const name = contacts.find((c: any) => c.wa_id === waId)?.profile?.name;
        let conv = await prisma.conversation.findFirst({ where: { tenantId: tenant.id, channel: "WHATSAPP", externalThreadId: waId, status: { not: "RESOLVED" } } });
        if (!conv) {
          const customer = await conversationService.findOrCreateCustomer(tenant.id, { phone: `+${waId}`, name });
          conv = await conversationService.create(tenant.id, { channel: "WHATSAPP", customerId: customer?.id, externalThreadId: waId });
        }
        await conversationService.addMessage(conv, "CUSTOMER", m.text.body);
      }
    }
  }
  logger.debug({ tenant: tenant.slug }, "whatsapp webhook processed");
  res.json({ ok: true });
});
