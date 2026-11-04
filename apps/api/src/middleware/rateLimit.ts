import type { NextFunction, Request, Response } from "express";
import { getRedis } from "../lib/redis";
import { tooMany } from "../lib/errors";
import { env } from "../config/env";
import { logger } from "../lib/logger";

const memory = new Map<string, { count: number; reset: number }>();

/**
 * Fixed-window limiter keyed by tenant (or IP for anonymous calls).
 * Uses Redis so limits hold across horizontally scaled API pods; falls back to memory.
 */
export const rateLimit = (opts: { windowSec: number; max: number; prefix: string }) =>
  async (req: Request, res: Response, next: NextFunction) => {
    const id = req.ctx?.tenantId ?? req.ip ?? "anon";
    const bucket = Math.floor(Date.now() / 1000 / opts.windowSec);
    const key = `rl:${opts.prefix}:${id}:${bucket}`;
    let count: number;
    if (env.INLINE_JOBS || env.NODE_ENV === "test") {
      const e = memory.get(key) ?? { count: 0, reset: Date.now() + opts.windowSec * 1000 };
      e.count++;
      memory.set(key, e);
      count = e.count;
    } else {
      try {
        const r = getRedis();
        count = await r.incr(key);
        if (count === 1) await r.expire(key, opts.windowSec);
      } catch (err) {
        logger.warn({ err }, "rate limiter unavailable, allowing request");
        return next();
      }
    }
    res.setHeader("X-RateLimit-Limit", opts.max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, opts.max - count));
    if (count > opts.max) throw tooMany();
    next();
  };
