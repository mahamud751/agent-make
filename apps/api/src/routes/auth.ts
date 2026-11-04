import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { body } from "../lib/http";
import { badRequest, conflict, unauthorized } from "../lib/errors";
import { sha256 } from "../lib/crypto";
import { authenticate, ctxOf, signUserToken } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { bootstrapTenant, uniqueSlug } from "../modules/tenants/bootstrap";

export const authRouter = Router();
const limiter = rateLimit({ prefix: "auth", windowSec: 60, max: 20 });

const password = z.string().min(8).max(200);

authRouter.post("/signup", limiter, async (req, res) => {
  const input = body(req, z.object({ name: z.string().min(1).max(100), email: z.string().email(), password, company: z.string().min(1).max(100) }));
  const email = input.email.toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) throw conflict("An account with this email already exists");
  const slug = await uniqueSlug(input.company);
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email, name: input.name, passwordHash: await bcrypt.hash(input.password, 12) } });
    const tenant = await tx.tenant.create({ data: { name: input.company, slug } });
    await tx.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "OWNER" } });
    const { publishableKey } = await bootstrapTenant(tx, tenant.id, input.company);
    return { user, tenant, publishableKey };
  });
  res.status(201).json({
    token: signUserToken({ sub: result.user.id, tid: result.tenant.id, role: "OWNER" }),
    tenant: result.tenant,
    user: { id: result.user.id, email, name: result.user.name },
    publishableKey: result.publishableKey, // shown once
  });
});

authRouter.post("/login", limiter, async (req, res) => {
  const input = body(req, z.object({ email: z.string().email(), password: z.string(), tenantId: z.string().optional() }));
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() }, include: { memberships: { include: { tenant: true } } } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) throw unauthorized("Invalid email or password");
  const m = input.tenantId ? user.memberships.find((x) => x.tenantId === input.tenantId) : user.memberships[0];
  if (!m) throw unauthorized("No workspace access");
  res.json({
    token: signUserToken({ sub: user.id, tid: m.tenantId, role: m.role }),
    user: { id: user.id, email: user.email, name: user.name },
    tenant: m.tenant,
    workspaces: user.memberships.map((x) => ({ id: x.tenantId, name: x.tenant.name, role: x.role })),
  });
});

authRouter.get("/me", authenticate, async (req, res) => {
  const ctx = ctxOf(req);
  if (ctx.actor.type !== "user") throw badRequest("Not a user token");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.actor.id }, include: { memberships: { include: { tenant: true } } } });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
  res.json({
    user: { id: user.id, email: user.email, name: user.name },
    role: ctx.actor.role,
    tenant,
    workspaces: user.memberships.map((x) => ({ id: x.tenantId, name: x.tenant.name, role: x.role })),
  });
});

authRouter.post("/switch", authenticate, async (req, res) => {
  const ctx = ctxOf(req);
  if (ctx.actor.type !== "user") throw badRequest("Not a user token");
  const { tenantId } = body(req, z.object({ tenantId: z.string() }));
  const m = await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId, userId: ctx.actor.id } } });
  if (!m) throw unauthorized("No access to that workspace");
  res.json({ token: signUserToken({ sub: m.userId, tid: m.tenantId, role: m.role }) });
});

/** Accept a team invite (creates the user if needed). */
authRouter.post("/invites/accept", limiter, async (req, res) => {
  const input = body(req, z.object({ token: z.string().min(10), name: z.string().min(1).max(100).optional(), password: password.optional() }));
  const invite = await prisma.invite.findUnique({ where: { tokenHash: sha256(input.token) } });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) throw badRequest("Invite is invalid or expired");
  let user = await prisma.user.findUnique({ where: { email: invite.email } });
  if (!user) {
    if (!input.password || !input.name) throw badRequest("name and password are required for new accounts");
    user = await prisma.user.create({ data: { email: invite.email, name: input.name, passwordHash: await bcrypt.hash(input.password, 12) } });
  } else if (!input.password || !(await bcrypt.compare(input.password, user.passwordHash))) {
    throw unauthorized("Enter your existing password to accept");
  }
  const m = await prisma.membership.upsert({
    where: { tenantId_userId: { tenantId: invite.tenantId, userId: user.id } },
    create: { tenantId: invite.tenantId, userId: user.id, role: invite.role },
    update: {},
  });
  await prisma.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
  res.json({ token: signUserToken({ sub: user.id, tid: m.tenantId, role: m.role }) });
});
