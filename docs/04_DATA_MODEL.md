# Buildwise — Data Model

## Status

**M0 — Initial canonical schema**

The schema may evolve during implementation, but entity responsibilities and tenant boundaries are frozen.

---

# 1. Tenant model

Every brand is a tenant.

Core principle:

```text
tenant_id / brand_id
```

must exist on every tenant-owned entity.

No brand can access another brand's operational data.

---

# 2. Core entities

```text
Brand
User
IntegrationConnection
Customer
Product
ProductVariant
RetailStore
RetailInventory
CustomerIntent
Conversation
ConversationMessage
AIRecommendation
Reservation
Outcome
AuditEvent
CommerceEvent
```

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
```

Settings may include:

```text
brand_tone
allowed_ai_actions
reservation_policy
customer_communication_preferences
human_handoff_rules
```

---

# 4. User

```text
User
- user_id
- brand_id
- role
- email
- status
- created_at
- updated_at
```

Roles:

```text
BRAND_ADMIN
BRAND_MARKETING
BRAND_OPERATIONS
RETAIL_MANAGER
RETAIL_STAFF
```

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

---

# 6. Customer

```text
Customer
- customer_id
- brand_id
- shopify_customer_id
- whatsapp_identity_reference
- lifecycle_stage
- relevant_preferences
- consent_state
- preferred_channel
- location_reference
- created_at
- updated_at
```

Only relevant customer data should be retained/used.

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

---

# 9. RetailStore

```text
RetailStore
- store_id
- brand_id
- name
- address
- city
- latitude
- longitude
- status
- operating_hours
- reservation_available
- pickup_available
```

---

# 10. RetailInventory

```text
RetailInventory
- inventory_id
- brand_id
- store_id
- variant_id
- canonical_sku
- quantity
- offline_price
- availability_status
- last_updated_at
```

Availability may be:

```text
IN_STOCK
LOW_STOCK
OUT_OF_STOCK
UNKNOWN
```

---

# 11. CustomerIntent

```text
CustomerIntent
- intent_id
- brand_id
- customer_id
- source
- product_variant_id
- intent_type
- confidence
- event_reference
- detected_at
- status
```

Sources:

```text
SHOPIFY
WEBSITE
WHATSAPP
SIMULATOR
```

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
- human_handoff
```

Channel MVP:

```text
WHATSAPP
```

---

# 13. ConversationMessage

```text
ConversationMessage
- message_id
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
- confidence
- rationale_summary
- evidence_references
- proposed_at
- guardrail_status
```

Action examples:

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

---

# 15. Reservation

```text
Reservation
- reservation_id
- brand_id
- customer_id
- store_id
- variant_id
- quantity
- status
- created_at
- expires_at
- confirmed_at
- ready_at
- completed_at
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
- store_id
- order_reference
- value
- timestamp
```

Purchase type:

```text
ONLINE
OFFLINE
ALTERNATIVE
NONE
```

---

# 17. CommerceEvent

```text
CommerceEvent
- event_id
- brand_id
- customer_id
- event_type
- source
- entity_reference
- event_payload_reference
- timestamp
- idempotency_key
```

Event examples:

```text
PRODUCT_VIEW
ADD_TO_CART
CHECKOUT_STARTED
ORDER_CREATED
AI_INTERVENTION
MESSAGE_SENT
MESSAGE_RECEIVED
STORE_RECOMMENDATION
RESERVATION_CREATED
PICKUP_COMPLETED
ONLINE_PURCHASE
OFFLINE_PURCHASE
```

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
    "type": "urgent_purchase",
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
        "quantity": 8,
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

Only the minimum required context should be sent to Gemini.
