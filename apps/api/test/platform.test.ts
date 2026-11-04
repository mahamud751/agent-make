import { beforeEach, describe, expect, it } from "vitest";
import { api, resetDb, secretKey, seedCatalog, signup, prisma, drainInlineJobs } from "./helpers";
import { signPayload, verifySignature, encrypt, decrypt } from "../src/lib/crypto";
import { render, matches } from "../src/modules/automations/engine";

beforeEach(resetDb);

describe("auth & tenancy", () => {
  it("signup bootstraps a working tenant", async () => {
    const t = await signup("Acme Shoes");
    expect(t.pk).toMatch(/^pk_live_/);
    const me = await api().get("/v1/auth/me").set("Authorization", `Bearer ${t.token}`);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe("OWNER");
    const agents = await api().get("/v1/agents").set("Authorization", `Bearer ${t.token}`);
    expect(agents.body).toHaveLength(1);
    expect(agents.body[0].isDefault).toBe(true);
    const kb = await api().get("/v1/knowledge").set("Authorization", `Bearer ${t.token}`);
    expect(kb.body.length).toBeGreaterThan(0);
  });

  it("isolates tenants from each other", async () => {
    const a = await signup();
    const b = await signup();
    await seedCatalog(a.tenantId);
    const sk = await secretKey(a.token);
    const order = await api().post("/v1/orders").set("Authorization", `Bearer ${sk}`).send({ customer: { email: "x@y.com" }, items: [{ sku: "MUG", quantity: 1 }] });
    expect(order.status).toBe(201);
    const peek = await api().get(`/v1/orders/${order.body.id}`).set("Authorization", `Bearer ${b.token}`);
    expect(peek.status).toBe(404);
    const list = await api().get("/v1/orders").set("Authorization", `Bearer ${b.token}`);
    expect(list.body.data).toHaveLength(0);
  });

  it("publishable keys cannot reach the admin API", async () => {
    const t = await signup();
    const res = await api().get("/v1/orders").set("Authorization", `Bearer ${t.pk}`);
    expect(res.status).toBe(403);
  });

  it("enforces origin allow-lists on publishable keys", async () => {
    const t = await signup();
    const key = await api().post("/v1/api-keys").set("Authorization", `Bearer ${t.token}`).send({ name: "w", kind: "PUBLISHABLE", allowedOrigins: ["https://shop.example.com"] });
    const bad = await api().post("/v1/widget/session").set("Authorization", `Bearer ${key.body.key}`).set("Origin", "https://evil.example").send({});
    expect(bad.status).toBe(403);
    const good = await api().post("/v1/widget/session").set("Authorization", `Bearer ${key.body.key}`).set("Origin", "https://shop.example.com").send({});
    expect(good.status).toBe(201);
  });

  it("role guard blocks viewers from admin actions", async () => {
    const t = await signup();
    const inv = await api().post("/v1/members/invite").set("Authorization", `Bearer ${t.token}`).send({ email: "viewer@test.dev", role: "VIEWER" });
    const token = new URL(inv.body.inviteUrl).searchParams.get("token");
    const acc = await api().post("/v1/auth/invites/accept").send({ token, name: "V", password: "password123" });
    expect(acc.status).toBe(200);
    const res = await api().post("/v1/agents").set("Authorization", `Bearer ${acc.body.token}`).send({ name: "x" });
    expect(res.status).toBe(403);
  });
});

describe("orders", () => {
  it("creates orders, decrements stock, enforces transitions and restocks on cancel", async () => {
    const t = await signup();
    await seedCatalog(t.tenantId);
    const auth = { Authorization: `Bearer ${t.token}` };
    const o = await api().post("/v1/orders").set(auth).send({ customer: { email: "buyer@x.com", name: "B" }, items: [{ sku: "TEE", quantity: 2 }], paymentStatus: "PAID" });
    expect(o.status).toBe(201);
    expect(o.body.total).toBe(50);
    expect((await prisma.product.findFirstOrThrow({ where: { tenantId: t.tenantId, sku: "TEE" } })).stock).toBe(3);

    const oversell = await api().post("/v1/orders").set(auth).send({ customer: { email: "b@x.com" }, items: [{ sku: "TEE", quantity: 99 }] });
    expect(oversell.status).toBe(400);

    const bad = await api().post(`/v1/orders/${o.body.id}/status`).set(auth).send({ status: "DELIVERED" });
    expect(bad.status).toBe(400);

    const cancelled = await api().post(`/v1/orders/${o.body.id}/cancel`).set(auth).send({ reason: "changed mind" });
    expect(cancelled.body.status).toBe("CANCELLED");
    expect(cancelled.body.paymentStatus).toBe("REFUNDED");
    expect((await prisma.product.findFirstOrThrow({ where: { tenantId: t.tenantId, sku: "TEE" } })).stock).toBe(5);
  });

  it("refunds cannot exceed the paid amount", async () => {
    const t = await signup();
    await seedCatalog(t.tenantId);
    const auth = { Authorization: `Bearer ${t.token}` };
    const o = await api().post("/v1/orders").set(auth).send({ customer: { email: "buyer@x.com" }, items: [{ sku: "MUG", quantity: 1 }], paymentStatus: "PAID" });
    expect((await api().post(`/v1/orders/${o.body.id}/refund`).set(auth).send({ amount: 5, reason: "chip" })).body.paymentStatus).toBe("PARTIALLY_REFUNDED");
    expect((await api().post(`/v1/orders/${o.body.id}/refund`).set(auth).send({ amount: 8, reason: "again" })).status).toBe(400);
  });
});

describe("automations & webhooks", () => {
  it("messages the customer when an order ships", async () => {
    const t = await signup();
    await prisma.tenant.update({ where: { id: t.tenantId }, data: { plan: "STARTER" } });
    await seedCatalog(t.tenantId);
    const auth = { Authorization: `Bearer ${t.token}` };
    const rule = await api().post("/v1/automations").set(auth).send({
      name: "shipped",
      event: "order.status_changed",
      conditions: { to: "SHIPPED" },
      actions: [{ type: "notify_customer", template: "Order #{{order.number}} shipped via {{order.carrier}}" }],
    });
    expect(rule.status).toBe(201);
    const o = await api().post("/v1/orders").set(auth).send({ customer: { email: "c@x.com" }, items: [{ sku: "MUG", quantity: 1 }], status: "PROCESSING" });
    const conv = await prisma.conversation.create({ data: { tenantId: t.tenantId, channel: "WEB_WIDGET", verifiedEmail: "c@x.com" } });
    await api().post(`/v1/orders/${o.body.id}/status`).set(auth).send({ status: "SHIPPED", carrier: "DHL", trackingNumber: "T1" });
    await drainInlineJobs();
    const msgs = await prisma.message.findMany({ where: { conversationId: conv.id } });
    expect(msgs.map((m) => m.content)).toContain(`Order #${o.body.number} shipped via DHL`);
  });

  it("free plan cannot create automations", async () => {
    const t = await signup();
    const res = await api().post("/v1/automations").set("Authorization", `Bearer ${t.token}`).send({ name: "x", event: "order.created", actions: [{ type: "tag_conversation", tag: "a" }] });
    expect(res.status).toBe(402);
  });

  it("templating and conditions", () => {
    expect(render("Hi {{a.b}} {{missing}}!", { a: { b: "Sam" } })).toBe("Hi Sam !");
    expect(matches({ to: ["SHIPPED", "DELIVERED"] }, { to: "SHIPPED" })).toBe(true);
    expect(matches({ "order.status": "PENDING" }, { order: { status: "SHIPPED" } })).toBe(false);
  });
});

describe("crypto", () => {
  it("signs and verifies payloads, rejects tampering and replays", () => {
    const sig = signPayload("s3cret", '{"a":1}');
    expect(verifySignature("s3cret", '{"a":1}', sig)).toBe(true);
    expect(verifySignature("s3cret", '{"a":2}', sig)).toBe(false);
    const old = signPayload("s3cret", "{}", Math.floor(Date.now() / 1000) - 3600);
    expect(verifySignature("s3cret", "{}", old)).toBe(false);
  });
  it("round-trips encrypted credentials", () => {
    expect(decrypt(encrypt("token-123"))).toBe("token-123");
  });
});
