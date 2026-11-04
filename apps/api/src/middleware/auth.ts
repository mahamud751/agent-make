import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { sha256 } from "../lib/crypto";
import { forbidden, unauthorized } from "../lib/errors";
import type { RequestContext } from "../types";

interface JwtPayload {
  sub: string; // user id
  tid: string; // active tenant id
  role: Role;
}

export const signUserToken = (p: JwtPayload) => jwt.sign(p, env.JWT_SECRET, { expiresIn: "7d" });

export function ctxOf(req: Request): RequestContext {
  if (!req.ctx) throw unauthorized();
  return req.ctx;
}

async function fromApiKey(raw: string, req: Request): Promise<RequestContext | null> {
  const key = await prisma.apiKey.findUnique({ where: { keyHash: sha256(raw) } });
  if (!key || key.revokedAt) return null;
  if (key.kind === "PUBLISHABLE") {
    const origin = req.headers.origin;
    if (key.allowedOrigins.length && (!origin || !key.allowedOrigins.includes(origin))) {
      throw forbidden("Origin not allowed for this key");
    }
  }
  // fire-and-forget usage stamp
  prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { tenantId: key.tenantId, actor: { type: "api_key", id: key.id, kind: key.kind } };
}

/**
 * Resolves the caller:
 *  - `Authorization: Bearer <jwt>`         dashboard users
 *  - `Authorization: Bearer sk_...|pk_...` API keys (also accepted via `x-api-key`)
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = (req.headers["x-api-key"] as string | undefined) ?? bearer;
  if (!token) throw unauthorized();

  if (token.startsWith("sk_") || token.startsWith("pk_")) {
    const ctx = await fromApiKey(token, req);
    if (!ctx) throw unauthorized("Invalid API key");
    req.ctx = ctx;
    return next();
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    throw unauthorized("Invalid or expired token");
  }
  // Re-check membership so removed users lose access immediately.
  const m = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId: payload.tid, userId: payload.sub } },
  });
  if (!m) throw unauthorized("Membership revoked");
  req.ctx = { tenantId: m.tenantId, actor: { type: "user", id: m.userId, role: m.role } };
  next();
}

const RANK: Record<Role, number> = { VIEWER: 0, SUPPORT: 1, ADMIN: 2, OWNER: 3 };

/**
 * Authorisation guard. Users need at least `minRole`; secret API keys act as ADMIN;
 * publishable keys are rejected (they only reach /v1/widget).
 */
export const requireRole = (minRole: Role) => (req: Request, _res: Response, next: NextFunction) => {
  const { actor } = ctxOf(req);
  if (actor.type === "api_key") {
    if (actor.kind !== "SECRET") throw forbidden("Publishable keys cannot access this endpoint");
    if (RANK[minRole] > RANK.ADMIN) throw forbidden();
    return next();
  }
  if (RANK[actor.role] < RANK[minRole]) throw forbidden(`Requires ${minRole} role`);
  next();
};

export const actorLabel = (ctx: RequestContext) =>
  ctx.actor.type === "user" ? `user:${ctx.actor.id}` : `api_key:${ctx.actor.id}`;
