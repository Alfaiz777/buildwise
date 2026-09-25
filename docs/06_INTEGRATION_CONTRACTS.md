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

Input:

```json
{
  "brand_id": "...",
  "customer_id": "...",
  "store_id": "...",
  "variant_id": "...",
  "quantity": 1
}
```

Backend must validate before creation.

Result:

```json
{
  "reservation_id": "...",
  "status": "PENDING",
  "expires_at": "..."
}
```

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

Required logical fields:

```text
store_id
store_name
location
sku
quantity
offline_price
store_status
store_hours
```

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
PATCH /api/reservations/:id
POST /api/webhooks/shopify
POST /api/webhooks/whatsapp
POST /api/retail/import
GET  /api/stores/nearby
POST /api/analytics/events
```

Exact routes may change during implementation, but responsibilities must remain separated.

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
