import { httpJson } from "./http";
import { signPayload } from "../lib/crypto";
import type { CommerceConnector, OrderDTO, ProductDTO } from "./types";

export interface CustomWebhookConfig {
  endpointUrl: string; // the tenant's RPC endpoint, e.g. https://api.mysite.com/agentdesk
  signingSecret: string; // we sign every call; the site verifies with our SDK helper
  headers?: Record<string, string>;
}

/**
 * Bring-your-own-backend. AgentDesk POSTs `{ action, params }` to one endpoint on the client's
 * website; the site answers with normalised JSON. See docs/INTEGRATION.md for the contract.
 *
 *   order.get            { number }                 -> { order: OrderDTO | null }
 *   orders.by_email      { email, limit }           -> { orders: OrderDTO[] }
 *   order.cancel         { number, reason }         -> { order }
 *   order.refund         { number, amount, reason } -> { order }
 *   order.update_address { number, address }        -> { order }
 *   products.search      { query, limit }           -> { products: ProductDTO[] }
 *   product.get          { sku }                    -> { product: ProductDTO | null }
 *   order.create         { customer, items, ... }   -> { order }
 */
export function customWebhookConnector(cfg: CustomWebhookConfig): CommerceConnector {
  const rpc = async <T>(action: string, params: Record<string, unknown>) => {
    const body = JSON.stringify({ action, params, sentAt: new Date().toISOString() });
    return httpJson<T>(cfg.endpointUrl, {
      method: "POST",
      body,
      headers: { ...(cfg.headers ?? {}), "X-AgentDesk-Signature": signPayload(cfg.signingSecret, body) },
    });
  };
  const withSource = (o: OrderDTO): OrderDTO => ({ ...o, source: "CUSTOM_WEBHOOK" });

  return {
    type: "CUSTOM_WEBHOOK",
    async getOrderByNumber(number) {
      const r = await rpc<{ order: OrderDTO | null }>("order.get", { number });
      return r.order ? withSource(r.order) : null;
    },
    async listOrdersByEmail(email, limit = 10) {
      return (await rpc<{ orders: OrderDTO[] }>("orders.by_email", { email, limit })).orders.map(withSource);
    },
    async cancelOrder(o, reason, actor) {
      return withSource((await rpc<{ order: OrderDTO }>("order.cancel", { number: o.number, reason, actor })).order);
    },
    async refundOrder(o, amount, reason, actor) {
      return withSource((await rpc<{ order: OrderDTO }>("order.refund", { number: o.number, amount, reason, actor })).order);
    },
    async updateShippingAddress(o, address, actor) {
      return withSource((await rpc<{ order: OrderDTO }>("order.update_address", { number: o.number, address, actor })).order);
    },
    async searchProducts(query, limit = 5) {
      return (await rpc<{ products: ProductDTO[] }>("products.search", { query, limit })).products;
    },
    async getProductBySku(sku) {
      return (await rpc<{ product: ProductDTO | null }>("product.get", { sku })).product;
    },
    async createOrder(input, actor) {
      return withSource((await rpc<{ order: OrderDTO }>("order.create", { ...input, actor })).order);
    },
  };
}
