# Buildwise — MVP Specification

## Status

**M0 — Frozen MVP scope.** Updated by the post-M0 architecture change (`00_M0_SPECIFICATION_FREEZE.md` §11.8): four interfaces, minimal platform administration, retailer administration, execution profiles. The vertical slice and customer journey are unchanged.

---

# 1. MVP objective

Build one complete working vertical slice that proves the product thesis.

The MVP does not need every future integration.

It must make the core product decision visible and functional.

---

# 2. MVP vertical slice

```text
Brand connects Shopify
        ↓
Relevant online commerce data available
        ↓
Brand uploads retail network data
        ↓
Products are mapped by stable SKU/identifier
        ↓
Customer intent enters Buildwise
        ↓
Buildwise constructs decision context
        ↓
Gemini + ADK reasons over context
        ↓
Next-best action selected
        ↓
WhatsApp conversation
        ↓
Customer chooses
  ├── online purchase
  └── store reservation
        ↓
Action guardrail
        ↓
Retailer workflow
        ↓
Outcome
        ↓
Brand intelligence
```

---

# 3. MVP modules

The MVP has **four interfaces**: Platform Admin Console, Brand Console, Retailer Console and Customer AI Channel (`01_PRODUCT_SOURCE_OF_TRUTH.md` §8b). Roles and permissions are in `07_SECURITY_SPEC.md` §4.

## 0. Platform administration (minimal)

Required:

- list brands and their status
- create a brand
- suspend / reactivate a brand
- provision a brand's first `BRAND_ADMIN` (password-setup link handed over manually; the MVP has no email service)
- view integration health metadata across brands (no credentials)
- view reservations/outcomes at aggregate or operational level (no customer PII)
- view the platform audit log

Not included: customer profiles or conversation content (`07_SECURITY_SPEC.md` §4.2), billing, platform analytics beyond the items above.

## A. Brand onboarding

Required:

- brand account created by a platform admin; Brand Admin signs in (no self-signup)
- Brand Admin manages brand members (`BRAND_ADMIN`, `BRAND_MEMBER`)
- Brand Admin creates retailers, assigns stores to retailers and provisions retailer users (`RETAILER_ADMIN`, `RETAILER_STAFF`)
- connect Shopify
- show connection status
- initial sync status
- retail data upload
- SKU mapping status
- WhatsApp connection status

---

## B. Shopify integration

For the prototype, retrieve the minimum relevant commerce data:

- products
- variants
- SKUs
- relevant product details
- customers required for the use case
- orders
- online inventory/location data if required

Shopify remains the source of truth for online commerce.

Buildwise maintains a normalized operational representation in Firestore.

### Important MVP constraint

Do not assume Shopify Admin API automatically provides every raw website-behavior event required for “high intent.”

For the prototype, customer intent can enter through:

1. a controlled Buildwise intent-event endpoint, or
2. a small demo instrumentation layer, or
3. seeded/simulated events.

The source of the intent event must be explicit.

---

# 4. Retail network ingestion

Brand uploads CSV/XLSX data (≤ 10 MB per file) using the canonical retail schema (`04_DATA_MODEL.md` §9.1). Required:

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

`store_hours` uses the canonical structured format: an IANA `timezone` plus one `HH:MM-HH:MM` value per weekday (`04_DATA_MODEL.md` §9.2).

Optional:

```text
pickup_available
reservation_available
```

The ingestion pipeline:

```text
Upload
↓
Cloud Storage
↓
Cloud Run
↓
Validate
↓
Normalize
↓
Map SKU
↓
Firestore
```

---

# 5. Product mapping

The system must not rely primarily on product names.

Preferred mapping:

```text
SKU
↓
barcode/GTIN where available
↓
Shopify variant identifier
↓
manual exception mapping where necessary
```

Canonical identity:

```text
Buildwise canonical product
        ↕
Shopify variant/SKU
        ↕
Retail SKU
```

Unmapped/conflicting records must be visible to the brand.

---

# 6. Customer intent

The MVP represents customer intent with two separate fields (`04_DATA_MODEL.md` §11).

`intent_stage` is how strong the demonstrated intent is. It is deterministic only:

```text
NO_MEANINGFUL_INTENT
INTERESTED
HIGH_INTENT
```

`intent_type` is what the customer is trying to accomplish:

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

(The earlier draft's `CASUAL` corresponds to `intent_stage = NO_MEANINGFUL_INTENT`, and its `HIGH_INTENT` to `intent_stage = HIGH_INTENT`.)

The intent engine is deterministic for `intent_stage`. For `intent_type`, it is deterministic on web events and may be refined by Gemini from conversation content, with backend validation.

Web intent is carried into WhatsApp through the `START_BUILDWISE_<INTENT_TOKEN>` handshake (`06_INTEGRATION_CONTRACTS.md` §10.1).

Gemini then reasons over the resulting context rather than being responsible for every low-level event calculation.

---

# 7. Customer experience

Primary channel:

**WhatsApp**

Customer may receive:

- contextual assistance
- product education
- comparison help
- online-purchase guidance
- nearby-store availability
- store reservation
- alternative options
- human handoff

The MVP does not include a customer dashboard.

The **Customer AI Channel** is:

- WhatsApp-first in the final (`gcp`) system
- the customer simulator during local development, and as the approved fallback
- contextual web pages only when a task needs them

Optional contextual web pages:

```text
/nearby-stores
/reservation/:id
/pickup/:id
```

These are task pages, not a customer portal.

Access requires a short-lived opaque page token bound to the customer, conversation and resource (`07_SECURITY_SPEC.md` §16). A guessable resource ID alone is never sufficient.

---

# 8. WhatsApp MVP

Required:

```text
Incoming message (WhatsApp webhook | simulator channel)
↓
ConversationPipeline (one pipeline for both channels)
↓
Customer resolution
↓
Buildwise context
↓
AgentRuntime (gcp: ADK + Gemini · local: MockAgentRuntime)
↓
Next-best action
↓
Guardrail
↓
Response/action on the same channel
```

The simulator is a customer-channel adapter into the same pipeline (`03_TECH_ARCHITECTURE.md` §8.2). It is not a separate AI flow. Its entry point is `POST /api/channels/simulator/messages` (`06_INTEGRATION_CONTRACTS.md` §14.2).

For the prototype, use one controlled WhatsApp Business setup if production multi-merchant onboarding is not available in time.

The architecture must still be modular enough for multi-brand onboarding later.

---

# 9. Retail reservation

Required flow:

```text
Customer requests store reservation
        ↓
Backend checks:
- customer identity
- tenant
- SKU
- store
- availability
- reservation eligibility
        ↓
Reservation created
        ↓
Retailer notified
        ↓
Retailer:
Confirm
→ Ready
→ Customer Arrived
→ Completed
```

---

# 10. Brand intelligence

The brand console should show useful outcomes, not duplicate Shopify.

Minimum:

```text
High-intent opportunities
AI-assisted conversations
Store recommendations
Reservations
Recovered opportunities
Online purchases
Offline purchases
```

---

# 11. Analytics

Capture at least these events. The names are canonical `CommerceEvent.event_type` values (`04_DATA_MODEL.md` §17):

```text
PRODUCT_VIEW / PRODUCT_DETAIL_VIEW / ADD_TO_CART / CHECKOUT_STARTED / WHATSAPP_CLICK   (intent events)
CONVERSATION_STARTED
AI_DECISION
MESSAGE_SENT
MESSAGE_RECEIVED
STORE_RECOMMENDATION
RESERVATION_CREATED
RESERVATION_CONFIRMED
PICKUP_COMPLETED
ONLINE_PURCHASE
OFFLINE_PURCHASE
HUMAN_HANDOFF
```

Then:

```text
Firestore
(current state)

BigQuery
(historical analytics)

Looker — optional for the MVP
(brand intelligence)
```

---

# 12. MVP acceptance criteria

The MVP is accepted when all of these work, first in the `local` profile (M12) and finally in the `gcp` profile with the real integrations (G3; see §14).

### 0. Platform administration

- [ ] Platform Admin can create a brand and provision its first Brand Admin
- [ ] Platform Admin can suspend a brand, and its users are then refused
- [ ] Platform Admin cannot see customer profiles or conversation content
- [ ] Platform actions appear in the platform audit log

### A. Brand setup

- [ ] Brand can authenticate
- [ ] Brand Admin can add members, retailers and retailer users; Brand Member cannot
- [ ] Shopify connection can be verified
- [ ] Relevant Shopify data can appear in Buildwise
- [ ] Retail data can be uploaded
- [ ] SKU mappings can be displayed

### B. AI

- [ ] Intent can be represented
- [ ] Customer/product/retail context can be assembled
- [ ] The agent runtime selects a structured next-best action (Gemini in the final system; mock locally, labeled as mock)
- [ ] Response is personalized
- [ ] AI can hand off to human

### C. Customer

- [ ] Customer message is received (simulator locally; WhatsApp in the final system) through the same pipeline
- [ ] Context is retrieved
- [ ] AI reply is generated
- [ ] Store availability can be returned
- [ ] Reservation can be requested

### D. Retailer

- [ ] Reservation appears, scoped to the retailer (Retailer Admin: all its stores; Retailer Staff: assigned stores)
- [ ] Inventory is visible
- [ ] Status can transition
- [ ] Completion can be recorded

### E. Brand outcome

- [ ] Outcome is recorded
- [ ] Brand can see online/offline result
- [ ] Relevant event data is available to analytics

---

# 13. Explicit non-goals

Do not allow implementation to expand into:

- complete Shopify clone
- complete Meta CRM
- full loyalty system
- advanced recommendation engine
- real-time nationwide inventory network
- full POS integration
- autonomous messaging campaign optimizer
- complex forecasting
- multi-agent swarm
- customer dashboard or customer login
- platform-wide customer-data access for platform administrators

---

# 14. Execution profiles

The MVP is built **locally first**, then cut over to Google Cloud (`10_EXECUTION_PLAN.md`).

| | `local` profile (M2–M12) | `gcp` profile (G1–G3, judged) |
|---|---|---|
| Commerce | `MockCommerceProvider` | Shopify |
| Customer channel | simulator | WhatsApp (+ simulator fallback) |
| AI | `MockAgentRuntime` (deterministic, labeled mock) | ADK + Gemini |
| Data / auth | Firestore + Auth emulators | Firestore + Firebase Auth |
| Files / events | local storage / local event sink | Cloud Storage / BigQuery |

The business logic is identical in both profiles. Only adapters change (`03_TECH_ARCHITECTURE.md` §2.2).

The **judged prototype** runs the `gcp` profile with real Shopify, real Meta WhatsApp and Gemini. Mock adapters exist for development and automated tests. They are never the judge/demo path.
