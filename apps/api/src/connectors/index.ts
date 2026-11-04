import type { Integration } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { decryptJson } from "../lib/crypto";
import { nativeConnector } from "./native";
import { shopifyConnector, type ShopifyConfig } from "./shopify";
import { wooConnector, type WooConfig } from "./woocommerce";
import { customWebhookConnector, type CustomWebhookConfig } from "./customWebhook";
import type { CommerceConnector } from "./types";

export function buildConnector(tenantId: string, integration: Integration | null): CommerceConnector {
  if (!integration || integration.type === "NATIVE") return nativeConnector(tenantId);
  const cfg = decryptJson(integration.configEncrypted);
  switch (integration.type) {
    case "SHOPIFY":
      return shopifyConnector(cfg as unknown as ShopifyConfig);
    case "WOOCOMMERCE":
      return wooConnector(cfg as unknown as WooConfig);
    case "CUSTOM_WEBHOOK":
      return customWebhookConnector(cfg as unknown as CustomWebhookConfig);
  }
}

/** The tenant's primary commerce backend: the first active external integration, else native. */
export async function getConnector(tenantId: string): Promise<CommerceConnector> {
  const integration = await prisma.integration.findFirst({
    where: { tenantId, active: true, type: { not: "NATIVE" } },
    orderBy: { createdAt: "asc" },
  });
  return buildConnector(tenantId, integration);
}
