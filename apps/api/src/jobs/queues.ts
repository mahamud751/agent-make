import { Queue } from "bullmq";
import { env } from "../config/env";
import { getRedis } from "../lib/redis";
import { logger } from "../lib/logger";

export type JobName = "agent.reply" | "webhook.deliver" | "automation.run" | "action.execute" | "email.send" | "whatsapp.send";

export interface JobPayloads {
  "agent.reply": { conversationId: string; messageId: string };
  "webhook.deliver": { deliveryId: string };
  "automation.run": { tenantId: string; event: string; data: Record<string, unknown> };
  "action.execute": { actionId: string; userId: string };
  "email.send": { tenantId: string; to: string; subject: string; text: string; conversationId?: string };
  "whatsapp.send": { tenantId: string; to: string; text: string };
}

type Handler<N extends JobName> = (data: JobPayloads[N]) => Promise<unknown>;
const handlers: Partial<{ [N in JobName]: Handler<N> }> = {};

export function registerHandler<N extends JobName>(name: N, h: Handler<N>) {
  (handlers as Record<string, unknown>)[name] = h;
}
export const getHandler = <N extends JobName>(name: N) => handlers[name] as Handler<N> | undefined;

export const QUEUE_NAME = "agentdesk";
let queue: Queue | null = null;
const getQueue = () => (queue ??= new Queue(QUEUE_NAME, { connection: getRedis() }));

const pending = new Set<Promise<unknown>>();

/**
 * Enqueue background work. Production: BullMQ (retries w/ exponential backoff, horizontally
 * scalable workers). INLINE_JOBS=true: run in-process — no Redis needed for local dev/tests.
 */
export async function enqueue<N extends JobName>(name: N, data: JobPayloads[N], opts: { jobId?: string; delayMs?: number } = {}) {
  if (env.INLINE_JOBS || env.NODE_ENV === "test") {
    const h = getHandler(name);
    if (!h) return;
    const p = (async () => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, Math.min(opts.delayMs!, 50)));
      await h(data);
    })()
      .catch((err) => logger.error({ err, name }, "inline job failed"))
      .finally(() => pending.delete(p));
    pending.add(p);
    return;
  }
  await getQueue().add(name, data, {
    jobId: opts.jobId,
    delay: opts.delayMs,
    attempts: name === "webhook.deliver" ? 8 : 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
  });
}

/** Test helper: wait for inline jobs (including jobs they enqueue) to settle. */
export async function drainInlineJobs() {
  while (pending.size) await Promise.allSettled([...pending]);
}
