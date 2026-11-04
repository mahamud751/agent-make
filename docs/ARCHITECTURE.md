# Architecture & scaling

## Components

| Process | Role | Scale |
|---|---|---|
| **API** (`dist/server.js`) | REST v1, auth, socket.io realtime, inbound webhooks | stateless; run N replicas behind a load balancer (sticky sessions only needed for socket.io long-polling) |
| **Worker** (`dist/worker.js`) | BullMQ consumers: `agent.reply`, `webhook.deliver`, `automation.run`, `email.send`, `whatsapp.send` | N replicas × `WORKER_CONCURRENCY` (default 20) |
| **Postgres** | system of record, with every tenant row keyed by `tenantId` | managed PG + read replicas; partition `Message`/`AgentRun` by month at very high volume |
| **Redis** | job queue, distributed locks, rate limits, realtime pub/sub | managed Redis (cluster mode OK) |

## Message → reply flow

1. A customer message arrives (widget / API / email / WhatsApp). `conversationService.addMessage` persists it, pushes it
   realtime to the dashboard, emits `message.created`, and enqueues `agent.reply` (job id = message id, so it is idempotent).
2. A worker takes a **per-conversation Redis lock**, so two workers never answer the same chat at once.
   If the customer sent more messages after the trigger, the job is *superseded* and the newest job answers them all (debounce).
3. Pre-checks: the agent's auto-reply is on, the conversation is not with a human, the plan quota is not exhausted, and no handoff keywords appear.
4. **Agent loop** (`src/agent/runtime.ts`):
   * `system` holds the tenant and agent prompt (stable, so it is **prompt-cached** across every conversation of that agent),
     followed by the deterministic tool list.
   * The history is the last 40 messages. Per-turn facts (time, channel, verification state) are appended as a mid-conversation
     `system` message, so the cached prefix is never invalidated.
   * `claude-opus-5-5` runs with adaptive thinking, and the agent's `effort` (default `medium`) controls depth.
     `fallbacks: "default"` means a safety-classifier refusal is retried server-side on Anthropic's recommended fallback model.
   * Each tool call goes through **policy**: DISABLED tools are never exposed, and APPROVAL tools run their `precheck`
     (ownership + business rules) and then create a `PendingAction` instead of executing. A guardrail
     (`maxRefundAmount`) can force approval. Parallel tool calls run concurrently and return in one message.
   * At most 8 tool iterations. Refusal → polite reply + escalate.
5. The reply is stored, tokens and usage are metered (`UsageRecord`), and an `AgentRun` row records the model, tokens,
   cache hits, tool calls and latency.
6. If the job fails 3 times (model outage, bad key), the failure handler escalates and tells the customer a human will reply.

## Multi-tenancy & security model

* **Isolation:** every query filters on `tenantId` from the authenticated context, never from the request body.
  Tests assert that cross-tenant reads return 404.
* **Keys:** API keys and visitor tokens are stored as SHA-256 hashes, and raw keys are shown once. Publishable keys only reach
  `/widget/*` and can be pinned to origins. Integration credentials and webhook secrets are encrypted with AES-256-GCM
  (`ENCRYPTION_KEY`).
* **Customer identity:** the model can't read order data until the conversation is verified, by order number plus the
  checkout email, by a trusted server (`customerVerified`), or by the email sender. The same error is returned for
  "no such order" and "wrong email" to prevent enumeration, with a lockout after 5 failures. The tools themselves enforce
  ownership, so a manipulated model still can't read another customer's orders.
* **Prompt injection:** the system prompt treats customer text and tool output as untrusted. The real protection is
  structural: tools are tenant-scoped, ownership-checked, schema-validated (`strict` tool schemas + zod) and policy-gated, and
  money-moving actions default to human approval.
* **Webhooks:** outbound and custom-connector calls are HMAC-signed with a timestamp (replay window 5 minutes). Inbound
  Shopify/Woo webhooks are verified with the platform's HMAC. Stripe webhooks are verified with the Stripe SDK.
* **Approvals** are claimed atomically (`updateMany where status=PENDING`), so double-clicks or two reviewers can't execute twice.
* **Roles:** OWNER (billing, roles), ADMIN (config, keys, integrations), SUPPORT (inbox, orders, approvals), VIEWER.

## Adding a new commerce platform

Implement `CommerceConnector` (`src/connectors/types.ts`): `getOrderByNumber`, `listOrdersByEmail`, `cancelOrder`,
`refundOrder`, `updateShippingAddress`, `searchProducts`, `getProductBySku`, and optionally `createOrder`. Add a case to
`buildConnector` and an inbound webhook mapper if the platform pushes events. Every agent tool then works unchanged.

## Adding a new agent tool

Add a `defineTool({...})` entry in `src/agent/tools/index.ts` with a zod schema, a JSON schema, `defaultPolicy`, an optional
`precheck` / `forceApproval`, and `run`. It automatically appears in the dashboard's policy table.

## Production checklist

* `INLINE_JOBS=false`, at least 2 workers, and `NODE_ENV=production`.
* Strong `JWT_SECRET` and `ENCRYPTION_KEY` (rotate with a re-encrypt job), HTTPS everywhere, and `PUBLIC_API_URL` set.
* Postgres backups and PITR. Redis persistence (AOF) so queued jobs survive restarts.
* Observability: pino JSON logs → your log stack, BullMQ metrics, and `AgentRun` for per-tenant AI cost dashboards.
* Configure Stripe prices (`STRIPE_PRICE_*`) and webhooks, plus email and WhatsApp provider credentials per tenant.
