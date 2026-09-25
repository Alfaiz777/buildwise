# Buildwise — Integration Contracts

## Status

**M0 — Interfaces frozen before external implementation**

---

# 1. Principle

Buildwise should depend on stable internal interfaces rather than directly coupling the entire application to Shopify, WhatsApp, or the retail file implementation.

```text
Buildwise domain logic
        ↓
Internal contract
        ↓
Provider
        ↓
External system
```

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

The mock provider exists so the product can be developed and tested before external authentication/integration is complete.

---

# 3. MessagingProvider

```text
MessagingProvider

sendTextMessage()
sendTemplateMessage()
receiveMessage()
getMessageStatus()
sendInteractiveMessage()
```

Implementations:

```text
MockMessagingProvider
WhatsAppProvider
```

---

# 4. RetailProvider

```text
RetailProvider

importStores()
importInventory()
getStore()
getInventory()
findEligibleStores()
checkAvailability()
createReservation()
updateReservation()
```

Implementation for MVP:

```text
SpreadsheetRetailProvider
```

Future:

```text
POSRetailProvider
```

---

# 5. AnalyticsProvider

```text
AnalyticsProvider

recordEvent()
recordOutcome()
queryMetrics()
```

MVP implementation:

```text
FirestoreEventWriter
BigQueryEventWriter
```

---

# 6. AIProvider

```text
AIProvider

understandIntent()
buildDecision()
generateResponse()
```

MVP implementation:

```text
GeminiAIProvider
```

The provider should hide raw model-specific details from the rest of the application.

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

`brand_id` and `customer_id` are **always derived server-side**. They come from the resolved WhatsApp identity (agent tool path) or from a validated page mutation token (customer page path). They are never taken from client-supplied request fields.

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

The exact Shopify auth/distribution mechanism must be verified against the current Shopify development setup during the Shopify milestone.

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

1. verifies the incoming request
2. resolves the connected brand/WABA
3. resolves the customer
4. creates/updates the conversation
5. sends relevant context to the agent
6. records response and status

Signature verification and idempotency follow `03_TECH_ARCHITECTURE.md` §16.3.

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
ADK + Gemini run with the bound intent as context
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

The token string is removed from the message text before it reaches Gemini, and it is not stored in the ConversationMessage content.

The Web Conversation Simulator uses the same parsing when a simulator message contains the prefix.

---

# 11. WhatsApp outbound contract

The application should produce an internal message request:

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

The WhatsApp provider converts this into the correct external API request.

---

# 12. Retail ingestion contract

Input file:

```text
CSV/XLSX
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

Maximum file size: 10 MB per CSV/XLSX file.

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

Example Cloud Run endpoints:

```text
POST /api/auth/session
GET  /api/brands/:brandId
POST /api/integrations/shopify/connect
POST /api/integrations/shopify/sync
GET  /api/products
GET  /api/customers/:id
POST /api/intents
POST /api/ai/decide
POST /api/reservations
GET  /api/reservations
GET  /api/reservations/:id
PATCH /api/reservations/:id
GET  /api/page/context
POST /api/webhooks/shopify
POST /api/webhooks/whatsapp
POST /api/retail/import
GET  /api/stores/nearby
POST /api/analytics/events
```

Exact routes may change during implementation, but responsibilities must remain separated. The contracts in §14.1–§14.5 are the minimum the implementation must honor.

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

## 14.2 POST /api/ai/decide

Runs the same Cloud Run → ADK → Gemini → tools → guardrail path as the WhatsApp webhook. It is the entry point for the **Web Conversation Simulator**.

Auth: `FIREBASE`, role `BRAND_ADMIN`.

Request:

```json
{
  "channel": "SIMULATOR",
  "simulator_customer_ref": "sim_customer_01",
  "conversation_id": "conv_123",
  "message": { "text": "I need it today" },
  "location": { "latitude": 19.07, "longitude": 72.87 }
}
```

- `conversation_id`: optional; omitted → new conversation
- `simulator_customer_ref`: a simulator customer inside the caller's own brand
- `location`: optional; simulates a WhatsApp location share
- `message.text` may contain `START_BUILDWISE_<INTENT_TOKEN>` (§10.1)

Response `200`:

```json
{
  "conversation_id": "conv_123",
  "recommendation": {
    "recommendation_id": "rec_456",
    "action": "STORE_RESERVATION",
    "target_store_id": "store_A",
    "target_variant_id": "var_789",
    "guardrail_status": "ALLOWED",
    "decision_source": "GEMINI",
    "rationale_summary": "Customer needs it today; Store A is open with verified stock."
  },
  "reply": {
    "message_type": "INTERACTIVE",
    "text": "Store A (2.1 km) is open and has it in stock. Shall I reserve one for you?",
    "options": ["Reserve at Store A", "See other stores", "Buy online"]
  },
  "executed_action": null
}
```

`executed_action` is non-null only when a backend action actually ran (e.g. `{ "type": "RESERVATION_CREATED", "reservation_id": "..." }`).

Errors: `400 INVALID_REQUEST`, `403 FORBIDDEN`, `429 RATE_LIMITED`. When Gemini fails, the response is still `200` with `decision_source = DETERMINISTIC_FALLBACK` (`03_TECH_ARCHITECTURE.md` §16.2).

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

When a customer confirms a reservation in WhatsApp, the agent's `create_reservation()` tool calls the same ReservationService directly (no HTTP). It uses the resolved WhatsApp customer and `idempotency_key = recommendation_id`.

### GET /api/reservations

Lists reservations for the Retailer Console and the Brand Console.

Auth: `FIREBASE`. `RETAIL_MANAGER` / `RETAIL_STAFF` see only their `store_ids`. `BRAND_ADMIN` / `BRAND_OPERATIONS` see all stores of their brand.

Query: `store_id` (optional), `status` (optional), `limit` (default 50).

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

Auth: `FIREBASE`, `RETAIL_MANAGER` / `RETAIL_STAFF` for the reservation's store.

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
