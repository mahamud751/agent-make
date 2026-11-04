import type { OrderStatus, PaymentStatus } from "@prisma/client";
import { httpJson } from "./http";
import type { CommerceConnector, OrderDTO, ProductDTO } from "./types";
import { ConnectorError } from "./types";
import { addressBlocker, cancelBlocker, refundBlocker } from "../modules/orders/rules";

export interface WooConfig {
  siteUrl: string; // https://shop.example.com
  consumerKey: string;
  consumerSecret: string;
  webhookSecret?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUS: Record<string, OrderStatus> = {
  pending: "PENDING",
  processing: "PROCESSING",
  "on-hold": "ON_HOLD",
  completed: "DELIVERED",
  cancelled: "CANCELLED",
  refunded: "REFUNDED",
  failed: "ON_HOLD",
  shipped: "SHIPPED",
};

export function mapWooOrder(o: any): OrderDTO {
  const refunded = (o.refunds ?? []).reduce((s: number, r: any) => s + Math.abs(Number(r.total ?? 0)), 0);
  const total = Number(o.total ?? 0);
  let pay: PaymentStatus = o.date_paid ? "PAID" : "UNPAID";
  if (refunded > 0) pay = refunded >= total ? "REFUNDED" : "PARTIALLY_REFUNDED";
  const s = o.shipping ?? {};
  const meta = (k: string) => o.meta_data?.find((m: any) => m.key === k)?.value ?? null;
  return {
    id: String(o.id),
    externalId: String(o.id),
    number: String(o.number ?? o.id),
    source: "WOOCOMMERCE",
    status: STATUS[o.status] ?? "PENDING",
    paymentStatus: pay,
    currency: o.currency,
    subtotal: total - Number(o.shipping_total ?? 0),
    shippingTotal: Number(o.shipping_total ?? 0),
    total,
    refundedTotal: refunded,
    customerEmail: o.billing?.email ?? null,
    customerName: `${o.billing?.first_name ?? ""} ${o.billing?.last_name ?? ""}`.trim() || null,
    customerExternalId: o.customer_id ? String(o.customer_id) : null,
    shippingAddress: s.address_1
      ? { name: `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim(), line1: s.address_1, line2: s.address_2 || undefined, city: s.city, state: s.state, postalCode: s.postcode, country: s.country }
      : null,
    trackingNumber: meta("_tracking_number"),
    carrier: meta("_tracking_provider"),
    items: (o.line_items ?? []).map((li: any) => ({ sku: li.sku || String(li.product_id), name: li.name, quantity: li.quantity, unitPrice: Number(li.price) })),
    placedAt: o.date_created_gmt ? `${o.date_created_gmt}Z` : new Date().toISOString(),
  };
}

export function wooConnector(cfg: WooConfig): CommerceConnector {
  const auth = "Basic " + Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString("base64");
  const base = `${cfg.siteUrl.replace(/\/$/, "")}/wp-json/wc/v3`;
  const call = <T>(path: string, init: RequestInit = {}) => httpJson<T>(`${base}${path}`, { ...init, headers: { Authorization: auth } });

  return {
    type: "WOOCOMMERCE",
    async getOrderByNumber(n) {
      const clean = n.replace(/^#/, "");
      try {
        return mapWooOrder(await call<any>(`/orders/${encodeURIComponent(clean)}`));
      } catch (e) {
        if (e instanceof ConnectorError && /404/.test(e.message)) {
          const r = await call<any[]>(`/orders?search=${encodeURIComponent(clean)}&per_page=5`);
          const hit = r.find((o) => String(o.number) === clean);
          return hit ? mapWooOrder(hit) : null;
        }
        throw e;
      }
    },
    async listOrdersByEmail(email, limit = 10) {
      const r = await call<any[]>(`/orders?search=${encodeURIComponent(email)}&per_page=${limit}`);
      return r.filter((o) => o.billing?.email?.toLowerCase() === email.toLowerCase()).map(mapWooOrder);
    },
    async cancelOrder(o, reason) {
      const b = cancelBlocker(o);
      if (b) throw new ConnectorError(b);
      await call(`/orders/${o.externalId}/notes`, { method: "POST", body: JSON.stringify({ note: `Cancelled via AgentDesk: ${reason}` }) });
      return mapWooOrder(await call(`/orders/${o.externalId}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) }));
    },
    async refundOrder(o, amount, reason) {
      const b = refundBlocker(o, amount);
      if (b) throw new ConnectorError(b);
      await call(`/orders/${o.externalId}/refunds`, { method: "POST", body: JSON.stringify({ amount: amount.toFixed(2), reason, api_refund: true }) });
      return mapWooOrder(await call(`/orders/${o.externalId}`));
    },
    async updateShippingAddress(o, a) {
      const b = addressBlocker(o);
      if (b) throw new ConnectorError(b);
      const [first, ...rest] = (a.name ?? "").split(" ");
      return mapWooOrder(
        await call(`/orders/${o.externalId}`, {
          method: "PUT",
          body: JSON.stringify({ shipping: { first_name: first, last_name: rest.join(" "), address_1: a.line1, address_2: a.line2 ?? "", city: a.city, state: a.state ?? "", postcode: a.postalCode, country: a.country } }),
        }),
      );
    },
    async searchProducts(query, limit = 5) {
      const r = await call<any[]>(`/products?search=${encodeURIComponent(query)}&per_page=${limit}&status=publish`);
      return r.map((p): ProductDTO => ({
        id: String(p.id),
        sku: p.sku || String(p.id),
        name: p.name,
        description: String(p.short_description ?? "").replace(/<[^>]+>/g, "").slice(0, 300),
        price: Number(p.price ?? 0),
        currency: "USD",
        stock: p.stock_quantity ?? (p.stock_status === "instock" ? 99 : 0),
        url: p.permalink,
      }));
    },
    async getProductBySku(sku) {
      const r = await call<any[]>(`/products?sku=${encodeURIComponent(sku)}`);
      if (!r[0]) return null;
      const p = r[0];
      return { id: String(p.id), sku: p.sku, name: p.name, price: Number(p.price), currency: "USD", stock: p.stock_quantity ?? 0, url: p.permalink };
    },
  };
}
