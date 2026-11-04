import { z } from "zod";
import type { ActionPolicy } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { conversationService } from "../../modules/conversations/service";
import { searchKnowledge } from "../../modules/knowledge/search";
import type { OrderDTO } from "../../connectors/types";
import { ConnectorError } from "../../connectors/types";
import { AppError } from "../../lib/errors";
import { addressBlocker, cancelBlocker, refundBlocker, round2 } from "../../modules/orders/rules";
import { defineTool, fail, ok, type ToolContext, type ToolDef, type ToolResult } from "./types";

const MAX_VERIFY_ATTEMPTS = 5;

const orderNumber = z.string().min(1).max(64).describe("Order number as the customer sees it, e.g. 1042 or #1042");

/** What the model is allowed to see about an order. */
const publicOrder = (o: OrderDTO) => ({
  number: o.number,
  status: o.status,
  paymentStatus: o.paymentStatus,
  total: `${o.total.toFixed(2)} ${o.currency}`,
  refunded: o.refundedTotal ? `${o.refundedTotal.toFixed(2)} ${o.currency}` : undefined,
  placedAt: o.placedAt,
  items: o.items.map((i) => `${i.quantity} × ${i.name} (${i.sku})`),
  shippingAddress: o.shippingAddress ?? undefined,
  tracking: o.trackingNumber ? { number: o.trackingNumber, carrier: o.carrier } : undefined,
});

/**
 * Ownership check. The agent may only discuss / modify an order when the customer in this
 * conversation has proven they own it (verified email matches the order email).
 */
async function loadOwnedOrder(ctx: ToolContext, number: string): Promise<OrderDTO | string> {
  const order = await ctx.connector.getOrderByNumber(number.replace(/^#/, "").trim());
  if (!order) return `No order found with number ${number}.`;
  const verified = ctx.conversation.verifiedEmail?.toLowerCase();
  if (!verified) return "IDENTITY_NOT_VERIFIED: ask the customer for the email address used on the order, then call verify_customer.";
  if (order.customerEmail?.toLowerCase() !== verified) return "This order does not belong to the verified customer. Do not share any details about it.";
  return order;
}

const addressSchema = z.object({
  name: z.string().max(120).optional(),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().max(100).optional(),
  postalCode: z.string().min(1).max(20),
  country: z.string().min(2).max(56),
  phone: z.string().max(40).optional(),
});

const addressJsonSchema = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    line1: { type: "string" },
    line2: { type: "string" },
    city: { type: "string" },
    state: { type: "string" },
    postalCode: { type: "string" },
    country: { type: "string", description: "ISO country code or name" },
    phone: { type: "string" },
  },
  required: ["line1", "city", "postalCode", "country"],
  additionalProperties: false,
};

export const TOOLS: ToolDef[] = [
  defineTool({
    name: "verify_customer",
    description:
      "Verify the customer's identity before discussing or changing any order. Requires an order number and the email address used on that order. On success the customer stays verified for this conversation.",
    schema: z.object({ order_number: orderNumber, email: z.string().email() }),
    inputSchema: {
      type: "object",
      properties: { order_number: { type: "string" }, email: { type: "string", description: "Email used at checkout" } },
      required: ["order_number", "email"],
      additionalProperties: false,
    },
    defaultPolicy: "AUTO",
    async run(ctx, input) {
      if (ctx.conversation.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        return fail("Too many failed verification attempts. Offer to connect the customer with a human (escalate_to_human).");
      }
      const order = await ctx.connector.getOrderByNumber(input.order_number.replace(/^#/, "").trim());
      const match = order && order.customerEmail?.toLowerCase() === input.email.toLowerCase();
      if (!match) {
        const c = await prisma.conversation.update({ where: { id: ctx.conversation.id }, data: { verifyAttempts: { increment: 1 } } });
        ctx.conversation.verifyAttempts = c.verifyAttempts;
        // identical message for "no such order" and "wrong email" so order numbers can't be enumerated
        return fail("Verification failed: that order number and email don't match our records. Ask the customer to double-check both.");
      }
      const email = input.email.toLowerCase();
      const customer = await conversationService.findOrCreateCustomer(ctx.tenantId, { email, name: order.customerName ?? undefined });
      await prisma.conversation.update({ where: { id: ctx.conversation.id }, data: { verifiedEmail: email, customerId: customer?.id } });
      ctx.conversation.verifiedEmail = email;
      return ok({ verified: true, customerName: order.customerName });
    },
  }),
  defineTool({
    name: "get_order",
    description: "Get status, items, shipping address and tracking for one of the verified customer's orders.",
    schema: z.object({ order_number: orderNumber }),
    inputSchema: { type: "object", properties: { order_number: { type: "string" } }, required: ["order_number"], additionalProperties: false },
    defaultPolicy: "AUTO",
    async run(ctx, input) {
      const o = await loadOwnedOrder(ctx, input.order_number);
      return typeof o === "string" ? fail(o) : ok(publicOrder(o));
    },
  }),
  defineTool({
    name: "list_customer_orders",
    description: "List the verified customer's recent orders.",
    schema: z.object({ limit: z.number().int().min(1).max(20).optional() }),
    inputSchema: { type: "object", properties: { limit: { type: "integer" } }, additionalProperties: false },
    defaultPolicy: "AUTO",
    async run(ctx, input) {
      if (!ctx.conversation.verifiedEmail) return fail("IDENTITY_NOT_VERIFIED: ask for an order number and the email used on it, then call verify_customer.");
      const orders = await ctx.connector.listOrdersByEmail(ctx.conversation.verifiedEmail, input.limit ?? 5);
      return ok(orders.map(publicOrder));
    },
  }),
  defineTool({
    name: "cancel_order",
    description: "Cancel one of the verified customer's orders that has not shipped yet. Paid orders are refunded in full. Confirm with the customer before calling.",
    schema: z.object({ order_number: orderNumber, reason: z.string().min(2).max(500) }),
    inputSchema: {
      type: "object",
      properties: { order_number: { type: "string" }, reason: { type: "string", description: "Customer's reason for cancelling" } },
      required: ["order_number", "reason"],
      additionalProperties: false,
    },
    defaultPolicy: "APPROVAL",
    async precheck(ctx, input) {
      const o = await loadOwnedOrder(ctx, input.order_number);
      return typeof o === "string" ? o : cancelBlocker(o);
    },
    async run(ctx, input) {
      const o = await loadOwnedOrder(ctx, input.order_number);
      if (typeof o === "string") return fail(o);
      const updated = await ctx.connector.cancelOrder(o, input.reason, ctx.actor);
      return ok(publicOrder(updated), `Order #${updated.number} has been cancelled.`);
    },
  }),
  defineTool({
    name: "request_refund",
    description: "Refund all or part of a paid order for the verified customer — for example a damaged or missing item. Omit amount for a full refund of the remaining balance.",
    schema: z.object({ order_number: orderNumber, amount: z.number().positive().optional(), reason: z.string().min(2).max(500) }),
    inputSchema: {
      type: "object",
      properties: {
        order_number: { type: "string" },
        amount: { type: "number", description: "Amount in the order currency. Omit for the full remaining amount." },
        reason: { type: "string" },
      },
      required: ["order_number", "reason"],
      additionalProperties: false,
    },
    defaultPolicy: "APPROVAL",
    forceApproval: (ctx, input) => ctx.guardrails.maxRefundAmount !== undefined && (input.amount ?? Infinity) > ctx.guardrails.maxRefundAmount,
    async precheck(ctx, input) {
      const o = await loadOwnedOrder(ctx, input.order_number);
      if (typeof o === "string") return o;
      return refundBlocker(o, input.amount ?? round2(o.total - o.refundedTotal));
    },
    async run(ctx, input) {
      const o = await loadOwnedOrder(ctx, input.order_number);
      if (typeof o === "string") return fail(o);
      const amount = input.amount ?? round2(o.total - o.refundedTotal);
      const updated = await ctx.connector.refundOrder(o, amount, input.reason, ctx.actor);
      return ok(publicOrder(updated), `A refund of ${amount.toFixed(2)} ${updated.currency} for order #${updated.number} has been issued.`);
    },
  }),
  defineTool({
    name: "update_shipping_address",
    description: "Change the shipping address of a verified customer's order that hasn't shipped. Read the full new address back to the customer and get confirmation first.",
    schema: z.object({ order_number: orderNumber, address: addressSchema }),
    inputSchema: { type: "object", properties: { order_number: { type: "string" }, address: addressJsonSchema }, required: ["order_number", "address"], additionalProperties: false },
    defaultPolicy: "AUTO",
    async precheck(ctx, input) {
      const o = await loadOwnedOrder(ctx, input.order_number);
      return typeof o === "string" ? o : addressBlocker(o);
    },
    async run(ctx, input) {
      const o = await loadOwnedOrder(ctx, input.order_number);
      if (typeof o === "string") return fail(o);
      const updated = await ctx.connector.updateShippingAddress(o, input.address, ctx.actor);
      return ok(publicOrder(updated), `The shipping address for order #${updated.number} has been updated.`);
    },
  }),
  defineTool({
    name: "search_products",
    description: "Search the store catalogue by keywords. Returns name, SKU, price and stock.",
    schema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }),
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false },
    defaultPolicy: "AUTO",
    async run(ctx, input) {
      return ok(await ctx.connector.searchProducts(input.query, input.limit ?? 5));
    },
  }),
  defineTool({
    name: "check_stock",
    description: "Check price and stock for a product SKU.",
    schema: z.object({ sku: z.string().min(1).max(100) }),
    inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false },
    defaultPolicy: "AUTO",
    async run(ctx, input) {
      const p = await ctx.connector.getProductBySku(input.sku);
      return p ? ok({ sku: p.sku, name: p.name, price: p.price, currency: p.currency, inStock: p.stock > 0, stock: p.stock }) : fail(`No product with SKU ${input.sku}`);
    },
  }),
  defineTool({
    name: "create_order",
    description:
      "Place a new order on the customer's behalf (unpaid, pending payment). Collect email, items (SKU + quantity) and shipping address, read the summary back and get explicit confirmation before calling.",
    schema: z.object({
      email: z.string().email(),
      name: z.string().max(120).optional(),
      items: z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().min(1).max(100) })).min(1).max(30),
      shipping_address: addressSchema,
      notes: z.string().max(500).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string" },
        name: { type: "string" },
        items: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, quantity: { type: "integer" } }, required: ["sku", "quantity"], additionalProperties: false } },
        shipping_address: addressJsonSchema,
        notes: { type: "string" },
      },
      required: ["email", "items", "shipping_address"],
      additionalProperties: false,
    },
    defaultPolicy: "DISABLED",
    async run(ctx, input) {
      if (!ctx.connector.createOrder) return fail("This store does not support placing orders through chat.");
      const order = await ctx.connector.createOrder(
        { customer: { email: input.email, name: input.name }, items: input.items, shippingAddress: input.shipping_address, notes: input.notes },
        ctx.actor,
      );
      // the person who placed it owns it
      await prisma.conversation.update({ where: { id: ctx.conversation.id }, data: { verifiedEmail: input.email.toLowerCase() } });
      ctx.conversation.verifiedEmail = input.email.toLowerCase();
      return ok(publicOrder(order), `Order #${order.number} has been placed.`);
    },
  }),
  defineTool({
    name: "search_knowledge_base",
    description: "Search the store's help articles and policies (shipping, returns, warranty, payments, FAQs). Use this before answering any policy question.",
    schema: z.object({ query: z.string().min(1).max(300) }),
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    defaultPolicy: "AUTO",
    async run(ctx, input) {
      const hits = await searchKnowledge(ctx.tenantId, input.query, 4);
      return ok(hits.length ? hits : "No matching articles. Don't guess policies; offer a human if needed.");
    },
  }),
  defineTool({
    name: "escalate_to_human",
    description:
      "Hand the conversation to a human support teammate. Use when the customer asks for a human, is upset, the request is outside your tools, or you are unsure.",
    schema: z.object({ reason: z.string().min(2).max(300), summary: z.string().max(1500).optional() }),
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" }, summary: { type: "string", description: "Short summary for the human teammate" } },
      required: ["reason"],
      additionalProperties: false,
    },
    defaultPolicy: "AUTO",
    async run(ctx, input) {
      const c = await conversationService.escalate(ctx.conversation, input.reason, input.summary);
      ctx.conversation.status = c.status;
      return ok({ escalated: true, note: "A teammate will reply here. Tell the customer, and stop trying to solve it yourself." });
    },
  }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export function effectivePolicy(toolName: string, policies: Record<string, ActionPolicy>): ActionPolicy {
  const t = TOOL_MAP.get(toolName);
  if (!t) return "DISABLED";
  return policies[toolName] ?? t.defaultPolicy;
}

/** Validate input, then run, converting thrown errors into model-readable failures. */
export async function runTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolResult> {
  const tool = TOOL_MAP.get(name);
  if (!tool) return fail(`Unknown tool ${name}`);
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) return fail(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  try {
    return await tool.run(ctx, parsed.data);
  } catch (e) {
    if (e instanceof ConnectorError || e instanceof AppError) return fail(e.message);
    throw e;
  }
}
