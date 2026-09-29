# Buildwise — Integration Contracts

## Status

**M0 — Interfaces frozen before external implementation.** Updated by the post-M0 architecture change (`00_M0_SPECIFICATION_FREEZE.md` §11.8): provider ports, simulator channel, platform/brand administration routes.

---

# 1. Principle

Buildwise should depend on stable internal interfaces rather than directly coupling the entire application to Shopify, WhatsApp, or the retail file implementation.

```text
Buildwise domain logic
        ↓
Internal contract (port)
        ↓
Provider (adapter)
        ↓
External system
```

## 1.1 Provider ports

These five ports are the **only** points where the `local` and `gcp` execution profiles differ (`03_TECH_ARCHITECTURE.md` §2.2):

| Port | Local adapter | GCP adapter |
|---|---|---|
| `CommerceProvider` (§2) | `MockCommerceProvider` | `ShopifyCommerceProvider` |
| `MessagingProvider` (§3) | `SimulatorMessagingProvider` | `WhatsAppMessagingProvider` (+ `SimulatorMessagingProvider` as fallback) |
| `AgentRuntime` (§6) | `MockAgentRuntime` | `AdkGeminiAgentRuntime` |
| `FileStorageProvider` (§6a) | `LocalFileStorageProvider` | `GCSFileStorageProvider` |
| `EventSink` (§5) | `LocalEventSink` | `BigQueryEventSink` |

Rules:

- Domain and application logic depends only on the port, never on an adapter. No business rule may live in an adapter.
- Firestore and Firebase Auth are **not** ports. They are direct SDK dependencies (emulators locally, real services in GCP).
- Secrets are not a port: Cloud Run exposes Secret Manager values as environment variables; locally they come from git-ignored `.env` files.
- Every port has one shared contract test suite that every adapter must pass (`08_TEST_PLAN.md` §4).

---

# 2. CommerceProvider

This is the **canonical CommerceProvider contract**. Other documents (e.g. `00_M0_SPECIFICATION_FREEZE.md` §12) reference it and must not redefine it.

Conceptual interface:

```text
CommerceProvider

getProducts()
getProductVariant()
getCustomer()
getOrder()
getOrders()
getInventory()
getLocations()
```

Implementations:

```text
MockCommerceProvider
ShopifyCommerceProvider
```

Products carry optional `tags` and `attributes` (`04_DATA_MODEL.md` §7) in the same normalized shape for every adapter.

`MockCommerceProvider` serves a deterministic fixture dataset (products, variants, customers, orders, inventory, locations) in the same normalized shapes, including Shopify-format IDs. It is the commerce source for the local profile and for automated tests. It is **not** the judged demo path: the `gcp` profile uses `ShopifyCommerceProvider`.

---

# 3. MessagingProvider

One adapter per customer channel. The pipeline selects the adapter by `Conversation.channel`, and both adapters can be active at once in `gcp`.

```text
MessagingProvider
  channel                      WHATSAPP | SIMULATOR
  verifyInbound(request)       signature check (WhatsApp); simulator relies on console auth
  normalizeInbound(raw)        → InboundMessage[]           (was receiveMessage())
  normalizeStatus(raw)         → DeliveryStatusUpdate[]     (was getMessageStatus())
  send(OutboundMessage)        → SendResult                 (text / template / interactive;
                                                              was sendTextMessage(),
                                                              sendTemplateMessage(),
                                                              sendInteractiveMessage())
```

Implementations:

```text
SimulatorMessagingProvider
WhatsAppMessagingProvider
```

`InboundMessage` (channel-neutral):

```json
{
  "channel": "SIMULATOR",
  "brand_id": "...",
  "external_customer_ref": "sim:customer_01",
  "external_message_id": "...",
  "received_at": "...",
  "content": { "type": "TEXT", "text": "I need it today" }
}
```

`content.type` is one of `TEXT`, `LOCATION` (`latitude`, `longitude`) or `INTERACTIVE_REPLY` (`option_id`).

Adapters only translate and transport. Policy (consent, opt-out, customer-service window, templates) is enforced by the `ConversationPipeline` before `send()` is called (`03_TECH_ARCHITECTURE.md` §8.2).

`SimulatorMessagingProvider.send()` writes the outbound message to the conversation, where the simulator UI reads it. It never contacts an external service.

---

# 4. Retail import and retail domain services

The earlier `RetailProvider` mixed an import adapter with domain logic. It is split as follows.

**Retail import (adapter concern):** parsing CSV (XLSX deferred) into the canonical retail schema (`04_DATA_MODEL.md` §9.1).

```text
RetailFileParser
  parseStores(fileStream)      → canonical store rows + row errors
  parseInventory(fileStream)   → canonical inventory rows + row errors
```

The file itself is read through `FileStorageProvider` (§6a). The parser is identical in both profiles. A future `POSRetailSource` would be a new adapter behind the same canonical output.

**Retail domain services (not adapters; identical in every profile, over Firestore):**

```text
RetailImportService       validate → normalize → SKU mapping → Firestore (retailImports report)
StoreService              getStore, findEligibleStores (distance, hours, status, availability)
InventoryService          checkAvailability
ReservationService        createReservation (transaction, 03 §15), updateReservation (transitions)
```

---

# 5. EventSink

Analytics **export** of `CommerceEvent`s. Firestore remains the operational record: events are always written to `commerceEvents` first, then emitted.

```text
EventSink
  emit(events: CommerceEvent[]) → void
```

Implementations:

```text
LocalEventSink       append-only JSON Lines files under the local data directory
BigQueryEventSink    BigQuery streaming insert into the events table
```

The earlier `AnalyticsProvider.queryMetrics()` is **not** part of the sink. Brand Console metrics are computed by application services from Firestore, so the console works without BigQuery or Looker. Emission failures are logged and retried, and they never fail the user-facing request.

---

# 6. AgentRuntime

Replaces the earlier `AIProvider`.

```text
AgentRuntime
  runtime                                   MOCK | ADK_GEMINI
  decide(DecisionInput, ToolExecutor)      → AgentDecision
```

Implementations:

```text
MockAgentRuntime          deterministic rules; local development and automated tests only
AdkGeminiAgentRuntime     Google ADK for TypeScript + Gemini on Vertex AI
```

- `DecisionInput` is the controlled context package (`04_DATA_MODEL.md` §20) plus the inbound message and the relevant conversation history.
- `AgentDecision` is the structured decision contract (`05_AI_AGENT_SPEC.md` §8).
- Both runtimes call tools **only** through the backend `ToolExecutor`, which enforces tool authorization and the AI Action Guardrail.
- The runtime never writes to Firestore directly.

---

# 6a. FileStorageProvider

```text
FileStorageProvider
  createUploadTarget(key, contentType, maxBytes) → UploadTarget { method, url, headers, expires_at }
  openRead(key)                                  → readable stream
  delete(key)                                    → void
```

Implementations:

```text
LocalFileStorageProvider   files under the local data directory; upload URL is a short-lived,
                           authenticated backend endpoint (local profile only)
GCSFileStorageProvider     Cloud Storage; upload URL is a V4 signed URL
```

The 10 MB retail file limit is enforced by `maxBytes` in both adapters and re-checked when the file is read.

---

# 7. Reservation contract

Internal ReservationService input:

```json
{
  "brand_id": "...",
  "customer_id": "...",
  "store_id": "...",
  "variant_id": "...",
  "quantity": 1,
  "idempotency_key": "..."
}
```

`brand_id` and `customer_id` are **always derived server-side**. They come from the customer resolved by the `ConversationPipeline` from its channel identity (agent tool path; WhatsApp or simulator) or from a validated page mutation token (customer page path). They are never taken from client-supplied request fields.

The backend must validate before creation. Creation runs in the Firestore transaction defined in `03_TECH_ARCHITECTURE.md` §15.

Result:

```json
{
  "reservation_id": "...",
  "status": "PENDING",
  "expires_at": "..."
}
```

Failure reasons (verified, never guessed):

```text
OUT_OF_STOCK
STORE_INACTIVE
RESERVATIONS_DISABLED
QUANTITY_LIMIT_EXCEEDED
UNKNOWN_VARIANT
```

The HTTP contract is §14.4.

---

# 8. Shopify synchronization contract

```text
Shopify
  ↓
Shopify connector
  ↓
normalizer
  ↓
canonical Buildwise models
  ↓
Firestore
```

Initial sync:

```text
products
variants
customers (minimum necessary)
orders
inventory/location data
```

Event sync:

```text
order change
product change
inventory change
```

Every event must be idempotent.

Use:

```text
external_event_id
+
event_type
+
brand_id
```

as part of idempotency handling.

---

# 9. Shopify authentication boundary

Buildwise should isolate Shopify authentication behind the connector.

Do not let Shopify-specific credentials leak into:

- React
- Firestore client code
- Gemini context
- browser storage

The exact Shopify auth/distribution mechanism must be verified against the current Shopify development setup during spike S1 and phase L2 (`10_EXECUTION_PLAN.md`). Local milestones use `MockCommerceProvider`.

For the hackathon MVP, one controlled development-store setup is acceptable as long as the end-to-end product behavior works.

---

# 10. WhatsApp webhook contract

Incoming event:

```text
Meta
 ↓
HTTPS webhook
 ↓
Cloud Run
```

Cloud Run:

1. verifies the incoming request (`WhatsAppMessagingProvider.verifyInbound`)
2. resolves the connected brand/WABA
3. normalizes the payload (`normalizeInbound`)
4. hands each `InboundMessage` to the **`ConversationPipeline`** (`03_TECH_ARCHITECTURE.md` §8.2), which:
   resolves the customer, creates/updates the conversation, applies consent/window policy,
   runs the agent, applies the guardrail, executes tools, persists, and sends the reply
5. records response and status

Signature verification and idempotency follow `03_TECH_ARCHITECTURE.md` §16.3.

The simulator channel (§14.2) hands its messages to the **same** `ConversationPipeline` at step 4. There is no separate simulator AI flow.

## 10.1 Web → WhatsApp intent handshake

This carries web intent (captured anonymously on the storefront) into the WhatsApp conversation **without putting PII in the link or message**.

```text
Storefront (Buildwise instrumentation)
   ↓  POST /api/intents  { event_type: WHATSAPP_CLICK, web_session_id, ... }
Cloud Run
   ↓  records CommerceEvent, updates CustomerIntent (customer_id = null)
   ↓  issues IntentToken bound to intent_id
Storefront
   ↓  opens wa.me/<brand WhatsApp number>?text=START_BUILDWISE_<INTENT_TOKEN>
Customer sends the prefilled message
   ↓
WhatsApp webhook → Cloud Run
   ↓  resolve brand from phone_number_id
   ↓  resolve/create Customer from WhatsApp identity
   ↓  detect token, validate, consume (transaction)
   ↓  bind CustomerIntent.customer_id, set Conversation.current_intent_id
AgentRuntime runs with the bound intent as context
```

Token rules:

| Rule | Value |
|---|---|
| Format | `START_BUILDWISE_<INTENT_TOKEN>` |
| `INTENT_TOKEN` | 128-bit cryptographically random value, Crockford Base32, uppercase, 26 characters |
| Contents | Opaque. No PII, no customer, brand, product or intent identifiers encoded. |
| Storage | Only the SHA-256 hash is stored (`intentTokens/{token_hash}`, `04_DATA_MODEL.md` §18.1) |
| TTL | 30 minutes from issue |
| Use | Single use. It is consumed by the first valid WhatsApp message that carries it. |
| Brand binding | Valid only when the message arrives on the WhatsApp number of the brand that issued it |
| Detection | Regex `START_BUILDWISE_([0-9A-HJKMNP-TV-Z]{26})` anywhere in the first inbound text |

Validation (inside one Firestore transaction):

```text
token hash exists
AND token.brand_id = brand resolved from phone_number_id
AND now < expires_at
AND consumed_at is null
→ set consumed_at, consumed_by_customer_id
→ set CustomerIntent.customer_id
→ set Conversation.current_intent_id
```

If the token is missing, invalid, expired, already used or for another brand:

- the conversation continues normally **without** web intent context
- the customer is not told why (no oracle for token guessing)
- an AuditEvent is recorded with a reason code

The token string is removed from the message text before it reaches the agent runtime (Gemini or mock), and it is not stored in the ConversationMessage content.

The simulator channel uses the same parsing and validation when a simulator message contains the prefix. In the simulator, "brand's WhatsApp number" means the brand the simulator is acting for.

---

# 11. Outbound message contract

The application produces a channel-neutral outbound message. The `MessagingProvider` for the conversation's channel sends it:

```json
{
  "brand_id": "...",
  "customer_id": "...",
  "conversation_id": "...",
  "message_type": "TEXT",
  "content": "...",
  "action_reference": "..."
}
```

`WhatsAppMessagingProvider` converts this into the correct external API request. `SimulatorMessagingProvider` stores it for the simulator UI.

---

# 12. Retail ingestion contract

Input file:

```text
CSV   (XLSX deferred for the prototype, 00 §11.8 Change 10)
```

Required fields use the **canonical retail schema** (`04_DATA_MODEL.md` §9.1):

```text
store_id
store_name
city
address
latitude
longitude
store_hours
store_status
sku
quantity
offline_price
```

`store_hours` is a structured object with an IANA `timezone` and one `HH:MM-HH:MM` value per weekday. In the file it is supplied as the columns `store_hours.timezone`, `store_hours.monday` … `store_hours.sunday` (`04_DATA_MODEL.md` §9.2).

Optional:

```text
pickup_available
reservation_available
```

Maximum file size: 10 MB per CSV file.

Normalization output:

```text
RetailStore
RetailInventory
```

The ingestion service must report:

```text
rows_processed
rows_valid
rows_invalid
mappings_created
mappings_failed
```

---

# 13. Product mapping contract

Required:

```text
source_system
source_identifier
canonical_sku
mapping_status
mapping_reason
```

Statuses:

```text
AUTO_MATCHED
MANUAL_MATCH_REQUIRED
CONFLICT
UNMAPPED
```

---

# 14. Internal API boundaries

Cloud Run endpoints, grouped by interface:

```text
# Public
GET   /api/health                                  (liveness; no auth, no data)

# Any console user
GET   /api/me

# Platform Admin Console (PLATFORM_ADMIN) — §14.6
GET   /api/platform/brands
POST  /api/platform/brands
PATCH /api/platform/brands/:brandId                 (status: ACTIVE | SUSPENDED)
POST  /api/platform/brands/:brandId/admins          (provision the brand's single BRAND_ADMIN)
GET   /api/platform/brands/:brandId/retailers       (metadata)
GET   /api/platform/brands/:brandId/stores          (metadata)
GET   /api/platform/integrations                    (health metadata, all brands)
GET   /api/platform/reservations                    (operational, no customer PII)
GET   /api/platform/outcomes/summary                (aggregate)
GET   /api/platform/audit

# Brand Console (BRAND_ADMIN) — §14.7 for administration
GET   /api/brands/:brandId
GET   /api/brand/users                             (read-only: the brand's BRAND_ADMIN and RETAIL_ADMINs)
GET   /api/brand/retailers               POST /api/brand/retailers
GET   /api/brand/stores                           (stores with their retailer and Retail Admin)
POST  /api/brand/stores/:storeId/admins           (provision the store's single RETAIL_ADMIN)
PATCH /api/brand/stores/:storeId                   (associate store → retailer; backend-only, no UI)
POST  /api/integrations/shopify/connect            (BRAND_ADMIN)
POST  /api/integrations/shopify/sync               (BRAND_ADMIN)
GET   /api/products
GET   /api/customers/:id
POST  /api/brand/retail-imports                    (create an import + upload target; 06 §6a)
POST  /api/brand/retail-imports/:importId/process  (validate → normalize → map → Firestore)
GET   /api/brand/retail-imports                    (history)   GET /api/brand/retail-imports/:importId (report)
POST  /api/analytics/events

# Retailer Console (RETAIL_ADMIN, own store only) — §14.9
GET   /api/retail/stores/:storeId                  (own store; any other store → 404)

# Brand + Retailer Consoles (BRAND_ADMIN view, RETAIL_ADMIN operate its own store)
GET   /api/reservations
GET   /api/reservations/:id
PATCH /api/reservations/:id                        (RETAIL_ADMIN)

# Customer AI Channel
POST  /api/channels/simulator/messages             (simulator channel; §14.2)
GET   /api/channels/simulator/conversations/:conversationId/messages
POST  /api/webhooks/whatsapp                       (WhatsApp channel; §10)
GET   /api/page/context                            (contextual pages)
GET   /api/stores/nearby
POST  /api/reservations                            (page mutation token)

# Storefront + commerce events
POST  /api/intents
POST  /api/webhooks/shopify

# Internal / profile-specific
POST  /api/internal/reservations/expire            (expiry sweep, 03 §15; not callable by browsers)
PUT   /api/local-files/uploads/:uploadId           (LocalFileStorageProvider upload target; local profile only, 06 §6a)
```

Exact routes may change during implementation, but responsibilities must remain separated. The contracts in §14.1–§14.9 are the minimum the implementation must honor.

`POST /api/ai/decide` is **retired**. The simulator is a customer-channel adapter (§14.2), not a standalone AI endpoint.

The earlier example `POST /api/auth/session` is removed: console authentication uses Firebase ID tokens as Bearer tokens on every request, with no server session (`07_SECURITY_SPEC.md` §4.1).

Authentication types used below:

| Type | Mechanism |
|---|---|
| `FIREBASE` | `Authorization: Bearer <Firebase ID token>`, verified per `07_SECURITY_SPEC.md` §4.1 |
| `PAGE_TOKEN` | `X-Buildwise-Page-Token: <opaque token>`, validated per `07_SECURITY_SPEC.md` §16 |
| `PUBLIC` | Unauthenticated. Brand origin allowlist + rate limiting (`07_SECURITY_SPEC.md` §17) |

For `FIREBASE` and `PAGE_TOKEN` requests, `brand_id` always comes from the verified principal or token, never from the request body or query.

Common error envelope (all endpoints):

```json
{
  "error": {
    "code": "OUT_OF_STOCK",
    "message": "Safe, user-presentable message",
    "retryable": false,
    "request_id": "..."
  }
}
```

## 14.1 POST /api/intents

Records a storefront behavioral event, updates the deterministic intent and, for `WHATSAPP_CLICK`, issues the handshake token (§10.1).

Auth: `PUBLIC`. The `Origin` must be in `brand.settings.allowed_storefront_origins`.

Request:

```json
{
  "brand_id": "brd_123",
  "web_session_id": "ws_<opaque random>",
  "client_event_id": "uuid",
  "event_type": "ADD_TO_CART",
  "shopify_variant_id": "gid://shopify/ProductVariant/...",
  "occurred_at": "2026-10-01T10:00:00Z"
}
```

- `event_type`: `PRODUCT_VIEW | PRODUCT_DETAIL_VIEW | ADD_TO_CART | CHECKOUT_STARTED | WHATSAPP_CLICK`
- `web_session_id`: random ID generated by the instrumentation; must not contain PII
- idempotency key: `brand_id + web_session_id + client_event_id`
- no name, phone, email or precise location is accepted

Response `202`:

```json
{
  "accepted": true,
  "intent_stage": "HIGH_INTENT",
  "whatsapp": {
    "prefilled_text": "START_BUILDWISE_7K3M9Q2XH4T8VBN6R1CZ5WJPDA",
    "wa_link": "https://wa.me/<brand number>?text=START_BUILDWISE_7K3M9Q2XH4T8VBN6R1CZ5WJPDA",
    "expires_at": "2026-10-01T10:30:00Z"
  }
}
```

`whatsapp` is present only for `WHATSAPP_CLICK`; otherwise `null`.

Errors: `400 INVALID_EVENT`, `403 ORIGIN_NOT_ALLOWED`, `404 UNKNOWN_VARIANT`, `429 RATE_LIMITED`.

## 14.2 Simulator channel

The simulator is the **customer-channel adapter** used during local development, and as the approved fallback in `gcp`. It is the simulator's equivalent of the WhatsApp webhook.

It enters the **same `ConversationPipeline`** as WhatsApp: identity resolution, conversation state, consent/window policy, `AgentRuntime`, guardrail, tools, persistence and outcome recording. There is no separate simulator AI flow.

### POST /api/channels/simulator/messages

Auth: `FIREBASE`, role `BRAND_ADMIN`. The simulator acts for the caller's own brand, and it is enabled only when the simulator channel is configured (`03_TECH_ARCHITECTURE.md` §2.2).

Request:

```json
{
  "simulator_customer_ref": "customer_01",
  "client_message_id": "uuid",
  "content": { "type": "TEXT", "text": "I need it today" }
}
```

- `simulator_customer_ref` identifies a synthetic customer. It resolves through `channel_identities` as `SIMULATOR` / `sim:customer_01` (`04_DATA_MODEL.md` §6). The first message creates the Customer, just like a first WhatsApp message.
- `client_message_id` is the idempotency key (the simulator's equivalent of a WhatsApp message ID). The receipt key is `SIMULATOR:{brand_id}:MESSAGE:{client_message_id}`.
- `content.type` is one of `TEXT` (may contain `START_BUILDWISE_<INTENT_TOKEN>`, §10.1), `LOCATION` (`latitude`, `longitude`; simulates a location share) or `INTERACTIVE_REPLY` (`option_id`).
- The conversation is resolved by the pipeline, exactly as for WhatsApp. The client never supplies `conversation_id`.

Response `200`: the pipeline ran synchronously. The response contains the messages that `SimulatorMessagingProvider.send()` produced during this run, plus a decision summary for the brand admin.

```json
{
  "conversation_id": "conv_123",
  "inbound_message_id": "msg_001",
  "outbound_messages": [
    {
      "message_id": "msg_002",
      "message_type": "INTERACTIVE",
      "text": "Store A (2.1 km) is open and has it in stock. Shall I reserve one for you?",
      "options": [
        { "option_id": "reserve_store_A", "label": "Reserve at Store A" },
        { "option_id": "other_stores", "label": "See other stores" },
        { "option_id": "buy_online", "label": "Buy online" }
      ]
    }
  ],
  "decision": {
    "recommendation_id": "rec_456",
    "action": "STORE_RESERVATION",
    "guardrail_status": "ALLOWED",
    "runtime": "MOCK",
    "decision_source": "AGENT",
    "executed_action": null
  }
}
```

- `decision.runtime` is always shown in the simulator UI. A `MOCK` decision is labeled as deterministic mock AI, never as Gemini.
- `executed_action` is non-null only when a backend action actually ran (e.g. `{ "type": "RESERVATION_CREATED", "reservation_id": "..." }`).
- A replayed `client_message_id` returns the original result.

Errors: `400 INVALID_REQUEST`, `403 FORBIDDEN`, `404 CHANNEL_DISABLED`, `429 RATE_LIMITED`. When the agent runtime fails, the response is still `200`, with `decision_source = DETERMINISTIC_FALLBACK` (`03_TECH_ARCHITECTURE.md` §16.2).

### GET /api/channels/simulator/conversations/:conversationId/messages

Returns the simulator conversation's messages after an optional `after` message ID. The simulator UI polls this for messages sent outside a request, for example "your order is ready" when a retailer marks a reservation `READY`.

Auth: `FIREBASE`, `BRAND_ADMIN`. The conversation must be a `SIMULATOR` conversation of the caller's brand.

## 14.3 GET /api/stores/nearby

Returns eligible nearby stores with verified availability for one variant.

Auth: `PAGE_TOKEN` (scope `VIEW`, resource `NEARBY_STORES`; the variant comes from the token binding), or `FIREBASE` (brand roles; `variant_id` query parameter required).

Query:

```text
lat        optional; rounded to 2 decimal places (~1 km) by client and server
lng        optional; rounded to 2 decimal places
radius_km  default 10, max 25
limit      default 5, max 10
variant_id FIREBASE callers only
```

If `lat`/`lng` are omitted, the customer's stored authorized location is used. If none exists → `400 LOCATION_REQUIRED`.

Response `200`:

```json
{
  "variant": { "variant_id": "var_789", "title": "..." },
  "stores": [
    {
      "store_id": "store_A",
      "store_name": "...",
      "address": "...",
      "city": "...",
      "distance_km": 2.1,
      "open_now": true,
      "store_hours": {
        "timezone": "Asia/Kolkata",
        "monday": "10:00-21:00",
        "tuesday": "10:00-21:00",
        "wednesday": "10:00-21:00",
        "thursday": "10:00-21:00",
        "friday": "10:00-21:00",
        "saturday": "10:00-22:00",
        "sunday": "11:00-20:00"
      },
      "availability_status": "IN_STOCK",
      "offline_price": 999,
      "pickup_available": true,
      "reservation_available": true
    }
  ]
}
```

Only `ACTIVE` stores with `available_quantity > 0` are returned. Exact quantities are not shown to customers.

Errors: `400 LOCATION_REQUIRED`, `401 TOKEN_INVALID`, `401 TOKEN_EXPIRED`, `429 RATE_LIMITED`.

## 14.4 Reservation endpoints

### POST /api/reservations

Customer creates a reservation from a contextual page.

Auth: `PAGE_TOKEN`, scope `MUTATE`, `allowed_action = CREATE_RESERVATION`. The token is single-use and is consumed in the same transaction as the reservation (`07_SECURITY_SPEC.md` §16). `brand_id`, `customer_id` and `variant_id` come from the token.

Request:

```json
{
  "store_id": "store_A",
  "quantity": 1,
  "idempotency_key": "uuid"
}
```

Response `201` (or `200` on idempotent replay):

```json
{
  "reservation_id": "res_001",
  "status": "PENDING",
  "store_id": "store_A",
  "variant_id": "var_789",
  "quantity": 1,
  "expires_at": "2026-10-01T12:00:00Z"
}
```

Errors: `409 OUT_OF_STOCK | STORE_INACTIVE | RESERVATIONS_DISABLED | QUANTITY_LIMIT_EXCEEDED`, `401 TOKEN_INVALID | TOKEN_EXPIRED | TOKEN_USED`.

When a customer confirms a reservation in a conversation (WhatsApp or simulator channel), the agent's `create_reservation()` tool calls the same ReservationService directly (no HTTP). It uses the customer resolved by the pipeline and `idempotency_key = recommendation_id`.

### GET /api/reservations

Lists reservations for the Retailer Console and the Brand Console.

Auth: `FIREBASE`. Scoping per `07_SECURITY_SPEC.md` §4.0:

- `BRAND_ADMIN`: all reservations of its brand (view)
- `RETAIL_ADMIN`: reservations of its own store only
- `PLATFORM_ADMIN`: uses `GET /api/platform/reservations` instead (§14.6)

Query: `store_id` (optional; for `RETAIL_ADMIN` any value other than its own store returns nothing), `status` (optional), `limit` (default 50).

Response `200`:

```json
{
  "reservations": [
    {
      "reservation_id": "res_001",
      "store_id": "store_A",
      "product_title": "...",
      "sku": "...",
      "quantity": 1,
      "status": "PENDING",
      "customer_display": "Customer •••• 4821",
      "created_at": "...",
      "expires_at": "..."
    }
  ]
}
```

Retail users receive operational context only, with a masked customer reference and no customer history.

### GET /api/reservations/:id

Same auth and scoping as the list. It returns one reservation in the same shape.

### PATCH /api/reservations/:id

Retailer status transition.

Auth: `FIREBASE`. `RETAIL_ADMIN`, for its own store only (another store's reservation → 404). `BRAND_ADMIN` can view reservations but does not perform store fulfillment transitions.

Request:

```json
{
  "status": "CONFIRMED",
  "expected_current_status": "PENDING"
}
```

Allowed transitions: `04_DATA_MODEL.md` §15. Inventory-affecting transitions run in a transaction (`03_TECH_ARCHITECTURE.md` §15).

Response `200`: the updated reservation. Moving to `COMPLETED` also records an `Outcome`, as defined in `04_DATA_MODEL.md` §16.

Errors: `409 INVALID_TRANSITION`, `409 STALE_STATUS`, `403 FORBIDDEN`.

## 14.5 GET /api/page/context

Entry point for every contextual customer page (`/nearby-stores`, `/reservation/:id`, `/pickup/:id`).

Auth: `PAGE_TOKEN`, scope `VIEW`.

Response `200` for `NEARBY_STORES`:

```json
{
  "resource_type": "NEARBY_STORES",
  "product": { "variant_id": "var_789", "title": "..." },
  "mutation_token": {
    "token": "<opaque>",
    "allowed_action": "CREATE_RESERVATION",
    "expires_at": "..."
  },
  "view_expires_at": "..."
}
```

`mutation_token` is issued only when the brand's reservation policy allows reservations.

Response `200` for `RESERVATION` / `PICKUP`:

```json
{
  "resource_type": "RESERVATION",
  "reservation": {
    "reservation_id": "res_001",
    "status": "READY",
    "product_title": "...",
    "quantity": 1,
    "store": {
      "store_name": "...",
      "address": "...",
      "store_hours": { "timezone": "Asia/Kolkata", "monday": "10:00-21:00", "...": "..." }
    },
    "expires_at": "..."
  },
  "view_expires_at": "..."
}
```

No customer name, phone number or other customer PII is returned.

Errors: `401 TOKEN_INVALID | TOKEN_EXPIRED`, `429 RATE_LIMITED`.

## 14.6 Platform administration

Auth: `FIREBASE`, role `PLATFORM_ADMIN`, for every route in this section. Every state-changing call writes a `PlatformAuditEvent`, plus an `AuditEvent` in the affected brand (`04_DATA_MODEL.md` §18.0). None of these routes return customer PII or conversation content (`07_SECURITY_SPEC.md` §4.2).

### POST /api/platform/brands

```json
{ "name": "Brand XYZ" }
```

Response `201`: `{ "brand_id": "...", "name": "Brand XYZ", "status": "ACTIVE", "created_at": "..." }`. The server generates `brand_id`.

### PATCH /api/platform/brands/:brandId

```json
{ "status": "SUSPENDED", "reason": "..." }
```

`status` is `ACTIVE` or `SUSPENDED`. Suspension takes effect on the next request of every `BRAND_ADMIN` and `RETAIL_ADMIN` of that brand.

### POST /api/platform/brands/:brandId/admins

Provisions the brand's **single** `BRAND_ADMIN`. This is the only way a `BRAND_ADMIN` is created.

```json
{ "email": "admin@brand.example" }
```

Response `201`: `{ "user_id": "...", "email": "...", "role": "BRAND_ADMIN", "password_setup_link": "https://..." }`. The link is an Admin SDK password-reset link that the platform admin hands over; there is no email service in the MVP.

Errors: `409 BRAND_ADMIN_ALREADY_PROVISIONED` (the brand already has its Brand Admin), `409 USER_EXISTS_IN_OTHER_BRAND`.

### Read routes

| Route | Returns |
|---|---|
| `GET /api/platform/brands` | brand registry: `brand_id, name, status, created_at, brand_admin_user_id` |
| `GET /api/platform/brands/:brandId/retailers` | `retailer_id, name, status, store_count` |
| `GET /api/platform/brands/:brandId/stores` | `store_id, store_name, city, store_status, retailer_id, retail_admin_user_id` |
| `GET /api/platform/integrations` | per brand: provider, status, `last_sync_at`, `last_error` code. **No credentials.** |
| `GET /api/platform/reservations` | `reservation_id, brand_id, store_id, status, quantity, created_at, expires_at`. **No customer fields.** |
| `GET /api/platform/outcomes/summary` | per brand and period: outcome counts and values by `purchase_type` |
| `GET /api/platform/audit` | `platformAuditEvents`, newest first |

## 14.7 Brand administration

Auth: `FIREBASE`, role `BRAND_ADMIN` (the only brand role), for every route in this section. Every change is audited in the brand's `auditEvents`. The brand always comes from the principal.

| Route | Body / result |
|---|---|
| `GET /api/brand/users` | read-only: the brand's console users (its `BRAND_ADMIN` and its retailers' `RETAIL_ADMIN`s): `user_id, email, role, retailer_id, store_id, status` |
| `POST /api/brand/retailers` | `{ "name" }` → `{ "retailer_id", "name", "status" }` |
| `GET /api/brand/retailers` | the brand's retailers: `retailer_id, name, status` |
| `GET /api/brand/stores` | the brand's stores: `store_id, store_name, city, store_status, retailer_id, retail_admin_user_id` (null = not provisioned) |
| `POST /api/brand/stores/:storeId/admins` | `{ "email" }` → the store's **single** `RETAIL_ADMIN` + `password_setup_link`. Its `brand_id`, `retailer_id` and `store_id` come from the store record; any scope in the request is ignored. A second one → `409 RETAIL_ADMIN_ALREADY_PROVISIONED` (no user and no link created); a store without a retailer → `409 STORE_HAS_NO_RETAILER`. There is no retailer-wide provisioning route. |
| `PATCH /api/brand/stores/:storeId` | `{ "retailer_id": "..." \| null }`: associate a store with a retailer (a retailer may own many stores), or remove the association. Errors: `409 STORE_ALREADY_ASSIGNED`, `409 STORE_HAS_ADMIN` (detaching a store operated by its Retail Admin). **Backend-only**: there is no Brand Console UI, because stores and their retailer come from retail ingestion (M3); kept for tests and as the ingestion building block. Response: the store in the `GET /api/brand/stores` shape. |

There is **no** route for a `BRAND_ADMIN` to create another `BRAND_ADMIN`: only `PLATFORM_ADMIN` provisions a brand's single Brand Admin (§14.6).

Errors: `409 RETAIL_ADMIN_ALREADY_PROVISIONED`, `409 STORE_HAS_NO_RETAILER`, `409 STORE_ALREADY_ASSIGNED`, `409 STORE_HAS_ADMIN`, `409 USER_EXISTS_IN_OTHER_BRAND`, `409 USER_ALREADY_PROVISIONED`, `404 NOT_FOUND` for another brand's retailer or store.

## 14.8 GET /api/me

Returns the verified console principal. Each scope returns only its own fields; obsolete roles are never returned (a user document carrying one is refused with 403). Customers never call this route.

```json
{ "scope": "PLATFORM", "role": "PLATFORM_ADMIN", "user": { "user_id": "...", "email": "..." } }
```

```json
{ "scope": "BRAND", "role": "BRAND_ADMIN", "user": { "...": "..." },
  "brand_id": "brd_...", "brand_name": "..." }
```

```json
{ "scope": "RETAIL", "role": "RETAIL_ADMIN", "user": { "...": "..." },
  "brand_id": "brd_...", "brand_name": "...", "retailer_id": "rtl_...", "retailer_name": "...",
  "store_id": "st_...",
  "store": { "store_id": "st_...", "store_name": "...", "city": "...", "address": "...",
             "store_status": "ACTIVE", "store_hours": { "timezone": "Asia/Kolkata", "monday": "10:00-21:00" } } }
```

A `RETAIL_ADMIN` has exactly one store, so the response carries `store_id` and a single `store`, never a list of stores.

## 14.9 Retailer Console

Auth: `FIREBASE`, role `RETAIL_ADMIN`, for every route in this section. Scope is store-level: brand, retailer and store all come from the principal (`07_SECURITY_SPEC.md` §4.1).

| Route | Result |
|---|---|
| `GET /api/retail/stores/:storeId` | the principal's own store: `store_id, store_name, city, address, store_status, store_hours`. Any other store (same brand, another retailer, unassigned, another brand, or missing) → `404 NOT_FOUND`. |

Other scopes calling `/api/retail/*` → `403 FORBIDDEN`. Inventory and reservations for the store are added in later milestones under the same store-level rule.

---

# 15. Provider isolation rule

The rest of Buildwise must not depend directly on:

```text
Shopify GraphQL response shape
Meta webhook payload shape
Excel column names
```

Those differences are handled inside provider/adaptor layers.

---

# 16. Error contract

Every integration error should become a normalized internal error:

```text
provider
error_code
retryable
message
external_reference
timestamp
```

The UI must receive safe, useful error messages.

Do not expose secrets or raw provider credentials.

---

# 17. Integration test strategy

Every provider must have:

```text
unit tests
contract tests
mock tests
failure tests
```

External integration tests should be isolated so the domain logic remains testable without live services.

Each port has **one** contract test suite. The local adapter runs it in every build. The real adapter runs the same suite once it exists (phase L2, `10_EXECUTION_PLAN.md` §4), which is how the two profiles are kept behaviorally equivalent.

## 17.1 Integration spike findings

Findings from the isolated integration spikes (S1 Shopify, S2 Meta WhatsApp, S3 ADK + Gemini; `10_EXECUTION_PLAN.md` §5) are recorded here when available. They must not change a contract without an explicit spec update.

```text
S1 Shopify:        (pending)
S2 Meta WhatsApp:  (pending)
S3 ADK + Gemini:   (pending; record in 05_AI_AGENT_SPEC.md)
```
