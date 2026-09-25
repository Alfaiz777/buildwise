# Buildwise — MVP Specification

## Status

**M0 — Frozen MVP scope**

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

## A. Brand onboarding

Required:

- create/login brand account
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

Brand uploads CSV/XLSX data containing, at minimum:

```text
store_id
store_name
city
address
latitude
longitude
sku
quantity
offline_price
store_status
store_hours
```

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

The MVP needs a small set of meaningful intent states.

Suggested states:

```text
CASUAL
PRODUCT_EXPLORATION
HIGH_INTENT
CART_ABANDONMENT
PRODUCT_QUESTION
COMPARISON
URGENT_PURCHASE
STORE_ORIENTED
SUPPORT_REQUEST
```

The intent engine may be deterministic initially.

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

Optional contextual web pages:

```text
/nearby-stores
/reservation/:id
/pickup/:id
```

These are task pages, not a customer portal.

---

# 8. WhatsApp MVP

Required:

```text
Incoming message
↓
Cloud Run webhook
↓
Customer resolution
↓
Buildwise context
↓
ADK
↓
Gemini
↓
Next-best action
↓
Guardrail
↓
WhatsApp response/action
```

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

Capture at least:

```text
intent_event
conversation_event
ai_decision
message_sent
message_received
store_recommendation
reservation_created
reservation_confirmed
pickup_completed
online_purchase
offline_purchase
human_handoff
```

Then:

```text
Firestore
(current state)

BigQuery
(historical analytics)

Looker
(brand intelligence)
```

---

# 12. MVP acceptance criteria

The MVP is accepted when all of these work:

### A. Brand setup

- [ ] Brand can authenticate
- [ ] Shopify connection can be verified
- [ ] Relevant Shopify data can appear in Buildwise
- [ ] Retail data can be uploaded
- [ ] SKU mappings can be displayed

### B. AI

- [ ] Intent can be represented
- [ ] Customer/product/retail context can be assembled
- [ ] Gemini can select a structured next-best action
- [ ] Response is personalized
- [ ] AI can hand off to human

### C. Customer

- [ ] WhatsApp incoming message is received
- [ ] Context is retrieved
- [ ] AI reply is generated
- [ ] Store availability can be returned
- [ ] Reservation can be requested

### D. Retailer

- [ ] Reservation appears
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
