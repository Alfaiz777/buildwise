# Buildwise — Data Model

## Status

**M0 — Initial canonical schema**, updated by the post-M0 architecture change (`00_M0_SPECIFICATION_FREEZE.md` §11.8)

The schema may evolve during implementation, but entity responsibilities and tenant boundaries are frozen.

This document is the **canonical home** for:

- user roles and scopes (§4)
- the retailer model (§8a)
- the retail ingestion schema (§9.1)
- customer intent type and stage (§11)
- the AI action taxonomy (§14)
- the Outcome purchase type and its mapping to AI actions (§16, §16.1)
- the Firestore collection layout (§21)

Other documents reference these definitions rather than redefining them.

---

# 1. Tenant model

Every brand is a tenant.

Core principle:

```text
tenant_id / brand_id
```

must exist on every tenant-owned entity.

No brand can access another brand's operational data.

Buildwise itself (the platform) is **not** a tenant. Platform-level records (the brand registry, platform users, the platform audit) live outside any brand. Platform scope is never represented by a special `brand_id` value (see §4 and `07_SECURITY_SPEC.md` §4.2).

A **Retailer** belongs to exactly one brand (§8a). Retail scope (a `RETAIL_ADMIN`'s retailer) is a subset of brand scope, so the brand remains the tenant boundary.

---

# 2. Core entities

```text
Brand
User
IntegrationConnection
Customer
Product
ProductVariant
ProductMapping
Retailer
RetailStore
RetailInventory
RetailImport
CustomerIntent
IntentToken
Conversation
ConversationMessage
AIRecommendation
Reservation
PageAccessToken
Outcome
AuditEvent
PlatformAuditEvent
CommerceEvent
WebhookReceipt
```

`ProductMapping`, `IntentToken`, `PageAccessToken` and `WebhookReceipt` are supporting entities. They persist state that other specifications already require: the SKU mapping contract, the web → WhatsApp handshake, contextual-page authorization and webhook idempotency. They do not add product features.

---

# 3. Brand

```text
Brand
- brand_id
- name
- status
- created_at
- updated_at
- settings
- brand_admin_user_id   (the brand's single BRAND_ADMIN; null until provisioned)
```

`status`:

```text
ACTIVE
SUSPENDED    (set by PLATFORM_ADMIN; its BRAND_ADMIN and RETAIL_ADMINs are refused)
```

Brands are created by a `PLATFORM_ADMIN`, who also provisions the brand's **one** `BRAND_ADMIN` (`07_SECURITY_SPEC.md` §4.4). `brand_admin_user_id` is claimed in a Firestore transaction at provisioning, so a brand can never get a second Brand Admin.

Settings may include:

```text
brand_tone
allowed_ai_actions
reservation_policy
customer_communication_preferences
human_handoff_rules
allowed_storefront_origins
```

`reservation_policy` includes at least:

```text
reservations_enabled
hold_minutes          (prototype default: 120)
max_quantity_per_reservation (prototype default: 2)
```

`allowed_storefront_origins` is the allowlist of website origins that may call `POST /api/intents` for this brand (see `06_INTEGRATION_CONTRACTS.md` §14.1).

---

# 4. User

```text
User
- user_id            (= Firebase Auth uid)
- role
- brand_id           (null for PLATFORM_ADMIN; required for BRAND_ADMIN and RETAIL_ADMIN)
- retailer_id        (required for RETAIL_ADMIN; null otherwise)
- store_id           (required for RETAIL_ADMIN: its one store; null otherwise)
- email
- status             (ACTIVE | DISABLED)
- created_at
- updated_at
```

The MVP has exactly **three internal roles**, one per console:

```text
PLATFORM_ADMIN
BRAND_ADMIN
RETAIL_ADMIN
```

Role → scope and required fields:

| Role | Scope | `brand_id` | `retailer_id` | `store_id` | Access |
|---|---|---|---|---|---|
| `PLATFORM_ADMIN` | Platform | **must be null** | null | null | Platform Admin Console |
| `BRAND_ADMIN` | Brand | required | null | null | Brand Console: full administration of its one brand |
| `RETAIL_ADMIN` | Retail (store-level) | required | required | required | Retailer Console: exactly its one store |

A document that violates this table, or carries any other role value, is rejected during principal resolution (`07_SECURITY_SPEC.md` §4.1).

MVP user model — **exactly one operator per scope**:

- one `PLATFORM_ADMIN` for the prototype (bootstrapped by the seed script)
- exactly one `BRAND_ADMIN` per brand, recorded as `Brand.brand_admin_user_id`, provisioned only by `PLATFORM_ADMIN`
- at most one `RETAIL_ADMIN` per store, recorded as `RetailStore.retail_admin_user_id`, provisioned by the brand's `BRAND_ADMIN` for that specific store (the store must belong to a retailer)

Retail ownership (§8a): a retailer may own many stores; each store belongs to exactly one retailer and has at most one `RETAIL_ADMIN`; each `RETAIL_ADMIN` operates exactly one store. There is no multi-store Retail Admin and no store-staff role.

A `BRAND_ADMIN` is accepted only if it is the admin recorded on its brand; a `RETAIL_ADMIN` only if it is the admin recorded on the store named by `users.store_id`, and `RetailStore.retailer_id = users.retailer_id` (`07_SECURITY_SPEC.md` §4.1). A missing or mismatched `store_id` is a misconfigured user. `retailer_id` and `store_id` are written by provisioning from the store record, never chosen by a client. Replacing an admin, or having several admins per scope, is not part of the MVP.

The customer is **not** a User and has no internal role. Customers are identified through their channel identity (§6) or a contextual page token (`07_SECURITY_SPEC.md` §4.3), and are represented by a customer principal, never by `users/{uid}`.

Permissions per role are defined in `07_SECURITY_SPEC.md` §4.

---

# 5. IntegrationConnection

Used for external systems:

```text
IntegrationConnection
- connection_id
- brand_id
- provider
- status
- external_account_id
- credential_reference
- connected_at
- last_sync_at
- last_error
```

Providers:

```text
SHOPIFY
WHATSAPP
RETAIL_FILE
```

Sensitive credentials are referenced through secure secret storage, not stored as ordinary readable fields.

For `WHATSAPP`, `external_account_id` holds the phone number ID used to resolve an inbound webhook to its brand.

---

# 6. Customer

```text
Customer
- customer_id
- brand_id
- shopify_customer_id
- channel_identities       (list of { channel, external_ref })
- lifecycle_stage
- relevant_preferences
- consent_state
- preferred_channel
- location_reference
- created_at
- updated_at
```

`channel_identities` replaces the earlier `whatsapp_identity_reference`, so both customer channels resolve identity through the same pipeline step:

| channel | external_ref |
|---|---|
| `WHATSAPP` | the customer's WhatsApp ID (from the webhook) |
| `SIMULATOR` | `sim:{simulator_customer_ref}` (synthetic; never a real person's identifier) |

A (`channel`, `external_ref`) pair identifies at most one Customer per brand.

Only relevant customer data should be retained/used. Customer records and conversation content are **customer PII** for the purposes of platform-scope restrictions (`07_SECURITY_SPEC.md` §4.2).

`shopify_*` identifiers are populated by the active `CommerceProvider`. `MockCommerceProvider` supplies fixture IDs in the same format, so the model is identical in both profiles.

---

# 7. Product

```text
Product
- product_id
- brand_id
- canonical_product_id
- shopify_product_id
- title
- description
- category
- status
- asset_references
```

---

# 8. ProductVariant

```text
ProductVariant
- variant_id
- brand_id
- product_id
- shopify_variant_id
- sku
- barcode
- price
- currency
- status
```

## 8.1 ProductMapping

Persists the product mapping contract (`06_INTEGRATION_CONTRACTS.md` §13).

```text
ProductMapping
- mapping_id
- brand_id
- source_system        (SHOPIFY | RETAIL_FILE)
- source_identifier
- canonical_sku
- variant_id
- mapping_status       (AUTO_MATCHED | MANUAL_MATCH_REQUIRED | CONFLICT | UNMAPPED)
- mapping_reason
- updated_at
```

---

# 8a. Retailer

A retailer is the retail business or partner that operates one or more of a brand's physical stores (for example a retail chain, franchisee or store operator). A store is one physical location. A `RETAIL_ADMIN` operates exactly one store:

```text
Brand                         (Dot & Key)
 └── Retailer                 (Nykaa)
      ├── Store A ── RETAIL_ADMIN_A     (Mumbai Store)
      ├── Store B ── RETAIL_ADMIN_B     (Delhi Store)
      └── Store C ── RETAIL_ADMIN_C     (Ahmedabad Store)
```

```text
Retailer
- retailer_id
- brand_id
- name
- status                 (ACTIVE | INACTIVE)
- created_at
- updated_at
```

Rules:

- A retailer belongs to **exactly one brand**. A real-world business that sells for several brands is represented by a separate Retailer record under each brand in the MVP. Retailer identity is not shared across brands.
- Retailers are created and managed by `BRAND_ADMIN`.
- **One retailer, many stores:** a retailer may own any number of stores; a store belongs to at most one retailer (`RetailStore.retailer_id`). Attaching a store that already has a retailer → `409 STORE_ALREADY_ASSIGNED`; detaching a store that has a `RETAIL_ADMIN` → `409 STORE_HAS_ADMIN`.
- **One Retail Admin per store:** the `BRAND_ADMIN` provisions a store's single `RETAIL_ADMIN` from that store (claimed transactionally in `RetailStore.retail_admin_user_id`; a second one → `409 RETAIL_ADMIN_ALREADY_PROVISIONED`; a store without a retailer → `409 STORE_HAS_NO_RETAILER`).
- A store with no retailer is visible only to brand scope until it is associated with one.
- The store ↔ retailer association is established by retail ingestion (M4): the optional `retailer_id` column of the retail file (§9.1). Until then the Brand Console has **no** store UI and no manual store-ID entry; a backend-only association operation exists for tests and as the ingestion building block (`06_INTEGRATION_CONTRACTS.md` §14.7).
- An `INACTIVE` retailer's users are refused during principal resolution.

---

# 9. RetailStore

```text
RetailStore
- store_id
- brand_id
- retailer_id             (its one retailer; null until associated; see §8a)
- retail_admin_user_id    (the store's single RETAIL_ADMIN; null until provisioned; see §4)
- store_name
- city
- address
- latitude
- longitude
- store_hours             (structured object; format in §9.2)
- store_status
- reservation_available   (optional in upload; default true)
- pickup_available        (optional in upload; default true)
- updated_at
```

`store_status`:

```text
ACTIVE
INACTIVE
```

Only `ACTIVE` stores can be recommended or reserved.

## 9.1 Canonical retail schema

This is the **single canonical retail schema**. The upload file, the ingestion contract and the normalized entities all use these exact field names.

Required fields (one row per store × SKU):

```text
store_id
store_name
city
address
latitude
longitude
store_hours       (structured; see §9.2 for format and upload columns)
store_status
sku
quantity
offline_price
```

Optional fields:

```text
pickup_available
reservation_available
retailer_id              (must reference an existing Retailer of the same brand)
```

The 11 required fields are unchanged. `retailer_id` is optional. When present it establishes the store's retailer (§8a): the same `retailer_id` may appear on many stores (one retailer, many stores), and a store that already belongs to a different retailer is reported as a conflict, not silently moved. Ingestion never sets `retail_admin_user_id`; each imported store can later receive its Retail Admin.

Normalization:

```text
store_id, store_name, city, address,
latitude, longitude, store_hours, store_status,
pickup_available, reservation_available, retailer_id
        → RetailStore

store_id, sku, quantity, offline_price
        → RetailInventory
```

Store-level fields must be consistent across all rows of the same `store_id`. Rows with conflicting values are reported as invalid.

## 9.2 store_hours format

`store_hours` is a structured object. This is the **canonical MVP format**:

```yaml
store_hours:
  timezone: "Asia/Kolkata"      # IANA timezone string
  monday:    "10:00-21:00"      # "HH:MM-HH:MM"
  tuesday:   "10:00-21:00"
  wednesday: "10:00-21:00"
  thursday:  "10:00-21:00"
  friday:    "10:00-21:00"
  saturday:  "10:00-22:00"
  sunday:    "11:00-20:00"
```

Rules:

- `timezone` must be a valid IANA timezone identifier (e.g. `Asia/Kolkata`). Offsets such as `+05:30` or abbreviations such as `IST` are rejected.
- Each day uses the 24-hour format `HH:MM-HH:MM` in the store's `timezone`, with opening time earlier than closing time.
- A day with an empty value is treated as **closed** that day.
- Hours that run past midnight are not supported in the MVP.

Representation in the CSV/XLSX upload (flat files cannot nest objects). Each part is its own column, named by its path:

```text
store_hours.timezone
store_hours.monday
store_hours.tuesday
store_hours.wednesday
store_hours.thursday
store_hours.friday
store_hours.saturday
store_hours.sunday
```

Ingestion assembles these columns into the `store_hours` object. A row with an invalid timezone or a malformed day value is reported as invalid.

"Open now" is computed deterministically by backend code:

```text
local_time = now converted to store_hours.timezone
day        = weekday of local_time
open_now   = store_hours[day] is non-empty
             AND opening ≤ local_time < closing
```

Gemini never computes or asserts opening hours. It receives only the verified `open_now` / hours result from tools.

---

# 10. RetailInventory

```text
RetailInventory
- inventory_id          (deterministic: store_id + canonical_sku)
- brand_id
- store_id
- sku                   (retail SKU as uploaded, normalized)
- canonical_sku
- variant_id
- quantity              (on-hand units reported by the retail file)
- reserved_quantity     (units held by active reservations; maintained by Buildwise)
- offline_price
- availability_status
- last_updated_at
```

Available-to-reserve quantity:

```text
available_quantity = quantity − reserved_quantity
```

`reserved_quantity` is changed **only** inside the reservation transaction (`03_TECH_ARCHITECTURE.md` §15). A retail re-upload overwrites `quantity` but never `reserved_quantity`.

Availability may be:

```text
IN_STOCK
LOW_STOCK
OUT_OF_STOCK
UNKNOWN
```

## 10.1 RetailImport

Persists each retail file ingestion and its report (`06_INTEGRATION_CONTRACTS.md` §4, §12).

```text
RetailImport
- import_id
- brand_id
- file_key              (FileStorageProvider key; never a public URL)
- uploaded_by           (user_id)
- status                (UPLOADED | PROCESSING | COMPLETED | FAILED)
- rows_processed
- rows_valid
- rows_invalid
- mappings_created
- mappings_failed
- row_errors_reference  (FileStorageProvider key of the row-level error report)
- created_at
- completed_at
```

---

# 11. CustomerIntent

```text
CustomerIntent
- intent_id
- brand_id
- customer_id           (null until the web session is bound to a customer)
- web_session_id        (opaque random storefront session ID; no PII)
- source
- product_variant_id
- intent_stage
- intent_type
- confidence
- event_reference
- detected_at
- updated_at
- status
```

Sources:

```text
SHOPIFY
WEBSITE
WHATSAPP
SIMULATOR
```

## 11.1 intent_stage vs intent_type

Two separate fields answer two separate questions.

| Field | Question | Set by |
|---|---|---|
| `intent_stage` | How strong is the customer's demonstrated intent? | Deterministic rules over behavioral events only. Gemini never sets it. |
| `intent_type` | What is the customer trying to accomplish? | Deterministic rules for web events. It may be refined by Gemini from conversation content, and the backend validates the value. |

`intent_stage`:

```text
NO_MEANINGFUL_INTENT
INTERESTED
HIGH_INTENT
```

`intent_type`:

```text
PRODUCT_EXPLORATION
CART_ABANDONMENT
PRODUCT_QUESTION
COMPARISON
URGENT_PURCHASE
STORE_ORIENTED
SUPPORT_REQUEST
UNKNOWN
```

`confidence` applies to `intent_type` only.

## 11.2 Prototype stage rules

These are the prototype default rules. They are deterministic and configurable, and Gemini must not invent the underlying behavioral facts.

```text
NO_MEANINGFUL_INTENT
  default; only PRODUCT_VIEW events below the INTERESTED threshold

INTERESTED
  PRODUCT_DETAIL_VIEW for a variant
  OR ≥ 2 PRODUCT_VIEW events for the same product in one web session

HIGH_INTENT
  ADD_TO_CART
  OR CHECKOUT_STARTED
  OR WHATSAPP_CLICK
```

A stage can only increase within a web session.

---

# 12. Conversation

```text
Conversation
- conversation_id
- brand_id
- customer_id
- channel
- status
- current_intent_id
- started_at
- updated_at
- last_inbound_at        (used for the customer-service window policy; applied to every channel)
- human_handoff
```

Channel values:

```text
WHATSAPP
SIMULATOR    (approved prototype fallback; same backend path)
```

---

# 13. ConversationMessage

```text
ConversationMessage
- message_id
- brand_id
- conversation_id
- direction
- message_type
- content_reference
- external_message_id
- timestamp
- delivery_status
```

Avoid storing unnecessary sensitive content in broad analytics/logging systems.

---

# 14. AIRecommendation

```text
AIRecommendation
- recommendation_id
- brand_id
- customer_id
- conversation_id
- intent_id
- action
- target_store_id        (when applicable)
- target_variant_id      (when applicable)
- confidence
- rationale_summary
- evidence_references
- runtime                (MOCK | ADK_GEMINI)
- decision_source        (AGENT | DETERMINISTIC_FALLBACK)
- proposed_at
- guardrail_status
```

`runtime` records which `AgentRuntime` produced the decision. It is mandatory on every recommendation.

- `MOCK` decisions come from the deterministic `MockAgentRuntime`. They are never presented or reported as Gemini intelligence (`05_AI_AGENT_SPEC.md` §9.2).
- `decision_source = AGENT` means the runtime produced the decision. `DETERMINISTIC_FALLBACK` means the runtime failed and the fixed fallback was used (`03_TECH_ARCHITECTURE.md` §16.2).

`action` is the **canonical AI action taxonomy**:

```text
NO_ACTION
EDUCATE
COMPARE
ONLINE_PURCHASE
STORE_DISCOVERY
STORE_RESERVATION
ALTERNATIVE_PRODUCT
HUMAN_HANDOFF
```

| Action | Meaning |
|---|---|
| `NO_ACTION` | No commerce action is proposed. The agent does not initiate contact. In an inbound conversation it may still send a plain informational or refusal reply. |
| `EDUCATE` | Answer product questions from verified product information. |
| `COMPARE` | Guided comparison between verified products/variants. |
| `ONLINE_PURCHASE` | Guide the customer to complete the purchase online (Shopify). |
| `STORE_DISCOVERY` | Show eligible nearby stores with verified availability. |
| `STORE_RESERVATION` | Propose/create a reservation at a specific eligible store. |
| `ALTERNATIVE_PRODUCT` | Suggest a different verified product/variant. |
| `HUMAN_HANDOFF` | Stop automated handling and route to a human. |

`guardrail_status`:

```text
ALLOWED
BLOCKED
HUMAN_APPROVAL_REQUIRED
```

An `AIRecommendation` records what the AI **proposed**. It never records what the customer actually did.

---

# 15. Reservation

```text
Reservation
- reservation_id
- brand_id
- retailer_id            (copied from the store at creation; null if the store has no retailer)
- customer_id
- store_id
- variant_id
- quantity
- status
- idempotency_key
- ai_recommendation_id   (when created from an AI recommendation)
- created_at
- expires_at
- confirmed_at
- ready_at
- customer_arrived_at
- completed_at
- cancelled_at
```

Status:

```text
PENDING
CONFIRMED
READY
CUSTOMER_ARRIVED
COMPLETED
CANCELLED
EXPIRED
```

Allowed transitions:

```text
PENDING → CONFIRMED → READY → CUSTOMER_ARRIVED → COMPLETED
PENDING | CONFIRMED | READY → CANCELLED
PENDING | CONFIRMED | READY → EXPIRED
```

`expires_at = created_at + brand.settings.reservation_policy.hold_minutes`.

Inventory effect of each transition (always applied inside a Firestore transaction):

| Transition | RetailInventory effect |
|---|---|
| create (PENDING) | `reserved_quantity += quantity` |
| → CANCELLED / EXPIRED | `reserved_quantity −= quantity` |
| → COMPLETED | `reserved_quantity −= quantity` and `quantity −= quantity` |
| other transitions | none |

---

# 16. Outcome

```text
Outcome
- outcome_id
- brand_id
- customer_id
- source_intent_id
- ai_recommendation_id
- purchase_type
- channel
- store_id               (OFFLINE / offline ALTERNATIVE)
- reservation_id         (OFFLINE via reservation)
- order_reference        (ONLINE / online ALTERNATIVE: Shopify order ID)
- value
- timestamp
```

`purchase_type` is the **canonical business outcome**:

```text
ONLINE
OFFLINE
ALTERNATIVE
NONE
```

| purchase_type | Recorded when (verified evidence required) |
|---|---|
| `ONLINE` | A Shopify order for the intent's product/variant is received via sync/webhook (`order_reference` set). |
| `OFFLINE` | A reservation for the intent's variant reaches `COMPLETED` (`store_id`, `reservation_id` set). |
| `ALTERNATIVE` | A verified online order or completed reservation is for a **different** variant from the intent's variant. `order_reference` or `store_id` shows which channel. |
| `NONE` | The journey closes without a verified purchase (for example the reservation expired or was cancelled, or the attribution window elapsed). |

`channel` is the conversation channel the journey ran through (`WHATSAPP` or `SIMULATOR`).

An Outcome is written by deterministic backend code from verified evidence. It is never written from the AI's proposed action.

## 16.1 Action → outcome mapping

AI action and business outcome are separate, and any action can end in any outcome. The table shows the outcome each action aims for. It is used for success analytics ("did the recommended path convert?"). It does not set the outcome.

| AIRecommendation.action | Intended (success) purchase_type | Other possible purchase_type |
|---|---|---|
| `NO_ACTION` | — (organic) | ONLINE, OFFLINE, ALTERNATIVE, NONE |
| `EDUCATE` | ONLINE or OFFLINE | ALTERNATIVE, NONE |
| `COMPARE` | ONLINE or OFFLINE | ALTERNATIVE, NONE |
| `ONLINE_PURCHASE` | ONLINE | OFFLINE, ALTERNATIVE, NONE |
| `STORE_DISCOVERY` | OFFLINE | ONLINE, ALTERNATIVE, NONE |
| `STORE_RESERVATION` | OFFLINE | ONLINE, ALTERNATIVE, NONE |
| `ALTERNATIVE_PRODUCT` | ALTERNATIVE | ONLINE, OFFLINE, NONE |
| `HUMAN_HANDOFF` | — (human-owned) | ONLINE, OFFLINE, ALTERNATIVE, NONE |

A recommendation "converted" when the recorded `purchase_type` equals its intended `purchase_type`.

## 16.2 Mapping from product outcome vocabulary

`01_PRODUCT_SOURCE_OF_TRUTH.md` §16 lists journey outcome types. Each one maps to a canonical field:

| 01 §16 outcome type | Canonical representation |
|---|---|
| `NO_ACTION` | `AIRecommendation.action = NO_ACTION` |
| `CONVERSATION_STARTED` | `CommerceEvent.event_type = CONVERSATION_STARTED` |
| `PRODUCT_EDUCATION` | `AIRecommendation.action = EDUCATE` |
| `ONLINE_PURCHASE` | `Outcome.purchase_type = ONLINE` |
| `STORE_RESERVATION` | `Reservation` created + `CommerceEvent RESERVATION_CREATED` |
| `STORE_PURCHASE` | `Outcome.purchase_type = OFFLINE` |
| `ALTERNATIVE_PURCHASE` | `Outcome.purchase_type = ALTERNATIVE` |
| `HUMAN_HANDOFF` | `AIRecommendation.action = HUMAN_HANDOFF` + `CommerceEvent HUMAN_HANDOFF` |
| `NO_CONVERSION` | `Outcome.purchase_type = NONE` |

---

# 17. CommerceEvent

```text
CommerceEvent
- event_id
- brand_id
- customer_id           (null for anonymous web events)
- web_session_id        (for web events before customer binding)
- event_type
- source
- entity_reference
- event_payload_reference
- timestamp
- idempotency_key
```

Canonical `event_type` values:

```text
PRODUCT_VIEW
PRODUCT_DETAIL_VIEW
ADD_TO_CART
CHECKOUT_STARTED
WHATSAPP_CLICK
ORDER_CREATED
CONVERSATION_STARTED
MESSAGE_RECEIVED
MESSAGE_SENT
AI_DECISION
STORE_RECOMMENDATION
RESERVATION_CREATED
RESERVATION_CONFIRMED
PICKUP_COMPLETED
ONLINE_PURCHASE
OFFLINE_PURCHASE
HUMAN_HANDOFF
```

These are the only event names. Other documents that list analytics events (for example `02_MVP_SPEC.md` §11) refer to this list.

---

# 18. AuditEvent

```text
AuditEvent
- audit_id
- brand_id
- actor_type
- actor_id
- action
- target_type
- target_id
- result
- reason_code
- timestamp
```

The audit trail should answer:

> What happened, who/what initiated it, what was proposed, what was allowed, and what actually executed?

## 18.0 PlatformAuditEvent

Platform-scope actions (`PLATFORM_ADMIN`) are recorded outside any brand:

```text
PlatformAuditEvent
- audit_id
- actor_id               (PLATFORM_ADMIN user_id)
- action                 (e.g. BRAND_CREATED, BRAND_SUSPENDED, BRAND_ADMIN_PROVISIONED)
- target_brand_id        (when the action concerns a brand)
- target_type
- target_id
- result
- reason_code
- timestamp
```

When a platform action concerns a brand, an `AuditEvent` with `actor_type = PLATFORM_ADMIN` is **also** written to that brand's `auditEvents`, so the brand can see what the platform did.

---

# 18.1 IntentToken

Persists the web → WhatsApp handshake token (`06_INTEGRATION_CONTRACTS.md` §10.1).

```text
IntentToken
- token_hash            (SHA-256 of the token; document ID; raw token never stored)
- brand_id
- intent_id
- web_session_id
- issued_at
- expires_at            (issued_at + 30 minutes)
- consumed_at
- consumed_by_customer_id
```

Contains no PII.

# 18.2 PageAccessToken

Persists contextual customer-page authorization (`07_SECURITY_SPEC.md` §16).

```text
PageAccessToken
- token_hash            (SHA-256 of the token; document ID; raw token never stored)
- brand_id
- customer_id
- conversation_id
- resource_type         (NEARBY_STORES | RESERVATION | PICKUP)
- resource_id
- scope                 (VIEW | MUTATE)
- allowed_action        (MUTATE only; e.g. CREATE_RESERVATION)
- issued_at
- expires_at
- used_at               (MUTATE only)
- revoked
```

# 18.3 WebhookReceipt

Persists webhook idempotency (`03_TECH_ARCHITECTURE.md` §16.3).

```text
WebhookReceipt
- receipt_id            (deterministic idempotency key; document ID)
- brand_id              (when resolved)
- provider              (SHOPIFY | WHATSAPP | SIMULATOR)
- event_type
- external_event_id
- status                (PROCESSING | PROCESSED | FAILED)
- received_at
- expires_at            (retention: 7 days)
```

---

# 19. Canonical identity rule

For product matching:

```text
Shopify Variant SKU
        ↕
Canonical SKU
        ↕
Retail SKU
```

Do not make product name equality the primary mapping mechanism.

---

# 20. AI context package

The backend creates a temporary decision context:

```json
{
  "customer": {
    "lifecycle_stage": "new",
    "relevant_preferences": [],
    "location": {}
  },
  "intent": {
    "intent_stage": "HIGH_INTENT",
    "intent_type": "URGENT_PURCHASE",
    "product_variant_id": "..."
  },
  "product": {
    "title": "...",
    "sku": "...",
    "price": 999
  },
  "retail": {
    "eligible_stores": [
      {
        "store_id": "...",
        "distance_km": 2.1,
        "available": true,
        "available_quantity": 8,
        "open": true,
        "pickup_available": true
      }
    ]
  },
  "brand_policy": {
    "allow_reservation": true
  }
}
```

Only the minimum required context should be sent to the agent runtime (Gemini in `gcp`; the same package is built for `MockAgentRuntime` locally).

---

# 21. Firestore collection layout

Tenant-owned entities live under their brand. Paths are always resolved server-side from the authenticated principal or a validated token, never from client-supplied `brand_id` alone.

```text
brands/{brand_id}
brands/{brand_id}/connections/{connection_id}
brands/{brand_id}/customers/{customer_id}
brands/{brand_id}/products/{product_id}
brands/{brand_id}/productVariants/{variant_id}
brands/{brand_id}/productMappings/{mapping_id}
brands/{brand_id}/retailers/{retailer_id}
brands/{brand_id}/stores/{store_id}
brands/{brand_id}/retailInventory/{inventory_id}
brands/{brand_id}/retailImports/{import_id}
brands/{brand_id}/customerIntents/{intent_id}
brands/{brand_id}/conversations/{conversation_id}
brands/{brand_id}/conversations/{conversation_id}/messages/{message_id}
brands/{brand_id}/aiRecommendations/{recommendation_id}
brands/{brand_id}/reservations/{reservation_id}
brands/{brand_id}/outcomes/{outcome_id}
brands/{brand_id}/commerceEvents/{event_id}
brands/{brand_id}/auditEvents/{audit_id}
```

Top-level collections. They must be looked up before the brand is known, or they are platform-level:

```text
users/{user_id}                 (Firebase uid → role, brand_id, retailer_id, store_id)
intentTokens/{token_hash}
pageAccessTokens/{token_hash}
webhookReceipts/{receipt_id}
platformAuditEvents/{audit_id}  (platform-level; no brand owner)
```

Documents in `intentTokens`, `pageAccessTokens` and `webhookReceipts` carry `brand_id`. `users` carries `brand_id` except for `PLATFORM_ADMIN`.

Entity → collection:

| Entity | Collection |
|---|---|
| Brand | `brands` |
| User | `users` |
| IntegrationConnection | `connections` |
| Customer | `customers` |
| Product | `products` |
| ProductVariant | `productVariants` |
| ProductMapping | `productMappings` |
| Retailer | `retailers` |
| RetailStore | `stores` |
| RetailInventory | `retailInventory` |
| RetailImport | `retailImports` |
| CustomerIntent | `customerIntents` |
| IntentToken | `intentTokens` |
| Conversation | `conversations` |
| ConversationMessage | `conversations/{id}/messages` |
| AIRecommendation | `aiRecommendations` |
| Reservation | `reservations` |
| PageAccessToken | `pageAccessTokens` |
| Outcome | `outcomes` |
| CommerceEvent | `commerceEvents` |
| AuditEvent | `auditEvents` |
| PlatformAuditEvent | `platformAuditEvents` |
| WebhookReceipt | `webhookReceipts` |
