import { prisma } from "../lib/prisma";
import { orderService } from "../modules/orders/service";
import type { CommerceConnector, ProductDTO } from "./types";
import type { Product } from "@prisma/client";

const productDTO = (p: Product): ProductDTO => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  description: p.description,
  price: Number(p.price),
  currency: p.currency,
  stock: p.stock,
});

/** Orders and catalogue stored in AgentDesk itself (pushed by the tenant's site via REST API). */
export function nativeConnector(tenantId: string): CommerceConnector {
  return {
    type: "NATIVE",
    getOrderByNumber: (n) => orderService.getByNumber(tenantId, n),
    listOrdersByEmail: (e, limit) => orderService.listByEmail(tenantId, e, limit),
    cancelOrder: (o, reason, actor) => orderService.cancel(tenantId, o.number, reason, actor),
    refundOrder: (o, amount, reason, actor) => orderService.refund(tenantId, o.number, amount, reason, actor),
    updateShippingAddress: (o, a, actor) => orderService.updateAddress(tenantId, o.number, a, actor),
    async searchProducts(query, limit = 5) {
      const terms = query.split(/\s+/).filter(Boolean).slice(0, 6);
      const rows = await prisma.product.findMany({
        where: {
          tenantId,
          active: true,
          OR: terms.flatMap((t) => [
            { name: { contains: t, mode: "insensitive" as const } },
            { description: { contains: t, mode: "insensitive" as const } },
            { sku: { equals: t, mode: "insensitive" as const } },
          ]),
        },
        take: limit,
      });
      return rows.map(productDTO);
    },
    async getProductBySku(sku) {
      const p = await prisma.product.findFirst({ where: { tenantId, sku } });
      return p ? productDTO(p) : null;
    },
    createOrder: (input, actor) => orderService.create(tenantId, input, actor),
  };
}
