import type { OrderStatus, PaymentStatus } from "@prisma/client";
import { httpJson } from "./http";
import type { Address, CommerceConnector, OrderDTO, ProductDTO } from "./types";
import { ConnectorError } from "./types";
import { addressBlocker, cancelBlocker, refundBlocker } from "../modules/orders/rules";

export interface ShopifyConfig {
  shopDomain: string; // my-store.myshopify.com
  accessToken: string; // Admin API access token
  apiVersion?: string;
  webhookSecret?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapShopifyOrder(o: any): OrderDTO {
  const fin: Record<string, PaymentStatus> = {
    paid: "PAID",
    partially_refunded: "PARTIALLY_REFUNDED",
    refunded: "REFUNDED",
    pending: "UNPAID",
    authorized: "UNPAID",
    voided: "FAILED",
  };
  let status: OrderStatus = "CONFIRMED";
  if (o.cancelled_at) status = "CANCELLED";
  else if (o.financial_status === "refunded") status = "REFUNDED";
  else if (o.fulfillment_status === "fulfilled") status = "SHIPPED";
  else if (o.fulfillment_status === "partial") status = "PROCESSING";
  const f = o.fulfillments?.[0];
  const a = o.shipping_address;
  const refunded = (o.refunds ?? []).reduce(
    (s: number, r: any) => s + (r.transactions ?? []).reduce((t: number, x: any) => t + Number(x.amount ?? 0), 0),
    0,
  );
  return {
    id: String(o.id),
    externalId: String(o.id),
    number: String(o.order_number ?? o.name).replace(/^#/, ""),
    source: "SHOPIFY",
    status,
    paymentStatus: fin[o.financial_status] ?? "UNPAID",
    currency: o.currency,
    subtotal: Number(o.subtotal_price ?? 0),
    shippingTotal: Number(o.total_shipping_price_set?.shop_money?.amount ?? 0),
    total: Number(o.total_price ?? 0),
    refundedTotal: refunded,
    customerEmail: o.email ?? o.customer?.email ?? null,
    customerName: o.customer ? `${o.customer.first_name ?? ""} ${o.customer.last_name ?? ""}`.trim() : null,
    customerExternalId: o.customer?.id ? String(o.customer.id) : null,
    shippingAddress: a
      ? { name: a.name, line1: a.address1, line2: a.address2 ?? undefined, city: a.city, state: a.province_code ?? a.province, postalCode: a.zip, country: a.country_code ?? a.country, phone: a.phone ?? undefined }
      : null,
    trackingNumber: f?.tracking_number ?? null,
    carrier: f?.tracking_company ?? null,
    items: (o.line_items ?? []).map((li: any) => ({ sku: li.sku ?? String(li.variant_id), name: li.name, quantity: li.quantity, unitPrice: Number(li.price) })),
    placedAt: o.created_at ?? new Date().toISOString(),
  };
}

export function shopifyConnector(cfg: ShopifyConfig): CommerceConnector {
  const base = `https://${cfg.shopDomain}/admin/api/${cfg.apiVersion ?? "2025-10"}`;
  const call = <T>(path: string, init: RequestInit = {}) =>
    httpJson<T>(`${base}${path}`, { ...init, headers: { "X-Shopify-Access-Token": cfg.accessToken } });
  const fetchOrder = async (id: string) => mapShopifyOrder((await call<any>(`/orders/${id}.json`)).order);

  return {
    type: "SHOPIFY",
    async getOrderByNumber(n) {
      const r = await call<any>(`/orders.json?status=any&name=${encodeURIComponent("#" + n.replace(/^#/, ""))}`);
      return r.orders?.[0] ? mapShopifyOrder(r.orders[0]) : null;
    },
    async listOrdersByEmail(email, limit = 10) {
      const r = await call<any>(`/orders.json?status=any&limit=${limit}&email=${encodeURIComponent(email)}`);
      return (r.orders ?? []).map(mapShopifyOrder);
    },
    async cancelOrder(o, reason) {
      const b = cancelBlocker(o);
      if (b) throw new ConnectorError(b);
      await call(`/orders/${o.externalId}/cancel.json`, { method: "POST", body: JSON.stringify({ reason: "customer", email: true, note: reason }) });
      return fetchOrder(o.externalId!);
    },
    async refundOrder(o, amount, reason) {
      const b = refundBlocker(o, amount);
      if (b) throw new ConnectorError(b);
      const tx = await call<any>(`/orders/${o.externalId}/transactions.json`);
      const parent = (tx.transactions ?? []).find((t: any) => (t.kind === "sale" || t.kind === "capture") && t.status === "success");
      if (!parent) throw new ConnectorError("No captured transaction found to refund");
      await call(`/orders/${o.externalId}/refunds.json`, {
        method: "POST",
        body: JSON.stringify({
          refund: { note: reason, notify: true, transactions: [{ parent_id: parent.id, amount: amount.toFixed(2), kind: "refund", gateway: parent.gateway }] },
        }),
      });
      return fetchOrder(o.externalId!);
    },
    async updateShippingAddress(o, a: Address) {
      const b = addressBlocker(o);
      if (b) throw new ConnectorError(b);
      await call(`/orders/${o.externalId}.json`, {
        method: "PUT",
        body: JSON.stringify({
          order: { id: o.externalId, shipping_address: { name: a.name, address1: a.line1, address2: a.line2, city: a.city, province: a.state, zip: a.postalCode, country: a.country, phone: a.phone } },
        }),
      });
      return fetchOrder(o.externalId!);
    },
    async searchProducts(query, limit = 5) {
      const r = await call<any>(`/products.json?limit=50&status=active&fields=id,title,body_html,handle,variants`);
      const q = query.toLowerCase();
      return (r.products ?? [])
        .filter((p: any) => `${p.title} ${p.body_html ?? ""}`.toLowerCase().includes(q) || q.split(/\s+/).some((t) => p.title.toLowerCase().includes(t)))
        .slice(0, limit)
        .map((p: any): ProductDTO => ({
          id: String(p.id),
          sku: p.variants?.[0]?.sku ?? String(p.id),
          name: p.title,
          description: String(p.body_html ?? "").replace(/<[^>]+>/g, "").slice(0, 300),
          price: Number(p.variants?.[0]?.price ?? 0),
          currency: "USD",
          stock: p.variants?.reduce((s: number, v: any) => s + (v.inventory_quantity ?? 0), 0) ?? 0,
          url: `https://${cfg.shopDomain}/products/${p.handle}`,
        }));
    },
    async getProductBySku(sku) {
      const found = await this.searchProducts(sku, 50);
      return found.find((p) => p.sku === sku) ?? null;
    },
  };
}
