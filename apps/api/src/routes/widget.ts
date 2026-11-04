import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { body, query } from "../lib/http";
import { forbidden, unauthorized } from "../lib/errors";
import { ctxOf } from "../middleware/auth";
import { randomToken, sha256 } from "../lib/crypto";
import { conversationService } from "../modules/conversations/service";
import { rateLimit } from "../middleware/rateLimit";

/**
 * Public endpoints used by the embeddable chat widget. Authenticated with a publishable key
 * (origin-restricted) + a per-visitor token that scopes access to exactly one conversation.
 */
export const widgetRouter = Router();

widgetRouter.use((req, _res, next) => {
  const a = ctxOf(req).actor;
  if (a.type !== "api_key") throw forbidden("Widget endpoints require a publishable key");
  next();
});
widgetRouter.use(rateLimit({ prefix: "widget", windowSec: 60, max: 300 }));

async function conversationFor(tenantId: string, visitorToken: string) {
  const c = await prisma.conversation.findUnique({ where: { visitorTokenHash: sha256(visitorToken) } });
  if (!c || c.tenantId !== tenantId) throw unauthorized("Unknown visitor session");
  return c;
}

const visible = { OR: [{ role: { not: "SYSTEM" as const } }] };

/** Start or resume a chat session. Returns agent branding and history. */
widgetRouter.post("/session", async (req, res) => {
  const { tenantId } = ctxOf(req);
  const input = body(req, z.object({ visitorToken: z.string().optional(), agentId: z.string().optional(), customer: z.object({ name: z.string().max(100).optional(), email: z.string().email().optional() }).optional() }));
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

  if (input.visitorToken) {
    const existing = await prisma.conversation.findUnique({ where: { visitorTokenHash: sha256(input.visitorToken) }, include: { agent: true } });
    if (existing && existing.tenantId === tenantId) {
      const messages = await prisma.message.findMany({ where: { conversationId: existing.id, ...visible }, orderBy: { createdAt: "asc" }, take: 200 });
      return res.json({ conversationId: existing.id, visitorToken: input.visitorToken, store: tenant.name, agent: branding(existing.agent), messages });
    }
  }
  const visitorToken = `vt_${randomToken(24)}`;
  const customer = input.customer?.email ? await conversationService.findOrCreateCustomer(tenantId, input.customer) : null;
  const conv = await conversationService.create(tenantId, { channel: "WEB_WIDGET", agentId: input.agentId, customerId: customer?.id, visitorTokenHash: sha256(visitorToken) });
  const agent = conv.agentId ? await prisma.agent.findUnique({ where: { id: conv.agentId } }) : null;
  const greeting = agent?.greeting ? await prisma.message.create({ data: { conversationId: conv.id, role: "AGENT", content: agent.greeting, metadata: { greeting: true } } }) : null;
  res.status(201).json({ conversationId: conv.id, visitorToken, store: tenant.name, agent: branding(agent), messages: greeting ? [greeting] : [] });
});

widgetRouter.post("/messages", async (req, res) => {
  const { tenantId } = ctxOf(req);
  const input = body(req, z.object({ visitorToken: z.string(), content: z.string().min(1).max(4000) }));
  const conv = await conversationFor(tenantId, input.visitorToken);
  const msg = await conversationService.addMessage(conv, "CUSTOMER", input.content.trim());
  res.status(201).json(msg);
});

/** Polling fallback for clients without websockets. */
widgetRouter.get("/messages", async (req, res) => {
  const { tenantId } = ctxOf(req);
  const q = query(req, z.object({ visitorToken: z.string(), after: z.string().datetime().optional() }));
  const conv = await conversationFor(tenantId, q.visitorToken);
  const messages = await prisma.message.findMany({
    where: { conversationId: conv.id, ...visible, ...(q.after ? { createdAt: { gt: new Date(q.after) } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  res.json({ status: conv.status, messages });
});

function branding(agent: { name: string; greeting: string; widgetTheme: unknown } | null) {
  if (!agent) return { name: "Support", theme: {} };
  return { name: agent.name, theme: agent.widgetTheme ?? {} };
}
