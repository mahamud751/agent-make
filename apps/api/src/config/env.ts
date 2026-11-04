import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  PUBLIC_API_URL: z.string().default("http://localhost:4000"),
  DASHBOARD_URL: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  // 32-byte key, base64 encoded — encrypts integration credentials at rest
  ENCRYPTION_KEY: z.string().min(40),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEFAULT_MODEL: z.string().default("claude-opus-5-5"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_STARTER: z.string().optional(),
  STRIPE_PRICE_GROWTH: z.string().optional(),
  // shared secret for inbound email provider (Postmark/SendGrid/Mailgun parse webhooks)
  INBOUND_EMAIL_SECRET: z.string().optional(),
  // Process AI replies inline (no Redis worker). Handy for local dev & tests.
  INLINE_JOBS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.string().default("info"),
  WIDGET_DIST_DIR: z.string().optional(),
  PLATFORM_ADMIN_EMAILS: z.string().default(""),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);
