# AgentDesk REST API (v1)

Base URL: `https://api.<your-domain>/v1`. All bodies are JSON.

**Authentication**: `Authorization: Bearer <token>`, where the token is one of:

| Token | Who | Access |
|---|---|---|
| JWT (from `/auth/login`) | dashboard users | per role: OWNER > ADMIN > SUPPORT > VIEWER |
| `sk_live_…` secret key | the tenant's servers | admin-level API (no team/billing changes) |
| `pk_live_…` publishable key | browser widget | `/widget/*` only, origin-restricted |

Errors look like `{ "error": { "code": "…", "message": "…", "details"? } }`. The status codes are 400 validation, 401, 403,
402 plan limit, 404, 409 conflict and 429 rate limited. Rate-limit headers: `X-RateLimit-Limit` and `X-RateLimit-Remaining`.

## Auth & workspace
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/auth/signup` | – | `{name,email,password,company}` → token + publishable key |
| POST | `/auth/login` | – | `{email,password,tenantId?}` |
| GET | `/auth/me` | user | user, role, tenant, workspaces |
| POST | `/auth/switch` | user | `{tenantId}` → new token |
| POST | `/auth/invites/accept` | – | `{token,name?,password}` |
| GET/PATCH | `/tenant` | VIEWER/ADMIN | name, timezone, settings (email, whatsapp) |
| GET | `/members` · POST `/members/invite` · PATCH/DELETE `/members/:id` | | team management |
| GET/POST | `/api-keys` · PATCH/DELETE `/api-keys/:id` | ADMIN | raw key returned once |
| GET | `/audit-logs` | ADMIN | |

## AI agents & knowledge
| Method | Path | Notes |
|---|---|---|
| GET | `/agents/tools` | tool catalogue + default policies |
| GET/POST | `/agents` | create: `{name, persona?, instructions?, language?, effort?, autoReply?, greeting?, toolPolicies?, guardrails?, widgetTheme?}` |
| GET/PATCH/DELETE | `/agents/:id` | `toolPolicies: {cancel_order: "AUTO"\|"APPROVAL"\|"DISABLED", …}`, `guardrails: {maxRefundAmount, handoffKeywords}` |
| GET/POST | `/knowledge` · PATCH/DELETE `/knowledge/:id` | articles `{title, content, tags?, published?}` |
| GET | `/knowledge/search?q=` | test retrieval |

## Commerce
| Method | Path | Notes |
|---|---|---|
| GET | `/products?search=` | |
| PUT | `/products` | bulk upsert `{products:[{sku,name,price,stock?,…}]}` (≤1000) |
| POST · PATCH · DELETE | `/products` · `/products/:id` | delete = deactivate |
| GET | `/customers` · `/customers/:id` | with orders + conversations |
| GET | `/orders?status=&search=&cursor=&limit=` | cursor pagination `{data,nextCursor}` |
| POST | `/orders` | `{number?, customer:{email,name?}, items:[{sku,quantity}], shippingAddress?, shippingTotal?, paymentStatus?, status?}`; validates & reserves stock |
| GET | `/orders/:id` | includes event history |
| POST | `/orders/:id/status` | `{status, trackingNumber?, carrier?, note?}` (transition rules enforced) |
| POST | `/orders/:id/cancel` | `{reason}`; restocks; paid → full refund |
| POST | `/orders/:id/refund` | `{amount, reason}` ≤ remaining |
| PATCH | `/orders/:id/address` | address object; only before shipping |
| POST | `/orders/:id/payment` · `/orders/:id/notes` | |

## Conversations
| Method | Path | Notes |
|---|---|---|
| GET | `/conversations?status=&channel=&assignedToMe=&cursor=` | inbox |
| GET | `/conversations/:id` | messages, agent runs, pending actions |
| POST | `/conversations/:id/messages` | `{content, internal?, takeOver?=true}`: a human reply pauses the AI |
| POST | `/conversations/:id/resume-ai` · `/resolve` · `/assign` `{userId}` · `/tags` `{tags}` | |
| POST | `/messages` | **server-to-server channel**: `{threadId, content, channel?, customer?, customerVerified?, wait?}` |

## Approvals
| GET | `/approvals?status=PENDING` | |
|---|---|---|
| POST | `/approvals/:id/approve` | runs the tool with the identity captured when requested, and notifies the customer |
| POST | `/approvals/:id/reject` | `{note?}`, which is sent to the customer |

## Automations & webhooks
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/automations` · PATCH/DELETE `/automations/:id` | `{name, event, conditions:{path: value\|[values]}, actions:[…]}` |
| GET/POST | `/webhooks` · DELETE `/webhooks/:id` · GET `/webhooks/:id/deliveries` | `{url, events:["*"\|event…]}` → secret once |

Actions: `{type:"notify_customer", template}`, `{type:"email", to, subject, template}` and `{type:"tag_conversation", tag}`.
Events: `order.created`, `order.status_changed`, `order.updated`, `order.refunded`, `conversation.created`,
`conversation.escalated`, `conversation.resolved`, `message.created`, `action.pending` and `action.decided`.

Webhook payload: `{ id, type, createdAt, data }`, with headers `x-agentdesk-event`, `x-agentdesk-delivery` and
`x-agentdesk-signature: t=…,v1=…`. Failed deliveries retry 8 times with exponential backoff.

## Integrations
| GET/POST | `/integrations` | `{type:"SHOPIFY"\|"WOOCOMMERCE"\|"CUSTOM_WEBHOOK", name?, config}` (credentials are encrypted at rest) |
|---|---|---|
| POST | `/integrations/:id/test` | live connectivity check |
| PATCH/DELETE | `/integrations/:id` | pause/resume, rotate config |

## Widget (publishable key)
| POST | `/widget/session` | `{visitorToken?, agentId?, customer?}` → `{conversationId, visitorToken, agent, messages}` |
|---|---|---|
| POST | `/widget/messages` | `{visitorToken, content}` |
| GET | `/widget/messages?visitorToken=&after=` | polling. Realtime is also available over socket.io at path `/realtime` with `auth:{visitorToken, conversationId}` |

## Billing, analytics, platform
| GET | `/billing` | plan, limits, usage |
|---|---|---|
| POST | `/billing/checkout` `{plan}` · `/billing/portal` | Stripe redirect URLs (OWNER) |
| POST | `/billing/webhooks/stripe` | Stripe → subscription status/plan |
| GET | `/analytics/overview?days=30` | volumes, automation rate, AI latency/tokens, revenue |
| GET/PATCH | `/platform/tenants[/:id]` | SaaS operator only (`PLATFORM_ADMIN_EMAILS`) |

## Inbound (public, signature-verified)
`POST /inbound/shopify/:integrationId` · `POST /inbound/woocommerce/:integrationId` · `POST /inbound/email` ·
`GET|POST /inbound/whatsapp/:tenantSlug`
