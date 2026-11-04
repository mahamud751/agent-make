import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, drainInlineJobs, lastToolResults, message, prisma, resetDb, scriptLLM, secretKey, seedCatalog, signup, text, toolUse } from "./helpers";
import { setLLM } from "../src/agent/llm";
import { verifySignature } from "../src/lib/crypto";

beforeEach(resetDb);
afterEach(() => setLLM(null));

async function storeWithOrder(paid = true) {
  const t = await signup();
  await seedCatalog(t.tenantId);
  const o = await api()
    .post("/v1/orders")
    .set("Authorization", `Bearer ${t.token}`)
    .send({ customer: { email: "sam@example.com", name: "Sam" }, items: [{ sku: "MUG", quantity: 2 }], paymentStatus: paid ? "PAID" : "UNPAID", status: "CONFIRMED" });
  return { ...t, order: o.body };
}

async function widgetSay(pk: string, content: string, visitorToken?: string) {
  if (!visitorToken) {
    const s = await api().post("/v1/widget/session").set("Authorization", `Bearer ${pk}`).send({});
    visitorToken = s.body.visitorToken as string;
  }
  await api().post("/v1/widget/messages").set("Authorization", `Bearer ${pk}`).send({ visitorToken, content });
  await drainInlineJobs();
  const res = await api().get("/v1/widget/messages").set("Authorization", `Bearer ${pk}`).query({ visitorToken });
  return { visitorToken, messages: res.body.messages as { role: string; content: string }[], status: res.body.status as string };
}

describe("AI agent", () => {
  it("requires identity verification before revealing order details", async () => {
    const s = await storeWithOrder();
    const calls = scriptLLM([
      () => message([toolUse("get_order", { order_number: s.order.number })]),
      (p) => {
        expect(lastToolResults(p)[0].data.error).toMatch(/IDENTITY_NOT_VERIFIED/);
        return message([toolUse("verify_customer", { order_number: s.order.number, email: "SAM@example.com" })]);
      },
      (p) => {
        expect(lastToolResults(p)[0].data.verified).toBe(true);
        return message([toolUse("get_order", { order_number: `#${s.order.number}` })]);
      },
      (p) => {
        const r = lastToolResults(p)[0];
        expect(r.isError).toBe(false);
        expect(r.data.status).toBe("CONFIRMED");
        return message([text(`Your order #${s.order.number} is confirmed and will ship soon.`)]);
      },
    ]);
    const { messages } = await widgetSay(s.pk, `Where is order ${s.order.number}? my email is sam@example.com`);
    expect(messages.at(-1)!.role).toBe("AGENT");
    expect(messages.at(-1)!.content).toContain("confirmed");
    expect(calls).toHaveLength(4);

    // request shape: cached system prompt, adaptive thinking, per-turn context as a system message
    const req = calls[0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect((req.system as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect(req.messages.at(-1)!.role).toBe("system");
    const toolNames = req.tools!.map((t) => (t as { name: string }).name);
    expect(toolNames).toContain("request_refund");
    expect(toolNames).not.toContain("create_order"); // DISABLED by default

    const run = await prisma.agentRun.findFirstOrThrow({ where: { tenantId: s.tenantId } });
    expect(run.inputTokens).toBe(400);
    const usage = await prisma.usageRecord.findFirstOrThrow({ where: { tenantId: s.tenantId, metric: "ai_replies" } });
    expect(usage.quantity).toBe(1);
  });

  it("never confirms someone else's order and locks out brute force", async () => {
    const s = await storeWithOrder();
    const steps = Array.from({ length: 6 }, () => () => message([toolUse("verify_customer", { order_number: s.order.number, email: "attacker@evil.com" })]));
    const calls = scriptLLM([...steps, () => message([text("I can't verify that.")])]);
    await widgetSay(s.pk, "order?");
    const results = calls.slice(1).map((c) => lastToolResults(c)[0].data.error as string);
    expect(results[0]).toMatch(/don't match/);
    expect(results.at(-1)).toMatch(/Too many failed verification attempts/);
  });

  it("queues refunds for human approval and executes on approve", async () => {
    const s = await storeWithOrder();
    scriptLLM([
      () => message([toolUse("verify_customer", { order_number: s.order.number, email: "sam@example.com" })]),
      () => message([toolUse("request_refund", { order_number: s.order.number, amount: 10, reason: "mug arrived chipped" })]),
      (p) => {
        expect(lastToolResults(p)[0].data.status).toBe("submitted_for_review");
        return message([text("I've sent your refund request to our team for review.")]);
      },
    ]);
    const chat = await widgetSay(s.pk, "my mug is chipped, refund $10 please. order " + s.order.number);
    expect(chat.messages.at(-1)!.content).toContain("review");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).paymentStatus).toBe("PAID");

    const pending = await api().get("/v1/approvals?status=PENDING").set("Authorization", `Bearer ${s.token}`);
    expect(pending.body).toHaveLength(1);
    const ok = await api().post(`/v1/approvals/${pending.body[0].id}/approve`).set("Authorization", `Bearer ${s.token}`);
    expect(ok.body.status).toBe("EXECUTED");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } });
    expect(Number(order.refundedTotal)).toBe(10);
    expect(order.paymentStatus).toBe("PARTIALLY_REFUNDED");

    const again = await api().post(`/v1/approvals/${pending.body[0].id}/approve`).set("Authorization", `Bearer ${s.token}`);
    expect(again.status).toBe(400); // no double execution
    const after = await api().get("/v1/widget/messages").set("Authorization", `Bearer ${s.pk}`).query({ visitorToken: chat.visitorToken });
    expect(after.body.messages.at(-1).content).toMatch(/refund of 10.00/);
  });

  it("executes AUTO-policy actions directly (address change)", async () => {
    const s = await storeWithOrder();
    const address = { line1: "9 New Rd", city: "Austin", postalCode: "73301", country: "US" };
    scriptLLM([
      () => message([toolUse("verify_customer", { order_number: s.order.number, email: "sam@example.com" })]),
      () => message([toolUse("update_shipping_address", { order_number: s.order.number, address })]),
      () => message([text("Done — the address is updated.")]),
    ]);
    await widgetSay(s.pk, "please ship to 9 New Rd Austin 73301 instead, yes I confirm");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } });
    expect((order.shippingAddress as { city: string }).city).toBe("Austin");
  });

  it("escalates on handoff keywords without calling the model", async () => {
    const s = await storeWithOrder();
    const calls = scriptLLM([]);
    const chat = await widgetSay(s.pk, "I want to speak to a human now");
    expect(calls).toHaveLength(0);
    expect(chat.status).toBe("PENDING_HUMAN");
    // AI stays quiet while a human owns the conversation
    const again = await widgetSay(s.pk, "hello?", chat.visitorToken);
    expect(again.messages.filter((m) => m.role === "AGENT")).toHaveLength(chat.messages.filter((m) => m.role === "AGENT").length);
  });

  it("stops replying when the monthly AI quota is exhausted", async () => {
    const s = await storeWithOrder();
    const period = new Date().toISOString().slice(0, 7);
    await prisma.usageRecord.create({ data: { tenantId: s.tenantId, period, metric: "ai_replies", quantity: 200 } });
    const calls = scriptLLM([]);
    const chat = await widgetSay(s.pk, "hi");
    expect(calls).toHaveLength(0);
    expect(chat.status).toBe("PENDING_HUMAN");
  });

  it("server-to-server messages API returns the reply inline and trusts pre-verified customers", async () => {
    const s = await storeWithOrder();
    const sk = await secretKey(s.token);
    scriptLLM([
      () => message([toolUse("list_customer_orders", {})]),
      (p) => {
        expect(lastToolResults(p)[0].data[0].number).toBe(s.order.number);
        return message([text("You have 1 order.")]);
      },
    ]);
    const res = await api()
      .post("/v1/messages")
      .set("Authorization", `Bearer ${sk}`)
      .send({ threadId: "app-user-42", content: "what are my orders?", customer: { email: "sam@example.com" }, customerVerified: true, wait: true });
    expect(res.status).toBe(200);
    expect(res.body.reply.content).toBe("You have 1 order.");
  });

  it("works against a client's own backend through the custom webhook connector", async () => {
    const t = await signup();
    let secret = "";
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        expect(verifySignature(secret, body, req.headers["x-agentdesk-signature"] as string)).toBe(true);
        const { action, params } = JSON.parse(body);
        seen.push(action);
        const order = { id: "ext-1", number: params.number ?? "A-77", source: "CUSTOM_WEBHOOK", status: "SHIPPED", paymentStatus: "PAID", currency: "EUR", subtotal: 30, shippingTotal: 0, total: 30, refundedTotal: 0, customerEmail: "kim@site.eu", items: [], placedAt: new Date().toISOString(), trackingNumber: "TRK1", carrier: "DPD" };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ order }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const integ = await api().post("/v1/integrations").set("Authorization", `Bearer ${t.token}`).send({ type: "CUSTOM_WEBHOOK", config: { endpointUrl: `http://127.0.0.1:${port}/agentdesk` } });
    secret = integ.body.signingSecret;
    expect(secret).toMatch(/^whsec_/);

    scriptLLM([
      () => message([toolUse("verify_customer", { order_number: "A-77", email: "kim@site.eu" })]),
      () => message([toolUse("get_order", { order_number: "A-77" })]),
      (p) => {
        expect(lastToolResults(p)[0].data.tracking.number).toBe("TRK1");
        return message([text("It shipped with DPD, tracking TRK1.")]);
      },
    ]);
    const chat = await widgetSay(t.pk, "where is A-77? kim@site.eu");
    server.close();
    expect(seen).toEqual(["order.get", "order.get"]);
    expect(chat.messages.at(-1)!.content).toContain("TRK1");
  });

  it("refusals hand the conversation to a human", async () => {
    const s = await storeWithOrder();
    scriptLLM([() => message([], "refusal")]);
    const chat = await widgetSay(s.pk, "something odd");
    expect(chat.status).toBe("PENDING_HUMAN");
    expect(chat.messages.at(-1)!.role).toBe("AGENT");
  });
});
