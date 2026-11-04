# AgentDesk — AI customer-service & order-management agent (multi-tenant SaaS)

AgentDesk is a SaaS platform that any online store can connect to. Once a website is connected, an AI agent
(powered by Claude) **replies to customers automatically** and **manages orders**: tracking, cancellations,
refunds, address changes, product questions and new orders. Sensitive actions can be routed to a human for approval, and
the agent hands off to the store's team whenever it should.

One deployment serves many client businesses (tenants). Each tenant has its own agents, knowledge base, orders,
integrations, team, API keys, billing plan and usage limits, fully isolated from every other tenant.

```
 Client website ──<script> widget──┐            ┌── Shopify / WooCommerce / client's own backend
 Client backend ──REST API (sk_)───┤            │        (live order + catalogue lookups)
 Email / WhatsApp ──inbound hooks──┤            │
                                   ▼            │
                   ┌──────────── AgentDesk API (stateless, N replicas) ────────────┐
                   │ auth · tenancy · orders · conversations · approvals · billing │
                   └──────┬──────────────────────────┬───────────────────┬─────────┘
                          │ BullMQ (Redis)           │ Postgres          │ Redis pub/sub
                          ▼                          │                   ▼
                 Workers (N replicas)                │        realtime → dashboards / widget
                 Claude tool-use agent loop ─────────┘
                 webhooks · automations · email/WhatsApp delivery
```

## Features

| Area | What you get |
|---|---|
| **AI auto-reply** | Claude tool-use agent per tenant, with a configurable persona, instructions, language, reasoning effort and greeting. Prompt caching keeps cost down, and safety refusals fall back to another model on the server side. |
| **Order management** | Look up, list, cancel, refund, change the address of, and create orders. Includes product search and stock checks, a built-in order system with stock reservation and status-transition rules, and a full order event history. |
| **Connect any website** | A one-line chat widget, a native REST API (push orders and the catalogue), **Shopify**, **WooCommerce**, or a **custom webhook** connector so the agent calls the client's own backend. |
| **Safety** | Customer identity verification (order number + email) before any order data is shared, with brute-force lockout. Per-tool policies: Auto / Needs approval / Off. Refund limit guardrail, handoff keywords, and prompt-injection-hardened prompts. |
| **Human in the loop** | Approvals queue, a realtime shared inbox, human takeover / hand back to AI, internal notes, assignment and tags. |
| **Channels** | Website widget, server-to-server Messages API (use it for any chat UI or app), email (inbound parse + Postmark/SendGrid/Resend), and WhatsApp Cloud API. |
| **Automations** | Event → condition → action rules, e.g. "when an order ships, message the customer with tracking". |
| **Webhooks** | Signed (`t=…,v1=HMAC`) outbound events with retries and a delivery log. |
| **SaaS plumbing** | Workspaces, roles (Owner/Admin/Support/Viewer), invites, secret and publishable API keys with origin allow-lists, plans with limits, usage metering, Stripe checkout/portal/webhooks, audit log, analytics, and a platform-operator console. |
| **Scale** | Stateless API, horizontally scaled workers, a per-conversation distributed lock, debouncing of message bursts, Redis rate limits, and realtime fan-out over Redis pub/sub. |

## Repository layout

```
apps/api        Express + Prisma (Postgres) + BullMQ (Redis) + Claude agent runtime   ← the platform
  src/agent       runtime.ts (tool-use loop) · prompt.ts · tools/ (order, KB, handoff tools)
  src/connectors  native · shopify · woocommerce · customWebhook   (CommerceConnector interface)
  src/modules     orders · conversations · approvals · automations · billing · channels · webhooks
  src/routes      REST API (v1)
  prisma/         schema, migrations, demo seed
  test/           integration tests (real Postgres, scripted model)
apps/dashboard  React admin app: inbox, approvals, orders, agents, knowledge, integrations, billing…
apps/widget     6 KB embeddable chat widget (Shadow DOM, no dependencies)
docs/           INTEGRATION.md (connect a website) · API.md · ARCHITECTURE.md
```

## Quick start (local)

Requirements: Node 20+, Postgres 14+, Redis 6+ (or use `docker compose up postgres redis`).

```bash
npm install
```

```bash
cp .env.example apps/api/.env
```

Then edit `apps/api/.env`: set `DATABASE_URL`, set `JWT_SECRET` (`openssl rand -hex 32`), set
`ENCRYPTION_KEY` (`openssl rand -base64 32`) and `ANTHROPIC_API_KEY`.

```bash
npm run db:migrate && npm run db:seed
```

The seed prints a demo login and API keys. Then start the services, each in its own terminal:

```bash
npm run dev:api
```

```bash
npm run dev:dashboard
```

```bash
npm run build -w @agentdesk/widget
```

Open http://localhost:5173 and log in with `owner@demo.store` / `password123`. Put the printed publishable key into
`apps/widget/demo.html`, open that file, and ask the bubble: *"Where is order 1002? My email is sam@example.com"*.

With `INLINE_JOBS=true` (the default in `.env.example`), AI replies run inside the API process, so you don't need a worker.
For production, set it to `false` and run workers:

```bash
npm run dev:worker
```

### Full stack in Docker

```bash
docker compose up --build
```

This starts the API on :4000, 2 workers, and the dashboard on :8080.

### Tests

```bash
npm test
```

The suite runs against a real Postgres database (`agentdesk_test`) with a scripted model. It covers tenant isolation, roles, the order
lifecycle, identity verification and lockout, approvals, automations, the custom-backend connector, quotas, refusals and outage fallback.

## How a client connects their website

1. Sign up, which creates a workspace, a default agent "Ava", starter policies and a widget key.
2. Paste the widget `<script>` (Developers page) into the site.
3. Connect orders, using one of:
   - **Shopify** or **WooCommerce**: paste API credentials and add the shown webhook URL.
   - **Built-in**: the site's checkout `POST /v1/orders` and `PUT /v1/products` with a secret key.
   - **Custom backend**: implement one signed RPC endpoint (see [docs/INTEGRATION.md](docs/INTEGRATION.md)).
4. Tune the agent: persona, instructions, which actions are automatic or need approval, refund limit, and knowledge articles.

Full guide: [docs/INTEGRATION.md](docs/INTEGRATION.md) · API reference: [docs/API.md](docs/API.md) · Design and scaling: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
