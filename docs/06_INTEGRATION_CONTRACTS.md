# Qwikspot — Integration Contracts

## Status

**M0 — Interfaces frozen before external implementation.** Updated by the post-M0 architecture change (`00_M0_SPECIFICATION_FREEZE.md` §11.8): provider ports, simulator channel, platform/brand administration routes.

---

# 1. Principle

Qwikspot should depend on stable internal interfaces rather than directly coupling the entire application to Shopify, WhatsApp, or the retail file implementation.

```text
Qwikspot domain logic
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

Products carry optional `tags` and `attributes` (`04_DATA_MODEL.md` §7) in the same normalized shape for every adapter. L2-Shopify adds an optional `handle` (the storefront handle; `null` for the mock), stored on the product for the "Buy online" link.

`ShopifyCommerceProvider` (L2-Shopify) implements the port over the **GraphQL Admin API** (version pinned by `SHOPIFY_API_VERSION`, default `2026-10`). It is built **per brand** from that brand's stored connection (`CommerceProviderResolver`): products are paginated 50 at a time with their variants (SKU, barcode, price in the shop's currency, featured image, tags, `productType` → category, status — `UNLISTED` counts as `ACTIVE` — and handle). The description HTML becomes plain text, and its "Label: value" lines for *Best for, Skin type, Key ingredients, Texture, When to use* become `attributes` (`best_for`, `skin_type`, …). A `THROTTLED` response waits for the cost bucket to refill (restore rate) and retries up to 5 times. Customers (first name, default email/phone, marketing consent) and orders (lines, totals, customer) are read with the minimum fields the port needs.

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
  parse(file bytes)            → header + raw rows with line numbers (format only)
```

The parser is a port (`ports/retailFile.ts`) with one adapter, `CsvRetailFileParser`. It only decodes the file (BOM, quoting, line numbers). Validation, normalization, store-level consistency and SKU mapping are domain rules (`domain/retailRows.ts`, `domain/skuMapping.ts`) applied by `RetailImportService`, so they are identical in every profile. The file itself is read through `FileStorageProvider` (§6a). A future `POSRetailSource` would be a new adapter behind the same canonical output.

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
- Tool declarations are zod schemas exported as JSON Schema (name, description, kind `READ | WRITE`, input). The runtime is given the read tools; writes are proposed in `next_best_action` and executed by the pipeline after the guardrail (`00` §11.8 Change 12, E1). A runtime call that passes `brand_id`, `customer_id` or `conversation_id` is blocked (`SCOPE_VIOLATION`).
- Budget: 20 s per inbound message (`03` §16.1); one repair attempt for invalid output, then the deterministic fallback (`03` §16.2).

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
canonical Qwikspot models
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

**L2-Shopify sync** (`POST /api/integrations/shopify/sync`) uses the brand's connected store (`409 SHOPIFY_NOT_CONNECTED` without one; `409 SHOPIFY_RECONNECT_REQUIRED` when Shopify rejects the token) and keeps the existing response shape, plus `shop_domain` / `shop_name`. Ids are deterministic from the GIDs, so a re-sync overwrites. **Catalogue switch:** a Shopify sync archives the brand's products and variants that the store does not have — e.g. the mock catalogue a demo brand was seeded with — and clears their `canonical_sku`, so SKUs never conflict; retail matching ignores archived variants. Retail stock is re-pointed by importing the stock file again (for the demo brand, **Reset demo** does it: it keeps the Shopify connection, syncs, then imports the judge stock).

**Keeping it current (L2-Shopify follow-up).** The `products/create`, `products/update` and `products/delete` webhooks queue the same sync in the background (`ShopifyCatalogRefresh`; actor `SYSTEM shopify-webhook`): the webhook answers at once, a burst coalesces per brand into the running sync plus at most one more, and a failed run is logged — the next webhook or a manual Sync catches up. After a successful **Sync products** the route also brings the store's webhook subscriptions up to date (a store connected before a topic was added gets it without reconnecting) and runs the order check (§8.1); both are best effort and never change the sync's response.

**Online stock for "Buy online".** Before the agent tools offer the connected store's cart link they ask Shopify whether the variant can be bought online now (`CommerceProvider.getOnlineAvailability` → `productVariant.availableForSale`, which counts inventory tracking and the oversell policy). A sold-out variant gets no online link at all (not even the storefront template's). When Shopify cannot be asked the answer is unknown and the link stays — Shopify's checkout still refuses what it cannot sell. Definite answers are cached for 60 seconds per brand and variant. Store stock still comes only from the retail file.

Use:

```text
external_event_id
+
event_type
+
brand_id
```

as part of idempotency handling.

## 8.1 Online-order attribution (M6 local, L2 Shopify)

When a reply offers "Buy online", the backend creates an AttributionRef (`00` §11.8 Change 13, F6) and adds it to the link: a storefront link (the brand's `online_store.product_url_template`) gets `?qs_ref=`, which the storefront keeps for the browsing session and hands to checkout; a cart permalink of the brand's **connected** Shopify store (`https://{shop}/cart/{variant}:1`) gets the cart attribute `attributes[qs_ref]=` (URL-encoded), which Shopify copies onto the order's `note_attributes` — a plain query parameter would be dropped at the cart.

```text
local (M6):  demo storefront → POST /api/demo-storefront/orders { ..., qs_ref } → OrderService.recordOrder
L2:          cart link ?attributes[qs_ref]=… → Shopify cart attribute → orders/create webhook (verified)
             → ShopifyOrderService.record → OrderService.recordOrder
```

**`POST /api/webhooks/shopify`** (L2-Shopify, public): the raw body's `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 with the app's client secret) is checked timing-safe first — `401`, nothing processed. The brand comes from `X-Shopify-Shop-Domain` (`shopifyShops/{shop}`; an unknown shop → `200`, ignored). Each event is processed once: a `webhookReceipts` entry keyed `shopify:{brand_id}:{topic}:{X-Shopify-Event-Id}`. It answers `200` well inside Shopify's 5-second limit.

- `orders/create`: `qs_ref` (and optionally `qs_ws`, the web session) from the order's `note_attributes`; `OrderService.recordOrder` for each line-item variant with `source: SHOPIFY`, `external_order_id` = the order GID. ORDER_CREATED stays idempotent per order; the journey's first purchase wins. Each order is recorded once per brand whichever path sees it first — a second receipt keyed `shopify:{brand_id}:order:{order_gid}` makes this webhook and the order check idempotent against each other.
- `orders/cancelled`: records the order if its create was missed, then `OrderService.cancelOrder` — ORDER_CANCELLED once per order (timestamp = Shopify's `cancelled_at`), and the Outcome the order produced gets `cancelled_at`: it stays (first purchase wins) but no longer counts in the insights or as a sale in the journey. Audited `ORDER_CANCELLED` and `OUTCOME_CANCELLED`.
- `products/create`, `products/update`, `products/delete`: a background catalogue sync (§8).
- `app/uninstalled`: the stored token is deleted and the connection becomes `DISCONNECTED` (audited `SHOPIFY_UNINSTALLED`).

**The order check** (`POST /api/integrations/shopify/orders/sync`, BRAND_ADMIN → `{ checked, recorded, cancelled }`; also run after **Sync products**): reads the connected store's orders from the last 7 days (`created_at:>'…'`, with `customAttributes` and `cancelledAt`) and records what the webhooks missed — the backend or the tunnel was down, a delivery was lost — plus every cancellation, through the same paths. Audited `SHOPIFY_ORDERS_CHECKED`. `409 SHOPIFY_NOT_CONFIGURED` in mock mode, `409 SHOPIFY_NOT_CONNECTED` / `SHOPIFY_RECONNECT_REQUIRED` as for sync, `502 SHOPIFY_ORDERS_FAILED` (retryable) when Shopify cannot be read.

`OrderService.recordOrder({ brand_id, web_session_id, external_order_id, variant_id, source, attribution_ref })` validates the ref (exists by hash, same brand, not expired) and links the order to the ref's journey; the Outcome service then records ONLINE (or ALTERNATIVE for another variant). An invalid, expired or other-brand ref never fails the order: it is recorded unattributed. The ref only links; the purchase evidence is the order from the commerce source.

---

# 9. Shopify authentication boundary

Qwikspot should isolate Shopify authentication behind the connector.

Do not let Shopify-specific credentials leak into:

- React
- Firestore client code
- Gemini context
- browser storage

The exact Shopify auth/distribution mechanism must be verified against the current Shopify development setup during spike S1 and phase L2 (`10_EXECUTION_PLAN.md`). Local milestones use `MockCommerceProvider`.

For the hackathon MVP, one controlled development-store setup is acceptable as long as the end-to-end product behavior works.

**L2-Shopify (implemented):** one Shopify app (Dev Dashboard, not embedded) and the OAuth **authorization-code grant** per brand:

```text
POST /api/integrations/shopify/connect { shop }   (BRAND_ADMIN) → { authorize_url }
   shop must match ^[a-z0-9][a-z0-9-]*\.myshopify\.com$ (anchored) → else 400 INVALID_SHOP_DOMAIN
   state = HMAC-signed { nonce, brand_id, user_id, shop, exp (10 min) }; the nonce is stored and single-use
GET  /api/integrations/shopify/callback            (public; Shopify redirects the browser here)
   1 query hmac (sorted params, HMAC-SHA256 hex, client secret) — timing-safe
   2 state signature + expiry; nonce consumed once (a replay fails); shop = the state's shop
   3 code → expiring offline token (expiring=1) + refresh token; shop name
   4 tokens sealed (AES-256-GCM, TOKEN_ENCRYPTION_KEY) in brands/{brand_id}/integrationSecrets/SHOPIFY;
     shopifyShops/{shop} → brand (one shop, one brand); connection CONNECTED; audited SHOPIFY_CONNECTED
   5 webhooks orders/create, orders/cancelled, products/create|update|delete, app/uninstalled
       → <PUBLIC_BACKEND_URL>/api/webhooks/shopify (idempotent; topics added later are registered by the next Sync)
   6 302 → <FRONTEND_URL>/brand/settings?shopify=connected
     or ?shopify=error&reason=INVALID_HMAC|INVALID_STATE|STATE_EXPIRED|SHOP_MISMATCH|
                              TOKEN_EXCHANGE_FAILED|SHOP_ALREADY_CONNECTED|WEBHOOKS_FAILED
POST /api/integrations/shopify/disconnect          (BRAND_ADMIN) → token deleted, DISCONNECTED, audited
```

No token or secret ever appears in a URL, an API response, a log line or the browser. An access token expiring within 5 minutes is refreshed before use; a refresh or call rejected with 401 marks the connection `ERROR` (`SHOPIFY_RECONNECT_REQUIRED`). With `COMMERCE_PROVIDER=mock`, connect and disconnect answer `409 SHOPIFY_NOT_CONFIGURED`.

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
Storefront (Qwikspot instrumentation)
   ↓  POST /api/intents  { event_type: WHATSAPP_CLICK, web_session_id, ... }
Cloud Run
   ↓  records CommerceEvent, updates CustomerIntent (customer_id = null)
   ↓  issues IntentToken bound to intent_id
Storefront
   ↓  opens wa.me/<brand WhatsApp number>?text=START_QWIKSPOT_<INTENT_TOKEN>
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
| Format | `START_QWIKSPOT_<INTENT_TOKEN>` |
| `INTENT_TOKEN` | 128-bit cryptographically random value, Crockford Base32, uppercase, 26 characters |
| Contents | Opaque. No PII, no customer, brand, product or intent identifiers encoded. |
| Storage | Only the SHA-256 hash is stored (`intentTokens/{token_hash}`, `04_DATA_MODEL.md` §18.1) |
| TTL | 30 minutes from issue |
| Use | Single use. It is consumed by the first valid WhatsApp message that carries it. |
| Brand binding | Valid only when the message arrives on the WhatsApp number of the brand that issued it |
| Detection | Regex `START_QWIKSPOT_([0-9A-HJKMNP-TV-Z]{26})` anywhere in the first inbound text |

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

## 11.1 Message parts and WhatsApp limits (Change 16)

Besides the body (`content`) and options, an outbound message may carry optional `parts`. Options become **reply buttons** when there are at most 3, each label ≤ 20 characters and none has a description or section; otherwise they become a **list**. The domain validator (`domain/whatsappLimits.ts`) runs in the outbound stage and again in every `MessagingProvider.send()`; it truncates text on a word boundary with "…" and rejects structural violations (`MESSAGE_PARTS_INVALID`, the message is stored `FAILED`).

| Part | Shape | Limit |
|---|---|---|
| body | WhatsApp formatting (`*bold*`, `_italic_`, `~strike~`, line breaks, links) | 1,024 characters when interactive, 4,096 plain (truncated) |
| `header` | `{ type: IMAGE, url, alt }` or `{ type: TEXT, text }` | image: absolute https URL (http only for localhost), PNG or JPEG; text ≤ 60 |
| `footer` | string | ≤ 60 |
| reply buttons | options `{ option_id, label }` | ≤ 3; label ≤ 20; ids unique |
| list | options with `description?`, `section?`; `list_button` | ≤ 10 rows; row title ≤ 24; description ≤ 72; section ≤ 24; list button ≤ 20 (default "Choose an option") |
| `location` | `{ name, address, latitude, longitude }` | valid coordinates; sent as a separate location message on WhatsApp |
| `cta_url` | `{ label, url }` | label ≤ 20; https; never together with options |

**Footer rule.** "Powered by Qwikspot" is added centrally (outbound stage) only when the message is interactive (buttons, list, CTA, image header or location), the origin is `AUTOMATED_REPLY`, `PROACTIVE_FOLLOW_UP` or `RESERVATION_UPDATE`, and the brand setting `messaging.powered_by_footer` is not `false`. `HUMAN_AGENT` messages never carry it; the sender is always the brand.

Stored messages (`04`) and the conversation routes return the parts in snake case: `parts: { header, footer, location, cta_url, list_button }` and options `{ option_id, label, description?, section? }`.

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
GET   /api/health                                  (liveness; no auth: { status, version, commit, profile } — M7; UI-5 adds adapters { agent_runtime, channels, commerce }, names only)
GET   /api/demo/config                             (M7: { demo_mode } — plus the demo logins only when DEMO_MODE is on; shopper_demo { brand_id } where the shopper demo is served (Change 16); 30/min per IP)

# Shopper demo channel (Change 16; local, and gcp with DEMO_MODE on for DEMO_BRAND_IDS only) — §14.11
POST  /api/shopper/session                         (issue a signed shopper session)
POST  /api/shopper/messages                        (X-Qwikspot-Shopper-Session)
GET   /api/shopper/messages?after=msg_…            (X-Qwikspot-Shopper-Session; the session's own conversation)

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
GET   /api/platform/audit                         (UI-5 adds target_brand_name, actor_role)
GET   /api/platform/network                       (UI-5: brand and store aggregates; ?days=7|28&include_history=)
GET   /api/platform/brands/:brandId/network       (UI-5: one brand's retailers → stores, counts and health flags)

# Brand Console (BRAND_ADMIN) — §14.7 for administration
GET   /api/brands/:brandId
GET   /api/brand/users                             (read-only: the brand's BRAND_ADMIN and RETAIL_ADMINs)
GET   /api/brand/retailers               POST /api/brand/retailers
GET   /api/brand/stores                           (stores with their retailer, Retail Admin and stock summary)
GET   /api/brand/connections                      (integration status only; never credentials)
POST  /api/brand/stores/:storeId/admins           (provision the store's single RETAIL_ADMIN)
PATCH /api/brand/stores/:storeId                   (associate store → retailer; backend-only, no UI)
POST  /api/integrations/shopify/connect            (BRAND_ADMIN; L2-Shopify — §9)
POST  /api/integrations/shopify/disconnect         (BRAND_ADMIN; L2-Shopify — §9)
POST  /api/integrations/shopify/sync               (BRAND_ADMIN; the brand's connected store in Shopify mode — §8)
POST  /api/integrations/shopify/orders/sync        (BRAND_ADMIN; L2-Shopify order check — §8.1)
GET   /api/products
GET   /api/customers/:id
POST  /api/brand/retail-imports                    (create an import + upload target; 06 §6a)
POST  /api/brand/retail-imports/:importId/process  (validate → normalize → map → Firestore)
GET   /api/brand/retail-imports                    (history)   GET /api/brand/retail-imports/:importId (report)
POST  /api/analytics/events
GET   /api/brand/conversations                     (list; customer display ref, channel, handoff, intent, follow-up)
GET   /api/brand/conversations/:conversationId     (messages, bound intent + web events + follow_up, recommendations)
GET   /api/brand/intents                           (every intent incl. anonymous; ?type=&follow_up_status=)
POST  /api/brand/follow-ups/process-due            (process due follow-ups; Cloud Scheduler with OIDC in gcp, L-phase)
GET   /api/brand/demo                              (M7: { reset_available } for this brand)
GET   /api/brand/settings                          (Change 16, UI-3: the read-only Settings page; §14.7)
POST  /api/brand/demo/reset                        (M7: Reset demo — DEMO_MODE + allowlisted brand only; 1/min per brand; §14.10)

# Retailer Console (RETAIL_ADMIN, own store only) — §14.9
GET   /api/retail/stores/:storeId                  (own store; any other store → 404)
GET   /api/retail/stores/:storeId/inventory        (own store's stock, read-only; any other store → 404)
GET   /api/retail/stores/:storeId/insights         (Change 16, UI-4: the own store's demand slice; any other store → 404)

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
POST  /api/webhooks/shopify                        (L2-Shopify: raw-body HMAC; orders/create, orders/cancelled, products/*, app/uninstalled — §8.1)
GET   /api/integrations/shopify/callback           (L2-Shopify, public: OAuth callback — §9)

# Internal / profile-specific
POST  /api/internal/reservations/expire            (expiry sweep, 03 §15; not callable by browsers)
PUT   /api/local-files/uploads/:uploadId           (LocalFileStorageProvider upload target; local profile only, 06 §6a)
GET   /api/demo-storefront/products                (shopper demo only — same gating as §14.11: demo storefront catalogue incl. image_url)
POST  /api/demo-storefront/shopper-sign-in         (shopper demo only: link the visitor to a synthetic shopper)
POST  /api/demo-storefront/orders                  (shopper demo only: same order path as the L2 orders webhook)
```

Exact routes may change during implementation, but responsibilities must remain separated. The contracts in §14.1–§14.9 are the minimum the implementation must honor.

`POST /api/ai/decide` is **retired**. The simulator is a customer-channel adapter (§14.2), not a standalone AI endpoint.

The earlier example `POST /api/auth/session` is removed: console authentication uses Firebase ID tokens as Bearer tokens on every request, with no server session (`07_SECURITY_SPEC.md` §4.1).

Authentication types used below:

| Type | Mechanism |
|---|---|
| `FIREBASE` | `Authorization: Bearer <Firebase ID token>`, verified per `07_SECURITY_SPEC.md` §4.1 |
| `PAGE_TOKEN` | `X-Qwikspot-Page-Token: <opaque token>`, validated per `07_SECURITY_SPEC.md` §16 |
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
  "visitor_id": "vis_<opaque random>",
  "client_event_id": "uuid",
  "event_type": "ADD_TO_CART",
  "shopify_variant_id": "gid://shopify/ProductVariant/...",
  "search_term": "vitamin c",
  "entry": "STORE_NEED",
  "occurred_at": "2026-10-01T10:00:00Z"
}
```

- `event_type`: `STOREFRONT_VISIT | SEARCH | PRODUCT_VIEW | PRODUCT_DETAIL_VIEW | VARIANT_SELECTED | ADD_TO_CART | CHECKOUT_STARTED | WHATSAPP_CLICK` (`00` §11.8 Change 11, D4). A completed order is never a browser event.
- `shopify_variant_id`: required for product events (`PRODUCT_VIEW`, `PRODUCT_DETAIL_VIEW`, `VARIANT_SELECTED`, `ADD_TO_CART`, `CHECKOUT_STARTED`); optional for `WHATSAPP_CLICK`
- `search_term`: `SEARCH` only; ≤ 80 characters, trimmed and lower-cased; a term that looks like an email or phone number is rejected. It is never echoed to the customer; personalization uses only the catalogue category/tag it matched.
- `entry`: `WHATSAPP_CLICK` only: `STORE_NEED` ("Need it today?") or `CHAT`
- `web_session_id` (per tab) and `visitor_id` (per browser): random IDs generated by the instrumentation; must not contain PII
- idempotency key: `brand_id + web_session_id + client_event_id`
- no name, phone, email or precise location is accepted

Response `202`:

```json
{
  "accepted": true,
  "intent_stage": "CART",
  "intent_strength": "HIGH_INTENT",
  "intent_type": "CART_ABANDONMENT",
  "whatsapp": {
    "prefilled_text": "START_QWIKSPOT_7K3M9Q2XH4T8VBN6R1CZ5WJPDA",
    "wa_link": "https://wa.me/<brand number>?text=START_QWIKSPOT_7K3M9Q2XH4T8VBN6R1CZ5WJPDA",
    "expires_at": "2026-10-01T10:30:00Z"
  }
}
```

`whatsapp` is present only for `WHATSAPP_CLICK`; otherwise `null`. `intent_stage` is the funnel stage and `intent_strength` the former three-level value (`04` §11.2).

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
- `content.type` is one of `TEXT` (may contain `START_QWIKSPOT_<INTENT_TOKEN>`, §10.1), `LOCATION` (`latitude`, `longitude`; simulates a location share) or `INTERACTIVE_REPLY` (`option_id`).
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
- Every returned message carries `origin` (`CUSTOMER | AUTOMATED_REPLY | PROACTIVE_FOLLOW_UP`) and, for outbound messages, `message_kind` (`SESSION | TEMPLATE`).

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

Built in M5 (read-only); M6 adds `view=active|history`, `GET /api/reservations/:id` and `PATCH /api/reservations/:id`. Each row also carries `store_timezone`, `customer_eta`, `allowed_actions`, `pickup_code_locked` and `last_notification` (`{status: SENT | NOT_SENT_OPTED_OUT | NOT_SENT_NO_CONVERSATION, event, at}`).

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
  "expected_current_status": "PENDING",
  "cancel_reason": "NOT_ACTUALLY_IN_STOCK | DAMAGED | STORE_CLOSING_EARLY | OTHER",
  "cancel_note": "≤ 140 chars, OTHER only, internal",
  "pickup_code": "123456"
}
```

`cancel_reason` is required for `CANCELLED` (refusal, `cancelled_by = RETAILER`); `pickup_code` is required for `COMPLETED` (from `CUSTOMER_ARRIVED`). Allowed transitions: `04_DATA_MODEL.md` §15. Inventory-affecting transitions run in a transaction (`03_TECH_ARCHITECTURE.md` §15); `NOT_ACTUALLY_IN_STOCK` also corrects the store's quantity to the reserved quantity (`00` §11.8 Change 13, F3).

Response `200`: the updated reservation plus `notification` (what was sent to the customer, `00` §11.8 Change 13, F4). Moving to `COMPLETED` also records an `Outcome`, as defined in `04_DATA_MODEL.md` §16.

Errors: `409 INVALID_TRANSITION`, `409 STALE_STATUS`, `422 PICKUP_CODE_MISMATCH`, `429 PICKUP_CODE_LOCKED`, `400 INVALID_REQUEST` (missing reason / code), `404 NOT_FOUND` (another store or brand), `403 FORBIDDEN` (`BRAND_ADMIN`, `PLATFORM_ADMIN`).

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

**Change 16, UI-5 — aggregates (read-only).** `GET /api/platform/network?days=7|28&include_history=true|false` → `{ period, demo_history { included, records }, totals { brands_active, retailers, stores_total, stores_live, holds, pickups, offline_value { amount, currency }, online_orders, online_value, completion_pct, fill_pct, unmet_demand, follow_ups_sent }, brands[] { brand_id, name, status, …the same counts…, stores_flagged, last_activity_at } }`. `GET /api/platform/brands/:brandId/network?days=&include_history=` → `{ brand_id, name, status, period, demo_history, retailers[] { retailer_id, name, status, stores[] }, unassigned_stores[] }`, each store `{ store_id, store_name, city, status, store_admin_provisioned (boolean), stock { sku_count, freshness FRESH|STALE|NONE, updated_at }, holds, completed, refused { NOT_ACTUALLY_IN_STOCK, DAMAGED, STORE_CLOSING_EARLY, OTHER }, expired, completion_pct, nearest_lookups, fill_pct, active_holds, stale_holds, flags[] }`; unknown brand → `404`. Neither response contains a customer, conversation, message, phone number, email, pickup code, stock line (SKU, quantity, price) or Store Admin identity. Definitions: offline value = Σ completed quantity × the store's current offline price (an estimate); online orders = ONLINE / ALTERNATIVE outcomes; completion = pickups ÷ finished holds; fill rate = lookups whose nearest store had stock ÷ lookups with a nearest store. `GET /api/platform/audit` events add `target_brand_name` and `actor_role` (the actor's role, or `SYSTEM`).

### POST /api/platform/brands

```json
{ "name": "Brand XYZ" }
```

Response `201`: `{ "brand_id": "...", "name": "Brand XYZ", "status": "ACTIVE", "created_at": "..." }`. The server generates `brand_id`.

### PATCH /api/platform/brands/:brandId

```json
{ "status": "SUSPENDED", "reason": "..." }
```

`status` is `ACTIVE` or `SUSPENDED`. Suspension takes effect on the next request of every `BRAND_ADMIN` and `RETAIL_ADMIN` of that brand, who get `403 BRAND_INACTIVE` "Your brand is suspended. Contact Qwikspot support." (M7). The Platform Admin console asks for the `reason`, which is kept in the audit trail.

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
| `GET /api/platform/brands` | brand registry: `brand_id, name, status, created_at, brand_admin_user_id`, plus (M7) `last_activity_at` (newest brand AuditEvent) and `onboarding`: `brand_admin_provisioned`, `catalog { synced, failed, last_sync_at, product_count }`, `stores { total, with_stock }`, `sku_mapping { auto_matched, needs_attention }`, `retail_admins { provisioned, stores_with_retailer }`, `channel { simulator, whatsapp_number_configured }`. Counts only — no customer, conversation, phone or email fields. |
| `GET /api/platform/brands/:brandId/retailers` | `retailer_id, name, status, store_count` |
| `GET /api/platform/brands/:brandId/stores` | `store_id, store_name, city, store_status, retailer_id, retail_admin_user_id` |
| `GET /api/platform/integrations` | per brand: provider, status, `last_sync_at`, `last_error` code. **No credentials.** |
| `GET /api/platform/reservations` | `reservation_id, brand_id, store_id, status, quantity, created_at, expires_at`. **No customer fields.** |
| `GET /api/platform/outcomes/summary` | per brand and period: outcome counts and values by `purchase_type` |
| `GET /api/platform/audit` | `platformAuditEvents`, newest first |

## 14.10 Demo mode (M7, `00` §11.8 Change 14, G3–G4)

`DEMO_MODE` never weakens authorization: demo users are ordinary users with ordinary scopes.

**`GET /api/demo/config`** (public, 30/min per IP). Off: `{ "demo_mode": false }`. On:

```json
{ "demo_mode": true, "logins": [{ "email": "...", "password": "...", "role": "BRAND_ADMIN", "title": "...", "hint": "..." }] }
```

The logins come from configuration (`DEMO_LOGINS`; locally the seeded users), never from the frontend bundle.

**`POST /api/brand/demo/reset`** (`BRAND_ADMIN`). `404` when `DEMO_MODE` is off; `403 DEMO_RESET_NOT_ALLOWED` when the caller's brand is not in `DEMO_BRAND_IDS` (audited `DENIED`); `403` for any other role; `429 RATE_LIMITED` more than once a minute per brand. It wipes that brand's customers, identities, visitors, intents, conversations and messages, recommendations, reservations, outcomes, commerce events, attribution refs, stock, imports, catalogue, mappings and connections (plus its own intent tokens and webhook receipts), keeps the brand, retailers, stores and their Retail Admins, users and the audit trail, then re-runs the catalogue sync, the judge stock fixture import and the synthetic history, and records `DEMO_RESET`. Response `200`:

```json
{ "brand_id": "brd_demo", "deleted": { "reservations": 73, "...": 0 }, "catalog": { "products": 10, "variants": 18 },
  "stock": { "status": "COMPLETED", "rows_valid": 33, "rows_invalid": 3 }, "history": { "outcomes": 192, "...": 0 } }
```

`GET /api/demo/config` also returns `"shopper_demo": { "brand_id": "brd_demo" }` where the shopper demo is served (local: `brd_demo`; gcp with DEMO_MODE on: the first of `DEMO_BRAND_IDS`), so `/shop`, `/chat` and "Open shopper demo" know which brand to open.

## 14.11 Shopper demo channel (Change 16)

The public twin of the simulator for the shopper's own chat (`/chat`). It enters the same `ConversationPipeline` as the simulator and WhatsApp. **Mounted** in the local profile, and in gcp only with `DEMO_MODE` on; in gcp only brands in `DEMO_BRAND_IDS` answer (others `404`), otherwise `404` for everything. `POST`s must come from the brand's `allowed_storefront_origins` (`403`). Bodies are strict: any unknown field (`customer_ref`, `simulator_customer_ref`, `brand_id` in a message) is `400`.

**`POST /api/shopper/session`** `{ "brand_id": "brd_demo", "shopper_id"?: "gid://shopify/Customer/3002" }` → `201`:

```json
{ "session_token": "<base64url payload>.<base64url HMAC>", "expires_at": "2026-10-05T22:00:00.000Z",
  "brand": { "brand_id": "brd_demo", "display_name": "Demo Beauty Co", "logo_url": "https://…/demo-beauty-co-logo.png" } }
```

Without `shopper_id` the server creates a guest ref `judge_<8 base32>`; with one of the synthetic demo shopper ids it creates a **fresh per-session ref** for that shopper, `shopper_3002_<8 base32>`, and the token carries `s` = the shopper id (UI-6; unknown id → `404 UNKNOWN_SHOPPER`).

**`POST /api/demo-storefront/shopper-sign-in`** (UI-6) accepts the `X-Qwikspot-Shopper-Session` header: with a valid session for the same brand and `s = shopper_id`, the browser is linked to that session's own customer (created with the synthetic shopper's consent and Shopify customer id, server-side); a session for another shopper or brand → `403 SHOPPER_SESSION_MISMATCH`; an invalid token → `401`. Without the header the shared synthetic customer is used (brand-scoped simulator only). `GET /api/demo-storefront/shoppers` no longer returns a customer ref. Audited `SHOPPER_SESSION_STARTED` (`GUEST` / `DEMO_SHOPPER`).

**`POST /api/shopper/messages`** header `X-Qwikspot-Shopper-Session`, body `{ "client_message_id": "cm_…", "content": { "type": "TEXT", "text": "…" } | { "type": "LOCATION", "latitude": 19.12, "longitude": 72.9 } | { "type": "INTERACTIVE_REPLY", "option_id": "hold:st_north_2" } }` → `200 { conversation_id, messages }`. Replays of a `client_message_id` return the original result.

**`GET /api/shopper/messages?after=msg_…`** → `{ conversation_id, messages }` — only the session's own conversation, oldest first. Messages carry `from: SHOPPER | BRAND`, text, options, parts, location, delivery status and time; never origin, message kind or template name (internal labels).

A missing, tampered, expired or other-brand token → `401 SHOPPER_SESSION_INVALID` (the page starts a new guest session).

## 14.7 Brand administration

**Change 16, UI-3 — Brand Console reads (all read-only, additive).**

`GET /api/brand/settings` (`BRAND_ADMIN`, own brand) returns exactly these fields, resolved through the same functions the backend acts on — never credentials, connection secrets, the WhatsApp number or user data:

```json
{ "brand_id": "brd_demo",
  "messaging": { "display_name": "Demo Beauty Co", "logo_url": "/demo-products/demo-beauty-co-logo.png",
                 "powered_by_footer": true, "handoff_enabled": true },
  "follow_up": { "inactivity_minutes": 1, "frequency_hours": 24,
                 "types": [{ "type": "CART_ABANDONMENT", "enabled": true, "delay_minutes": 2, "priority": "NORMAL" }] },
  "retail_freshness_hours": 24, "attribution_window_minutes": 10,
  "allowed_storefront_origins": ["http://localhost:5173"], "channel": { "mode": "SIMULATOR" } }
```

`GET /api/brand/conversations/:conversationId` adds `demo_history`, `outcomes[]` (`purchase_type`, `evidence`, `channel`, `store_id`, `store_name`, `reservation_id`, `value`, `currency`, `timestamp` — the journey's recorded outcome, found by its deterministic ID) and, on each `recommendations[].reservation`, `quantity`, `product_title`, `variant_title` and `status_history[]` (`{ status, at, by?, reason? }` from the reservation's own timestamps; the internal refusal note is never returned). `GET /api/brand/conversations` rows add `demo_history`. `GET /api/reservations` rows for a `BRAND_ADMIN` add `conversation_id`, `image_url` and `demo_history` (a `RETAIL_ADMIN` never receives `conversation_id`). `GET /api/products` adds `image_url` per product. `GET /api/brand/insights` adds `funnel.value: { amount, currency }`, the sum of the recorded values of purchase outcomes (OFFLINE, ONLINE, ALTERNATIVE) in the period, shown as "est.".

Auth: `FIREBASE`, role `BRAND_ADMIN` (the only brand role), for every route in this section. Every change is audited in the brand's `auditEvents`. The brand always comes from the principal.

| Route | Body / result |
|---|---|
| `GET /api/brand/users` | read-only: the brand's console users (its `BRAND_ADMIN` and its retailers' `RETAIL_ADMIN`s): `user_id, email, role, retailer_id, store_id, status` |
| `POST /api/brand/retailers` | `{ "name" }` → `{ "retailer_id", "name", "status" }` |
| `GET /api/brand/retailers` | the brand's retailers: `retailer_id, name, status` |
| `GET /api/brand/stores` | the brand's stores: `store_id, store_name, city, store_status, retailer_id, retail_admin_user_id` (null = not provisioned), `sku_count`, `stock_updated_at` (computed from `retailInventory`) |
| `POST /api/brand/stores/:storeId/admins` | `{ "email" }` → the store's **single** `RETAIL_ADMIN` + `password_setup_link`. Its `brand_id`, `retailer_id` and `store_id` come from the store record; any scope in the request is ignored. A second one → `409 RETAIL_ADMIN_ALREADY_PROVISIONED` (no user and no link created); a store without a retailer → `409 STORE_HAS_NO_RETAILER`. There is no retailer-wide provisioning route. |
| `PATCH /api/brand/stores/:storeId` | `{ "retailer_id": "..." \| null }`: associate a store with a retailer (a retailer may own many stores), or remove the association. Errors: `409 STORE_ALREADY_ASSIGNED`, `409 STORE_HAS_ADMIN` (detaching a store operated by its Retail Admin). **Backend-only**: there is no Brand Console UI, because stores and their retailer come from retail ingestion (M3); kept for tests and as the ingestion building block. Response: the store in the `GET /api/brand/stores` shape. |

There is **no** route for a `BRAND_ADMIN` to create another `BRAND_ADMIN`: only `PLATFORM_ADMIN` provisions a brand's single Brand Admin (§14.6).

Catalogue and retail data (M3), same auth:

| Route | Body / result |
|---|---|
| `POST /api/integrations/shopify/sync` | Syncs products and variants through the wired `CommerceProvider` (§8; mock locally) into `products`, `productVariants` and `productMappings` (source `SHOPIFY`), idempotently by deterministic IDs. Returns the connection: `connection_id, provider, source, status, connected_at, last_sync_at, last_error, product_count, variant_count`. Provider failure → `502 COMMERCE_SYNC_FAILED` (retryable) and the connection records a normalized `last_error`. Customers and orders are not synced in M3. |
| `GET /api/brand/connections` | `{ "connections": [...] }` in the shape above. Never credentials. |
| `GET /api/products` | `products[]` (with `tags`, `attributes`, and `variants[]`: `sku, canonical_sku, barcode, price, currency, mapping_status, stores_stocked`), `retail_mappings_needing_attention[]` (retail SKUs not AUTO_MATCHED), `mapping_summary { auto_matched, needs_attention }` |
| `POST /api/brand/retail-imports` | `{ "file_name": "*.csv" }` → `201 { "import": {...}, "upload": { "method": "PUT", "url", "headers", "expires_at" } }`. The browser PUTs the file to `upload.url` (§6a). |
| `PUT /api/local-files/uploads/:uploadId` | **local profile only** (mounted only when `LocalFileStorageProvider` is wired): raw file body, ≤ 10 MB; the upload's key must belong to the caller's brand, else `404`; one upload per target; expired/unknown → `404`. In `gcp` the browser PUTs to a Cloud Storage signed URL instead. |
| `POST /api/brand/retail-imports/:importId/process` | Validate → normalize → SKU mapping → Firestore (`04` §9–§10.1). Returns the report: `import_id, file_name, status, failure_code, rows_processed, rows_valid, rows_invalid, mappings_created, mappings_failed, row_errors[] { line, store_id, sku, code, field, message }`. `409 FILE_NOT_UPLOADED`, `409 IMPORT_ALREADY_PROCESSED`. A file without the required columns → `status: FAILED, failure_code: MISSING_COLUMNS`. |
| `GET /api/brand/retail-imports` | the latest imports (newest first) |
| `GET /api/brand/retail-imports/:importId` | one report, with its row errors read back from `FileStorageProvider` (`row_errors_reference`) |

Retail import semantics: an import is an **upsert** (stores and SKUs absent from the file are untouched); a store's retailer is set through the same domain rule as `PATCH /api/brand/stores/:storeId` (a store owned by another retailer → row error `RETAILER_CONFLICT`, never moved); `retail_admin_user_id` is never set by ingestion; inventory is written only for AUTO_MATCHED SKUs, and a re-import never changes `reserved_quantity`. Row error codes: `MISSING_VALUE, INVALID_STORE_ID, INVALID_SKU, INVALID_COORDINATES, INVALID_QUANTITY, INVALID_PRICE, INVALID_STATUS, INVALID_BOOLEAN, INVALID_TIMEZONE, INVALID_HOURS, INVALID_RETAILER_ID, DUPLICATE_ROW, STORE_FIELDS_CONFLICT, UNKNOWN_RETAILER, RETAILER_CONFLICT, UNKNOWN_SKU, SKU_CONFLICT, SKU_NEEDS_REVIEW`.

Errors: `409 RETAIL_ADMIN_ALREADY_PROVISIONED`, `409 STORE_HAS_NO_RETAILER`, `409 STORE_ALREADY_ASSIGNED`, `409 STORE_HAS_ADMIN`, `409 USER_EXISTS_IN_OTHER_BRAND`, `409 USER_ALREADY_PROVISIONED`, `404 NOT_FOUND` for another brand's retailer or store.

M6 brand routes (`BRAND_ADMIN`, own brand; another brand's conversation → `404`; other scopes → `403`):

| Route | Result |
|---|---|
| `POST /api/brand/conversations/:conversationId/replies` `{ text }` | a person's reply in a handed-off conversation (`origin = HUMAN_AGENT`; the sender's uid only in the AuditEvent). `409 NOT_IN_HANDOFF`, `409 CUSTOMER_OPTED_OUT`, `409 OUTSIDE_SERVICE_WINDOW` |
| `POST /api/brand/conversations/:conversationId/resolve` | `human_handoff = false` (audited); the next customer message gets automated replies again |
| `GET /api/brand/insights?days=7\|28&include_history=true\|false` | the Outcomes & insights panels (`00` §11.8 Change 13, F8), computed from stored records |

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

| `GET /api/retail/stores/:storeId/inventory` | the own store's stock, read-only: `items[] { sku, canonical_sku, variant_id, product_title, variant_title, quantity, reserved_quantity, available_quantity, availability_status, offline_price, last_updated_at }`. Any other store — including another store of the same retailer — → `404`. |

| `GET /api/retail/stores/:storeId/summary` | M6 "This week" for the own store: `{ days: 7, reservations, completed, refused, expired }`; UI-4 adds `completion_pct` (completed ÷ finished holds, `null` when none finished), `value { amount, currency }` (Σ completed quantity × the store's current offline price — an estimate) and `synthetic` (how many counted holds are generated history). Any other store → `404`. |

| `GET /api/retail/stores/:storeId/insights?days=7\|28&include_history=` | UI-4 "Demand near you": `{ store_id, period, demo_history: { included }, missed[] { sku, label, weekday, reason, count }, fill_rate[] { weekday, nearest, had_stock, fill_pct, refusals }, refusals { NOT_ACTUALLY_IN_STOCK, DAMAGED, STORE_CLOSING_EARLY, OTHER }, suggestions[] { rule, text } }` — only this store's rows, no evidence ids, no customer data. Any other store, including a sibling store of the same retailer → `404`. |

Other scopes calling `/api/retail/*` → `403 FORBIDDEN`. The store's reservation queue uses `GET /api/reservations` and `PATCH /api/reservations/:id` (§14.4) under the same store-level rule.

UI-4: for a `RETAIL_ADMIN`, reservation rows (list and `GET /api/reservations/:id`) add `why_here` (`{ text, distance_km, closer_unavailable[] { store_name, reason }, options }`, or `null` without a trace), `image_url` and `demo_history`. `why_here` names other stores with their exclusion reason only; the only distance is this store's own. The store never receives `conversation_id` (a `BRAND_ADMIN` row field). Inventory rows add `image_url`.

---

# 15. Provider isolation rule

The rest of Qwikspot must not depend directly on:

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
S1 Shopify:        recorded below (L2-Shopify, checked against shopify.dev on 2026-10-08)
S2 Meta WhatsApp:  (pending)
S3 ADK + Gemini:   (pending; record in 05_AI_AGENT_SPEC.md)
```

**S1 Shopify — what the current Shopify docs say (2026-10-08):**

| Topic | Finding | What Qwikspot does |
|---|---|---|
| API version | Quarterly; supported stable 2026-01, 2026-04, 2026-07 and **2026-10** (latest, supported to 2027-10-16). Always send a version. | Pinned `SHOPIFY_API_VERSION=2026-10`. |
| OAuth | Authorization-code grant: `https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state`; the redirect URI must match the app's configuration exactly. Validate the shop with an **anchored** `myshopify.com` regex. | §9 flow; `redirect_uri` = `<PUBLIC_BACKEND_URL>/api/integrations/shopify/callback`. |
| Callback HMAC | Remove `hmac`, sort the remaining params, join `key=value` with `&`, HMAC-SHA256 with the client secret, hex; compare timing-safe. | `verifyCallbackHmac` (domain/shopifyOAuth.ts). |
| Token exchange | `POST https://{shop}/admin/oauth/access_token`, form-encoded `client_id, client_secret, code` (+ `expiring=1`). | As documented. |
| Offline tokens | **Expiring offline tokens** are now the standard: `expires_in` 3600 s, `refresh_token` valid 90 days (`refresh_token_expires_in` 7776000). New public apps must use them; existing public apps by 2027-01-01; custom/merchant apps are exempt. Refresh: same endpoint, `grant_type=refresh_token, refresh_token, client_id, client_secret`; each refresh returns a new pair; 401 = terminal. | Always `expiring=1`; refresh 5 min before expiry; store the newest pair; 401 → reconnect. |
| Webhook HMAC | `X-Shopify-Hmac-Sha256` = base64 HMAC-SHA256 of the **raw** body with the client secret. 1 s connect / 5 s total timeout; 8 retries over 4 h, then the subscription is deleted. | Raw-body route before JSON parsing; quick 200; receipts. |
| Webhook ids | `X-Shopify-Event-Id` identifies the event (same across retries); `X-Shopify-Webhook-Id` the delivery. | Dedupe on event id + topic + brand (webhook id as fallback). |
| Subscriptions | `webhookSubscriptionCreate(topic, webhookSubscription: { uri })`; `callbackUrl` is deprecated; topics `ORDERS_CREATE`, `APP_UNINSTALLED`. | Listed first, created only when missing (idempotent). |
| Product fields | `featuredMedia` replaces the deprecated `featuredImage`; `ProductStatus` has `ACTIVE, ARCHIVED, DRAFT, UNLISTED`; prices in the shop's `currencyCode`. | `featuredMedia.preview.image.url`; UNLISTED → ACTIVE. |
| Customer fields | `email`, `phone`, `emailMarketingConsent`, `smsMarketingConsent` are deprecated → `defaultEmailAddress { emailAddress marketingState }`, `defaultPhoneNumber { phoneNumber marketingState }`. | Uses the new fields; `SUBSCRIBED` → OPTED_IN. |
| Order attributes | GraphQL `Order.customAttributes`; the REST-shaped webhook payload carries `note_attributes [{ name, value }]`. | Webhook reads `note_attributes` (`qs_ref`, `qs_ws`). |
