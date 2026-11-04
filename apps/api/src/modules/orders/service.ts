import { Prisma, type IntegrationType, type OrderStatus, type PaymentStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { emitEvent } from "../../events/bus";
import type { Address, NewOrderInput, OrderDTO } from "../../connectors/types";
import { addressBlocker, cancelBlocker, canTransition, refundBlocker, round2 } from "./rules";

const include = { items: true, customer: true } as const;
type OrderRow = Prisma.OrderGetPayload<{ include: typeof include }>;

export function toDTO(o: OrderRow): OrderDTO {
  return {
    id: o.id,
    externalId: o.externalId,
    number: o.number,
    source: o.source,
    status: o.status,
    paymentStatus: o.paymentStatus,
    currency: o.currency,
    subtotal: Number(o.subtotal),
    shippingTotal: Number(o.shippingTotal),
    total: Number(o.total),
    refundedTotal: Number(o.refundedTotal),
    customerEmail: o.customer?.email ?? null,
    customerName: o.customer?.name ?? null,
    customerExternalId: o.customer?.externalId ?? null,
    shippingAddress: (o.shippingAddress as Address | null) ?? null,
    trackingNumber: o.trackingNumber,
    carrier: o.carrier,
    items: o.items.map((i) => ({ sku: i.sku, name: i.name, quantity: i.quantity, unitPrice: Number(i.unitPrice) })),
    placedAt: o.placedAt.toISOString(),
  };
}

async function upsertCustomer(
  tx: Prisma.TransactionClient,
  tenantId: string,
  c: { email?: string | null; name?: string | null; phone?: string | null; externalId?: string | null },
) {
  if (c.externalId) {
    return tx.customer.upsert({
      where: { tenantId_externalId: { tenantId, externalId: c.externalId } },
      create: { tenantId, externalId: c.externalId, email: c.email?.toLowerCase(), name: c.name, phone: c.phone },
      update: { email: c.email?.toLowerCase() ?? undefined, name: c.name ?? undefined, phone: c.phone ?? undefined },
    });
  }
  if (!c.email) return null;
  const email = c.email.toLowerCase();
  const existing = await tx.customer.findFirst({ where: { tenantId, email } });
  if (existing) return existing;
  return tx.customer.create({ data: { tenantId, email, name: c.name, phone: c.phone } });
}

async function nextOrderNumber(tx: Prisma.TransactionClient, tenantId: string) {
  const count = await tx.order.count({ where: { tenantId } });
  return String(1001 + count);
}

export const orderService = {
  async get(tenantId: string, id: string) {
    const o = await prisma.order.findFirst({ where: { tenantId, id }, include: { ...include, events: { orderBy: { createdAt: "desc" } } } });
    if (!o) throw notFound("Order");
    return o;
  },

  async getByNumber(tenantId: string, number: string) {
    const clean = number.replace(/^#/, "").trim();
    const o = await prisma.order.findFirst({ where: { tenantId, number: clean }, include });
    return o ? toDTO(o) : null;
  },

  async listByEmail(tenantId: string, email: string, limit = 10) {
    const rows = await prisma.order.findMany({
      where: { tenantId, customer: { email: email.toLowerCase() } },
      include,
      orderBy: { placedAt: "desc" },
      take: limit,
    });
    return rows.map(toDTO);
  },

  async list(tenantId: string, q: { status?: OrderStatus; search?: string; cursor?: string; limit: number }) {
    const where: Prisma.OrderWhereInput = { tenantId };
    if (q.status) where.status = q.status;
    if (q.search) {
      where.OR = [
        { number: { contains: q.search.replace(/^#/, "") } },
        { customer: { email: { contains: q.search, mode: "insensitive" } } },
        { customer: { name: { contains: q.search, mode: "insensitive" } } },
      ];
    }
    const rows = await prisma.order.findMany({
      where,
      include,
      orderBy: { placedAt: "desc" },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > q.limit;
    const data = rows.slice(0, q.limit).map(toDTO);
    return { data, nextCursor: hasMore ? data[data.length - 1]?.id : null };
  },

  /** Create a native order (from tenant's checkout via API, dashboard, or the agent). */
  async create(tenantId: string, input: NewOrderInput & { number?: string; externalId?: string; paymentStatus?: PaymentStatus; status?: OrderStatus; shippingTotal?: number; currency?: string }, actor: string) {
    const order = await prisma.$transaction(async (tx) => {
      const skus = input.items.map((i) => i.sku);
      const products = await tx.product.findMany({ where: { tenantId, sku: { in: skus }, active: true } });
      const bySku = new Map(products.map((p) => [p.sku, p]));
      for (const item of input.items) {
        const p = bySku.get(item.sku);
        if (!p) throw badRequest(`Unknown SKU ${item.sku}`);
        if (p.stock < item.quantity) throw badRequest(`Insufficient stock for ${item.sku} (available: ${p.stock})`);
      }
      const subtotal = round2(input.items.reduce((s, i) => s + Number(bySku.get(i.sku)!.price) * i.quantity, 0));
      const shipping = input.shippingTotal ?? 0;
      const customer = await upsertCustomer(tx, tenantId, input.customer);
      // decrement stock atomically; the guard prevents overselling under concurrency
      for (const item of input.items) {
        const res = await tx.product.updateMany({
          where: { tenantId, sku: item.sku, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (res.count === 0) throw badRequest(`Insufficient stock for ${item.sku}`);
      }
      return tx.order.create({
        data: {
          tenantId,
          number: input.number ?? (await nextOrderNumber(tx, tenantId)),
          externalId: input.externalId,
          customerId: customer?.id,
          status: input.status ?? "PENDING",
          paymentStatus: input.paymentStatus ?? "UNPAID",
          currency: input.currency ?? products[0]?.currency ?? "USD",
          subtotal,
          shippingTotal: shipping,
          total: round2(subtotal + shipping),
          shippingAddress: (input.shippingAddress as unknown as Prisma.InputJsonValue) ?? undefined,
          notes: input.notes,
          items: {
            create: input.items.map((i) => {
              const p = bySku.get(i.sku)!;
              return { productId: p.id, sku: p.sku, name: p.name, quantity: i.quantity, unitPrice: p.price };
            }),
          },
          events: { create: { type: "created", actor } },
        },
        include,
      });
    });
    const dto = toDTO(order);
    await emitEvent(tenantId, "order.created", { order: dto });
    return dto;
  },

  /** Upsert an order mirrored from an external platform (Shopify/Woo webhooks or sync). */
  async upsertExternal(tenantId: string, source: IntegrationType, dto: OrderDTO) {
    const existing = await prisma.order.findFirst({ where: { tenantId, number: dto.number } });
    const order = await prisma.$transaction(async (tx) => {
      const customer = await upsertCustomer(tx, tenantId, {
        email: dto.customerEmail,
        name: dto.customerName,
        externalId: dto.customerExternalId ? `${source}:${dto.customerExternalId}` : null,
      });
      const data = {
        externalId: dto.externalId ?? dto.id,
        source,
        customerId: customer?.id,
        status: dto.status,
        paymentStatus: dto.paymentStatus,
        currency: dto.currency,
        subtotal: dto.subtotal,
        shippingTotal: dto.shippingTotal,
        total: dto.total,
        refundedTotal: dto.refundedTotal,
        shippingAddress: (dto.shippingAddress as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        trackingNumber: dto.trackingNumber,
        carrier: dto.carrier,
      };
      if (existing) {
        await tx.orderItem.deleteMany({ where: { orderId: existing.id } });
        return tx.order.update({
          where: { id: existing.id },
          data: { ...data, items: { create: dto.items } },
          include,
        });
      }
      return tx.order.create({
        data: { ...data, tenantId, number: dto.number, placedAt: new Date(dto.placedAt), items: { create: dto.items }, events: { create: { type: "imported", actor: `integration:${source}` } } },
        include,
      });
    });
    const out = toDTO(order);
    if (!existing) await emitEvent(tenantId, "order.created", { order: out });
    else if (existing.status !== out.status) await emitEvent(tenantId, "order.status_changed", { order: out, from: existing.status, to: out.status });
    return out;
  },

  async setStatus(tenantId: string, id: string, to: OrderStatus, actor: string, extra: { trackingNumber?: string; carrier?: string; note?: string } = {}) {
    const o = await prisma.order.findFirst({ where: { tenantId, id } });
    if (!o) throw notFound("Order");
    if (o.status === to) return toDTO(await prisma.order.findUniqueOrThrow({ where: { id }, include }));
    if (!canTransition(o.status, to)) throw badRequest(`Cannot change order from ${o.status} to ${to}`);
    const updated = await prisma.$transaction(async (tx) => {
      if (to === "CANCELLED") {
        // restock
        const items = await tx.orderItem.findMany({ where: { orderId: id } });
        for (const i of items) {
          if (i.productId) await tx.product.update({ where: { id: i.productId }, data: { stock: { increment: i.quantity } } });
        }
      }
      return tx.order.update({
        where: { id },
        data: {
          status: to,
          trackingNumber: extra.trackingNumber ?? undefined,
          carrier: extra.carrier ?? undefined,
          events: { create: { type: "status_changed", actor, data: { from: o.status, to, ...extra } } },
        },
        include,
      });
    });
    const dto = toDTO(updated);
    await emitEvent(tenantId, "order.status_changed", { order: dto, from: o.status, to });
    return dto;
  },

  async cancel(tenantId: string, number: string, reason: string, actor: string) {
    const dto = await this.getByNumber(tenantId, number);
    if (!dto) throw notFound("Order");
    const blocker = cancelBlocker(dto);
    if (blocker) throw badRequest(blocker);
    const out = await this.setStatus(tenantId, dto.id, "CANCELLED", actor, { note: reason });
    // a cancelled paid order is refunded in full
    if (dto.paymentStatus === "PAID") return this.refund(tenantId, number, round2(dto.total - dto.refundedTotal), `Cancellation: ${reason}`, actor, { keepStatus: true });
    return out;
  },

  async refund(tenantId: string, number: string, amount: number, reason: string, actor: string, opts: { keepStatus?: boolean } = {}) {
    const dto = await this.getByNumber(tenantId, number);
    if (!dto) throw notFound("Order");
    const blocker = refundBlocker(dto, amount);
    if (blocker) throw badRequest(blocker);
    const refunded = round2(dto.refundedTotal + amount);
    const full = refunded >= dto.total;
    const updated = await prisma.order.update({
      where: { id: dto.id },
      data: {
        refundedTotal: refunded,
        paymentStatus: full ? "REFUNDED" : "PARTIALLY_REFUNDED",
        ...(full && !opts.keepStatus && dto.status === "DELIVERED" ? { status: "REFUNDED" as const } : {}),
        events: { create: { type: "refund", actor, data: { amount, reason } } },
      },
      include,
    });
    const out = toDTO(updated);
    await emitEvent(tenantId, "order.refunded", { order: out, amount, reason });
    return out;
  },

  async updateAddress(tenantId: string, number: string, address: Address, actor: string) {
    const dto = await this.getByNumber(tenantId, number);
    if (!dto) throw notFound("Order");
    const blocker = addressBlocker(dto);
    if (blocker) throw badRequest(blocker);
    const updated = await prisma.order.update({
      where: { id: dto.id },
      data: {
        shippingAddress: address as unknown as Prisma.InputJsonValue,
        events: { create: { type: "address_changed", actor, data: { from: dto.shippingAddress ?? null, to: address } as unknown as Prisma.InputJsonValue } },
      },
      include,
    });
    const out = toDTO(updated);
    await emitEvent(tenantId, "order.updated", { order: out });
    return out;
  },

  async addNote(tenantId: string, id: string, note: string, actor: string) {
    await this.get(tenantId, id);
    return prisma.orderEvent.create({ data: { orderId: id, type: "note", actor, data: { note } } });
  },
};
