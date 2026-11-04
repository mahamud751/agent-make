/* Demo data: one store with products, customers, orders, an automation and API keys. */
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { bootstrapTenant, generateApiKey } from "../src/modules/tenants/bootstrap";

async function main() {
  const email = "owner@demo.store";
  if (await prisma.user.findUnique({ where: { email } })) {
    console.log("Seed already applied. Login: owner@demo.store / password123");
    return;
  }
  const { tenant, publishableKey, secretKey } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email, name: "Demo Owner", passwordHash: await bcrypt.hash("password123", 12) } });
    const tenant = await tx.tenant.create({ data: { name: "Demo Outdoor Co.", slug: "demo", plan: "GROWTH", subscriptionStatus: "ACTIVE" } });
    await tx.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "OWNER" } });
    const { publishableKey } = await bootstrapTenant(tx, tenant.id, tenant.name);
    const sk = generateApiKey("SECRET");
    await tx.apiKey.create({ data: { tenantId: tenant.id, name: "Store backend", kind: "SECRET", prefix: sk.prefix, keyHash: sk.hash } });
    return { tenant, publishableKey, secretKey: sk.raw };
  });

  const products = [
    { sku: "TENT-2P", name: "Trailhead 2-Person Tent", price: 189, stock: 40, description: "Lightweight 3-season backpacking tent, 1.9kg." },
    { sku: "BAG-20F", name: "Summit Down Sleeping Bag 20°F", price: 249, stock: 25, description: "800-fill down, packs to 25cm." },
    { sku: "STOVE-MINI", name: "Ember Mini Stove", price: 49, stock: 120, description: "Canister stove, boils 1L in 3.5 min." },
    { sku: "PACK-45L", name: "Ridge 45L Backpack", price: 159, stock: 0, description: "Ventilated frame pack. Restocking soon." },
  ];
  await prisma.product.createMany({ data: products.map((p) => ({ ...p, tenantId: tenant.id })) });

  const customers = [
    { email: "sam@example.com", name: "Sam Rivera" },
    { email: "lee@example.com", name: "Lee Chen" },
  ];
  for (const c of customers) await prisma.customer.create({ data: { ...c, tenantId: tenant.id } });
  const sam = await prisma.customer.findFirstOrThrow({ where: { tenantId: tenant.id, email: "sam@example.com" } });
  const lee = await prisma.customer.findFirstOrThrow({ where: { tenantId: tenant.id, email: "lee@example.com" } });
  const addr = { name: "Sam Rivera", line1: "12 Pine St", city: "Portland", state: "OR", postalCode: "97201", country: "US" };

  const orders = [
    { number: "1001", customerId: sam.id, status: "SHIPPED" as const, paymentStatus: "PAID" as const, sku: "TENT-2P", qty: 1, trackingNumber: "1Z999AA10123456784", carrier: "UPS" },
    { number: "1002", customerId: sam.id, status: "PROCESSING" as const, paymentStatus: "PAID" as const, sku: "STOVE-MINI", qty: 2 },
    { number: "1003", customerId: lee.id, status: "DELIVERED" as const, paymentStatus: "PAID" as const, sku: "BAG-20F", qty: 1 },
    { number: "1004", customerId: lee.id, status: "PENDING" as const, paymentStatus: "UNPAID" as const, sku: "STOVE-MINI", qty: 1 },
  ];
  for (const o of orders) {
    const p = products.find((x) => x.sku === o.sku)!;
    const product = await prisma.product.findFirstOrThrow({ where: { tenantId: tenant.id, sku: o.sku } });
    const subtotal = p.price * o.qty;
    await prisma.order.create({
      data: {
        tenantId: tenant.id, number: o.number, customerId: o.customerId, status: o.status, paymentStatus: o.paymentStatus,
        subtotal, shippingTotal: 0, total: subtotal, shippingAddress: addr, trackingNumber: o.trackingNumber, carrier: o.carrier,
        items: { create: [{ productId: product.id, sku: p.sku, name: p.name, quantity: o.qty, unitPrice: p.price }] },
        events: { create: { type: "created", actor: "seed" } },
      },
    });
  }

  await prisma.automationRule.create({
    data: {
      tenantId: tenant.id,
      name: "Tell customers when their order ships",
      event: "order.status_changed",
      conditions: { to: "SHIPPED" },
      actions: [{ type: "notify_customer", template: "Good news {{order.customerName}}! Order #{{order.number}} has shipped with {{order.carrier}} (tracking {{order.trackingNumber}})." }],
    },
  });

  console.log("\n✔ Seeded demo store");
  console.log("  Dashboard login : owner@demo.store / password123");
  console.log(`  Publishable key : ${publishableKey}`);
  console.log(`  Secret key      : ${secretKey}`);
  console.log("  Try the widget  : order 1002 + sam@example.com\n");
}

main().finally(() => prisma.$disconnect());
