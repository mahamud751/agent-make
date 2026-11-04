import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { Redis } from "ioredis";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { sha256 } from "../lib/crypto";
import { logger } from "../lib/logger";
import { REALTIME_CHANNEL, rooms, setLocalSink } from "./publisher";

/**
 * Two kinds of clients:
 *  - dashboard users:  auth { token: <jwt> }                -> joins tenant room
 *  - widget visitors:  auth { visitorToken, conversationId } -> joins that conversation room only
 */
export function attachRealtime(server: HttpServer) {
  const io = new Server(server, { cors: { origin: true, credentials: true }, path: "/realtime" });

  io.use(async (socket, next) => {
    try {
      const { token, visitorToken, conversationId } = socket.handshake.auth as Record<string, string | undefined>;
      if (token) {
        const p = jwt.verify(token, env.JWT_SECRET) as { sub: string; tid: string };
        const m = await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId: p.tid, userId: p.sub } } });
        if (!m) return next(new Error("unauthorized"));
        await socket.join(rooms.tenant(p.tid));
        return next();
      }
      if (visitorToken && conversationId) {
        const c = await prisma.conversation.findUnique({ where: { visitorTokenHash: sha256(visitorToken) } });
        if (!c || c.id !== conversationId) return next(new Error("unauthorized"));
        await socket.join(rooms.conversation(c.id));
        return next();
      }
      next(new Error("unauthorized"));
    } catch {
      next(new Error("unauthorized"));
    }
  });

  setLocalSink((room, event, payload) => io.to(room).emit(event, payload));

  if (!env.INLINE_JOBS && env.NODE_ENV !== "test") {
    const sub = new Redis(env.REDIS_URL);
    sub.subscribe(REALTIME_CHANNEL).catch((err) => logger.error({ err }, "realtime subscribe failed"));
    sub.on("message", (_ch, raw) => {
      try {
        const { room, event, payload } = JSON.parse(raw);
        io.to(room).emit(event, payload);
      } catch {
        /* ignore malformed */
      }
    });
  }
  return io;
}
