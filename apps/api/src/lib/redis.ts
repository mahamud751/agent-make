import { Redis } from "ioredis";
import { env } from "../config/env";

let client: Redis | null = null;

/** Shared Redis connection (BullMQ requires maxRetriesPerRequest: null). */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  }
  return client;
}
