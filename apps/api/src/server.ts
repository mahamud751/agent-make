import http from "node:http";
import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { attachRealtime } from "./realtime/socket";
import { registerJobHandlers } from "./jobs/handlers";
import { prisma } from "./lib/prisma";

registerJobHandlers(); // used when INLINE_JOBS=true (single-process mode)

const server = http.createServer(createApp());
attachRealtime(server);

server.listen(env.PORT, () => logger.info(`AgentDesk API listening on :${env.PORT} (inline jobs: ${env.INLINE_JOBS})`));

const shutdown = async () => {
  logger.info("shutting down API");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
