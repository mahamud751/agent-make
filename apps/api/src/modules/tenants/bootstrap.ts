import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { randomToken, sha256 } from "../../lib/crypto";

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "store";

export async function uniqueSlug(base: string) {
  const s = slugify(base);
  for (let i = 0; i < 20; i++) {
    const candidate = i ? `${s}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}` : s;
    if (!(await prisma.tenant.findUnique({ where: { slug: candidate } }))) return candidate;
  }
  return `${s}-${Date.now()}`;
}

export function generateApiKey(kind: "SECRET" | "PUBLISHABLE") {
  const raw = `${kind === "SECRET" ? "sk" : "pk"}_live_${randomToken(24)}`;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 12) };
}

/** Everything a brand-new tenant needs to work out of the box. */
export async function bootstrapTenant(tx: Prisma.TransactionClient, tenantId: string, storeName: string) {
  await tx.agent.create({
    data: {
      tenantId,
      name: "Ava",
      isDefault: true,
      persona: `A friendly, efficient support assistant for ${storeName}. Warm but brief; solves problems in as few messages as possible.`,
      greeting: `Hi! I'm Ava from ${storeName}. I can track orders, change addresses, handle returns and answer questions. How can I help?`,
      toolPolicies: { cancel_order: "APPROVAL", request_refund: "APPROVAL", update_shipping_address: "AUTO", create_order: "DISABLED" },
      guardrails: { maxRefundAmount: 50, handoffKeywords: ["lawyer", "chargeback", "speak to a human"] },
    },
  });
  await tx.knowledgeArticle.createMany({
    data: [
      { tenantId, title: "Shipping policy", content: "Orders ship within 1-2 business days. Standard delivery takes 3-7 business days. You'll get a tracking number by email once your order ships.", tags: ["shipping"] },
      { tenantId, title: "Returns & refunds", content: "Unused items can be returned within 30 days of delivery for a full refund. Damaged or wrong items are refunded or replaced at no cost. Refunds reach the original payment method within 5-10 business days.", tags: ["returns", "refunds"] },
      { tenantId, title: "Order changes & cancellations", content: "Orders can be cancelled or have their shipping address changed until they ship. After shipping, please wait for delivery and start a return.", tags: ["orders"] },
    ],
  });
  const pk = generateApiKey("PUBLISHABLE");
  await tx.apiKey.create({ data: { tenantId, name: "Website widget", kind: "PUBLISHABLE", prefix: pk.prefix, keyHash: pk.hash } });
  return { publishableKey: pk.raw };
}
