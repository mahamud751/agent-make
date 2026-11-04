import { Worker } from "bullmq";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { getRedis } from "./lib/redis";
import { prisma } from "./lib/prisma";
import { QUEUE_NAME, getFailureHandler, getHandler, type JobName } from "./jobs/queues";
import { registerJobHandlers } from "./jobs/handlers";

registerJobHandlers();

/**
 * Background worker. Scale horizontally: run N replicas; BullMQ distributes jobs and the
 * per-conversation Redis lock prevents two workers answering the same chat simultaneously.
 */
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const handler = getHandler(job.name as JobName);
    if (!handler) throw new Error(`No handler for ${job.name}`);
    return handler(job.data as never);
  },
  { connection: getRedis(), concurrency: Number(process.env.WORKER_CONCURRENCY ?? 20) },
);

worker.on("failed", async (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, attempts: job?.attemptsMade, err: err.message }, "job failed");
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await getFailureHandler(job.name as JobName)?.(job.data as never).catch((e) => logger.error({ err: e }, "failure handler failed"));
  }
});
worker.on("completed", (job) => logger.debug({ jobId: job.id, name: job.name }, "job completed"));
logger.info(`AgentDesk worker started (concurrency ${worker.opts.concurrency}, redis ${env.REDIS_URL.replace(/\/\/.*@/, "//***@")})`);

const shutdown = async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
