# Buildwise — Technical Architecture

## Status

**M0 — Frozen target architecture**

---

# 1. Architecture principle

Buildwise is a Google Cloud-native application with external commerce systems integrated through controlled backend services.

```text
Customer
  WhatsApp
     ↓
Buildwise backend
     ↓
AI agent + commerce context
     ↓
Verified action
     ↓
Retailer / Shopify
```

---

# 2. High-level architecture

```
                         BUILDWISE
                            │
                ┌───────────┴───────────┐
                ↓                       ↓
          BRAND CONSOLE          RETAILER CONSOLE
          React + TypeScript     React + TypeScript
                │                       │
                └───────────┬───────────┘
                            ↓
                       Firebase
                    Hosting + Auth
                            ↓
                        Cloud Run
                   Node.js + TypeScript
                         Express
                            │
          ┌─────────────────┼─────────────────┐
          ↓                 ↓                 ↓
      Firestore          ADK + Gemini    Business Rules
                            │
                       Vertex AI
                            │
       ┌────────────────────┼────────────────────┐
       ↓                    ↓                    ↓
    Shopify             WhatsApp             Retail
       │                    │                    │
       └────────────────────┼────────────────────┘
                            ↓
                       Buildwise Context
                            ↓
                        Next Action
                            ↓
                       Outcome Events
                            ↓
                         BigQuery
                            ↓
                     Looker (optional)
```

---

# 3. Frontend

Technology:

**React + TypeScript + Vite**

Responsibilities:

- Brand Console
- Retailer Console
- contextual task pages
- authentication UI
- connection setup
- conversation/operation views
- status and error states

The customer does not receive a full Buildwise dashboard.

# 4. Backend:

Technology:

- Node.js 24
- TypeScript
- Express

Agent:

- Google ADK for TypeScript

---

# 5. Firebase

## Firebase Hosting

Hosts the web application.

## Firebase Authentication

Identity for:

- brand users
- retailer users
- team members

Customer identity for WhatsApp is handled through the customer/channel identity model rather than requiring a Buildwise customer portal.

---

# 6. Cloud Run

Cloud Run is the central backend runtime.

Responsibilities:

- API endpoints
- Shopify integration
- WhatsApp webhook handling
- retail-file processing orchestration
- customer context assembly
- AI orchestration
- authorization
- business rules
- reservation workflow
- audit events
- analytics event emission

Cloud Run is the service boundary between the web application, external services, data layer and AI layer.

Cloud Run instances are **stateless**. No conversation, session, token or rate-limit state that must survive a request may live only in instance memory (per-instance rate limiting in §16.4 is the one accepted MVP exception). Any instance must be able to handle any request.

Authenticated requests follow the Firebase ID token → Cloud Run → authorization chain defined in `07_SECURITY_SPEC.md` §4.1.

---

# 7. Firestore

Firestore is the operational application database.

Every persisted entity in `04_DATA_MODEL.md` has a collection. The authoritative path layout is `04_DATA_MODEL.md` §21.

Tenant-scoped (under `brands/{brand_id}/`):

```text
connections
customers
products
productVariants
productMappings
stores
retailInventory
customerIntents
conversations
conversations/{conversation_id}/messages   (ConversationMessage)
aiRecommendations
reservations
outcomes
commerceEvents
auditEvents
```

Top-level (looked up before the brand is known; each document carries `brand_id`):

```text
brands
users
intentTokens
pageAccessTokens
webhookReceipts
```

Use tenant-aware document paths and server-side authorization.

**Client access rule (MVP):** React never reads or writes Firestore directly. All data access goes through Cloud Run using the Firebase Admin SDK. Firestore security rules deny all client reads and writes.

---

# 8. AI architecture

```text
Customer input
      ↓
Cloud Run
      ↓
Context builder
      ↓
ADK
      ↓
Gemini
      ↓
Tool calls where required
      ↓
Structured decision
      ↓
Action guardrail
      ↓
Backend action
```

## 8.1 ADK execution model

ADK runs **inside the Cloud Run request**. Each run is stateless and request-scoped.

```text
Inbound request
(WhatsApp webhook message | POST /api/ai/decide)
      ↓
Load conversation state from Firestore
(conversation, recent messages, current intent, prior recommendations)
      ↓
Build controlled context package
      ↓
Create ADK runner + in-memory session for THIS request only
      ↓
Gemini reasoning + tool calls (tools = backend functions, guardrail enforced)
      ↓
Validate structured decision
      ↓
Persist to Firestore
(messages, AIRecommendation, CommerceEvents, audit, any executed action)
      ↓
Discard runner and session
```

Rules:

- Firestore is the only durable conversation state. The ADK in-memory session is rebuilt from Firestore on every request and thrown away when the request ends.
- No persistent ADK session service, background agent loop or long-lived agent process is used in the MVP.
- Agent tools are in-process backend functions. They call the same domain services as the HTTP API. They are not HTTP calls back into Cloud Run.
- The WhatsApp webhook and the Web Conversation Simulator (`POST /api/ai/decide`) use this same execution path.
- Inbound WhatsApp messages are processed synchronously within the webhook request, under the time budget in §16.1. A Meta redelivery that arrives while the first delivery is still processing is dropped by the webhook receipt (§16.3).
- MVP limitation: if a customer sends two messages in quick succession, each is processed in its own run against the Firestore state at run start. Strict per-conversation serialization is out of MVP scope.

---

# 9. External systems

## Shopify

Source of truth for online commerce.

## WhatsApp Cloud API

Customer communication channel.

## Retail file

Source for physical store/inventory information in MVP.

---

# 10. Data/analytics architecture

Operational:

```text
Firestore
```

Historical/event:

```text
BigQuery
```

Visualization:

```text
Looker (optional for the MVP)
```

The frontend may still display key metrics directly where needed.

Looker is an optional business-intelligence layer, not the primary customer/retailer application UI. The Brand Console must work without it.

---

# 11. File storage

Cloud Storage:

- retail uploads
- product assets
- store assets
- demo datasets
- generated reports where needed

Firestore stores metadata/references.

---

# 12. Secrets

Use:

**Google Secret Manager**

for:

- external API credentials
- access tokens
- webhook secrets
- application secrets

Never expose sensitive credentials to React.

---

# 13. Optional components

These are not required for the first working MVP:

```text
Pub/Sub
Vertex AI Search
Cloud SQL
AlloyDB
advanced Looker modeling
```

They may be introduced only when a concrete requirement justifies them.

---

# 14. Final responsibility split

```text
React
→ experience

Firebase
→ identity + hosting

Cloud Run
→ backend + orchestration + policies

Firestore
→ current application state

ADK
→ agent orchestration

Gemini
→ reasoning + language + next-best action

Shopify
→ online commerce source

WhatsApp
→ customer channel

Retail data
→ physical commerce input

BigQuery
→ historical analytics

Looker
→ optional brand BI
```

---

# 15. Reservation transaction

Reservation creation **must** run inside a single Firestore transaction, so that concurrent reservations cannot overbook inventory.

```text
runTransaction:
  1. read reservations/{reservation_id}
       reservation_id is derived from idempotency_key.
       If it exists → return the existing reservation (idempotent replay).
  2. read stores/{store_id}
       require store_status = ACTIVE and reservation_available = true
  3. read retailInventory/{store_id + canonical_sku}
       available_quantity = quantity − reserved_quantity
       require available_quantity ≥ requested quantity
  4. read brand reservation_policy
       require reservations_enabled and quantity ≤ max_quantity_per_reservation
  5. write reservations/{reservation_id}  status = PENDING, expires_at
  6. update retailInventory: reserved_quantity += quantity
  7. write CommerceEvent RESERVATION_CREATED + AuditEvent
commit
```

Why this works: every reservation for the same store × SKU reads and writes the same `retailInventory` document. Firestore therefore serializes the competing transactions. The losing transaction retries, reads the updated `reserved_quantity` and fails the availability check.

If a check fails, nothing is written. The caller receives a verified, specific reason, such as `OUT_OF_STOCK`, `STORE_INACTIVE` or `RESERVATIONS_DISABLED`, and the AI explains it without inventing alternatives.

Every later status transition that changes inventory (CANCELLED, EXPIRED, COMPLETED) uses the same transaction pattern. The effects are listed in `04_DATA_MODEL.md` §15.

**Expiry:** a sweep marks reservations past `expires_at` (still PENDING, CONFIRMED or READY) as `EXPIRED`, releasing each one in its own transaction. For the MVP, the sweep is an internal Cloud Run endpoint invoked on a schedule. The retailer console also triggers it when the reservation list loads.

---

# 16. MVP reliability rules

These rules cover the MVP. The numbers are prototype defaults and may be tuned.

## 16.1 Gemini timeout

```text
per Gemini call timeout          10 s
total AI decision budget         20 s per inbound message / decide request
```

If the budget is exhausted, the request stops calling Gemini and uses the deterministic fallback (§16.2).

## 16.2 Retry and fallback

| Dependency | Retry | On final failure |
|---|---|---|
| Gemini (timeout, 429, 5xx) | 1 retry with jittered backoff, only if the budget remains | Deterministic fallback |
| Gemini (invalid structured output) | 1 repair attempt with the validation error | Deterministic fallback |
| WhatsApp send (429, 5xx, network) | up to 2 retries with exponential backoff, same outbound request ID | Message marked `FAILED`; visible in Brand Console |
| Shopify API (429, 5xx) | exponential backoff respecting Shopify throttling, up to 3 retries | Sync marked failed on the connection (`last_error`) |
| Firestore transaction contention | handled by the Firestore SDK transaction retry | Reservation request fails with a retryable error |
| 4xx validation / auth errors | never retried | Normalized error (`06_INTEGRATION_CONTRACTS.md` §16) |

**Deterministic fallback:** Buildwise sends a fixed, safe holding reply. It never claims stock, price or policy. The AIRecommendation is recorded with `action = HUMAN_HANDOFF` and `decision_source = DETERMINISTIC_FALLBACK` when human handoff is enabled for the brand. Otherwise it is recorded with `action = NO_ACTION` and a reply asking the customer to try again. The fallback never executes a commerce action.

## 16.3 Webhook idempotency

Every webhook is handled in this order:

```text
1. verify signature          (reject 401 on failure, nothing persisted)
2. derive idempotency key
3. create webhookReceipts/{key} with create-if-absent
       already exists → return 200, do nothing
4. process
5. mark receipt PROCESSED (or FAILED)
6. return 200
```

Idempotency keys:

| Source | Key |
|---|---|
| Shopify webhook | `SHOPIFY:{brand_id}:{event_type}:{X-Shopify-Webhook-Id}` |
| WhatsApp inbound message | `WHATSAPP:{phone_number_id}:MESSAGE:{wamid}` |
| WhatsApp status update | `WHATSAPP:{phone_number_id}:STATUS:{wamid}:{status}` |
| Reservation request | client-supplied `idempotency_key` scoped to brand + customer (§15) |
| Analytics event | `CommerceEvent.idempotency_key` |

This follows the rule in `06_INTEGRATION_CONTRACTS.md` §8 (external_event_id + event_type + brand_id).

If processing fails after the receipt was created, the receipt is marked `FAILED` and the handler returns 5xx so that the provider redelivers. A redelivery that finds a `FAILED` receipt may process again. One that finds a `PROCESSING` or `PROCESSED` receipt is dropped.

## 16.4 Rate limiting and abuse protection

Defined in `07_SECURITY_SPEC.md` §17. In summary:

- per-IP and per-brand request limits on public endpoints (`POST /api/intents`, customer-page endpoints)
- per-conversation limits on AI decisions
- request body size limits on every endpoint
- a Cloud Run max-instances cap to bound cost under abuse

For the MVP, HTTP rate limiting may be in-memory per instance. The per-conversation AI limit is enforced through Firestore, because it must hold across instances.

---

# 17. Critical API contracts

The minimal request/response contracts for the critical endpoints are in `06_INTEGRATION_CONTRACTS.md` §14.1–§14.5.
