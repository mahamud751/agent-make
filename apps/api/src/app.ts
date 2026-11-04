import express, { type Request } from "express";
import path from "node:path";
import helmet from "helmet";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger";
import { authenticate } from "./middleware/auth";
import { rateLimit } from "./middleware/rateLimit";
import { errorHandler } from "./middleware/errorHandler";
import { authRouter } from "./routes/auth";
import { workspaceRouter } from "./routes/workspace";
import { commerceRouter } from "./routes/commerce";
import { conversationsRouter } from "./routes/conversations";
import { widgetRouter } from "./routes/widget";
import { inboundRouter } from "./routes/inbound";
import { billingRouter, stripeWebhookRouter } from "./routes/billing";
import { analyticsRouter } from "./routes/analytics";
import { platformRouter } from "./routes/platform";
import { prisma } from "./lib/prisma";
import { env } from "./config/env";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  // Widget endpoints are called from customers' websites; origin checks happen per publishable key.
  app.use(cors({ origin: true, credentials: false, maxAge: 86400 }));
  // keep the raw body for webhook signature verification
  app.use(
    express.json({
      limit: "2mb",
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf.toString("utf8");
      },
    }),
  );
  if (env.NODE_ENV !== "test") app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));

  app.get("/health", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  });

  // Embeddable widget bundle: <script src="https://api.example.com/agentdesk.js">
  app.use(express.static(env.WIDGET_DIST_DIR ?? path.resolve(process.cwd(), "../widget/dist"), { maxAge: "1h", index: false }));

  // Public (signature-verified) webhooks
  app.use("/v1/inbound", rateLimit({ prefix: "inbound", windowSec: 60, max: 2000 }), inboundRouter);
  app.use("/v1/billing/webhooks", stripeWebhookRouter);

  // Auth
  app.use("/v1/auth", authRouter);

  // Everything below is authenticated and tenant-scoped
  app.use("/v1", authenticate);
  app.use("/v1/widget", widgetRouter);
  app.use("/v1/platform", platformRouter);
  app.use("/v1", rateLimit({ prefix: "api", windowSec: 60, max: 1200 }));
  app.use("/v1", workspaceRouter, commerceRouter, conversationsRouter, billingRouter, analyticsRouter);

  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
  app.use(errorHandler);
  return app;
}
