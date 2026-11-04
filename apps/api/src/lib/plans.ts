import type { PlanTier } from "@prisma/client";

export interface PlanLimits {
  aiRepliesPerMonth: number;
  agents: number;
  seats: number;
  integrations: number;
  channels: string[];
  automations: boolean;
  approvals: boolean;
  priceUsd: number;
}

export const PLANS: Record<PlanTier, PlanLimits> = {
  FREE: { aiRepliesPerMonth: 200, agents: 1, seats: 2, integrations: 1, channels: ["WEB_WIDGET", "API"], automations: false, approvals: true, priceUsd: 0 },
  STARTER: { aiRepliesPerMonth: 3_000, agents: 2, seats: 5, integrations: 2, channels: ["WEB_WIDGET", "API", "EMAIL"], automations: true, approvals: true, priceUsd: 49 },
  GROWTH: { aiRepliesPerMonth: 20_000, agents: 10, seats: 25, integrations: 10, channels: ["WEB_WIDGET", "API", "EMAIL", "WHATSAPP", "MESSENGER", "SMS"], automations: true, approvals: true, priceUsd: 199 },
  ENTERPRISE: { aiRepliesPerMonth: 1_000_000, agents: 1000, seats: 1000, integrations: 1000, channels: ["WEB_WIDGET", "API", "EMAIL", "WHATSAPP", "MESSENGER", "SMS"], automations: true, approvals: true, priceUsd: 0 },
};

export const currentPeriod = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
