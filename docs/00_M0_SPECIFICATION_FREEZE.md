# Qwikspot — M0 Specification Freeze

**Status:** M0 frozen at tag `m0-spec-freeze`; approved post-M0 changes are recorded in §11.8  
**Prototype target:** Working, judge-testable prototype by **13 October 2026**  
**Product name:** Qwikspot  
**Primary customer channel:** WhatsApp  
**Primary online commerce system:** Shopify  
**Primary physical-retail input:** Brand-provided retail store/inventory data (CSV for the prototype; XLSX deferred, §11.8 Change 10)  
**Backend language:** Node.js + TypeScript  
**Agent framework:** Google ADK for TypeScript  
**Primary AI:** Gemini on Vertex AI  

---

## 1. Purpose of M0

M0 exists to freeze the product definition before implementation.

The goal is not to design every screen or write production code. The goal is to establish one authoritative specification that Claude Code, Gemini, Antigravity, and the team can use without repeatedly redefining the product.

### M0 rule

> **No feature implementation should change the product definition without updating and approving the relevant specification first.**

The eight core specification files are:

```text
01_PRODUCT_SOURCE_OF_TRUTH.md
02_MVP_SPEC.md
03_TECH_ARCHITECTURE.md
04_DATA_MODEL.md
05_AI_AGENT_SPEC.md
06_INTEGRATION_CONTRACTS.md
07_SECURITY_SPEC.md
08_TEST_PLAN.md
```

`09_LEARNING_LOG.md` is the companion learning file.

`10_EXECUTION_PLAN.md` (added post-M0, §11.8) defines execution profiles, the milestone sequence and spike rules. It governs **how** Qwikspot is built, never **what** it is.

`11_INTERFACE_CONTRACT.md` (added in M2.1, updated in M2.2; §11.8 Changes 8–9) states, per interface, the role, scope, purpose, current data and actions, out-of-scope items and empty / unauthorized / loading / error states.

The PDFs and research documents remain reference material. The Markdown specification pack is the implementation source of truth.

---

# 2. Product in one sentence

> **Qwikspot connects a D2C brand's online customer intent with its physical retail availability through an AI-powered WhatsApp commerce agent, helping customers take the most relevant next step—online purchase, local store purchase/reservation, assistance, or human handoff—while giving the brand and retailer a connected view of the resulting outcome.**

---

# 3. Core product loop

```text
Digital Intent
      ↓
Context
(customer + product + location + timing + retail)
      ↓
AI Decision
      ↓
Conversational Action
(WhatsApp)
      ↓
Online Purchase OR Store Reservation/Purchase
      ↓
Retailer Fulfillment
      ↓
Outcome
      ↓
Brand Intelligence
```

Short form:

> **Intent → Context → AI Decision → Action → Purchase → Learn**

---

# 4. The product thesis

The product is NOT:

- a generic chatbot
- a WhatsApp broadcast tool
- a recommendation engine
- a store locator
- a Shopify analytics clone
- a customer dashboard
- a full POS
- a CRM
- a full ERP

The product IS:

> **A decision and engagement layer that uses online customer intent plus physical retail context to create a more useful next step for customers and a measurable business outcome for brands.**

---

# 5. Primary users

*Post-M0 (§11.8, Change 6):* the MVP has exactly three internal roles — `PLATFORM_ADMIN`, `BRAND_ADMIN` and `RETAIL_ADMIN` — plus the customer, who is a channel principal, not a role (`04_DATA_MODEL.md` §4).

## Platform

The Qwikspot operator (`PLATFORM_ADMIN`). They onboard brands and see platform-level metadata, but have no default access to customer data.

## Brand

The D2C brand is the primary buyer/operator.

Typical Qwikspot brand users:

- Brand Admin (`BRAND_ADMIN`), the only brand role in the MVP. It also covers the commerce/growth/marketing and operations needs.

Their goal is to understand and act on customer opportunities across digital and physical commerce.

## Retailer

The retail business (partner) operating one or more of the brand's physical stores (§11.8 Change 9).

Retailer console user:

- Retail Admin (`RETAIL_ADMIN`), the only retail role in the MVP: operates exactly one physical store of its retailer; each store has at most one.

Their goal is to receive actionable customer requests and fulfill them correctly.

## Customer

A shopper who has demonstrated meaningful product intent and interacts with the brand through WhatsApp.

The customer does **not** need a Qwikspot account or customer dashboard for the MVP.

The customer experience is **WhatsApp-first**, with small contextual web pages used only when a richer task genuinely requires a web interface.

---

# 6. Atomic product decision

> **When a customer has meaningful purchase intent but has not completed the online purchase, should Qwikspot intervene, and what is the most helpful next action given the customer's intent, product, location, timing, and current physical retail availability?**

Possible AI actions (`AIRecommendation.action`):

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

These are the actions the AI **proposes**. They are separate from the business outcome that actually happens (`Outcome.purchase_type`: `ONLINE | OFFLINE | ALTERNATIVE | NONE`). The mapping between them is defined in `04_DATA_MODEL.md` §16.1.

---

# 7. Core product principles

### Principle 1 — Customer first

Do not optimize for sending more messages.

Optimize for making the customer's next step more useful.

### Principle 2 — Context before action

The AI must understand the situation before recommending an action.

### Principle 3 — Verified facts, AI reasoning

Deterministic systems provide verified facts.

Gemini reasons over those facts.

### Principle 4 — WhatsApp-first, not WhatsApp-only

WhatsApp is the primary customer channel.

A small contextual web page may be opened when WhatsApp is not the best interface for the task.

### Principle 5 — Shopify is online-commerce source of truth

Qwikspot may normalize relevant Shopify data into Firestore for application use, but does not replace Shopify as the merchant's online commerce system.

### Principle 6 — Retail data is separate from Shopify

Physical retail inventory and store information are maintained in Qwikspot for the MVP.

### Principle 7 — AI cannot bypass business controls

Gemini proposes; deterministic policy/authorization layers decide whether an action can execute.

### Principle 8 — Measure outcomes

A message is not the business outcome.

The system should connect:

```text
intent → intervention → reservation/purchase → outcome
```

### Principle 9 — Minimum necessary context

The AI should receive enough context to be useful, not unrestricted access to the entire customer, brand, or retailer dataset.

### Principle 10 — One continuous customer relationship

The customer should experience Qwikspot as a brand assistant that remembers relevant context within the authorized journey, not as a sequence of disconnected automations.

---

# 8. Scope boundary for the 13 October prototype

The prototype must demonstrate one complete, credible vertical journey.

### Required working journey

```text
Brand connected to Shopify
        ↓
Relevant Shopify data synchronized
        ↓
Retail store/inventory data imported
        ↓
Products mapped across online + retail
        ↓
Customer intent enters Qwikspot
        ↓
Qwikspot constructs customer/product/retail context
        ↓
Gemini + ADK determines next-best action
        ↓
WhatsApp customer conversation
        ↓
Customer chooses online purchase OR store reservation
        ↓
Backend validates action
        ↓
Retailer receives action
        ↓
Outcome recorded
        ↓
Brand sees the resulting intelligence
```

### Explicit MVP exclusions

- Instagram
- full customer dashboard
- full POS integrations
- automated nationwide retail synchronization
- full CRM
- full CDP
- generic product recommendation platform
- autonomous advertising-budget changes
- autonomous inventory purchasing
- complex multi-agent system
- production-scale omnichannel infrastructure
- dozens of third-party integrations
- alternative customer messaging channels as part of the MVP

### Approved prototype fallback

If Meta/WhatsApp cannot be used reliably during prototype testing, the fallback customer channel is:

> **Qwikspot Web Conversation Simulator**

The simulator must use the **same Cloud Run → ADK → Gemini → tools → next-best-action backend path** as WhatsApp. It is a testing interface, not a second product direction.

*Post-M0 (§11.8):* the simulator is a customer-channel adapter into the single `ConversationPipeline`. It is also the channel of the local development profile.

---

# 9. Technology ownership

```text
React + TypeScript
= Brand/Retailer product experience + contextual customer web pages when required

Firebase
= application hosting + authentication

Cloud Run
= backend APIs, integrations, orchestration and policy enforcement

Node.js + TypeScript + Express
= primary backend implementation stack

Firestore
= Qwikspot operational state

Google ADK for TypeScript
= agent orchestration/tools

Gemini on Vertex AI
= intent understanding, reasoning, next-best action, response generation

Shopify
= online commerce source

WhatsApp Cloud API
= primary customer conversation channel

Retail CSV (XLSX deferred, §11.8 Change 10)
= physical retail network input for MVP

BigQuery
= historical/event analytics

Looker
= optional brand business intelligence layer for MVP

Cloud Storage
= uploaded retail files and assets

Secret Manager
= secrets

Cloud Logging / Audit Logs
= observability/audit
```

### Looker MVP decision

Looker is **optional for the 13 October MVP**.

The Brand Console must remain functional without Looker.

The core brand intelligence can be powered by Firestore aggregations and/or BigQuery-backed application views. Looker may be added when it strengthens the final demonstration without threatening prototype stability.

---

# 10. Source-of-truth hierarchy

If two documents conflict:

```text
01_PRODUCT_SOURCE_OF_TRUTH.md
        ↓
02_MVP_SPEC.md
        ↓
03_TECH_ARCHITECTURE.md
        ↓
04_DATA_MODEL.md
        ↓
05_AI_AGENT_SPEC.md
        ↓
06_INTEGRATION_CONTRACTS.md
        ↓
07_SECURITY_SPEC.md
        ↓
08_TEST_PLAN.md
        ↓
11_INTERFACE_CONTRACT.md  (per-interface contract; derived from 01–08, never overrides them)
        ↓
10_EXECUTION_PLAN.md      (process only; can never override 01–08)
```

Technical documents must not silently change the product decision.

If implementation discovers a genuine contradiction, stop the affected work, record the issue, update the relevant specification, and obtain approval before continuing.

---

# 11. M0 decisions added after architecture review

The following decisions are now part of the M0 freeze candidate.

## 11.1 Customer contextual web pages

Customer task pages such as:

```text
/reservation/:id
/pickup/:id
```

must not rely on a guessable resource ID alone.

They must use:

- short-lived opaque authorization tokens or an equivalent signed authorization mechanism
- server-side validation
- expiration
- binding to the authorized customer/session and intended resource
- minimum necessary information exposure
- no sensitive customer data in query strings

The preferred flow is:

```text
WhatsApp
   ↓
customer requests a contextual page
   ↓
Cloud Run creates a short-lived opaque token
   ↓
customer opens contextual web page
   ↓
backend validates token + expiry + resource binding
   ↓
minimum required information is shown
```

The full token lifecycle is defined in `07_SECURITY_SPEC.md` §16:

- opaque token
- server-side validation
- resource binding
- customer/session binding
- 15-minute TTL for view-only access
- single-use mutation token
- no sensitive PII in URL parameters

## 11.2 WhatsApp fallback

Primary customer channel:

> WhatsApp Cloud API

Prototype fallback:

> Qwikspot Web Conversation Simulator

Do not add Instagram, SMS, email, or another customer messaging channel to the MVP merely as a fallback.

## 11.3 Customer intent source

Shopify is not assumed to provide a perfect native “high intent” label.

For the prototype, customer-intent events are produced by controlled Qwikspot instrumentation and deterministic rules.

Prototype events (canonical `CommerceEvent.event_type`):

```text
PRODUCT_VIEW
PRODUCT_DETAIL_VIEW
ADD_TO_CART
CHECKOUT_STARTED
WHATSAPP_CLICK
```

Prototype intent stage (`CustomerIntent.intent_stage`):

```text
NO_MEANINGFUL_INTENT
        ↓
INTERESTED
        ↓
HIGH_INTENT
```

Customer intent has two separate fields:

- `intent_type` is what the customer is trying to accomplish.
- `intent_stage` is how strong the demonstrated intent is. *(Updated by §11.8 Change 11: `intent_stage` is now funnel progress, and the three strength values above are kept as `intent_strength`.)*

Both are defined in `04_DATA_MODEL.md` §11.

The exact thresholds are deterministic prototype logic (`04_DATA_MODEL.md` §11.2). Gemini must not invent the underlying behavioral facts, and it never sets `intent_stage`.

Web intent reaches the WhatsApp conversation through a short-lived opaque token in the prefilled message `START_QWIKSPOT_<INTENT_TOKEN>`. The token contains no PII (`06_INTEGRATION_CONTRACTS.md` §10.1).

## 11.4 Retail upload boundary

Supported MVP retail file size:

> **Up to 10 MB per CSV file** (XLSX deferred, §11.8 Change 10).

Flow:

```text
Browser
   ↓
Cloud Storage
   ↓
Cloud Run ingestion
   ↓
validate
   ↓
normalize
   ↓
SKU mapping
   ↓
Firestore
```

Future production architecture may introduce asynchronous/streaming processing for larger datasets.

## 11.5 Looker boundary

Looker is an optional MVP enhancement.

It must not become a blocking dependency for the core customer → AI → retailer → outcome workflow.

## 11.6 Reconciliation decisions (approved after the two M0 reviews)

These decisions are approved. Each one has a single canonical home:

| Decision | Canonical home |
|---|---|
| One canonical retail schema (11 required fields + 2 optional) | `04_DATA_MODEL.md` §9.1 |
| `store_hours` = IANA `timezone` + `HH:MM-HH:MM` per weekday | `04_DATA_MODEL.md` §9.2 |
| One canonical `CommerceProvider` contract | `06_INTEGRATION_CONTRACTS.md` §2 |
| AI action (`AIRecommendation.action`) separate from business outcome (`Outcome.purchase_type`), with a documented mapping | `04_DATA_MODEL.md` §14, §16 |
| `intent_type` (what) vs `intent_stage` (how strong; deterministic) | `04_DATA_MODEL.md` §11 |
| Firestore collection layout covering every persisted entity | `04_DATA_MODEL.md` §21, `03_TECH_ARCHITECTURE.md` §7 |
| Web → WhatsApp handshake `START_QWIKSPOT_<INTENT_TOKEN>` (opaque, no PII, 30 min, single use) | `06_INTEGRATION_CONTRACTS.md` §10.1 |
| Reservation creation in a Firestore transaction (`reserved_quantity`) | `03_TECH_ARCHITECTURE.md` §15 |
| Contextual page token lifecycle (15-min view, single-use mutation) | `07_SECURITY_SPEC.md` §16 |
| Stateless, request-scoped ADK in Cloud Run; state in Firestore | `03_TECH_ARCHITECTURE.md` §8.1 |
| Critical API request/response contracts | `06_INTEGRATION_CONTRACTS.md` §14.1–§14.9 |
| Firebase ID token → Cloud Run → verification → user/brand/role → authorization | `07_SECURITY_SPEC.md` §4.1 |
| Gemini timeout, retry, webhook idempotency, rate limiting | `03_TECH_ARCHITECTURE.md` §16, `07_SECURITY_SPEC.md` §17 |
| All 12 AI evaluation scenarios covered | `08_TEST_PLAN.md` §7 |
| Retail users scoped by store list (superseded by §11.8 Change 6, then Change 8: `RETAIL_ADMIN` scoped to one store) | `04_DATA_MODEL.md` §4 |
| `brand.settings.allowed_storefront_origins` | `04_DATA_MODEL.md` §3 |
| `RetailInventory.reserved_quantity` | `04_DATA_MODEL.md` §10 |
| `Outcome.reservation_id` | `04_DATA_MODEL.md` §16 |
| `SIMULATOR` conversation channel (approved fallback; also the local development channel per §11.8) | `04_DATA_MODEL.md` §12 |
| `GET /api/reservations` and `GET /api/reservations/:id` | `06_INTEGRATION_CONTRACTS.md` §14.4 |
| Prototype default values (token TTLs, rate limits, 120-min reservation hold, Gemini timeouts) | `03`, `04`, `07` as referenced |

## 11.7 Items deferred to the start of M1

These items do not change any product or architecture boundary. They are settled at the start of M1, before the feature that needs them:

- **Reservation expiry trigger.** The expiry sweep endpoint is specified (`03_TECH_ARCHITECTURE.md` §15), but the schedule mechanism is not yet chosen. The options are Cloud Scheduler, or relying only on the sweep run when the retailer console loads. *Status: locally, the sweep runs on retailer-console load; the `gcp` schedule is decided at deployment (phase L1, Change 10).*
- **User provisioning.** How the first Brand Admin and the retail users are created and linked to a brand and stores. For the MVP, a seed/admin script is acceptable. *Status: resolved by §11.8. The seed script bootstraps only the first `PLATFORM_ADMIN`; everything else follows the provisioning chain in `07_SECURITY_SPEC.md` §4.4.*
- **Meta webhook timing.** Verify that synchronous processing within the 20 s AI budget avoids unnecessary redeliveries. Duplicates are already safe. *Status: moved to spike S2 / phase L2 (Change 10).*
- **Shopify auth mechanism.** Verify it against the development store (`06_INTEGRATION_CONTRACTS.md` §9). *Status: moved to spike S1 / phase L2 (Change 10).*

## 11.8 Post-M0 change log

M0 was frozen at tag `m0-spec-freeze`. The changes below were approved **after** the freeze, following the M0 rule in §1. Each is reflected in the canonical documents listed.

### Change 1 — Four interfaces and scoped roles (approved)

**What changed:**

- Qwikspot has exactly **four interfaces**: Platform Admin Console, Brand Console, Retailer Console, Customer AI Channel (`01` §8b).
- The customer remains WhatsApp-first, with contextual pages only when needed and no dashboard.
- A five-role model with platform, brand and retailer scopes replaced the M0 brand/retail roles. *Superseded by Change 6* (three internal roles).
- Scopes: platform / brand / retail / customer.
- Platform scope is a distinct principal type, never `brand_id = "ALL"` (`07` §4.1–§4.2).
- New `Retailer` entity, belonging to exactly one brand (`04` §8a). It adds `RetailStore.retailer_id`, `Reservation.retailer_id` and `User.retailer_id`.
- `PlatformAuditEvent` added for platform actions (`04` §18.0).

**Decisions:**

- **D1:** a read-mostly brand role. *Superseded by Change 6:* `BRAND_ADMIN` is the only brand role.
- **D2:** `PLATFORM_ADMIN` has **no** default access to customer PII or conversation content. Any future support access must be explicitly authorized, narrowly scoped, audited and separately specified (`07` §4.2).

### Change 2 — Simulator as a channel adapter (approved)

- **D3:** `POST /api/ai/decide` is retired. It is replaced by `POST /api/channels/simulator/messages` (`06` §14.2).
- There is **one** `ConversationPipeline` for WhatsApp and the simulator (`03` §8.2). There is no separate simulator AI flow.
- `Customer.whatsapp_identity_reference` becomes `Customer.channel_identities` (`04` §6).

### Change 3 — Provider architecture and execution profiles (approved)

- **Five provider ports:**
  - `CommerceProvider` (Mock / Shopify)
  - `MessagingProvider` (Simulator / WhatsApp)
  - `AgentRuntime` (Mock / AdkGemini)
  - `FileStorageProvider` (Local / GCS)
  - `EventSink` (Local / BigQuery)

  Details are in `06` §1.1–§6a.
- **Replaced contracts:**
  - `AIProvider` becomes `AgentRuntime`.
  - `AnalyticsProvider` becomes `EventSink`; metrics are read from Firestore.
  - `RetailProvider` is split into a retail file parser plus retail domain services.
- **Direct SDK dependencies:** Firestore and Firebase Auth stay direct SDK dependencies, using the emulators locally.
- **Profiles:** there are two, `local` and `gcp` (`03` §2.2). The `gcp` profile refuses mock and local adapters, except the simulator channel (`07` §19).
- **AI decisions:** every AI decision carries `runtime = MOCK | ADK_GEMINI`, and `decision_source` values are now `AGENT | DETERMINISTIC_FALLBACK` (`04` §14). `MockAgentRuntime` is never presented as Gemini, and the final AI evaluation uses `AdkGeminiAgentRuntime` (`05` §9.2, `08` §7.3).

### Change 4 — Execution strategy (approved)

- **Local first:** the complete core product is built locally first (M2–M12), then cut over to GCP (G1), then the real integrations (G2), then the final live verification (G3) — *sequence superseded by Change 10 (M3–M7, then L1–L3)*. The plan is `10_EXECUTION_PLAN.md`.
- **Not a blocker:** GCP is not a blocker for any local milestone.
- **Spikes:** Shopify, Meta WhatsApp and ADK/Gemini spikes are small and isolated.
- **Judged path:** the judged prototype runs the `gcp` profile with real integrations.

### Change 5 — Review decisions D4–D7 (approved)

- **D4:** The customer simulator is restricted to `BRAND_ADMIN`. `PLATFORM_ADMIN` and `RETAIL_ADMIN` do not use it in the MVP (`07` §4.0, `06` §14.2).
- **D5:** `BRAND_ADMIN` can **view** reservations but cannot change their operational status. Only `RETAIL_ADMIN` fulfills and transitions reservations (`07` §4.0, `06` §14.4).
- **D6:** `decision_source = AGENT | DETERMINISTIC_FALLBACK`, never `GEMINI`. The runtime is tracked separately as `runtime = MOCK | ADK_GEMINI`, and a `MOCK` decision is never represented as a Gemini decision (`04` §14, `05` §9.2).
- **D7:** The unused `POST /api/auth/session` route is removed (`06` §14).

### Change 6 — MVP role simplification (approved)

The prototype uses only the minimum roles it needs:

| Actor | Kind | Scope | Console |
|---|---|---|---|
| `PLATFORM_ADMIN` | internal role | platform (no `brand_id`) | Platform Admin Console |
| `BRAND_ADMIN` | internal role (the only brand role) | one brand | Brand Console |
| `RETAIL_ADMIN` | internal role (the only retail role) | one store of one retailer in one brand (Change 8) | Retailer Console |
| Customer | channel principal, **not** a role | own conversation / context / resources | Customer AI Channel (no login) |

- **Removed:** the read-mostly brand role (`BRAND_MEMBER`), the store-staff role (`RETAILER_STAFF`) and per-user store assignment (`store_ids`). The retailer admin role is renamed `RETAILER_ADMIN` → `RETAIL_ADMIN`, and its scope `RETAILER` → `RETAIL`. A user document carrying any other role value is refused (`07` §4.1).
- **Brand administration routes** follow the simplification: `GET /api/brand/users`, `POST /api/brand/retailers/:retailerId/admins` (`06` §14.7; brand-admin self-provisioning was removed again by Change 7; Retail Admin provisioning became store-based in Change 9). `GET /api/me` returns only the fields of the caller's scope (`06` §14.8).
- **Not introduced:** granular permission matrices, store-staff roles, brand-member roles, extra admin tiers, customer authentication. The role model may be extended only after the core prototype works, through a spec change.

### Change 7 — One operator per scope (approved)

- **Exactly one operator per applicable scope:** one `PLATFORM_ADMIN` for the prototype; exactly one `BRAND_ADMIN` per brand; exactly one `RETAIL_ADMIN` per retailer (per store since Change 9) (`04` §4). Recorded as `Brand.brand_admin_user_id` and `Retailer.retail_admin_user_id`, claimed in a Firestore transaction at provisioning; a second one is refused with `409 BRAND_ADMIN_ALREADY_PROVISIONED` / `409 RETAIL_ADMIN_ALREADY_PROVISIONED`. A non-recorded admin document is refused at sign-in (`07` §4.1).
- **Only `PLATFORM_ADMIN` provisions a `BRAND_ADMIN`.** `POST /api/brand/admins` and the "Add brand admin" UI are removed; `GET /api/brand/users` remains as a read-only accounts view.
- **`BRAND_ADMIN` provisions its retailers' Retail Admins**, one per retailer (one per store, provisioned from the store, since Change 9).
- **Store → retailer assignment is deferred to retail ingestion (M4).** The Brand Console no longer asks for store IDs; `PATCH /api/brand/stores/:storeId` stays backend-only (used by tests and as the ingestion building block) (`06` §14.7).
- **Not introduced:** admin replacement, multiple admins per scope, store-level staff assignment.

### Change 8 — Retail ownership and interface contract (M2.1, approved)

- **Ownership model:** *superseded by Change 9.* M2.1 used one retailer ↔ one store ↔ one `RETAIL_ADMIN` (`Retailer.store_id`, `Retailer.retail_admin_user_id`).
- **Store-level retail scope:** a `RETAIL_ADMIN` requires `brand_id`, `retailer_id` and `store_id`, and can access only its own store. Another store (even of the same brand), another retailer or brand → `404`; brand and platform routes → `403` (`07` §4.1). There is no multi-store access and no store-staff role.
- **Provisioning:** *superseded by Change 9* (retailer-based in M2.1; store-based since M2.2). Still valid: a `users/{uid}` whose `store_id` is missing or does not match the recorded admin/store is refused (`403 USER_MISCONFIGURED`).
- **Association:** retail ingestion establishes store → retailer ownership (M4). Until then the association is backend-only. No console has manual store-ID entry. The M2.1 one-store-per-retailer conflicts are removed by Change 9.
- **API:** `GET /api/me` for `RETAIL` returns `store_id` and a single `store` (not a `stores` list); `GET /api/retail/stores/:storeId` added (`06` §14.8, §14.9).
- **Interface contract:** `11_INTERFACE_CONTRACT.md` documents the four frozen interfaces. No UI redesign and no new features.
- **Supersedes:** "`RETAIL_ADMIN` operates every store of its retailer" (Change 6) and "store access derived from `RetailStore.retailer_id`".

### Change 9 — Final retail ownership: store-based Retail Admins (M2.2, approved)

```text
Brand
 └── Retailer              (retail business / partner, e.g. Nykaa)
      ├── Store A ── RETAIL_ADMIN_A
      ├── Store B ── RETAIL_ADMIN_B
      └── Store C ── RETAIL_ADMIN_C
```

- **A retailer may own many stores.** Each store belongs to exactly one retailer (`RetailStore.retailer_id`). The M2.1 rule "one retailer owns one store" and `Retailer.store_id` are removed.
- **At most one `RETAIL_ADMIN` per store**, recorded as `RetailStore.retail_admin_user_id` (claimed in a Firestore transaction). `Retailer.retail_admin_user_id` is removed. Each `RETAIL_ADMIN` operates exactly one store; there is no multi-store Retail Admin and no store-staff role.
- **Store-level scope unchanged:** `RETAIL_ADMIN` requires `brand_id` + `retailer_id` + `store_id`; Retail Admin A cannot access Store B even when both stores belong to the same retailer (`404`). At sign-in the user must be the store's recorded admin and user and store must agree on the retailer, else `403 USER_MISCONFIGURED`.
- **Store-based provisioning:** the Brand Admin provisions a Retail Admin from a specific store: `POST /api/brand/stores/:storeId/admins` (replaces `POST /api/brand/retailers/:retailerId/admins`). The store must exist in the brand, belong to a retailer (`409 STORE_HAS_NO_RETAILER`) and have no Retail Admin (`409 RETAIL_ADMIN_ALREADY_PROVISIONED`, no setup link generated). The response carries the local Firebase password-setup link, displayed in the local prototype; production delivery (invitation email) is a later concern.
- **Brand Console** shows Retailer → Stores → Retail Admin (`GET /api/brand/stores`), with the provisioning action on each store without an admin. No manual store-ID entry.
- **Association:** a store cannot be attached to a second retailer (`409 STORE_ALREADY_ASSIGNED`) nor detached while it has a Retail Admin (`409 STORE_HAS_ADMIN`). M4 ingestion supports one retailer → many stores through the same domain rule.
- **Unchanged:** the three roles, `GET /api/me` shape (`store_id` + single `store`), `GET /api/retail/stores/:storeId`, and the Customer AI Channel (WhatsApp-only, not an admin role).

### Change 10 — Local-first delivery plan, CSV-only retail input, product knowledge fields, route fix (approved, start of M3)

- **Execution plan (supersedes the sequence in Change 4):** the whole prototype is built on the `local` profile first, in five milestones, then taken live in three phases (`10_EXECUTION_PLAN.md` §3–§4):

  | # | Milestone | Replaces |
  |---|---|---|
  | M3 | Catalog & store truth | old M3 commerce data + M4 retail ingestion |
  | M4 | Intent → conversation | old M5 customer intent + M6 pipeline/simulator |
  | M5 | Decide & reserve | old M7 agent/tools/guardrail + M8 reservations (contextual pages deferred) |
  | M6 | Store fulfilment & outcomes | old M9 Retailer Console + M10 outcomes/intelligence |
  | M7 | Local E2E + hardening | old M11 platform/hardening + M12 local E2E |
  | L1 | Live deploy | old G1: Cloud Run + Firebase Hosting, real Firebase, Gemini on Vertex AI via ADK |
  | L2 | Live integrations | old G2: WhatsApp Cloud API, Shopify development store, BigQuery |
  | L3 | Live E2E | old G3: final live verification |

  Target: complete by **15 Oct 2026**, submit **18 Oct 2026**.
- **Retail upload is CSV only** for the prototype. XLSX is deferred; the canonical schema and the 10 MB limit are unchanged (`04` §9.1–§9.2, `06` §12).
- **Product knowledge fields:** `Product` gains optional `tags` (string list) and `attributes` (string map, e.g. `skin_type`, `key_ingredients`, `size`), so EDUCATE / COMPARE answers can be grounded in catalogue data (`04` §7, `06` §2).
- **Route conflict fix:** `/api/retail/*` is the Retailer Console (RETAIL scope, `06` §14.9). Brand retail import therefore moves from `POST /api/retail/import` to the brand-scoped `/api/brand/retail-imports` routes (`06` §14).
- **Recorded for later milestones (no code before then):**
  - online-order attribution through an opaque reference carried through checkout (M6 / L2);
  - a Brand Console human-handoff queue (M6);
  - Reservation `pickup_code`, optional `customer_eta`, and retailer refusal recorded as `cancelled_by` / `cancel_reason` (M5 / M6; `04` §15);
  - unmet local demand recorded as a payload on the existing `STORE_RECOMMENDATION` event (M5 / M6).
- **Final live stack:** the existing `gcp` profile, deployed on Cloud Run (backend) and Firebase Hosting (frontend), with Firestore, Cloud Storage, Secret Manager, BigQuery (the `EventSink` export), Gemini on Vertex AI through ADK for TypeScript, WhatsApp Cloud API and a Shopify development store. The simulator stays enabled in `gcp` as the judge-testable customer channel (`BRAND_ADMIN` only). Product knowledge is passed to Gemini in context; there is no RAG pipeline.

### Change 11 — Intent → follow-up → conversation (approved, start of M4)

- **D1 — Proactive messages only to reachable customers.** Customer contact was customer-initiated only; it becomes *customer-initiated, plus policy-controlled follow-up to known, opted-in customers*. A storefront visitor is anonymous (opaque session ID, no phone, no opt-in), so a follow-up can be sent only when the web session is linked to a known Customer with a channel identity (`WHATSAPP` or `SIMULATOR`), `consent_state = OPTED_IN` and no opt-out. An anonymous visitor's intent is still recorded and classified; its follow-up decision is `FOLLOW_UP_NOT_ELIGIBLE` / `CUSTOMER_NOT_REACHABLE` — a real outcome, not an error. A web session is linked in exactly two ways:
  - (a) **returning chatter**: the storefront snippet keeps an opaque random `visitor_id` (localStorage) beside the per-tab `web_session_id` (sessionStorage), neither containing PII. When the customer completes the intent-token handshake, the pipeline links that visitor to the Customer (`webVisitors`, stored only as a hash);
  - (b) **signed-in shopper**: mirrors a Shopify customer account with marketing consent (L2: a real Shopify customer or abandoned checkout). Locally the demo storefront's "Sign in as demo shopper" links the visitor server-side to a synthetic shopper from the mock commerce fixture (SIMULATOR identity, consent from the fixture) — never from a phone or email sent by the browser.
- **D2 — `intent_stage` is funnel progress.** Ordered and monotonic within a web session: `VISIT < SEARCH < PRODUCT_VIEW < CONSIDERATION < CART < CHECKOUT`. The former three-level value is kept as `intent_strength` (`NO_MEANINGFUL_INTENT | INTERESTED | HIGH_INTENT`), derived deterministically from the stage plus the WhatsApp-click signal (`04` §11.2), so existing consumers keep working. A later weak event never lowers a stage.
- **D3 — `intent_type` additions:** `VISIT_ONLY`, `SEARCH_EXPLORATION`, `PRODUCT_CONSIDERATION`, `CHECKOUT_ABANDONMENT`. A "Need it today?" WhatsApp click sets `STORE_ORIENTED` at any stage (overrides the type, not the stage). "Abandonment" is a conclusion: `CustomerIntent.status` is `ACTIVE` while the session is live, `ABANDONED` only after inactivity, `CONVERTED` on a completed order, or `EXPIRED`.
- **D4 — Storefront events** (`06` §14.1): `STOREFRONT_VISIT`, `SEARCH` (`search_term`: ≤ 80 chars, trimmed, lower-cased, never echoed to the customer), `PRODUCT_VIEW`, `PRODUCT_DETAIL_VIEW`, `VARIANT_SELECTED`, `ADD_TO_CART`, `CHECKOUT_STARTED`, `WHATSAPP_CLICK` (`entry: STORE_NEED | CHAT`). There is no browser "left the site" event (exit = server-side inactivity) and no compare event. A completed purchase is **not** a public browser event: locally the demo storefront's "Place order" calls a local-only endpoint that goes through the same order-recording path as the L2 Shopify orders webhook. It writes the existing `ORDER_CREATED` CommerceEvent and marks the session's open intents `CONVERTED`.
- **D5 — Deterministic, per-brand follow-up policy** (`brand.settings.follow_up_policy`, `04` §3, §11.3): a pure `evaluateFollowUp` returns `FOLLOW_UP_ELIGIBLE` (with `due_at`) or `FOLLOW_UP_NOT_ELIGIBLE` with one reason: `ALREADY_CONVERTED, ALREADY_FOLLOWED_UP, WEAK_INTENT, INTENT_TYPE_DISABLED, CUSTOMER_NOT_REACHABLE, CHANNEL_DISABLED, OPTED_OUT, NO_CONSENT, HUMAN_HANDOFF, CUSTOMER_ALREADY_IN_CONVERSATION, FREQUENCY_LIMIT` (checked in that order). `VISIT_ONLY`, `PRODUCT_EXPLORATION` and a search that matched no catalogue category or tag are `WEAK_INTENT`; `INTENT_TYPE_DISABLED` means the brand switched off a normally-on type. At most 1 follow-up per intent and 1 proactive message per customer per 24 h. The policy is re-checked at send time; a change in between (converted, opted out, handed off, started chatting) makes the follow-up `SUPPRESSED` with the reason. Due work is processed by `POST /api/brand/follow-ups/process-due` (Brand Console button, optional local auto-poll); in `gcp` the same endpoint will be called by Cloud Scheduler with an OIDC service identity (L-phase; not built in M4).
- **D6 — Message kind follows the WhatsApp window:** inside 24 h of the customer's last inbound message a `SESSION` message (free text); outside it only a named, parameterised `TEMPLATE` (e.g. `qwikspot_cart_reminder_v1`) with parameters limited to the brand name and verified product data. The simulator labels the kind. Template approval with Meta is an L2 task; M4 keeps the template registry in code. Every proactive message says how to opt out.
- **Also:** `ConversationMessage` gains `origin` (`CUSTOMER | AUTOMATED_REPLY | PROACTIVE_FOLLOW_UP`) and `message_kind`; CommerceEvent names gain `STOREFRONT_VISIT, SEARCH, VARIANT_SELECTED, FOLLOW_UP_SCHEDULED, FOLLOW_UP_SUPPRESSED, FOLLOW_UP_SENT` (`04` §17). In M4 the agent stage is not built: every reply is the deterministic fallback (`03` §16.2), recorded with the configured `runtime` and `decision_source = DETERMINISTIC_FALLBACK`.

### Change 12 — Decide & reserve (approved, start of M5)

- **E1 — Agent loop: reads during decide, writes only after the guardrail.** The `AgentRuntime` receives the controlled context package (`04` §20) and the **read** tool declarations only (`get_product_context`, `get_brand_policy`, `get_customer_history`, `find_nearby_stores`, `check_store_inventory`, `get_store_hours`). It proposes a write through `next_best_action` (+ `required_tools`). The **write** tools (`create_reservation`, `cancel_reservation`, `request_human_handoff`, `record_customer_intent`) run in pipeline step 8 (TOOLS), after step 7 (GUARDRAIL) has re-verified the proposal against fresh Firestore data. A write tool called during the decide step is `BLOCKED` with `WRITE_NOT_ALLOWED_IN_DECIDE`. The `ToolExecutor` checks, on every call: the tool exists (`UNKNOWN_TOOL`), the input carries no scope keys (`brand_id`, `customer_id`, `conversation_id` → `SCOPE_VIOLATION`, audited), the input is valid for the tool's strict schema (`INVALID_INPUT`), and the action is allowed in this step. Scope is always injected from the pipeline's resolved customer. Every call is recorded (input, output summary, status, reason, duration) in the decision trace. Tool declarations are zod schemas exportable as JSON Schema, so `AdkGeminiAgentRuntime` reuses them unchanged.
- **E2 — Guardrail block codes:** `OUT_OF_STOCK`, `STORE_CLOSED`, `NOT_ELIGIBLE` (inactive store, reservations disabled for the store or brand, too far, quantity limit), `SCOPE_VIOLATION`, `AMBIGUOUS` (no pending proposal, or the store/variant does not match what was offered). A block is recorded as `guardrail_status = BLOCKED` with the reason code, audited (`AI_ACTION_BLOCKED`), executes nothing and is answered with a verified safe alternative (another eligible store, online purchase or an eligible alternative product). A guardrail block is not a runtime failure: `decision_source` stays `AGENT`.
- **E3 — Commerce replies are built by the pipeline** from verified tool results (`05` §8: the pipeline may replace the proposed reply): store options, reservation confirmation, "no eligible store", blocked-alternative, lost race and cancellation. The confirmation contains the store name and address, the `pickup_code`, the hold-until time in the store's timezone, a maps link built from the store's coordinates, "Pay at the store", a "Cancel reservation" option and "The store will confirm when it's ready." No reply promises a pickup time. "Only 1 left" appears only when the verified available quantity is exactly 1.
- **E4 — `Conversation.pending_proposal`** `{store_id, variant_id, quantity, proposed_at, expires_at, offered_stores[]}`: set when a hold is offered, cleared when the reservation is created, ignored after `expires_at = proposed_at + hold_minutes`. "Reserve it" / a "Hold" tap is only executable against it.
- **E5 — Customer location sources:** (a) a shared location message (stored on the Customer as `last_location`, rounded to 2 decimal places, ~1 km); (b) an area name in the text that matches exactly one store **locality** (derived from the store name and its address segments), which gives an *approximate* origin at that store's coordinates and is labelled approximate in the reply. With neither, the agent asks for the area and lists no stores. It never guesses.
- **E6 — Reservation:** created in the single transaction of `03` §15 with `reservation_id` derived from `idempotency_key` (agent path: `idempotency_key = recommendation_id`), `retailer_id` copied from the store, `ai_recommendation_id`, `expires_at = now + hold_minutes`, optional `customer_eta`, and `pickup_code` = 6 random digits, unique among the store's active (PENDING / CONFIRMED / READY / CUSTOMER_ARRIVED) reservations, checked inside the transaction. Cancel (by the customer, in the conversation) and expiry release `reserved_quantity` transactionally. Expiry runs through the existing `POST /api/brand/follow-ups/process-due` (Brand Console button and local auto-poll). Cancellation and expiry are AuditEvents (`RESERVATION_CANCELLED`, `RESERVATION_EXPIRED`); no CommerceEvent names are added. In M5 the only status transitions are create, cancel (`cancelled_by = CUSTOMER`) and expire (`cancelled_by` unset, status `EXPIRED`); retailer transitions are M6.
- **E7 — Unmet local demand** is a `STORE_RECOMMENDATION` CommerceEvent with payload `{kind: "UNMET_DEMAND", variant_id, sku, area: {type: "LOCALITY" | "GRID_5KM", value}, excluded: [{store_id, reason}], local_weekday, local_hour, timezone}`. `area` is the nearest store's locality, or a ~5 km grid cell (`g5:<floor(lat/0.045)>:<floor(lng/0.045)>`); weekday and hour are in the nearest store's timezone. The payload contains no coordinates. A successful proposal records `STORE_RECOMMENDATION` with `{kind: "PROPOSED", variant_id, stores}`.
- **E8 — Decision trace:** the `AIRecommendation` also stores `context_hash` (SHA-256 of the context package), a `context_summary` (no message text, no PII), the tool calls, eligible and excluded stores, the guardrail result and the executed action (with any `reservation_id`). The Brand Console shows it as "Why Qwikspot did this".
- **E9 — Runtime failure** (the 20 s budget elapsed, or the output still invalid after one repair attempt) uses the deterministic fallback of `03` §16.2 exactly: `HUMAN_HANDOFF` when the brand has handoff enabled, otherwise `NO_ACTION` with a "please try again" reply; `decision_source = DETERMINISTIC_FALLBACK`, the configured `runtime` is kept.
- **E10 — Brand settings:** `online_store.product_url_template` (e.g. `https://<shop>/products/{handle}`; locally the demo storefront `…/demo-store#product={product_id}`) provides the "Buy online" link; without it the reply names the online store without a link.
- **Deferred (unchanged):** contextual pages and page tokens, retailer status transitions, `PATCH /api/reservations/:id`, Outcomes, the handoff queue and the scheduled expiry sweep in `gcp`.

### Change 13 — Store fulfilment & outcomes (approved, start of M6)

- **F1 — Retailer transitions.** Only the store's `RETAIL_ADMIN` moves a reservation through `04` §15: PENDING → CONFIRMED → READY → CUSTOMER_ARRIVED → COMPLETED, or PENDING / CONFIRMED / READY → CANCELLED (refusal). `CUSTOMER_ARRIVED` stays an explicit step (the §15 table does not allow READY → COMPLETED). `PATCH /api/reservations/:id` carries `expected_current_status` (optimistic concurrency: a different current status → `409 STALE_STATUS`; a transition not in the table → `409 INVALID_TRANSITION`). Every inventory effect runs in the same Firestore transaction as the status change, with `0 ≤ reserved_quantity ≤ quantity`. `BRAND_ADMIN` views only; `PLATFORM_ADMIN` → 403; another store (even of the same retailer) → 404.
- **F2 — Pickup-code check at completion.** COMPLETED requires the customer's `pickup_code`, entered by the store. A wrong code → `422 PICKUP_CODE_MISMATCH`, audited, nothing else changes except the reservation's `pickup_code_attempts`. From the 5th wrong attempt the reservation is locked for completion (`429 PICKUP_CODE_LOCKED`); refusal stays possible.
- **F3 — Refusal.** CANCELLED with `cancelled_by = RETAILER` and `cancel_reason` ∈ `NOT_ACTUALLY_IN_STOCK | DAMAGED | STORE_CLOSING_EARLY | OTHER` (OTHER takes an internal note ≤ 140 characters, never shown to the customer). `NOT_ACTUALLY_IN_STOCK` also sets that store's inventory for the SKU to `quantity = reserved_quantity` (after this reservation's release), so the SKU shows unavailable there; audited as `INVENTORY_CORRECTED_BY_RETAILER`. A later retail upload overwrites `quantity` as usual.
- **F4 — Customer notifications.** Each retailer transition, and expiry, sends one deterministic message built from verified data through the shared outbound path, with `ConversationMessage.origin = RESERVATION_UPDATE` and the M4 kind rule (SESSION inside 24 h, otherwise the named TEMPLATE):

  | Event | Template | Content |
  |---|---|---|
  | CONFIRMED | `qwikspot_reservation_confirmed_v1` | store confirmed · product · pickup code · held until (store time) · Cancel option |
  | READY | `qwikspot_reservation_ready_v1` | ready at store · code · maps link |
  | Refused | `qwikspot_reservation_refused_v1` | apology (no reason note, never blames the customer) + re-offer |
  | EXPIRED | `qwikspot_reservation_expired_v1` | hold expired · "Check stores again" |

  Not sent when the customer opted out; the reservation records `last_notification.status = NOT_SENT_OPTED_OUT` and the Retailer Console shows "customer opted out; not notified". **Refusal forward dispatch:** the backend re-runs the eligible-store search for the same variant from the customer's last location, excluding the refusing store, and offers the best remaining store as a one-tap Hold (through `pending_proposal` + the guardrail, so nothing is reserved without the tap) plus Buy online; with no eligible store it offers the verified alternative or online and records `UNMET_DEMAND` (Change 12, E7). The automated re-offer is skipped while a person owns the conversation; the factual updates are still sent.
- **F5 — Outcomes.** One Outcome per **engaged journey** (a conversation exists or a follow-up was sent); the journey key is the bound intent (`int:<intent_id>`) or, without one, the conversation (`conv:<conversation_id>`). Anonymous browse-only intents never get an Outcome. The Outcome document ID derives from the journey key and is created only if absent, so **the first verified purchase wins**; a later purchase in the same journey is recorded only as its CommerceEvent. Evidence: reservation → COMPLETED (OFFLINE, or ALTERNATIVE for a different variant than the intent's); an order attributed to the journey (ONLINE or ALTERNATIVE). `NONE` is decided only by the process-due sweep, after `outcome_policy.attribution_window` (default 7 days; local demo override in minutes) has passed since the journey's last recommendation with no active reservation — never at the moment a hold expires. Value = catalogue price × quantity. Each Outcome links the journey's last `ai_recommendation_id`. New CommerceEvent `OUTCOME_RECORDED` (added to `04` §17) plus an AuditEvent. Reservation completion also emits `PICKUP_COMPLETED` and `OFFLINE_PURCHASE`. Pipeline step 11 re-checks stored evidence for the conversation's journey; the AI never writes an Outcome.
- **F6 — AttributionRef (`qs_ref`).** When a reply offers Buy online, the backend creates an opaque reference (16 random bytes, Crockford Base32; only its SHA-256 is stored, `attributionRefs`), linking brand, intent, conversation and recommendation, with TTL = the attribution window and no PII, and adds it to the product URL as `qs_ref`. The storefront keeps it for the session and sends it with the order; `OrderService.recordOrder` validates it (exists, same brand, not expired) and links the order to the journey. An invalid or expired ref never fails the order — it is recorded unattributed. In L2 the ref travels as a Shopify cart attribute and the orders webhook calls the same method (`06` §8.1). The ref only links; the purchase evidence is the order from the commerce source.
- **F7 — Handoff queue.** A Brand Admin can reply as a person to a conversation in handoff (`origin = HUMAN_AGENT`; the sender's uid only in the AuditEvent; opt-out and the 24 h window still apply) and "Resolve and return to assistant" (`human_handoff = false`, audited). `Conversation.handoff_at` shows the waiting time.
- **F8 — Insights.** The Brand Console Outcomes screen (funnel, conversion by action, unmet demand, demand vs availability by weekday, fill rate, suggested actions) is computed deterministically by the application from raw records read through an `InsightsReader` port (Firestore now; BigQuery can serve the same port in L2). Weekdays use the store's timezone. Readings and suggestions are rule-based text built only from the numbers; nothing is sent. `STORE_RECOMMENDATION` payloads gain `nearest_store_id` and `nearest_reason` for fill rate.
- **F9 — Synthetic demo history.** `seed:demo` (emulator-only) adds 4 weeks of deterministic synthetic history built with the live domain functions; every such document carries `demo_history: true`, and the Outcomes screen shows and can exclude it. Live actions are never flagged.

### Change 14 — Local E2E, hardening and judge readiness (approved, start of M7)

- **G1 — Stale stock.** Brand setting `retail_freshness_hours` (default 24). A store whose stock row for the variant is older than that is marked `stale` by the store tools; the consoles show "stock as of …", and a customer reply about a stale store says when its stock was last updated ("store stock last updated <date, store time>") instead of a bare availability claim. The guardrail still re-verifies the numbers before any hold; freshness qualifies the claim, it does not block.
- **G2 — Reliability.** Outbound sends are retried up to 2 times with exponential backoff and the same outbound request ID (`03` §16.2); after that the message is stored `FAILED` and the console shows "Not delivered". A database outage (gRPC UNAVAILABLE / DEADLINE_EXCEEDED) answers `503 SERVICE_UNAVAILABLE`, retryable, with a safe message. No response ever contains a stack trace. A simulator replay that arrives while the first delivery is still processing waits briefly (≤ 5 s) and returns the original result; nothing is processed twice (otherwise `409 MESSAGE_IN_PROGRESS`, retryable).
- **G3 — DEMO_MODE.** A configuration flag (env `DEMO_MODE`, default off; on locally and for the judged deployment). It never weakens authorization: demo users are normal users with normal scopes. When on, `GET /api/demo/config` returns the demo logins from configuration (`DEMO_LOGINS`; never in the frontend bundle) and the login page shows "Try the demo". Console sign-in is per browser tab (Firebase session persistence), so four tabs can hold the four demo roles side by side; closing a tab signs it out.
- **G4 — Reset demo.** `POST /api/brand/demo/reset` by the BRAND_ADMIN of a brand in `DEMO_BRAND_IDS` while DEMO_MODE is on (otherwise refused). An application service, so it works on emulators and on real Firestore: it removes that brand's customers, conversations, intents, follow-ups, recommendations, reservations, outcomes, events, tokens, attribution references, catalogue and stock; re-runs the catalogue sync, the judge stock import and the synthetic history; keeps the brand, retailers, stores with their Retail Admins, users and the audit log. Idempotent, audited (`DEMO_RESET`), at most once per minute per brand; other brands are never touched.
- **G5 — Shared-demo safety.** Several judges may use the demo at once: each simulator browser session gets its own customer ref (`judge_xxxx`); the judge stock fixture leaves headroom for the success path (Serum 30 ml: Bandra 20, Andheri 25) while keeping the designed gaps (Powai 0, Serum 50 ml none in Mumbai), and its Mumbai stores are open 00:00–23:59 so a judge in any timezone can reserve — the test fixture `demo-retail.csv` keeps 10:00–21:00, so "store closed" stays covered by tests and scenario 11; in DEMO_MODE the demo brand's hold time is `DEMO_HOLD_MINUTES` (default 20), so abandoned holds release stock quickly. No per-judge tenants.
- **G6 — Runtime-agnostic AI scenario suite.** The `08` §7.2 scenarios are one suite parameterised by `AgentRuntime` and run count, asserting only structured output (action, guardrail status, tool calls, persisted records) with the `08` §7.3 pass rules. It runs on `MockAgentRuntime` now and on `AdkGeminiAgentRuntime` in L1 unchanged; the adapter contract suites (commerce, messaging, agent, file storage, event sink) are likewise shared.
- **G7 — gcp configuration contract.** In the `gcp` profile the backend validates every required setting at startup and fails fast with one message naming all that are missing (never values): project, region, Firestore database, Vertex model and location, WhatsApp token / phone number id / app secret / verify token, Shopify shop / admin token / webhook secret, BigQuery dataset, Cloud Storage bucket, DEMO_MODE and allowed origins. Secrets come only from the environment (Secret Manager in Cloud Run).
- **G8 — `seed:live`.** Bootstraps the judged environment through the normal provisioning chain (Platform Admin, demo brand, Brand Admin, retailers, Retail Admins) and then calls the Reset demo service. It requires `--project <id>`, a typed confirmation and `DEMO_MODE=true`; it is not emulator-guarded.
- **G9 — `demo:check`.** A script that walks the judged journey against a `BASE_URL` through the public API only and prints a pass/fail line per step; in L3 it is the production smoke test (`08` §14).
- **Also:** the docs/07 §15 cases for webhook signatures and contextual page tokens have no local surface (WhatsApp/Shopify webhooks are L2; contextual pages are deferred by Change 10). The messaging contract suite carries the invalid-signature case for every adapter that verifies signatures.

### Change 15 — Product renamed to Qwikspot (2 Oct 2026)

The product name changed from Buildwise to Qwikspot everywhere in the repository (code, UI, customer messages, tests, fixtures, docs and infrastructure names); nothing else changed — no data shape, route, rule or behaviour. Externally visible renames: intent token prefix `START_BUILDWISE_` → `START_QWIKSPOT_`; env vars `BUILDWISE_PROFILE` / `VITE_BUILDWISE_PROFILE` → `QWIKSPOT_PROFILE` / `VITE_QWIKSPOT_PROFILE`; storefront snippet `buildwise-intent.js` → `qwikspot-intent.js` and its global `BuildwiseIntent` → `QwikspotIntent`; header `X-Buildwise-Page-Token` → `X-Qwikspot-Page-Token`; attribution reference `bw_ref` → `qs_ref` (and the browser keys `bw_*` → `qs_*`); stored event source `BUILDWISE` → `QWIKSPOT`; WhatsApp templates `buildwise_*_v1` → `qwikspot_*_v1`; emulator project `demo-buildwise` → `demo-qwikspot`; demo logins `@buildwise.test` → `@qwikspot.test` with the local password `buildwise-demo-1` → `qwikspot-demo-1`.

### Change 16 — Interface refresh (UI-0 onwards, Oct 2026)

Interfaces only: the guardrail, reservation rules, follow-up policy, outcome rules, tenant isolation and console authorization are unchanged ("AI proposes; the deterministic backend decides"). No new Firestore collection.

- **UI-0/UI-1 — Public landing and role-aware login.** `/` is a public landing page (no API call except the public demo config); `/login?as=brand|store` adapts its copy; `/app` sends a signed-in user to their own console (`/platform`, `/brand`, `/store`); `/retailer` → `/store` and `/demo-store` → `/shop` keep working.
- **UI-2 — Shopper experience.** The customer experience leaves the Brand Console. `/shop` is the brand's demo website with the Qwikspot widget ("Need it today? Check a store near you", "Chat on WhatsApp", "Powered by Qwikspot"); `/chat` is the brand's WhatsApp chat as the shopper sees it (docked beside the store on desktop, full screen on phones). Both exist where the shopper demo is served — the local profile, and gcp only with `DEMO_MODE` on, for the allowlisted demo brands (`DEMO_BRAND_IDS`); elsewhere the page says "The shopper demo isn't available here."
- **Signed shopper sessions.** The browser never chooses a customer ref. `POST /api/shopper/session` issues an HMAC-SHA256-signed token (12 h) carrying the brand and a server-generated ref (`judge_xxxxxxxx` for a guest, or the synthetic demo shopper's ref when the browser names one of the synthetic shopper ids); every other shopper route reads the ref only from the verified token (`06` §14.11, `07` §4.3). The secret is `SHOPPER_SESSION_SECRET` (required in gcp when `DEMO_MODE` is on; random per process locally).
- **Structured message parts.** Outbound messages gain optional WhatsApp-compatible parts — image header, footer, location, CTA URL, list button — beside the existing body text and options (options become reply buttons or list rows, same ids). A domain validator enforces the WhatsApp limits (`06` §11.1) in the outbound stage and in the messaging adapter; a message that breaks a structural limit is stored `FAILED` with `MESSAGE_PARTS_INVALID`. The simulator renders only what WhatsApp can render. Templates: store found (image, body, Hold / Other stores / Buy online), other stores (a list), hold confirmed (pickup pass = body + location message + Cancel), store updates (confirmed, ready with location, refused, expired), follow-up (image, approved template text, Find a store near me / Buy online / Talk to a person). The new option id `handoff` starts the existing human handoff.
- **"Powered by Qwikspot".** Messages always come from the brand (its display name and logo). "Powered by Qwikspot" appears only as the WhatsApp footer of interactive automated messages (assistant replies, follow-ups, store updates) and only while the brand setting `messaging.powered_by_footer` is not `false`; never on a team member's reply, never on plain text, never in the body, never as the sender.
- **Product images.** Self-made illustrations (SVG drawn for this project, rendered to 600×600 PNG by `scripts/render-product-images.mjs`; no third-party photos) in `frontend/public/demo-products/`; products carry an optional `image_url` (`04`). Relative URLs become absolute with `PUBLIC_WEB_ORIGIN`.
- **UI-3 — Brand Console, results first.** Navigation **Overview · Conversations · Reservations · Insights · Network · Settings** (`/brand/outcomes` redirects to `/brand/insights`), with a "needs a person" count on Conversations.
  - **Overview:** KPI tiles from `GET /api/brand/insights` (intents caught, conversations, holds, pickups, online orders, conversion = the share of finished journeys (a recorded outcome) that ended in a purchase, "New conversations" = conversations started in the period, and the recorded value of purchases marked "est."), each marked when synthetic history is included; "Needs your attention" (handoffs waiting with minutes, store refusals in the last 24 h, stale-stock stores, SKU mapping issues); the weekday reading and the top suggestion linked to the store it names; the demo guide; a setup card that collapses once complete.
  - **Conversations:** one **journey timeline** per conversation (website events → chat → decisions → hold → store steps → outcome), the read-only transcript, and a plain **"why" sentence** per decision built only from the stored trace ("Offered Andheri Store (7.6 km) because Powai Store (0.7 km) is out of stock and Bandra Store (10.6 km) is too far."), with the technical trace under "Technical details". A completed pickup reads "Picked up at Andheri Store — in-store purchase" (it was "Ordered: no"). "Run due follow-ups" is now **Process due work now**.
  - **Reservations** page: product image, store, status, masked customer, how the hold ended; a row opens its conversation. **Insights:** hand-built SVG charts (funnel with step conversion, weekday bars with the problem day) with table fallbacks; suggestions link to the store. **Network:** catalogue (images, mapping reasons in words), retail import with **Download sample CSV** (the fixture's valid rows), retailers and stores with copy-link provisioning. **Settings:** read-only, from `GET /api/brand/settings`.
  - **Synthetic labelling:** conversation and reservation rows carry the stored `demo_history` flag; lists show a "Synthetic" pill and a "Hide synthetic history" toggle (on by default, remembered per browser).
  - **Backend (read-only, additive):** the conversation detail adds `outcomes[]`, the reservation's `status_history` (from its own timestamps; never the internal refusal note), quantity and product titles, and `demo_history`; brand reservation rows add `conversation_id`, `image_url` and `demo_history` (the store's rows never get the conversation); `GET /api/products` adds `image_url`; the insights funnel adds `value` (the sum of recorded purchase outcomes' values); new `GET /api/brand/settings`. No rule, write path or collection changed.
- **UI-5 — Platform Console with the retail side (spec change: platform scope widened to brand and store AGGREGATES; `07` §4.2, `11` §3).** Navigation **Overview · Brands · Retail network · Audit · System**.
  - **Overview** (7 / 28 days, synthetic history included or not): active brands and retailers; stores live (active + stock + Store Admin); holds; store pickups (offline sales); offline sales value (completed quantity × the store's current offline price, "est."); attributed online orders (ONLINE / ALTERNATIVE outcomes) with their recorded value; completion (pickups ÷ finished holds — completed, refused, expired or cancelled; holds still active are left out; the same definition as the Store Console); fill rate (lookups whose nearest store had stock); unmet demand lookups; follow-ups sent; and "Brands needing attention".
  - **Brands:** the onboarding checklist plus the next step in words ("Waiting for the brand to import store stock.") and the last 7 days per brand; create, provision the Brand Admin (with **Copy link**), suspend / reactivate with toasts.
  - **Retail network:** per brand → retailers → stores with counts only (city, status, Store Admin yes / not yet, stock fresh / stale / none, holds, picked up, refused by reason, expired, completion, fill rate) and health flags — No stock upload, Stale stock, No Store Admin, Low fill rate, High refusal rate, Stale holds.
  - **Audit:** brand names, the actor's role, the reason and the result, with filters. **System:** profile, AI runtime, customer channel, commerce, version and commit from `GET /api/health`, each explained.
  - **Backend (read-only, additive):** `GET /api/platform/network`, `GET /api/platform/brands/:brandId/network`; the audit adds `target_brand_name` and `actor_role`; `/api/health` adds `adapters` (names only). A test asserts both network responses contain no customer refs, messages, phone numbers, emails, pickup codes, stock lines or Store Admin identities.
- **UI-4 — Store Console.** Header "Andheri Store · for Demo Beauty Co via North Retail"; navigation **Today · History · Stock · Demand** (Today shows a count of holds to confirm).
  - **Today:** a "Last 7 days" value strip — holds, picked up, completion (picked up ÷ finished holds; active holds left out), refused, expired and the value of pickups (quantity × the store's current offline price, "est."), marked when synthetic history is included; a **Next up** card for the most urgent hold with one big action; the queue with product images, expiry, customer-notified status and **"Why this hold came to you"**; the pickup-code hint "Ask for the 6-digit code in their WhatsApp."
  - **Why this hold came to you** is built on the server from the decision trace and is store-safe: other stores by name and exclusion reason only, this store's own distance from the customer as the only number (e.g. "Powai Store was closer but out of stock. You were the nearest store with stock — 7.6 km from the customer."). Never the customer's location, area, coordinates, messages or identity, never a conversation or recommendation id, never another store's distance.
  - **New-hold alert:** a toast, a "New" badge, the nav count and the tab title; a short tone only when the store switches sound on (off by default, remembered per browser).
  - **Demand near you:** `GET /api/retail/stores/:storeId/insights` — the store's own slice of the brand's insights (missed demand where it was the nearest store, its fill rate by weekday, its refusals, the suggestions that name it; counts only, no evidence ids). Own store only: any other store, including a sibling store of the same retailer, is 404.
  - **History** (how each hold ended) and **Stock** (read-only, product images, "Your brand updates this from its retail file", the store's details).
  - **Backend (read-only, additive):** store reservation rows add `why_here`, `image_url`, `demo_history`; the summary adds `completion_pct`, `value`, `synthetic`; inventory rows add `image_url`; suggestions carry `store_id`. No rule, write path or collection changed.
- **Brand Console without the simulator.** `/brand/conversations` shows the conversation read-only, exactly as the shopper sees it, with internal labels (AI assistant, Team member, Store update, Follow-up · Template/Session) and delivery status; the handoff reply box, intent panel and decision trace stay. "Open shopper demo ↗" (demo brand, DEMO_MODE) opens `/shop`. The brand-scoped `/api/channels/simulator/*` routes are unchanged (tests, `demo:check`).

- **UI-6 — Judge polish, docs and demo.**
  - **Per-session demo shoppers** (security review of UI-2, note 1): "Sign in as <demo shopper>" in the shopper demo starts its own signed session first; the server gives that session a fresh ref (`shopper_3002_<8 random>`, token claim `s` = the synthetic shopper) and the storefront sign-in, sent with that session, links the browser to the **session's own customer** — the same consent and Shopify customer link as the synthetic shopper, its own conversation. Two visitors who both pick Asha never share a customer or see each other's messages, and the 24 h follow-up limit no longer blocks the next judge. Sign-in without a session keeps the legacy shared customer, reachable only through the brand-scoped simulator. Reset demo removes every per-session shopper with the rest of the brand's customers, identities and conversations (tested on the emulators).
  - **The 10-minute judge script** — the same 8 steps in the README, the Brand demo guide and `docs/screenshots/` — runs from a fresh **Reset demo** with no manual steps; `scripts/judge-script.mjs` performs it through the UI at 1440 px and 390 px and fails on any step that does not happen.
  - **Polish:** page titles per surface ("Today · Store Console · Qwikspot"); table wrappers keep their contents inside the scroll area; phone forms no longer stretch; the screenshot set is committed under `docs/screenshots/` with an index.
- **Judge-test fixes (after UI-6; `docs/JUDGE_TEST_PLAN.md`).**
  - **Pickup vs delivery:** the store card states the choice — "Pick up today at *<store>*, <km>" vs "Home delivery in 4–5 days" (brand setting `online_store.delivery_days`, default 4–5) — with the buttons **Pick up today · Home delivery · Other stores** (WhatsApp: ≤ 3 buttons, ≤ 20 characters); the pickup pass repeats the delivery option as text.
  - **Refusal beyond the radius:** when the refusing store was the only one within 10 km, the nearest store with stock within `reservation_policy.extended_radius_km` (default 25) is offered with its distance next to home delivery, instead of being dropped silently. **This is the one guardrail extension:** the pending proposal carries that radius and the hold check uses it for that one offered store only (capped at 25 km); every other check is unchanged.
  - **Thank-you after pickup:** **Complete** sends one plain-text thank-you from the brand (no footer), only inside the 24-hour window — outside it nothing is sent and the store sees why (`NOT_SENT_OUTSIDE_WINDOW`). **Customer arrived** sends nothing.
  - **Why this hold came to you, after a refusal:** the next store reads "<store> couldn't fulfil the customer's hold, so it came to you — <km> from the customer", no longer "the customer chose you" (found while testing the plan).
  - The Brand Admin login hint no longer mentions the simulator; `scripts/judge-test-plan.mjs` runs the whole plan in a browser.
- **Change 16 in one paragraph.** Qwikspot now has five surfaces — a public **landing** page, a DEMO_MODE-gated **shopper demo** (`/shop`, `/chat`) on signed per-tab sessions, and three role consoles (**Brand**, **Store**, **Platform**) on one design system. Customer messages are structured WhatsApp parts checked by a domain validator, always from the brand, with "Powered by Qwikspot" only as the footer of interactive automated messages. The Brand Console is results-first, with one journey per conversation and a plain "why"; the Store Console shows why each hold came and the demand near the store; the Platform Console widens to brand and store aggregates and never to customers. Business rules, the guardrail, tenancy and auth are unchanged; every backend change was additive and read-only except the shopper channel itself.

### Supporting additions

- `RetailImport` entity for the ingestion report (`04` §10.1). This closes a pre-existing gap.
- `Brand.status` values `ACTIVE | SUSPENDED`; `Retailer.status` values `ACTIVE | INACTIVE`.
- The unused example route `POST /api/auth/session` is removed, because console auth is Bearer-token only.
- The final contradiction audit removed the agent tool `record_outcome()`. It contradicted the approved rule that the AI never records outcomes (`04` §16, `05` §9). The audit also renamed `prepare_whatsapp_response()` to the channel-neutral `prepare_customer_response()` (`05` §6).
- The routes `GET /api/health` (already implemented in M1), `POST /api/internal/reservations/expire` and `PUT /api/local-files/uploads/:uploadId` were added to the route list. The last two were previously referenced but unnamed (`06` §14).

**Unchanged:** the product thesis, core customer journey, AI role, WhatsApp-first customer experience, Brand and Retailer Console purpose, Google Cloud target architecture, and every other M0 decision in §11.1–§11.6 not named above.

---

# 12. Shopify integration boundary

Shopify is the source of truth for Qwikspot's **online commerce context**.

The Qwikspot integration should conceptually provide the canonical `CommerceProvider` contract (`06_INTEGRATION_CONTRACTS.md` §2):

```text
getProducts()
getProductVariant()
getCustomer()
getOrder()
getOrders()
getInventory()
getLocations()
```

The application should use a provider abstraction such as:

```text
CommerceProvider
    ├── MockCommerceProvider
    └── ShopifyCommerceProvider
```

The MVP should support one controlled Shopify development-store integration and should not assume that the merchant-owned client-credentials model is a universal multi-merchant SaaS onboarding mechanism.

Initial sync:

```text
Shopify
   ↓
authentication
   ↓
products / variants / customers / orders / inventory / locations
   ↓
normalize
   ↓
Firestore
```

Ongoing sync:

```text
Shopify event/webhook
   ↓
Cloud Run
   ↓
validate + normalize
   ↓
Firestore update
```

Stable identifiers such as SKU/variant identifiers should be preferred over product-name matching.

---

# 13. Retail integration boundary

Retail data provides the physical-commerce reality that Shopify does not own.

Required fields use the canonical retail schema (`04_DATA_MODEL.md` §9.1):

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

The critical mapping is:

```text
Shopify Product/Variant
        ↕
Canonical SKU
        ↕
Retail SKU
        ↓
Retail Store Inventory
```

Do not use product names as the primary identity-matching mechanism.

Unmatched/ambiguous records should be surfaced for resolution rather than silently guessed.

---

# 14. WhatsApp integration boundary

WhatsApp is the primary customer interaction channel.

The intended flow is:

```text
Customer
   ↓
WhatsApp
   ↓
Meta Cloud API
   ↓
Qwikspot webhook
   ↓
Cloud Run
   ↓
customer resolution
   ↓
customer/brand/retail context
   ↓
ADK + Gemini
   ↓
next-best action
   ↓
AI Action Guardrail
   ↓
WhatsApp response / controlled action
```

The production onboarding direction is Meta Embedded Signup so a D2C brand connects its own WhatsApp Business Account and phone number to Qwikspot.

The AI should not send arbitrary messages without respecting WhatsApp policy, consent/opt-in requirements, template requirements, and the customer-service conversation window.

The backend must explicitly track relevant message/conversation state.

---

# 15. Customer experience boundary

There is **no full customer dashboard** in the MVP.

Customer experience is:

```text
Shopify website
      ↓
relevant intent/context
      ↓
WhatsApp
      ↓
AI conversation
      ↓
personalized next-best action
      ↓
online checkout
OR
store reservation
      ↓
retailer fulfillment
```

Small contextual web pages may be used when a task is better served by a richer interface, such as:

```text
nearby store selection
reservation confirmation
pickup status
```

The rule is:

> **WhatsApp is the customer's primary interface; Qwikspot web pages appear only when they materially improve completion of a task.**

---

# 16. AI decision boundary

The agent follows:

```text
UNDERSTAND
      ↓
CONTEXTUALIZE
      ↓
DECIDE
      ↓
ACT
      ↓
LEARN
```

Gemini can reason about:

```text
Should I intervene?
What is the customer trying to accomplish?
What problem/friction is blocking the purchase?
Should I educate?
Should I compare?
Should I recommend online purchase?
Should I recommend local pickup?
Should I find another store?
Should I suggest an alternative product?
Should I hand off to a human?
```

Deterministic code remains responsible for:

```text
customer identity
SKU identity
inventory
store distance
store hours
reservation validity
permissions
business rules
transaction execution
```

Gemini must not directly write to sensitive operational state or bypass authorization.

---

# 17. AI customer-context boundary

The AI should receive a controlled context package containing only relevant information.

Conceptually:

```text
CUSTOMER WORLD
+
BRAND WORLD
+
RETAIL WORLD
        ↓
CONTROLLED CONTEXT PACKAGE
        ↓
GEMINI
```

Example context may include:

```text
customer lifecycle
relevant preference
current intent
current product
customer location where authorized/needed
previous relevant conversation
brand policy
store availability
store hours
reservation capability
```

Do not pass unrelated customer history, credentials, payment details, or internal retailer/brand information merely because it is available.

---

# 18. Security boundary

Core security controls:

```text
Tenant isolation
+
RBAC
+
Minimum necessary context
+
Secret management
+
AI Action Guardrail
+
Audit trail
```

The security rule is:

> **AI may understand broadly enough to personalize, but it may act only within narrowly authorized boundaries.**

Example:

```text
Gemini:
“Reserve one unit at Store A.”

        ↓

Backend policy checks:

Is customer authorized?
Is brand/tenant correct?
Is SKU valid?
Is inventory available?
Is store eligible?
Is reservation permitted?

        ↓

ALLOWED / BLOCKED / HUMAN_APPROVAL_REQUIRED
```

---

# 19. Data boundary

Firestore is the current operational state for Qwikspot.

BigQuery is the historical/event analytics layer.

Looker is the optional BI presentation layer.

Conceptually:

```text
Firestore
= current operational state

BigQuery
= event/outcome history

Looker
= business intelligence
```

The application must not become dependent on Looker for transactional operations.

---

# 20. Testing boundary

The product must be testable as both independent components and one connected journey.

Required testing categories:

```text
Unit
Integration
AI behavior/evaluation
Security
Browser/E2E
Production smoke test
```

Core happy path:

```text
Shopify
 ↓
Customer intent
 ↓
WhatsApp / simulator
 ↓
Gemini
 ↓
Store matching
 ↓
Inventory validation
 ↓
Customer chooses pickup
 ↓
Retailer
 ↓
Completed pickup
 ↓
Brand
 ↓
Analytics
```

---

# 21. M0 approval checklist

Before moving to M1, the team must agree that:

- [ ] Product problem is frozen
- [ ] Target users are frozen
- [ ] Atomic decision is frozen
- [ ] MVP customer journey is frozen
- [ ] Brand console scope is frozen
- [ ] Retailer console scope is frozen
- [ ] WhatsApp-first customer experience is frozen
- [ ] No customer dashboard is part of the MVP
- [ ] Contextual web-page security rules are defined
- [ ] Shopify role is frozen
- [ ] Shopify prototype authentication/onboarding assumption is understood
- [ ] Retail-data role is frozen
- [ ] Retail SKU mapping rule is frozen
- [ ] Retail upload limit is frozen at 10 MB for MVP
- [ ] Customer-intent instrumentation approach is frozen
- [ ] WhatsApp simulator fallback is frozen
- [ ] Gemini role is frozen
- [ ] Deterministic vs AI responsibilities are frozen
- [ ] Node.js + TypeScript backend stack is frozen
- [ ] ADK for TypeScript is frozen as the agent framework
- [ ] Data model is frozen enough to start implementation
- [ ] Integration interfaces are frozen
- [ ] Security boundaries are frozen
- [ ] Looker is clearly optional for the MVP
- [ ] Test strategy is defined
- [ ] No coding agent is allowed to redefine the product during implementation

---

# 22. Four-tool operating rule

## ChatGPT

Product owner, specification reviewer and learning mentor.

## Gemini

Google AI / Google Cloud architecture specialist.

## Claude Code

Primary implementation owner and main codebase maintainer.

## Antigravity

High-value verification, browser testing, integration testing, security attack testing and deployment/judge simulation.

### Critical rule

> **Only Claude Code continuously owns the main implementation.**

Antigravity should not independently rebuild large sections of the product.

---

# 23. Learning-while-building rule

For every major feature:

```text
Learn
  ↓
Explain
  ↓
Plan
  ↓
Implement
  ↓
Run
  ↓
Test
  ↓
Read the code
  ↓
Teach back
  ↓
Verify
```

Target:

> **70% building / 30% learning**

Do not turn the M0 specification into a tutorial syllabus.

The learning happens immediately before the feature that needs it.

Use `09_LEARNING_LOG.md` to record:

```text
What is it?
Why does Qwikspot need it?
How does data flow through it?
Where is it implemented?
What can fail?
What are the security implications?
What do I still not understand?
```

---

# 24. Git/repository M0 boundary

The canonical specification pack should live in the Qwikspot GitHub repository.

Repository structure at M0:

```text
Qwikspot/
│
├── docs/
│   ├── 00_M0_SPECIFICATION_FREEZE.md
│   ├── 01_PRODUCT_SOURCE_OF_TRUTH.md
│   ├── 02_MVP_SPEC.md
│   ├── 03_TECH_ARCHITECTURE.md
│   ├── 04_DATA_MODEL.md
│   ├── 05_AI_AGENT_SPEC.md
│   ├── 06_INTEGRATION_CONTRACTS.md
│   ├── 07_SECURITY_SPEC.md
│   ├── 08_TEST_PLAN.md
│   ├── 09_LEARNING_LOG.md
│   ├── 10_EXECUTION_PLAN.md   (post-M0)
│   └── 11_INTERFACE_CONTRACT.md (post-M0, M2.1)
│
├── frontend/
├── backend/
├── agent/
├── infrastructure/
├── tests/
├── README.md
├── .gitignore
└── .env.example
```

M0 commits should be atomic and understandable. Examples:

```text
docs(product): add Qwikspot product source of truth
docs(mvp): add MVP specification
docs(architecture): freeze Node.js TypeScript architecture
docs(data): define Qwikspot data model
docs(ai): define Gemini ADK agent boundaries
docs(integrations): define Shopify WhatsApp and retail contracts
docs(security): define security specification
docs(test): define test plan
docs(learning): add learn-while-building log

docs(security): define contextual customer page authorization
docs(whatsapp): define prototype simulator fallback
docs(intent): define deterministic prototype intent instrumentation
docs(retail): define retail upload limits and storage flow
docs(analytics): move Looker to optional MVP integration

docs(m0): freeze specification after architecture review
```

Do not create artificial commits for every keystroke. Commit meaningful logical changes.

The M0 endpoint should be marked with a tag such as:

```text
m0-spec-freeze
```

---

# 25. Final M0 gate

M0 is complete only when:

> **A developer who did not participate in the original research could read these files and understand what Qwikspot is, what the MVP does, what it does not do, how AI participates, what external systems are integrated, how security works, and how success will be tested.**

In addition, the team must have completed three read-only architecture checks:

```text
Gemini
→ Google AI / Cloud review

Claude Code
→ repository/specification consistency review

Antigravity
→ architecture verification review
```

These checks do not authorize those tools to redefine the product.

They exist to find contradictions, implementation risks and missing boundaries **before** feature implementation starts.

---

# 26. M0 completion condition

M0 can be marked:

> **M0 — SPECIFICATION FROZEN**

only after all of the following are true:

```text
☑ Canonical specification files committed
☑ Node.js + TypeScript architecture confirmed
☑ Gemini review completed
☑ Claude Code read-only review completed
☑ Antigravity read-only verification completed
☑ Customer task-page token security defined
☑ WhatsApp fallback simulator defined
☑ Deterministic intent instrumentation defined
☑ Retail upload boundary defined
☑ Looker MVP boundary defined
☑ No unresolved architecture contradiction
☑ No secrets committed
☑ Team approves product/MVP boundaries
```

After this gate, implementation may begin from the approved specification rather than from the original research PDFs.

---

# 27. M0 operating principle

> **Freeze the decision, not the implementation.**

The architecture may evolve when implementation produces evidence of a better technical solution, but a change must be explicit, documented, reviewed, and kept consistent with the product source of truth.

The goal is a working real-world prototype—not a perfect architecture diagram.

Qwikspot's product foundation remains:

```text
ONLINE COMMERCE
Shopify
      +
PHYSICAL RETAIL
Retail data
      +
CUSTOMER CONVERSATION
WhatsApp
      +
AI REASONING
Gemini + ADK
      +
OPERATIONAL EXECUTION
Cloud Run + Firestore
      +
BUSINESS INTELLIGENCE
BigQuery + optional Looker
```

And the core loop remains:

> **Digital Intent → Context → AI Decision → Conversational Action → Retail/Online Purchase → Outcome → Brand Intelligence.**
