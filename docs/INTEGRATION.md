# Connecting a website to AgentDesk

A client store connects in two parts:

1. **Conversations**: where customers talk to the agent (the widget, the Messages API, email, WhatsApp).
2. **Commerce backend**: where the agent reads and changes orders (built-in, Shopify, WooCommerce, or the store's own API).

## 1. Chat widget

```html
<script src="https://api.your-agentdesk.com/agentdesk.js"
        data-key="pk_live_xxx"            <!-- publishable key (Developers page) -->
        data-api="https://api.your-agentdesk.com"
        data-email="shopper@example.com"  <!-- optional: logged-in shopper -->
        data-name="Sam"                   <!-- optional -->
        async></script>
```

* Restrict the publishable key to the store's domains (`allowedOrigins`) so it can't be reused on other sites.
* The widget keeps a visitor token in `localStorage`, so a returning visitor resumes the same conversation.
* JS API: `AgentDesk.open()`, `AgentDesk.close()`, `AgentDesk.identify({ email, name })`.

## 2. Server-to-server Messages API (custom chat UI, mobile app, SMS gateway…)

```bash
curl -X POST https://api.your-agentdesk.com/v1/messages \
  -H "Authorization: Bearer sk_live_xxx" -H "content-type: application/json" \
  -d '{
    "threadId": "app-user-42",          // your conversation key
    "content": "Where is my order?",
    "customer": { "email": "sam@example.com", "name": "Sam" },
    "customerVerified": true,           // your app already logged this user in
    "wait": true                         // return the AI reply in the response
  }'
```

When you set `customerVerified: true`, the agent can look up that email's orders without asking the customer to verify.
Only set it for users your own system has authenticated.

## 3. Commerce backends

### A. Built-in order system (default)

The store pushes its catalogue and orders to AgentDesk:

```bash
# idempotent catalogue sync (upsert by SKU)
curl -X PUT  .../v1/products -H "Authorization: Bearer sk_live_xxx" -H "content-type: application/json" \
  -d '{"products":[{"sku":"TENT-2P","name":"2P Tent","price":189,"stock":40}]}'
```

```bash
# from checkout
curl -X POST .../v1/orders -H "Authorization: Bearer sk_live_xxx" -H "content-type: application/json" \
  -d '{"number":"1042","customer":{"email":"sam@example.com"},"items":[{"sku":"TENT-2P","quantity":1}],"paymentStatus":"PAID"}'
```

```bash
# fulfilment
curl -X POST .../v1/orders/<id>/status -H "Authorization: Bearer sk_live_xxx" -H "content-type: application/json" \
  -d '{"status":"SHIPPED","carrier":"UPS","trackingNumber":"1Z..."}'
```

Subscribe to AgentDesk webhooks (`order.status_changed`, `order.refunded`, …) to learn about changes the agent
made, such as a cancellation or a refund. You then apply them in your payment provider or ERP.

### B. Shopify

Integrations → Shopify: enter the shop domain, an Admin API access token (scopes `read_orders, write_orders,
read_products`), and the webhook signing secret. Then add the shown URL as a webhook for `orders/create`,
`orders/updated`, `orders/cancelled` and `orders/fulfilled`. The agent reads live data from Shopify and mirrors orders
locally for the dashboard, analytics and automations.

### C. WooCommerce

Integrations → WooCommerce: enter the site URL plus a REST API consumer key and secret (read/write). Add a webhook
(topic *Order updated* / *Order created*) pointing at the shown URL, with the same secret.

### D. Custom backend (any stack)

Use this when the store has its own platform. Implement **one HTTPS endpoint**. AgentDesk POSTs
`{ action, params, sentAt }` to it and expects JSON back:

| action | params | response |
|---|---|---|
| `order.get` | `{ number }` | `{ order: Order \| null }` |
| `orders.by_email` | `{ email, limit }` | `{ orders: Order[] }` |
| `order.cancel` | `{ number, reason, actor }` | `{ order }` |
| `order.refund` | `{ number, amount, reason, actor }` | `{ order }` |
| `order.update_address` | `{ number, address, actor }` | `{ order }` |
| `products.search` | `{ query, limit }` | `{ products: Product[] }` |
| `product.get` | `{ sku }` | `{ product \| null }` |
| `order.create` | `{ customer, items, shippingAddress, notes, actor }` | `{ order }` |

```ts
type Order = {
  id: string; number: string;
  status: "PENDING"|"CONFIRMED"|"PROCESSING"|"SHIPPED"|"DELIVERED"|"CANCELLED"|"REFUNDED"|"ON_HOLD";
  paymentStatus: "UNPAID"|"PAID"|"PARTIALLY_REFUNDED"|"REFUNDED"|"FAILED";
  currency: string; subtotal: number; shippingTotal: number; total: number; refundedTotal: number;
  customerEmail: string; customerName?: string;
  items: { sku: string; name: string; quantity: number; unitPrice: number }[];
  shippingAddress?: { name?: string; line1: string; line2?: string; city: string; state?: string; postalCode: string; country: string };
  trackingNumber?: string; carrier?: string; placedAt: string; // ISO
};
type Product = { id: string; sku: string; name: string; price: number; currency: string; stock: number; description?: string; url?: string };
```

Return a non-2xx response with a short message to refuse an action, for example `409 {"error":"Order already shipped"}`.
The agent relays the refusal politely.

**Verify every request.** Each call carries `X-AgentDesk-Signature: t=<unix>,v1=<hex>`, where
`v1 = HMAC_SHA256(signingSecret, "<t>.<raw body>")`. The signing secret is shown once when you connect the integration.

```js
// Node / Express example
import crypto from "node:crypto";
app.post("/agentdesk", express.raw({ type: "application/json" }), (req, res) => {
  const header = req.get("X-AgentDesk-Signature") ?? "";
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = crypto.createHmac("sha256", process.env.AGENTDESK_SECRET).update(`${t}.${req.body}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  if (!fresh || !v1 || !crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) return res.sendStatus(401);
  const { action, params } = JSON.parse(req.body);
  // ...switch (action) { case "order.get": ... }
});
```

Outbound AgentDesk webhooks (Developers → Webhooks) use the same signature scheme.

## 4. Email & WhatsApp

* **Email:** point your inbound-parse provider at `POST /v1/inbound/email` with header `x-inbound-secret`. Send
  the normalised payload `{ from, fromName, to, subject, text, messageId }`. Mail addressed to `<tenant-slug>@…` starts a
  thread, and replies to `c+<conversationId>@…` continue it. Configure outbound email under tenant settings
  (`postmark` | `sendgrid` | `resend`).
* **WhatsApp Cloud API:** set `settings.whatsapp = { phoneNumberId, accessToken, verifyToken }` and use
  `https://api…/v1/inbound/whatsapp/<tenant-slug>` as the callback URL in Meta.

## 5. Recommended agent setup

* Keep **cancel** and **refund** on *Needs approval* until you trust the agent. Then switch them to *Allowed*, keeping a
  refund guardrail (for example: refunds above $50 always need approval).
* Write knowledge articles for shipping, returns, warranty, payment methods and sizing. The agent is told never to guess policies.
* Add store-specific instructions, such as tone, discount codes it may offer, and things it must never promise.
