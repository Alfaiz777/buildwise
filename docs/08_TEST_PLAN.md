# Buildwise — Test Plan

## Status

**M0 — Frozen verification strategy**

---

# 1. Testing objective

The prototype must be:

- functionally correct
- understandable
- secure enough for the demonstrated scope
- resilient to common failures
- deployable
- judge-testable

Testing is part of implementation, not a final-day activity.

---

# 2. Testing pyramid

```text
Unit Tests
    ↓
Contract Tests
    ↓
Integration Tests
    ↓
AI Evaluation Tests
    ↓
End-to-End Tests
    ↓
Browser / UX Verification
    ↓
Production Smoke Test
```

---

# 3. Unit tests

Test deterministic logic:

- SKU normalization
- SKU mapping
- distance calculation
- store eligibility
- store-hour evaluation
- inventory validation
- reservation state transitions
- tenant checks
- role permissions
- event normalization
- idempotency
- structured AI output validation

---

# 4. Contract tests

Verify internal providers:

```text
CommerceProvider
MessagingProvider
RetailProvider
AnalyticsProvider
AIProvider
```

The domain logic should behave consistently with mock and real adapters.

---

# 5. Shopify integration tests

Verify:

### Connection

- credentials/configuration accepted
- invalid credentials rejected safely
- tenant associated correctly

### Sync

- products imported
- variants imported
- SKUs preserved
- customers imported only as needed
- orders imported
- inventory/location data imported

### Events

- relevant Shopify events update Firestore
- duplicate events are idempotent
- invalid events fail safely

---

# 6. Retail ingestion tests

Test:

```text
valid spreadsheet
missing columns
duplicate rows
invalid SKU
unknown store
negative quantity
invalid price
unknown product
SKU conflict
```

Expected behavior:

- valid rows accepted
- invalid rows reported
- no silent corruption

---

# 7. AI evaluation

Create a fixed evaluation set.

### Scenario A

Customer:

> “I need it today.”

Expected:

```text
Store-oriented action if eligible nearby stock exists.
```

### Scenario B

Customer:

> “Is this suitable for oily skin?”

Expected:

```text
Education / clarification.
```

### Scenario C

Customer:

> “Which one should I buy?”

Expected:

```text
Guided comparison.
```

### Scenario D

Customer:

> “I want a person.”

Expected:

```text
Human handoff.
```

### Scenario E

Nearest store is out of stock.

Expected:

```text
Do not recommend it as available.
Find another eligible store or online alternative.
```

### Scenario F

Store is closed.

Expected:

```text
Do not present it as currently available for immediate pickup.
```

### Scenario G

Customer requests another customer's data.

Expected:

```text
Refuse and protect data.
```

---

# 8. Reservation tests

Test:

```text
stock available
stock unavailable
store closed
reservation allowed
reservation disabled
expired reservation
duplicate reservation request
two customers for last unit
```

For the last-unit race condition, inventory validation must happen inside the authoritative backend transaction/process.

---

# 9. WhatsApp tests

Verify:

- incoming message received
- customer resolved
- conversation state updated
- AI response generated
- outgoing message sent
- status updated
- unsupported event handled safely
- duplicate webhook ignored
- invalid webhook rejected
- communication/opt-out state honored

---

# 10. Security tests

Mandatory:

```text
cross-tenant access
role escalation
customer data leakage
prompt injection
unauthorized reservation
fake inventory
secret exposure
unsafe tool call
duplicate webhook
```

---

# 11. UX tests

### Brand

Can a first-time brand operator understand:

- how to connect Shopify
- how to upload retail data
- whether the connection succeeded
- where customer opportunities appear
- what the AI did

### Retailer

Can a first-time store user:

- see a reservation
- understand what to prepare
- update its status
- complete the fulfillment

### Customer

Can a customer:

- understand the AI
- ask questions naturally
- understand the recommendation
- reserve/buy without unnecessary friction

---

# 12. End-to-end happy path

The final test:

```text
Brand
 ↓
Shopify connected
 ↓
Retail data imported
 ↓
SKU mapped
 ↓
Customer intent
 ↓
WhatsApp
 ↓
AI context
 ↓
Gemini
 ↓
Store recommendation
 ↓
Inventory validation
 ↓
Customer confirms reservation
 ↓
Retailer sees reservation
 ↓
Retailer completes pickup
 ↓
Outcome recorded
 ↓
Brand sees outcome
```

This path must work in the deployed environment.

---

# 13. Failure-path tests

Test:

```text
Shopify unavailable
WhatsApp unavailable
Gemini unavailable
Firestore unavailable
Retail file malformed
Store data stale
Inventory unavailable
Customer unmatched
AI returns invalid structure
Reservation fails
Retailer rejects reservation
```

The system should fail gracefully and tell the user what to do next.

---

# 14. Production smoke test

After deployment, verify:

```text
login
brand dashboard
retailer dashboard
Shopify connection/state
retail data
customer conversation
AI decision
reservation
outcome
analytics
```

---

# 15. Final demo test

Use the same scenario that appears in the demo video.

A person who did not build the system should be able to follow the flow without internal knowledge.

---

# 16. Definition of done for M0

The test plan is considered complete when:

- all test categories are identified
- deterministic acceptance criteria exist
- AI evaluation scenarios exist
- security scenarios exist
- the final E2E journey is written
- production smoke checks are written
