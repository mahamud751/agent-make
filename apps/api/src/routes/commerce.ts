import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { body, param, query } from "../lib/http";
import { notFound } from "../lib/errors";
import { actorLabel, ctxOf, requireRole } from "../middleware/auth";
import { orderService, toDTO } from "../modules/orders/service";

export const commerceRouter = Router();

const address = z.object({
  name: z.string().optional(),
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  state: z.string().optional(),
  postalCode: z.string(),
  country: z.string(),
  phone: z.string().optional(),
});
const status = z.enum(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED", "ON_HOLD"]);

// ─────────────── Products ───────────────
const productInput = z.object({
  sku: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  price: z.number().nonnegative(),
  currency: z.string().length(3).optional(),
  stock: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  externalId: z.string().optional(),
});

commerceRouter.get("/products", requireRole("VIEWER"), async (req, res) => {
  const q = query(req, z.object({ search: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }));
  const rows = await prisma.product.findMany({
    where: { tenantId: ctxOf(req).tenantId, ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { sku: { contains: q.search, mode: "insensitive" } }] } : {}) },
    orderBy: { name: "asc" },
    take: q.limit,
  });
  res.json(rows);
});

/** Bulk upsert by SKU — the website pushes its catalogue here (idempotent). */
commerceRouter.put("/products", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const { products } = body(req, z.object({ products: z.array(productInput).min(1).max(1000) }));
  const out = await prisma.$transaction(
    products.map((p) =>
      prisma.product.upsert({
        where: { tenantId_sku: { tenantId: ctx.tenantId, sku: p.sku } },
        create: { ...p, tenantId: ctx.tenantId },
        update: p,
      }),
    ),
  );
  res.json({ upserted: out.length });
});

commerceRouter.post("/products", requireRole("ADMIN"), async (req, res) => {
  res.status(201).json(await prisma.product.create({ data: { ...body(req, productInput), tenantId: ctxOf(req).tenantId } }));
});

commerceRouter.patch("/products/:id", requireRole("ADMIN"), async (req, res) => {
  const ctx = ctxOf(req);
  const r = await prisma.product.updateMany({ where: { id: param(req, "id"), tenantId: ctx.tenantId }, data: body(req, productInput.partial()) });
  if (!r.count) throw notFound("Product");
  res.json(await prisma.product.findUnique({ where: { id: param(req, "id") } }));
});

commerceRouter.delete("/products/:id", requireRole("ADMIN"), async (req, res) => {
  const r = await prisma.product.updateMany({ where: { id: param(req, "id"), tenantId: ctxOf(req).tenantId }, data: { active: false } });
  if (!r.count) throw notFound("Product");
  res.status(204).end();
});

// ─────────────── Customers ───────────────
commerceRouter.get("/customers", requireRole("VIEWER"), async (req, res) => {
  const q = query(req, z.object({ search: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }));
  res.json(
    await prisma.customer.findMany({
      where: { tenantId: ctxOf(req).tenantId, ...(q.search ? { OR: [{ email: { contains: q.search, mode: "insensitive" } }, { name: { contains: q.search, mode: "insensitive" } }] } : {}) },
      include: { _count: { select: { orders: true, conversations: true } } },
      orderBy: { createdAt: "desc" },
      take: q.limit,
    }),
  );
});

commerceRouter.get("/customers/:id", requireRole("VIEWER"), async (req, res) => {
  const c = await prisma.customer.findFirst({
    where: { id: param(req, "id"), tenantId: ctxOf(req).tenantId },
    include: { orders: { include: { items: true, customer: true }, orderBy: { placedAt: "desc" }, take: 20 }, conversations: { orderBy: { lastMessageAt: "desc" }, take: 20 } },
  });
  if (!c) throw notFound("Customer");
  res.json({ ...c, orders: c.orders.map(toDTO) });
});

// ─────────────── Orders ───────────────
commerceRouter.get("/orders", requireRole("VIEWER"), async (req, res) => {
  const q = query(req, z.object({ status: status.optional(), search: z.string().optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }));
  res.json(await orderService.list(ctxOf(req).tenantId, q));
});

commerceRouter.get("/orders/:id", requireRole("VIEWER"), async (req, res) => {
  const o = await orderService.get(ctxOf(req).tenantId, param(req, "id"));
  res.json({ ...toDTO(o), events: o.events, notes: o.notes });
});

/** Create an order — called by the website's checkout (secret key) or by staff. */
commerceRouter.post("/orders", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(
    req,
    z.object({
      number: z.string().max(64).optional(),
      externalId: z.string().optional(),
      customer: z.object({ email: z.string().email(), name: z.string().optional(), phone: z.string().optional() }),
      items: z.array(z.object({ sku: z.string(), quantity: z.number().int().min(1) })).min(1),
      shippingAddress: address.optional(),
      shippingTotal: z.number().nonnegative().optional(),
      currency: z.string().length(3).optional(),
      paymentStatus: z.enum(["UNPAID", "PAID"]).optional(),
      status: status.optional(),
      notes: z.string().max(2000).optional(),
    }),
  );
  res.status(201).json(await orderService.create(ctx.tenantId, input, actorLabel(ctx)));
});

commerceRouter.post("/orders/:id/status", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, z.object({ status, trackingNumber: z.string().max(100).optional(), carrier: z.string().max(60).optional(), note: z.string().max(500).optional() }));
  res.json(await orderService.setStatus(ctx.tenantId, param(req, "id"), input.status, actorLabel(ctx), input));
});

commerceRouter.post("/orders/:id/cancel", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  const { reason } = body(req, z.object({ reason: z.string().min(1).max(500) }));
  const o = await orderService.get(ctx.tenantId, param(req, "id"));
  res.json(await orderService.cancel(ctx.tenantId, o.number, reason, actorLabel(ctx)));
});

commerceRouter.post("/orders/:id/refund", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  const input = body(req, z.object({ amount: z.number().positive(), reason: z.string().min(1).max(500) }));
  const o = await orderService.get(ctx.tenantId, param(req, "id"));
  res.json(await orderService.refund(ctx.tenantId, o.number, input.amount, input.reason, actorLabel(ctx)));
});

commerceRouter.patch("/orders/:id/address", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  const o = await orderService.get(ctx.tenantId, param(req, "id"));
  res.json(await orderService.updateAddress(ctx.tenantId, o.number, body(req, address), actorLabel(ctx)));
});

commerceRouter.post("/orders/:id/payment", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  const { paymentStatus } = body(req, z.object({ paymentStatus: z.enum(["PAID", "FAILED", "UNPAID"]) }));
  const o = await orderService.get(ctx.tenantId, param(req, "id"));
  await prisma.order.update({ where: { id: o.id }, data: { paymentStatus, events: { create: { type: "payment", actor: actorLabel(ctx), data: { paymentStatus } } } } });
  res.json(toDTO(await orderService.get(ctx.tenantId, o.id)));
});

commerceRouter.post("/orders/:id/notes", requireRole("SUPPORT"), async (req, res) => {
  const ctx = ctxOf(req);
  const { note } = body(req, z.object({ note: z.string().min(1).max(2000) }));
  res.status(201).json(await orderService.addNote(ctx.tenantId, param(req, "id"), note, actorLabel(ctx)));
});
