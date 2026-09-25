# Buildwise — Security Specification

## Status

**M0 — Security boundaries are mandatory from the first implementation**

---

# 1. Core security principle

> **The AI should know enough context to be useful, but each participant should see and change only what they are authorized to see or do.**

---

# 2. Four security layers

```text
IDENTITY
Who are you?
        ↓
AUTHORIZATION
What can you access/do?
        ↓
DATA PROTECTION
What data should be exposed/stored?
        ↓
AI ACTION CONTROL
What can the AI actually execute?
```

---

# 3. Tenant isolation

Every brand is a separate tenant.

```text
Brand A
├── customers
├── products
├── stores
├── inventory
├── conversations
└── reservations

Brand B
├── customers
├── products
├── stores
├── inventory
├── conversations
└── reservations
```

No cross-tenant reads or writes.

Tenant boundary applies to:

- data
- API requests
- AI context
- integrations
- audit logs

---

# 4. RBAC

Roles:

```text
BRAND_ADMIN
BRAND_MARKETING
BRAND_OPERATIONS
RETAIL_MANAGER
RETAIL_STAFF
```

Access should follow least privilege.

Examples:

### Brand Marketing

Can view:

- customer intent
- relevant conversations
- recommendations
- outcomes

Does not automatically receive:

- unrestricted store administration
- sensitive retailer details

### Retail Staff

Can view:

- assigned store
- reservation context
- product
- quantity
- ETA
- operational status

Does not receive:

- customer's entire history
- brand-wide analytics
- unrelated customers

---

# 5. Customer privacy

Use minimum necessary context.

For a store recommendation, Gemini may need:

```text
product
relevant customer preference
authorized location context
store availability
store hours
brand policy
```

It does not automatically need:

```text
entire conversation history
unrelated purchases
payment information
unrelated personal attributes
internal retailer financial information
```

---

# 6. Credential security

Sensitive credentials must remain server-side.

Use:

**Google Secret Manager**

for:

- Shopify credentials/tokens
- WhatsApp credentials
- webhook secrets
- other external API secrets

Never:

- hardcode secrets
- commit secrets to GitHub
- expose secrets to React
- put secrets into prompts
- send secrets to Gemini

---

# 7. AI Action Guardrail

Never build:

```text
Customer
 ↓
Gemini
 ↓
direct database mutation
```

Build:

```text
Customer
 ↓
Gemini
 ↓
Proposed action
 ↓
Policy / permission engine
 ↓
Validation
 ↓
ALLOW / DENY / HUMAN APPROVAL
 ↓
Backend tool
 ↓
Result
```

Example:

```text
Gemini:
Reserve one unit at Store A

Backend checks:
- correct brand?
- correct customer?
- correct SKU?
- inventory available?
- store active?
- reservation allowed?
- user/session authorized?
- reservation still valid?
```

Only then is the reservation created.

---

# 8. Prompt injection defense

Treat customer-generated content as untrusted data.

A customer message must not be able to:

- change system instructions
- change permissions
- retrieve other customers
- reveal internal data
- create an unauthorized action
- bypass business rules

Authorization must be enforced in backend code, not by trusting the LLM.

---

# 9. Inventory truth

Gemini must never invent inventory.

Correct:

```text
Backend checks inventory
        ↓
Verified result
        ↓
Gemini explains it
```

Incorrect:

```text
Gemini guesses the store has stock
```

---

# 10. WhatsApp privacy and consent

Buildwise must maintain:

```text
customer consent/opt-in state
communication preference
opt-out state
channel identity
conversation state
```

Messaging behavior must comply with the applicable WhatsApp Business Platform policies and the brand's configured communication rules.

---

# 11. Logging

Audit important decisions:

```text
customer intent detected
AI recommendation
tool requested
tool validation
action allowed/blocked
reservation created
message sent
outcome recorded
```

Do not log unnecessary PII.

Use references/IDs rather than full sensitive payloads wherever possible.

---

# 12. Idempotency

External events can be delivered more than once.

Webhook handlers must be idempotent.

Example:

```text
same Shopify webhook
        ↓
same idempotency key
        ↓
do not create duplicate order/outcome
```

The same applies to:

- WhatsApp events
- reservation requests
- analytics events

---

# 13. Data retention

Only store data needed for:

- current customer experience
- operational fulfillment
- authorized analytics
- auditability

Avoid storing unlimited conversation or customer history by default.

---

# 14. Human handoff

Human handoff is both a product and safety control.

Escalate when:

- customer requests a person
- AI confidence is low
- transaction is outside supported rules
- sensitive account issue occurs
- refund/dispute requires human handling

---

# 15. Security acceptance tests

Must pass:

```text
Brand A cannot access Brand B.
Retailer A cannot access Retailer B.
Customer A cannot access Customer B.
Gemini cannot directly mutate Firestore.
AI cannot reserve an unavailable SKU.
AI cannot claim verified stock without backend evidence.
Customer prompt cannot bypass authorization.
Secrets are not exposed in frontend.
Secrets are not logged.
Duplicate webhooks do not create duplicate actions.
```

---

# 16. Security principle to remember

> **AI may reason broadly enough to personalize, but it may act only within narrowly authorized boundaries.**
