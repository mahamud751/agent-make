import { env } from "../config/env";
import { getRedis } from "../lib/redis";
import { logger } from "../lib/logger";

export const REALTIME_CHANNEL = "agentdesk:realtime";

type LocalSink = (room: string, event: string, payload: unknown) => void;
let localSink: LocalSink | null = null;

/** The API process registers its socket.io server here. */
export const setLocalSink = (s: LocalSink) => {
  localSink = s;
};

export const rooms = {
  tenant: (tenantId: string) => `tenant:${tenantId}`,
  conversation: (conversationId: string) => `conv:${conversationId}`,
};

/**
 * Publish to a room. Workers have no sockets, so we always fan out via Redis pub/sub; every API
 * pod relays to its own connected clients. In inline mode (single process) deliver directly.
 */
export async function publish(room: string, event: string, payload: unknown) {
  if (env.INLINE_JOBS || env.NODE_ENV === "test") {
    localSink?.(room, event, payload);
    return;
  }
  try {
    await getRedis().publish(REALTIME_CHANNEL, JSON.stringify({ room, event, payload }));
  } catch (err) {
    logger.warn({ err }, "realtime publish failed");
  }
}
