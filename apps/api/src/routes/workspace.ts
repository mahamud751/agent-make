import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { body, param, query } from "../lib/http";
import { badRequest, notFound, paymentRequired, forbidden } from "../lib/errors";
import { ctxOf, requireRole } from "../middleware/auth";
import { audit } from "../lib/audit";
import { PLANS } from "../lib/plans";
import { randomToken, sha256, encryptJson, decryptJson, encrypt } from "../lib/crypto";
import { generateApiKey } from "../modules/tenants/bootstrap";
import { TOOLS } from "../agent/tools";
import { searchKnowledge } from "../modules/knowledge/search";
import { buildConnector } from "../connectors";
import { approvalService } from "../modules/approvals/service";
import { actionSchema } from "../modules/automations/engine";
import { ALL_EVENTS } from "../events/bus";
import { env } from "../config/env";

export const workspaceRouter = Router();

const planOf = async (tenantId: string) => PLANS[(await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).plan];

// ─────────────── Tenant settings ───────────────
workspaceRouter.get("/tenant", requireRole("VIEWER"), async (req, res) => {
  res.json(await prisma.tenant.findUniqueOrThrow({ where: { id: ctxOf(req).tenantId } }));
});

workspaceRouter.patch("/tenant", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(
    req,
    z.object({
      name: z.string().min(1).max(100).optional(),
      timezone: z.string().max(60).optional(),
      settings: z
        .object({
          email: z.object({ provider: z.enum(["postmark", "sendgrid", "resend"]), apiKey: z.string(), from: z.string().email() }).optional(),
          whatsapp: z.object({ phoneNumberId: z.string(), accessToken: z.string(), verifyToken: z.string() }).optional(),
        })
        .optional(),
    }),
  );
  const current = await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
  const t = await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { name: input.name, timezone: input.timezone, settings: input.settings ? ({ ...(current.settings as object), ...input.settings } as Prisma.InputJsonValue) : undefined },
  });
  await audit(ctx, "tenant.updated");
  res.json(t);
});

// ─────────────── Team ───────────────
workspaceRouter.get("/members", requireRole("VIEWER"), async (req, res) => {
  const rows = await prisma.membership.findMany({ where: { tenantId: ctxOf(req).tenantId }, include: { user: { select: { id: true, email: true, name: true } } } });
  res.json(rows.map((m) => ({ id: m.id, role: m.role, user: m.user, createdAt: m.createdAt })));
});

workspaceRouter.post("/members/invite", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, z.object({ email: z.string().email(), role: z.enum(["ADMIN", "SUPPORT", "VIEWER"]) }));
  const seats = await prisma.membership.count({ where: { tenantId: ctx.tenantId } });
  if (seats >= (await planOf(ctx.tenantId)).seats) throw paymentRequired("Seat limit reached for your plan");
  const token = randomToken(32);
  await prisma.invite.create({ data: { tenantId: ctx.tenantId, email: input.email.toLowerCase(), role: input.role, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 864e5) } });
  await audit(ctx, "member.invited", input.email);
  res.status(201).json({ inviteUrl: `${env.DASHBOARD_URL}/accept-invite?token=${token}` });
});

workspaceRouter.patch("/members/:id", requireRole("OWNER"), async (req, res) => {
  const ctx = ctxOf(req);
  const { role } = body(req, z.object({ role: z.enum(["OWNER", "ADMIN", "SUPPORT", "VIEWER"]) }));
  const m = await prisma.membership.findFirst({ where: { id: param(req, "id"), tenantId: ctx.tenantId } });
  if (!m) throw notFound("Member");
  res.json(await prisma.membership.update({ where: { id: m.id }, data: { role } }));
});

workspaceRouter.delete("/members/:id", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const m = await prisma.membership.findFirst({ where: { id: param(req, "id"), tenantId: ctx.tenantId } });
  if (!m) throw notFound("Member");
  if (m.role === "OWNER" && (await prisma.membership.count({ where: { tenantId: ctx.tenantId, role: "OWNER" } })) <= 1) throw badRequest("Cannot remove the last owner");
  await prisma.membership.delete({ where: { id: m.id } });
  await audit(ctx, "member.removed", m.userId);
  res.status(204).end();
});

// ─────────────── API keys ───────────────
workspaceRouter.get("/api-keys", requireRole("ADMIN"), async (req, res) => {
  const keys = await prisma.apiKey.findMany({ where: { tenantId: ctxOf(req).tenantId, revokedAt: null }, orderBy: { createdAt: "desc" } });
  res.json(keys.map(({ keyHash: _h, ...k }) => k));
});

workspaceRouter.post("/api-keys", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, z.object({ name: z.string().min(1).max(60), kind: z.enum(["SECRET", "PUBLISHABLE"]), allowedOrigins: z.array(z.string().url()).max(20).default([]) }));
  const k = generateApiKey(input.kind);
  const row = await prisma.apiKey.create({ data: { tenantId: ctx.tenantId, name: input.name, kind: input.kind, prefix: k.prefix, keyHash: k.hash, allowedOrigins: input.allowedOrigins } });
  await audit(ctx, "api_key.created", row.id);
  res.status(201).json({ id: row.id, name: row.name, kind: row.kind, prefix: row.prefix, key: k.raw }); // raw key shown once
});

workspaceRouter.patch("/api-keys/:id", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, z.object({ allowedOrigins: z.array(z.string().url()).max(20) }));
  const r = await prisma.apiKey.updateMany({ where: { id: param(req, "id"), tenantId: ctx.tenantId }, data: { allowedOrigins: input.allowedOrigins } });
  if (!r.count) throw notFound("API key");
  res.json({ ok: true });
});

workspaceRouter.delete("/api-keys/:id", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const r = await prisma.apiKey.updateMany({ where: { id: param(req, "id"), tenantId: ctx.tenantId }, data: { revokedAt: new Date() } });
  if (!r.count) throw notFound("API key");
  await audit(ctx, "api_key.revoked", param(req, "id"));
  res.status(204).end();
});

// ─────────────── Agents ───────────────
const policy = z.enum(["AUTO", "APPROVAL", "DISABLED"]);
const agentInput = z.object({
  name: z.string().min(1).max(60),
  persona: z.string().max(2000).optional(),
  instructions: z.string().max(20000).optional(),
  language: z.string().max(30).optional(),
  model: z.string().max(60).optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  autoReply: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  greeting: z.string().max(500).optional(),
  toolPolicies: z.record(z.string(), policy).optional(),
  guardrails: z
    .object({ maxRefundAmount: z.number().nonnegative().optional(), handoffKeywords: z.array(z.string().max(60)).max(50).optional() })
    .optional(),
  widgetTheme: z.object({ primaryColor: z.string().max(20).optional(), position: z.enum(["left", "right"]).optional(), title: z.string().max(60).optional() }).optional(),
});

workspaceRouter.get("/agents/tools", requireRole("VIEWER"), (_req, res) => {
  res.json(TOOLS.map((t) => ({ name: t.name, description: t.description, defaultPolicy: t.defaultPolicy })));
});

workspaceRouter.get("/agents", requireRole("VIEWER"), async (req, res) => {
  res.json(await prisma.agent.findMany({ where: { tenantId: ctxOf(req).tenantId }, orderBy: { createdAt: "asc" } }));
});

workspaceRouter.get("/agents/:id", requireRole("VIEWER"), async (req, res) => {
  const a = await prisma.agent.findFirst({ where: { id: param(req, "id"), tenantId: ctxOf(req).tenantId } });
  if (!a) throw notFound("Agent");
  res.json(a);
});

workspaceRouter.post("/agents", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, agentInput);
  const count = await prisma.agent.count({ where: { tenantId: ctx.tenantId } });
  if (count >= (await planOf(ctx.tenantId)).agents) throw paymentRequired("Agent limit reached for your plan");
  const a = await prisma.$transaction(async (tx) => {
    if (input.isDefault || count === 0) await tx.agent.updateMany({ where: { tenantId: ctx.tenantId }, data: { isDefault: false } });
    return tx.agent.create({ data: { ...input, isDefault: input.isDefault || count === 0, tenantId: ctx.tenantId } as Prisma.AgentUncheckedCreateInput });
  });
  await audit(ctx, "agent.created", a.id);
  res.status(201).json(a);
});

workspaceRouter.patch("/agents/:id", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, agentInput.partial());
  const existing = await prisma.agent.findFirst({ where: { id: param(req, "id"), tenantId: ctx.tenantId } });
  if (!existing) throw notFound("Agent");
  const a = await prisma.$transaction(async (tx) => {
    if (input.isDefault) await tx.agent.updateMany({ where: { tenantId: ctx.tenantId }, data: { isDefault: false } });
    return tx.agent.update({ where: { id: existing.id }, data: input as Prisma.AgentUpdateInput });
  });
  await audit(ctx, "agent.updated", a.id, { fields: Object.keys(input) });
  res.json(a);
});

workspaceRouter.delete("/agents/:id", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const a = await prisma.agent.findFirst({ where: { id: param(req, "id"), tenantId: ctx.tenantId } });
  if (!a) throw notFound("Agent");
  if (a.isDefault) throw badRequest("Make another agent the default first");
  await prisma.conversation.updateMany({ where: { agentId: a.id }, data: { agentId: null } });
  await prisma.agent.delete({ where: { id: a.id } });
  res.status(204).end();
});

// ─────────────── Knowledge base ───────────────
const articleInput = z.object({ title: z.string().min(1).max(200), content: z.string().min(1).max(50_000), tags: z.array(z.string().max(40)).max(20).optional(), published: z.boolean().optional() });

workspaceRouter.get("/knowledge", requireRole("VIEWER"), async (req, res) => {
  res.json(await prisma.knowledgeArticle.findMany({ where: { tenantId: ctxOf(req).tenantId }, orderBy: { updatedAt: "desc" } }));
});
workspaceRouter.get("/knowledge/search", requireRole("VIEWER"), async (req, res) => {
  const { q } = query(req, z.object({ q: z.string().min(1) }));
  res.json(await searchKnowledge(ctxOf(req).tenantId, q, 10));
});
workspaceRouter.post("/knowledge", requireRole("ADMIN"), async (req, res) => {
  res.status(201).json(await prisma.knowledgeArticle.create({ data: { ...body(req, articleInput), tenantId: ctxOf(req).tenantId } }));
});
workspaceRouter.patch("/knowledge/:id", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const r = await prisma.knowledgeArticle.updateMany({ where: { id: param(req, "id"), tenantId: ctx.tenantId }, data: body(req, articleInput.partial()) });
  if (!r.count) throw notFound("Article");
  res.json(await prisma.knowledgeArticle.findUnique({ where: { id: param(req, "id") } }));
});
workspaceRouter.delete("/knowledge/:id", requireRole("ADMIN"), async (req, res) => {
  const r = await prisma.knowledgeArticle.deleteMany({ where: { id: param(req, "id"), tenantId: ctxOf(req).tenantId } });
  if (!r.count) throw notFound("Article");
  res.status(204).end();
});

// ─────────────── Integrations ───────────────
const integrationInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SHOPIFY"), name: z.string().default("Shopify"), config: z.object({ shopDomain: z.string().regex(/^[a-z0-9-]+\.myshopify\.com$/), accessToken: z.string().min(10), apiVersion: z.string().optional(), webhookSecret: z.string().optional() }) }),
  z.object({ type: z.literal("WOOCOMMERCE"), name: z.string().default("WooCommerce"), config: z.object({ siteUrl: z.string().url(), consumerKey: z.string(), consumerSecret: z.string(), webhookSecret: z.string().optional() }) }),
  z.object({ type: z.literal("CUSTOM_WEBHOOK"), name: z.string().default("Custom backend"), config: z.object({ endpointUrl: z.string().url(), signingSecret: z.string().min(16).optional(), headers: z.record(z.string(), z.string()).optional() }) }),
]);

const publicIntegration = (i: { id: string; type: string; name: string; active: boolean; lastSyncAt: Date | null; lastError: string | null; createdAt: Date }) => ({
  id: i.id, type: i.type, name: i.name, active: i.active, lastSyncAt: i.lastSyncAt, lastError: i.lastError, createdAt: i.createdAt,
  inboundWebhookUrl: i.type === "SHOPIFY" || i.type === "WOOCOMMERCE" ? `${env.PUBLIC_API_URL}/v1/inbound/${i.type.toLowerCase()}/${i.id}` : undefined,
});

workspaceRouter.get("/integrations", requireRole("VIEWER"), async (req, res) => {
  const rows = await prisma.integration.findMany({ where: { tenantId: ctxOf(req).tenantId } });
  res.json(rows.map(publicIntegration));
});

workspaceRouter.post("/integrations", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, integrationInput);
  const count = await prisma.integration.count({ where: { tenantId: ctx.tenantId } });
  if (count >= (await planOf(ctx.tenantId)).integrations) throw paymentRequired("Integration limit reached for your plan");
  const config: Record<string, unknown> = { ...input.config };
  let signingSecret: string | undefined;
  if (input.type === "CUSTOM_WEBHOOK" && !config.signingSecret) config.signingSecret = signingSecret = `whsec_${randomToken(24)}`;
  const row = await prisma.integration.create({ data: { tenantId: ctx.tenantId, type: input.type, name: input.name, configEncrypted: encryptJson(config) } });
  await audit(ctx, "integration.connected", row.id, { type: input.type });
  res.status(201).json({ ...publicIntegration(row), signingSecret });
});

workspaceRouter.post("/integrations/:id/test", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const i = await prisma.integration.findFirst({ where: { id: param(req, "id"), tenantId: ctx.tenantId } });
  if (!i) throw notFound("Integration");
  try {
    const products = await buildConnector(ctx.tenantId, i).searchProducts("a", 1);
    await prisma.integration.update({ where: { id: i.id }, data: { lastSyncAt: new Date(), lastError: null } });
    res.json({ ok: true, sampleProducts: products.length });
  } catch (e) {
    await prisma.integration.update({ where: { id: i.id }, data: { lastError: (e as Error).message } });
    res.status(502).json({ ok: false, error: (e as Error).message });
  }
});

workspaceRouter.patch("/integrations/:id", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, z.object({ active: z.boolean().optional(), name: z.string().max(60).optional(), config: z.record(z.string(), z.unknown()).optional() }));
  const i = await prisma.integration.findFirst({ where: { id: param(req, "id"), tenantId: ctx.tenantId } });
  if (!i) throw notFound("Integration");
  const row = await prisma.integration.update({
    where: { id: i.id },
    data: { active: input.active, name: input.name, configEncrypted: input.config ? encryptJson({ ...decryptJson<Record<string, unknown>>(i.configEncrypted), ...input.config }) : undefined },
  });
  res.json(publicIntegration(row));
});

workspaceRouter.delete("/integrations/:id", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const r = await prisma.integration.deleteMany({ where: { id: param(req, "id"), tenantId: ctx.tenantId } });
  if (!r.count) throw notFound("Integration");
  await audit(ctx, "integration.removed", param(req, "id"));
  res.status(204).end();
});

// ─────────────── Outbound webhooks ───────────────
workspaceRouter.get("/webhooks", requireRole("ADMIN"), async (req, res) => {
  const rows = await prisma.webhookEndpoint.findMany({ where: { tenantId: ctxOf(req).tenantId } });
  res.json(rows.map(({ secret: _s, ...w }) => w));
});
workspaceRouter.post("/webhooks", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, z.object({ url: z.string().url(), events: z.array(z.enum(["*", ...ALL_EVENTS] as [string, ...string[]])).min(1) }));
  if (env.NODE_ENV === "production" && !input.url.startsWith("https://")) throw badRequest("Webhook URLs must use https");
  const secret = `whsec_${randomToken(24)}`;
  const w = await prisma.webhookEndpoint.create({ data: { tenantId: ctx.tenantId, url: input.url, events: input.events, secret: encrypt(secret) } });
  res.status(201).json({ id: w.id, url: w.url, events: w.events, secret });
});
workspaceRouter.delete("/webhooks/:id", requireRole("ADMIN"), async (req, res) => {
  const r = await prisma.webhookEndpoint.deleteMany({ where: { id: param(req, "id"), tenantId: ctxOf(req).tenantId } });
  if (!r.count) throw notFound("Webhook");
  res.status(204).end();
});
workspaceRouter.get("/webhooks/:id/deliveries", requireRole("ADMIN"), async (req, res) => {
  const w = await prisma.webhookEndpoint.findFirst({ where: { id: param(req, "id"), tenantId: ctxOf(req).tenantId } });
  if (!w) throw notFound("Webhook");
  res.json(await prisma.webhookDelivery.findMany({ where: { endpointId: w.id }, orderBy: { createdAt: "desc" }, take: 50 }));
});

// ─────────────── Automations ───────────────
const automationInput = z.object({
  name: z.string().min(1).max(100),
  event: z.enum(ALL_EVENTS as [string, ...string[]]),
  conditions: z.record(z.string(), z.unknown()).default({}),
  actions: z.array(actionSchema).min(1).max(10),
  active: z.boolean().default(true),
});
workspaceRouter.get("/automations", requireRole("VIEWER"), async (req, res) => {
  res.json(await prisma.automationRule.findMany({ where: { tenantId: ctxOf(req).tenantId }, orderBy: { createdAt: "asc" } }));
});
workspaceRouter.post("/automations", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  if (!(await planOf(ctx.tenantId)).automations) throw paymentRequired("Automations require the Starter plan or above");
  const input = body(req, automationInput);
  res.status(201).json(await prisma.automationRule.create({ data: { ...input, conditions: input.conditions as Prisma.InputJsonValue, tenantId: ctx.tenantId } }));
});
workspaceRouter.patch("/automations/:id", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, automationInput.partial());
  const r = await prisma.automationRule.updateMany({ where: { id: param(req, "id"), tenantId: ctx.tenantId }, data: { ...input, conditions: input.conditions as Prisma.InputJsonValue | undefined } });
  if (!r.count) throw notFound("Automation");
  res.json(await prisma.automationRule.findUnique({ where: { id: param(req, "id") } }));
});
workspaceRouter.delete("/automations/:id", requireRole("ADMIN"), async (req, res) => {
  const r = await prisma.automationRule.deleteMany({ where: { id: param(req, "id"), tenantId: ctxOf(req).tenantId } });
  if (!r.count) throw notFound("Automation");
  res.status(204).end();
});

// ─────────────── Approvals (human-in-the-loop) ───────────────
workspaceRouter.get("/approvals", requireRole("SUPPORT"), async (req, res) => {
  const { status } = query(req, z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXECUTED", "FAILED"]).optional() }));
  res.json(await approvalService.list(ctxOf(req).tenantId, status));
});
workspaceRouter.post("/approvals/:id/approve", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  if (ctx.actor.type !== "user") throw forbidden("Approvals must be made by a person");
  const r = await approvalService.approve(ctx.tenantId, param(req, "id"), ctx.actor.id);
  await audit(ctx, "action.approved", r.id, { tool: r.tool });
  res.json(r);
});
workspaceRouter.post("/approvals/:id/reject", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  if (ctx.actor.type !== "user") throw forbidden("Approvals must be made by a person");
  const { note } = body(req, z.object({ note: z.string().max(1000).optional() }));
  const r = await approvalService.reject(ctx.tenantId, param(req, "id"), ctx.actor.id, note);
  await audit(ctx, "action.rejected", r.id, { tool: r.tool });
  res.json(r);
});

// ─────────────── Audit log ───────────────
workspaceRouter.get("/audit-logs", requireRole("ADMIN"), async (req, res) => {
  res.json(await prisma.auditLog.findMany({ where: { tenantId: ctxOf(req).tenantId }, orderBy: { createdAt: "desc" }, take: 200 }));
});
