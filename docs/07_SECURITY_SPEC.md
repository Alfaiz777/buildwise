# Buildwise — Security Specification

## Status

**M0 — Security boundaries are mandatory from the first implementation.** Updated by the post-M0 architecture change (`00_M0_SPECIFICATION_FREEZE.md` §11.8): three internal roles, four interfaces, platform scope, execution profiles.

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

Retailers are sub-scopes **inside** a brand tenant (`04_DATA_MODEL.md` §8a). The platform is **outside** every tenant, and platform scope does not grant tenant data access (§4.2).

---

# 4. Roles, scopes and permissions

Buildwise has **four interfaces**:

| Interface | Who | Authentication |
|---|---|---|
| Platform Admin Console | `PLATFORM_ADMIN` | Firebase Auth |
| Brand Console | `BRAND_ADMIN` | Firebase Auth |
| Retailer Console | `RETAIL_ADMIN` | Firebase Auth |
| Customer AI Channel (WhatsApp; simulator; contextual pages) | Customer | Channel identity or page token, **never** Firebase Auth |

The MVP has exactly **three internal roles**, one per console, and no others:

```text
PLATFORM_ADMIN   → platform scope (no brand)
BRAND_ADMIN      → brand scope: full administration of exactly one brand
RETAIL_ADMIN     → retail scope: exactly one store (brand_id + retailer_id + store_id)
```

The customer is **not** an internal role and never logs in to a console. A customer is a channel principal (§4.3) and may access only their own conversation, context and resources.

Platform scope is a distinct principal type. It is **never** implemented as a brand principal with a wildcard or `"ALL"` brand ID.

The MVP has **exactly one operator per scope**: one `PLATFORM_ADMIN`, one `BRAND_ADMIN` per brand, at most one `RETAIL_ADMIN` per store (`04_DATA_MODEL.md` §4). A retailer may own many stores, but a `RETAIL_ADMIN` operates exactly one store (`04_DATA_MODEL.md` §8a), so retail scope is **store-level**: another store of the same retailer is out of scope. There are no read-only brand roles, no store-staff roles and no multi-store access in the MVP. The role model can be extended after the core prototype works; any extension needs a spec change.

## 4.0 Permission matrix (MVP)

| Capability | PLATFORM_ADMIN | BRAND_ADMIN | RETAIL_ADMIN |
|---|---|---|---|
| Create / suspend brands; provision each brand's single `BRAND_ADMIN` | ✓ | | |
| Platform audit log, platform health | ✓ | | |
| Brands, retailers, stores (metadata) | all brands | own brand | own store |
| Integration health (metadata only) | all brands | own brand | |
| Connect / change Shopify & WhatsApp credentials | | ✓ | |
| Brand settings, security/configuration | | ✓ | |
| Provision another `BRAND_ADMIN` | ✗ (only one per brand) | ✗ | |
| Create retailers; provision each store's single `RETAIL_ADMIN` | | ✓ | |
| Store → retailer association (a retailer may own many stores) | | via retail ingestion (M3); backend-only otherwise | |
| Retail file upload, SKU mapping resolution | | ✓ | |
| Customer intent, AI conversations, recommendations | | ✓ | |
| Outcomes, analytics / insights | aggregate only | ✓ | |
| Retail availability / inventory | aggregate / operational | ✓ | own store |
| Reservations | operational level, no customer PII | view | view + status transitions, own store |
| Customer simulator (`POST /api/channels/simulator/messages`) | | ✓ | |
| Customer profiles, full conversation history | **✗** (§4.2) | ✓ | ✗ (reservation context only) |

The customer simulator is available to `BRAND_ADMIN` only: it creates conversations and can trigger reservations inside the brand. `PLATFORM_ADMIN` does not use it, and `RETAIL_ADMIN` has no customer-conversation access.

## 4.1 Authentication and authorization chain (console users)

```text
React (Firebase Auth SDK)
   ↓  getIdToken() — short-lived Firebase ID token, auto-refreshed
   ↓  Authorization: Bearer <Firebase ID token>
Cloud Run
   ↓
1. Token verification
   Firebase Admin SDK verifyIdToken():
   signature, expiry, audience = Firebase project, issuer
   failure → 401
   ↓
2. Scoped principal resolution
   users/{uid} (Firestore) → role, brand_id, retailer_id, store_id, status
   missing or status ≠ ACTIVE → 403
   role not one of the three internal roles, or document violates
   the role table (04 §4) → 403 USER_MISCONFIGURED
   by role:
     PLATFORM_ADMIN  → brand_id, retailer_id and store_id must be null
                       principal = { scope: PLATFORM, user_id, role }
     BRAND_ADMIN     → retailer_id and store_id must be null
                       brand exists and ACTIVE, else 403
                       AND uid = brand.brand_admin_user_id (admin of record), else 403
                       principal = { scope: BRAND, user_id, role, brand_id }
     RETAIL_ADMIN    → brand_id, retailer_id and store_id all required
                       brand ACTIVE, retailer exists in that brand and ACTIVE, else 403
                       AND store exists with uid = store.retail_admin_user_id (admin of record)
                       AND store.retailer_id = retailer_id,
                       else 403 USER_MISCONFIGURED
                       principal = { scope: RETAIL, user_id, role, brand_id, retailer_id, store_id }
   ↓
3. Route authorization
   principal scope allowed for this route (§4.0)? → else 403
   (one role per scope, so the scope is the whole route check)
   ↓
4. Resource authorization (tenant resources: brand_id, retailer_id?, store_id?)
   PLATFORM scope      → refused on tenant routes (403); uses /api/platform/* only (§4.2)
   BRAND scope         → resource.brand_id = principal.brand_id
   RETAIL scope        → resource.brand_id = principal.brand_id
                         AND resource.retailer_id = principal.retailer_id
                         AND resource.store_id = principal.store_id
                         (own store only; resources without a store are refused)
   failure → 404 (do not reveal that another tenant's resource exists)
   ↓
5. Handler executes → AuditEvent (tenant) or PlatformAuditEvent (platform)
   for state-changing actions
```

Rules:

- `brand_id`, `retailer_id` and `store_id` are **always** taken from the principal, never from the request body, query or path alone. A path `storeId` is only a lookup key; it is authorized against the principal's own store.
- Firestore (`users/{uid}`) is the authority for role and scope. Firebase custom claims are not used for authorization in the MVP, so role changes take effect on the next request.
- The browser never talks to Firestore directly. Firestore security rules deny all client access (`03_TECH_ARCHITECTURE.md` §7).
- Customers are never Firebase-authenticated (§4.3).
- Tenant data-access helpers accept only brand- or retail-scope principals. Platform code reaches brand data only through explicit, audited platform services (§4.2).

## 4.2 Platform scope

`PLATFORM_ADMIN` operates the Buildwise platform. It does **not** operate inside a brand.

Can see:

- platform-level metadata and platform health
- the brand registry (name, status, created date)
- retailers and stores (metadata)
- integration health metadata (connected / error / last sync). **Never** credentials.
- reservations and outcomes at aggregate or operational level: IDs, brand, store, status, timestamps, counts, values. **No** customer name, phone number, channel identity, location or conversation content.
- the platform audit log

Must not see, by default:

- full customer profiles (`Customer` records)
- unnecessary customer PII (channel identities, location, preferences)
- conversation content or full conversation history

Any future support/debug access to customer data must be explicitly authorized, narrowly scoped (one brand, one purpose, time-limited), audited, and documented in a separate specification. **No such access exists in the MVP**, and no broad platform-wide customer-data access may be built.

Platform actions go through `/api/platform/*` routes. These routes name the target brand explicitly and always write a `PlatformAuditEvent`, plus an `AuditEvent` in the affected brand (`04_DATA_MODEL.md` §18.0).

## 4.3 Customer principal

The customer is resolved, never logged in:

| Entry | Resolution |
|---|---|
| WhatsApp webhook | verified signature → brand from phone number ID → `Customer` by `channel_identities` (`WHATSAPP`) |
| Simulator channel | Firebase-authenticated `BRAND_ADMIN` acting in their own brand → `Customer` by `channel_identities` (`SIMULATOR`) |
| Contextual page | page token bound to brand + customer + conversation + resource (§16) |

A customer principal can access only its own conversation, context and bound resources. It never reaches console routes.

## 4.4 Provisioning chain

```text
seed script (bootstrap only) → first PLATFORM_ADMIN
PLATFORM_ADMIN               → creates Brand + provisions its single BRAND_ADMIN
                               (a second one → 409 BRAND_ADMIN_ALREADY_PROVISIONED)
BRAND_ADMIN                  → creates Retailers + provisions each STORE's single RETAIL_ADMIN,
                               bound to that store's brand_id + retailer_id + store_id
                               (a second one → 409 RETAIL_ADMIN_ALREADY_PROVISIONED;
                                store without a retailer → 409 STORE_HAS_NO_RETAILER)
BRAND_ADMIN cannot provision another BRAND_ADMIN (no such route or service).
Store → retailer association (one retailer, many stores): retail ingestion (M3).
```

There is no self-signup. Firebase Auth client sign-up is disabled in GCP.

New users receive their first sign-in through an Admin SDK–generated password-reset link, which the provisioning admin hands over. The MVP has no email service (`02_MVP_SPEC.md` §3).

The retail-facing role:

- **`RETAIL_ADMIN`** sees operational context of its one store only: store, reservation context, product, quantity, ETA, status.
- It never sees a customer's history, brand-wide analytics or unrelated customers.

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
- send secrets to Gemini or any agent runtime

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
ALLOWED / BLOCKED / HUMAN_APPROVAL_REQUIRED
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

Only then is the reservation created. Creation itself runs in the Firestore transaction defined in `03_TECH_ARCHITECTURE.md` §15, so concurrent requests cannot overbook inventory.

Guardrail results are recorded as `AIRecommendation.guardrail_status` (`04_DATA_MODEL.md` §14).

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

Consent, opt-out and the customer-service window are enforced in the `ConversationPipeline`, not inside a channel adapter. The simulator channel is therefore subject to the same policy as WhatsApp (`03_TECH_ARCHITECTURE.md` §8.2).

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
Webhooks with invalid signatures are rejected.
Contextual page tokens are rejected when expired, reused (mutation), revoked, or bound to another resource/customer/brand.
Intent tokens contain no PII and cannot be used on another brand's WhatsApp number.
Concurrent reservations cannot exceed available inventory.
Public endpoints are rate limited.
PLATFORM_ADMIN is refused on every tenant route and cannot read Customer records or conversation content.
Every platform action writes a PlatformAuditEvent (and a brand AuditEvent when it concerns a brand).
A users/{uid} document with brand_id = "ALL" (or any wildcard) is rejected, not treated as platform scope.
Only PLATFORM_ADMIN, BRAND_ADMIN and RETAIL_ADMIN are accepted; any other role value (including CUSTOMER) is refused.
RETAIL_ADMIN can access its own store and cannot access any other store: another retailer's store in the same brand, an unassigned store, or any other brand (404).
RETAIL_ADMIN cannot perform brand administration.
A brand has exactly one BRAND_ADMIN and a store at most one RETAIL_ADMIN; a second provisioning is refused (409) and a non-recorded admin document, or a RETAIL_ADMIN whose retailer_id/store_id does not match the store's record, is refused at sign-in (403).
RETAIL_ADMIN A cannot access Store B even when both stores belong to the same retailer (404).
A store belongs to exactly one retailer (409 on violation); a retailer may own many stores.
BRAND_ADMIN cannot provision another BRAND_ADMIN.
Users of a SUSPENDED brand or INACTIVE retailer are refused.
The gcp profile refuses to start with mock/local adapters (§19).
```

---

# 16. Contextual customer-page token lifecycle

Applies to `/nearby-stores`, `/reservation/:id` and `/pickup/:id` (`02_MVP_SPEC.md` §7) and to the APIs they call (`06_INTEGRATION_CONTRACTS.md` §14.3–§14.5).

## 16.1 Token properties

| Property | Rule |
|---|---|
| Form | Opaque 256-bit cryptographically random value, base64url. Encodes nothing. |
| Storage | Only the SHA-256 hash is stored (`pageAccessTokens/{token_hash}`, `04_DATA_MODEL.md` §18.2) |
| Validation | Server-side only, on every request |
| Resource binding | `resource_type` + `resource_id` (and `brand_id`) |
| Customer/session binding | `customer_id` + `conversation_id` of the conversation (WhatsApp or simulator channel) that issued it |
| VIEW token TTL | **15 minutes** from issue. Reusable within the TTL (page refresh). |
| MUTATE token | **Single use**, TTL ≤ 15 minutes, restricted to one `allowed_action`. It is consumed in the same Firestore transaction as the mutation. |
| Revocation | `revoked = true` makes the token invalid immediately |

## 16.2 Lifecycle

```text
1. ISSUE
   The agent/backend decides a page materially helps the task
   → Cloud Run creates a VIEW token bound to
     { brand_id, customer_id, conversation_id, resource_type, resource_id }
   → WhatsApp message carries the link:
     https://<app>/nearby-stores#t=<token>
     https://<app>/reservation/<reservation_id>#t=<token>

2. OPEN
   The SPA reads the token from the URL fragment and removes it from the address bar.
   It sends the token only in the X-Buildwise-Page-Token header.

3. VALIDATE (every request)
   hash exists AND not revoked AND now < expires_at
   AND resource_type matches the endpoint
   AND resource_id matches the requested resource (path ID must equal the bound ID)
   AND resource.brand_id = token.brand_id
   AND resource.customer_id = token.customer_id (where the resource has a customer)
   failure → 401 TOKEN_INVALID / TOKEN_EXPIRED; no resource details revealed

4. MUTATE (only if the page needs it)
   GET /api/page/context returns a separate MUTATE token
   (same bindings, one allowed_action, e.g. CREATE_RESERVATION)
   → POST with the MUTATE token
   → in ONE Firestore transaction: check used_at is null → perform mutation → set used_at
   → reuse → 401 TOKEN_USED

5. EXPIRE
   After the TTL, the page shows "This link has expired — ask in WhatsApp for a new one."
   The customer asks in WhatsApp, and a fresh token is issued.
```

## 16.3 URL and response rules

- **No sensitive PII in URLs.** The URL may contain only the route, a non-PII resource ID and the opaque token in the **fragment** (`#t=`). The fragment is not sent to servers, proxies or logs.
- No name, phone number, email, precise location or customer ID in query strings or paths.
- Customer-page API responses set `Cache-Control: no-store`. Pages set `Referrer-Policy: no-referrer`.
- Responses expose only the minimum task information (`06_INTEGRATION_CONTRACTS.md` §14.5).
- Location sent to `GET /api/stores/nearby` is coarsened to 2 decimal places (~1 km).

---

# 17. Rate limiting and abuse protection (MVP)

The numbers are prototype defaults.

| Surface | Limit |
|---|---|
| `POST /api/intents` | 60 req/min per IP; 600 req/min per brand; `Origin` must be in `allowed_storefront_origins` |
| Intent token issuance | max 5 tokens per `web_session_id` per hour |
| Customer-page endpoints (`/api/page/context`, `/api/stores/nearby`, `POST /api/reservations`) | 30 req/min per IP |
| Invalid page/intent tokens | after 10 invalid attempts per IP in 10 min → `429` for 10 min |
| `POST /api/channels/simulator/messages` | 30 req/min per user |
| `/api/demo-storefront/*` (local only) | 120 req/min per IP |
| `GET /api/demo/config` (DEMO_MODE) | 30 req/min per IP |
| `POST /api/brand/demo/reset` (DEMO_MODE) | 1 per minute per brand |
| AI decisions per conversation | max 10 per 5 min (Firestore-backed counter). Beyond that, no agent runtime call is made and at most one fixed "please wait" reply is sent per window. |
| Inbound message length | text truncated to 2,000 characters before it reaches the agent runtime |
| Reservations | `max_quantity_per_reservation` enforced in the transaction (`04_DATA_MODEL.md` §3) |
| Request bodies | JSON ≤ 100 KB; retail files go through Cloud Storage (≤ 10 MB) |
| Cost bound | Cloud Run max-instances cap configured for the MVP environment |

HTTP limits may be in-memory per Cloud Run instance for the MVP. Limits that protect Gemini cost and customer experience (per-conversation AI decisions) are Firestore-backed, so that they hold across instances.

Webhooks are protected by signature verification and idempotency (`03_TECH_ARCHITECTURE.md` §16.3) rather than by IP rate limits.

---

# 18. Web → WhatsApp intent token security

The full contract is `06_INTEGRATION_CONTRACTS.md` §10.1. Security requirements:

- opaque random value; no PII or internal identifiers encoded
- only the hash is stored
- 30-minute TTL, single use
- valid only on the issuing brand's WhatsApp number
- binding occurs only after the customer's channel identity (WhatsApp, or simulator in local) is resolved server-side
- invalid tokens fail silently to the customer (no oracle) and are audited
- the token is stripped before message content reaches the agent runtime or storage

The token only carries anonymous web intent (product and stage) into the conversation. If it is forwarded to another person, the recipient gains no customer data.

---

# 19. Execution-profile security

Execution profiles are defined in `03_TECH_ARCHITECTURE.md` §2.2.

- **The `gcp` profile refuses to start** if any of these is selected: `MockCommerceProvider`, `MockAgentRuntime`, `LocalFileStorageProvider`, `LocalEventSink`, or Firebase emulator hosts. `SimulatorMessagingProvider` is allowed in `gcp` as the approved fallback channel, restricted to `BRAND_ADMIN`.
- **Mock AI is never presented as Gemini.** Every AI decision carries `runtime` (`04_DATA_MODEL.md` §14), and any console view of a decision shows it.
- **Local data is synthetic.** The local profile uses fixture brands, products and simulator customers. Real customer PII must not be loaded into local emulators.
- **Local secrets** live only in git-ignored `.env` files. In `gcp`, secrets come from Secret Manager and never from committed files.
- **`PLATFORM_ADMIN` accounts** are bootstrapped only by the seed script. In `gcp` they should use multi-factor sign-in, where Identity Platform is enabled.

---

# 20. Security principle to remember

> **AI may reason broadly enough to personalize, but it may act only within narrowly authorized boundaries.**
