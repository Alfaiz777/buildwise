# Qwikspot — Learning Log

## Purpose

Qwikspot is being developed as a learning project as well as a working prototype.

The objective is not to memorize tutorials.

The objective is:

> **Understand what was built, why it was built that way, how the data flows, and what can fail.**

---

# Learning loop

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
Inspect code
↓
Teach back
↓
Verify
```

---

# Feature learning template

## Feature

`<name>`

## What I learned

- What is it?
- Why does Qwikspot need it?
- What problem does it solve?
- How does data move through it?

## Architecture

```text
...
```

## Files I changed

```text
...
```

## Important code paths

```text
...
```

## What can fail?

```text
...
```

## Security implications

```text
...
```

## What I still do not understand

```text
...
```

## Teach-back

Explain the feature without opening the AI response.

---

# Five-question self-test

For every major feature, I should be able to answer:

1. What is this technology/component?
2. Why did Qwikspot need it?
3. What data goes into it?
4. What does it return/change?
5. What happens when it fails?

---

# Tool roles while learning

## ChatGPT

- teach concepts before features
- explain architecture
- quiz after implementation
- review product consistency

## Gemini

- explain Google AI/Cloud concepts
- review ADK/Gemini architecture
- explain Google-specific implementation choices

## Claude Code

- pair-program
- implement
- explain important code paths
- run tests
- fix implementation issues

## Antigravity

- inspect the real running product
- perform browser tests
- simulate users
- attack security boundaries
- verify deployment
- produce verification findings

---

# Rule

Do not ask the tools to replace understanding.

Use them to accelerate understanding.

---

# Entries

## M3 — Catalog & store truth

### What I learned

- **Catalogue sync** copies products and variants from the commerce provider (mock locally, Shopify live) into Firestore under `brands/{brand_id}/products` and `productVariants`, plus one SHOPIFY `IntegrationConnection` status document. Qwikspot answers questions from its own copy, never by calling Shopify mid-conversation.
- **Idempotent writes:** every document ID is derived from the source ID (`gid://shopify/Product/1001` → `prd_1001`, inventory `{store_id}__{canonical_sku}`), and writes are `set` on that ID. Running a sync or an import twice updates the same documents instead of creating duplicates.
- **CSV ingestion** is split into three layers: the adapter only decodes the file (BOM, quotes, line numbers); pure domain rules validate every row and report a code per rejected row; the application service writes stores, mappings and stock. Nothing is dropped silently.
- **Timezones:** "open now" is computed in the *store's* IANA timezone with `Intl.DateTimeFormat`, never the server's clock. `Asia/Kolkata` is accepted; `IST` and `+05:30` are rejected even though Node itself would accept them.
- **SKU mapping** links retail SKUs to catalogue variants by SKU first, then barcode, never by product name. Only AUTO_MATCHED rows become stock; unmapped, conflicting or near-match SKUs stay visible for a human.

### Architecture

```text
MockCommerceProvider ─► CommerceSyncService ─► products / productVariants / productMappings(SHOPIFY) / connections
Browser ─PUT file─► LocalFileStorageProvider ─► RetailImportService
        ─► CsvRetailFileParser (format) ─► domain/retailRows (validate) ─► domain/skuMapping (map)
        ─► stores (+ retailer via domain/retailOwnership) / productMappings(RETAIL_FILE) / retailInventory
        ─► row-error report (FileStorageProvider) + retailImports report
domain/storeHours + domain/storeTruth ─► StoreService.findEligibleStores (used by the agent from M5)
```

### Files I changed

```text
backend/src/domain/{storeHours,storeTruth,skuMapping,retailRows}.ts
backend/src/application/{commerceSyncService,retailImportService,catalogService,storeService,accountService}.ts
backend/src/ports/{retailFile,fileStorage,commerce,repositories}.ts
backend/src/adapters/{retail/csvRetailFileParser,firestore/repositories,storage/localFileStorageProvider,commerce/mockCommerceProvider}.ts
backend/src/routes/{catalog,retailImports,localFiles,retail,brandAdmin}.ts, app.ts, composition/container.ts
backend/fixtures/retail/*.csv, backend/scripts/seed-demo.ts
frontend/src/pages/brand/*, frontend/src/pages/retailer/RetailerHome.tsx, frontend/src/api/client.ts
```

### Important code paths

```text
POST /api/integrations/shopify/sync → CommerceSyncService.sync → ProductRepository.upsertCatalog
POST /api/brand/retail-imports → create (upload target) → PUT /api/local-files/uploads/:id → .../process
RetailImportService.run → validateRetailRows → decideStoreAssignment → matchRetailSku → upsertStock
FirestoreInventoryRepository.upsertStock reads reserved_quantity before writing, and never overwrites it
```

### What can fail?

```text
Provider down → connection status ERROR with a normalized last_error; 502 COMMERCE_SYNC_FAILED (retryable)
Missing columns / not a CSV / > 10 MB → the import is FAILED with a failure_code
Bad rows → row errors with line + code; the valid rows still import
Store owned by another retailer → RETAILER_CONFLICT (never moved)
Import before the first sync → every SKU is UNKNOWN_SKU until the catalogue is synced and the file re-imported
Backend restart between "create import" and the upload → the local upload target expires; start again
```

### Security implications

```text
Brand always from the verified principal; imports, catalogue and uploads are BRAND scope only
A local upload for another brand's key is 404; the upload route exists only in the local profile
Retail Admin stock: own store only (another store of the same retailer → 404)
Connections never store credentials; errors are normalized, never raw provider messages
Ingestion never sets retail_admin_user_id and never moves a store between retailers
```

### What I still do not understand

```text
How the real Shopify Admin API paginates and rate-limits a large catalogue (phase L2).
How Cloud Storage signed-URL uploads will replace the local upload endpoint (phase L1).
```

### Teach-back

Clicking "Sync catalog" asks the wired commerce provider for its products and variants, turns each into a Qwikspot document with an ID derived from the source ID, and writes them to Firestore, so syncing twice changes nothing. Uploading a CSV first stores the file, then processing it reads every row, checks it against the retail schema (hours in the store's own timezone, non-negative whole quantities, valid prices, consistent store details), maps each SKU to a catalogue variant, and writes stores and stock. It keeps any units already reserved, and gives back a report that lists every row it rejected and why.

### Five-question self-test

| | Firestore writes & idempotency | CSV ingestion | Timezones / open now | SKU mapping |
|---|---|---|---|---|
| 1. What is it? | Deterministic document IDs + `set`/batched writes | Upload → parse → validate → normalize → map → write | Store hours evaluated in the store's IANA timezone | Retail SKU ↔ canonical SKU ↔ Shopify variant |
| 2. Why needed? | Re-syncs and re-imports must never duplicate or corrupt data | Physical-store stock arrives as brand files | Customers must never be sent to a closed store | Retail and online systems name products differently |
| 3. What goes in? | Normalized records from the provider or the file | A ≤ 10 MB CSV in the canonical schema | `store_hours` + the current instant | Normalized retail SKU + catalogue variants |
| 4. What changes? | products, productVariants, productMappings, stores, retailInventory, connections, retailImports | stores, stock, mappings, an import report | Nothing; it returns open / closed | A mapping record; only AUTO_MATCHED rows become stock |
| 5. When it fails? | A failed batch leaves earlier chunks written; re-running the same sync/import converges | FAILED import or row errors; valid rows still import | Invalid hours count as closed | The row is rejected and the mapping stays visible for review |

## M4 — Intent → follow-up → conversation

### What I learned

- **Public endpoints and origin checks:** `POST /api/intents` has no login, so it defends itself differently: a strict body (any unexpected field, e.g. a phone number, is rejected), an origin allowlist per brand, per-IP and per-brand rate limits, and deterministic idempotency keys. CORS headers are only echoed for allowed origins.
- **Idempotency:** the same event or message can arrive twice. Storefront events carry `client_event_id` (remembered on the intent, so a replay is not applied twice); simulator/WhatsApp messages get a `webhookReceipts` document created _if absent_, and a duplicate returns the stored original result without running any stage.
- **Tokens and hashing:** the "Need it today?" link carries `START_QWIKSPOT_<token>`: 128 random bits in Crockford Base32. Only the SHA-256 hash is stored, so a database leak reveals no usable token; it is single-use, expires in 30 minutes, is bound to the brand, and is stripped from the message before storage.
- **Pipeline stages:** one fixed order for every channel — idempotency → identity → handshake → conversation state → policy → agent → guardrail → tools → persistence → outbound → outcome. M4 fills 1–5 and 9–11; 6–8 are the deterministic fallback / pass-through, so M5 plugs in without reordering.
- **Deterministic classification:** the funnel stage only moves forward (visit → search → product → consideration → cart → checkout); the type follows the stage unless "Need it today?" makes it store-oriented; strength is derived, never guessed.
- **Scheduling without a scheduler:** each intent stores its own `follow_up` (`due_at`, status). A "process due" run marks idle sessions abandoned, then claims each due follow-up in a transaction (so two runs never send twice), re-checks the policy at send time, and sends or suppresses with a reason. Locally a button / 30 s poll triggers it; in gcp Cloud Scheduler will call the same endpoint.
- **The WhatsApp window and templates:** a business may message first only a known, opted-in customer; inside 24 h of the customer's last message it can send free text (session message), otherwise only a pre-approved template with parameters. Qwikspot picks the kind from `last_inbound_at` and the simulator labels it honestly.

### Architecture

```text
Storefront (snippet) ─POST /api/intents─► IntentService ─► customerIntents (stage/type/strength)
                                                  │                 ├─► commerceEvents + EventSink
                                                  └─► FollowUpService.evaluate ─► follow_up {SCHEDULED | NOT_ELIGIBLE + reason}
Brand Console "Run due follow-ups" ─► FollowUpService.processDue ─► claim → re-check policy
        ─► sendAndPersist (shared OUTBOUND) ─► PROACTIVE_FOLLOW_UP message (SESSION | TEMPLATE)
Simulator ─► ConversationPipeline (1–11) ─► reply / handoff / opt-out ─► OUTCOME marks follow_up
Demo "Place order" ─► OrderService.recordOrder ─► ORDER_CREATED + intent CONVERTED (same path as the L2 webhook)
```

### Files I changed

```text
backend/src/domain/{intentClassification,intentToken,conversationPolicy,fallbackDecision,followUpPolicy,followUpMessages,brandSettings}.ts
backend/src/application/{intentService,followUpService,orderService,simulatorService,conversationQueryService,demoStorefrontService,eventRecorder,conversationModule}.ts
backend/src/application/conversation/{stages,outbound,pipeline}.ts
backend/src/ports/conversationRepositories.ts, adapters/firestore/conversationRepositories.ts
backend/src/routes/{intents,conversations,demoStorefront}.ts
frontend/public/qwikspot-intent.js, frontend/src/pages/brand/{ConversationsPage,SimulatorPhone,IntentPanel}.tsx, pages/demo/DemoStorePage.tsx
```

### Important code paths

```text
IntentService.recordEvent → applyWebEvent (pure) → intents.update (transaction) → EventRecorder → FollowUpService.evaluate
buildConversationPipeline: HANDSHAKE → tokens.consumeAndBind (one transaction: consume token + bind intent)
FollowUpService.processDue → listIdleActive → ABANDONED; listDueFollowUps → claim (claimed_at) → evaluateFollowUp → sendAndPersist
```

### What can fail?

```text
Origin not allowed / PII in the body / unknown variant → 403 / 400 / 404; nothing is recorded
Duplicate delivery → the original result is returned; no stage runs twice
Invalid, expired, reused or other-brand token → the chat continues without context; audited, the customer is not told
Converted / opted out / handed off / started chatting before due → SUPPRESSED with the reason
Process restarts between claim and send → that follow-up stays claimed (never sent twice)
Event export to the sink fails → logged; the request still succeeds
```

### Security implications

```text
Anonymous visitors are never messaged; a visitor becomes a known customer only via the handshake or a signed-in shopper
No PII in URLs, events or stored text; tokens stored as hashes and stripped from messages; the prefill travels in the URL fragment
Brand scope from the verified principal; another brand's conversations and intents are 404
Demo storefront / shopper / order endpoints exist only in the local profile
```

### What I still do not understand

```text
Meta template approval and categories (utility vs marketing) — L2.
Cloud Scheduler with OIDC calling process-due — L-phase.
```

### Teach-back

A click on the storefront becomes an event; the event moves the session's intent forward (never backwards) and decides whether a follow-up is allowed and when it will be due — or records exactly why not. Nothing is sent until the due follow-ups are run after that time; then the rule is checked again, and a short, personalised, opt-out-able message from the brand goes out through the same outbound path as every reply. When the customer answers, the one conversation pipeline handles it: STOP opts them out, asking for a person hands over, anything else gets a safe reply about the product.

### Five-question self-test

| | Public endpoint + origin | Idempotency | Tokens + hashing | Pipeline stages | Deterministic classification | Scheduling without a scheduler | WhatsApp window + templates |
|---|---|---|---|---|---|---|---|
| 1. What is it? | An unauthenticated API guarded by an allowlist, a strict body and rate limits | "Same input twice → same effect once" | A random one-time code carried in the WhatsApp text | A fixed sequence of steps for every message | Rules mapping events to stage / type / strength | Due work stored as data + an explicit "process due" run | Rules for when a business may message, and how |
| 2. Why needed? | Storefronts post events without a login | Networks and webhooks retry | To connect anonymous web intent to a chat safely | One behaviour for simulator and WhatsApp | The AI must not invent behavioural facts | No external scheduler in the local phase | WhatsApp policy and customer consent |
| 3. What goes in? | brand, session / visitor IDs, event type, variant | client_event_id / client_message_id | 16 random bytes → 26 characters | a channel-neutral inbound message | the storefront events of one session | intents with `follow_up.due_at` | `last_inbound_at`, consent |
| 4. What changes? | commerceEvents, customerIntents, intentTokens | receipts / processed IDs | the token hash and the intent binding | customers, conversations, messages, recommendations, events | the intent's stage, type, strength | follow_up status, messages, `last_proactive_at` | the message kind (SESSION / TEMPLATE) |
| 5. When it fails? | 403 / 400 / 429; nothing recorded | the stored result is returned | silent failure + audit | a FAILED receipt can be retried | invalid events are rejected before classification | claimed follow-ups are never re-sent | outside the window only a template; no consent → nothing sent |

## M5 — Decide & reserve

### What I learned

- **Agent loop and tool calling:** the runtime gets a small, backend-built context package and a list of tool declarations (JSON Schema). It asks for tools; the backend runs them and returns verified data; the runtime then returns one structured decision. It never writes anything itself and never chooses the brand or customer — those are injected by the pipeline.
- **Guardrail re-verification:** a decision is only a proposal. Before anything is written, the pipeline re-reads the store, the stock, the brand policy and the pending offer (fresh, not from the agent's context) and blocks with one reason: out of stock, store closed, not eligible, outside scope, or ambiguous (then the agent asks first).
- **Transactions and races:** a reservation reads and writes the same inventory document inside one Firestore transaction, so two customers racing for the last unit are serialised: the loser's transaction retries, sees the new `reserved_quantity` and gets a verified `OUT_OF_STOCK`. Tested with 10 concurrent requests → exactly one success.
- **Idempotency:** the reservation ID is derived from its idempotency key (the recommendation ID), so a replay returns the same reservation; a replayed simulator message returns the stored original response and runs nothing twice.
- **Structured output validation:** every decision is validated against one schema; invalid output gets one repair attempt, then the deterministic fallback; a runtime slower than the 20 s budget also falls back. The runtime name is set by the implementation and checked, so a mock can never pose as Gemini.
- **Forward dispatch:** the customer's reply for store options, confirmations, "no store has it" and blocks is rebuilt from this run's tool results (distance, closing time, "only 1 left" only when exactly one is available, pickup code, maps link from the store's own coordinates) — never from free text.

### Architecture

```text
Simulator ─► ConversationPipeline
  4 CONVERSATION_STATE  shared location → customer.last_location (rounded ~1 km)
  6 AGENT      buildAgentContext (brand, customer, intent, product sheets, last 10 messages, pending offer)
               → runAgentRuntime(MockAgentRuntime, read tools via AgentToolExecutor, 20 s budget, 1 repair) → AgentDecision
               (failure → deterministic fallback: handoff when enabled, else "try again")
  7 GUARDRAIL  fresh store / stock / policy / pending_proposal → ALLOWED | BLOCKED(reason) + audit
  8 TOOLS      create_reservation → ReservationService → Firestore transaction (stock, policy, pickup code, reserved += q)
               cancel_reservation · request_human_handoff · record_customer_intent
               → composeReply (verified results only)
  9 PERSISTENCE  AIRecommendation + trace, pending_proposal, STORE_RECOMMENDATION (PROPOSED / UNMET_DEMAND), events
process-due ─► FollowUpService.processDue ─► ReservationService.expireDue (each hold released in its own transaction)
```

### Files I changed

```text
backend/src/domain/{agentTools,agentReplies,guardrail,locality,mockAgentRules,reservationStatus,unmetDemand,fallbackDecision,storeHours,brandSettings}.ts
backend/src/ports/{agent,agentTools,reservations,conversationRepositories}.ts
backend/src/application/agent/{contextBuilder,toolExecutor,tools,replyComposer}.ts
backend/src/application/{reservationService,conversationModule,conversationQueryService,followUpService,simulatorService}.ts
backend/src/application/conversation/{stages,agentStage,pipeline}.ts   (toolRegistry.ts removed)
backend/src/adapters/agent/mockAgentRuntime.ts, adapters/firestore/{reservationRepository,conversationRepositories}.ts
backend/src/routes/{reservations,conversations}.ts, backend/fixtures/retail/scenario-stores.csv
frontend/src/pages/brand/{DecisionTrace,ReservationsPanel,ConversationsPage,SimulatorPhone}.tsx, pages/retailer/RetailerHome.tsx
```

### Important code paths

```text
stages.ts AGENT → buildAgentContext → runAgentRuntime → MockAgentRuntime.decide → AgentToolExecutor.execute (exists → scope → input → allowed)
stages.ts GUARDRAIL → checkReservationProposal / checkCancelProposal / checkOfferedStores (pure, fresh data)
stages.ts TOOLS → create_reservation → ReservationService.create → FirestoreReservationRepository.create (one transaction)
replyComposer.composeReply → confirmationReply / discoveryReply / noEligibleStoreReply / safeAlternative
```

### What can fail?

```text
Runtime timeout / invalid output twice → deterministic fallback (recorded with decision_source DETERMINISTIC_FALLBACK)
Agent passes a customer or brand ID → the tool call is BLOCKED (SCOPE_VIOLATION) and audited
Stock changed since the offer → guardrail OUT_OF_STOCK, or the transaction rejects (lost race) → another store / online
"Reserve it" with nothing offered, or the offer expired → nothing is written; the agent asks
Firestore contention → the SDK retries the transaction; the emulator is slower than production (re-run in L3)
A crash between reservation commit and reply → the hold exists and expires on schedule; a message replay returns the same reservation
```

### Security implications

```text
Scope comes from the pipeline's resolved customer, never from agent arguments; writes never run during the decide step
The context package holds only this customer's data; the trace stores a hash and a PII-free summary
Retail Admins see reservations of their own store only, with a masked customer reference
No coordinates in unmet-demand events; customer locations kept at ~1 km
```

### What I still do not understand

```text
How ADK for TypeScript exposes tool calls and structured output with Vertex AI (spike S3, L1).
How strongly Firestore serialises contended transactions in production (L3 re-run of the race test).
```

### Teach-back

A customer's message is first turned into a small, checked context: who they are, what they looked at, what we already offered. The agent then asks for tools — "which stores near this customer have it open and in stock?" — and gets real answers with reasons for every excluded store, and returns one structured decision. That decision is only a proposal: the guardrail re-reads stock, hours and policy fresh and either lets it through or blocks it with a reason. An approved hold runs in a single Firestore transaction that re-checks the stock and reserves the unit, so two people can never get the last one. Finally the reply is written from those verified results — store, distance, pickup code, hold time, maps link — and the whole path is shown to the brand as "Why Qwikspot did this".

### Five-question self-test

| | Agent loop + tool calling | Guardrail re-verification | Transactions + races | Idempotency | Structured output validation | Forward dispatch |
|---|---|---|---|---|---|---|
| 1. What is it? | Context → tool requests → verified results → one decision | A fresh check of a proposed action before any write | Read-check-write as one atomic unit | Same request twice → same effect once | Checking the AI's decision against one schema | Replies built only from this run's tool results |
| 2. Why needed? | The AI must reason over real data, not guesses | Data changes between proposal and execution | Two customers can race for the last unit | Retries and double taps | A model can return malformed or unsafe output | So no reply states an unverified fact |
| 3. What goes in? | Context package + read tool declarations | The proposal + fresh store, stock, policy, pending offer | store, stock, policy, quantity, idempotency key | recommendation ID / client_message_id | The runtime's raw output | Tool outputs (stores, reservation) |
| 4. What changes? | Nothing (reads only); the trace records calls | guardrail_status + audit | reservation doc + reserved_quantity | nothing on replay | nothing; the decision is accepted or replaced | the outbound message text and options |
| 5. When it fails? | Timeout / invalid → deterministic fallback | BLOCKED with a reason; a safe alternative is offered | The loser gets OUT_OF_STOCK; nothing is written | The stored result / existing reservation is returned | One repair, then the fallback | The runtime's own text is used only for non-commerce replies |

## M6 — Store fulfilment & outcomes

### What I learned

- **State machines and optimistic concurrency:** a reservation may only move along the §15 table, and only the store's own Retail Admin moves it. Every change carries `expected_current_status`; the transaction re-reads the document and refuses with `STALE_STATUS` if someone else got there first, or `INVALID_TRANSITION` if the move is not in the table — so two staff members can never both "complete" the same hold.
- **Transactional inventory:** the status change and its stock effect (release on cancel/expiry, quantity and reserved both −1 on completion, quantity = reserved after a "not actually in stock" refusal) are written in one Firestore transaction, always with 0 ≤ reserved ≤ quantity.
- **Attribution vs evidence:** a `qs_ref` on a "Buy online" link only links an order to a conversation; it never proves a purchase. The evidence is the order from the commerce source (locally the demo order call, in L2 the Shopify webhook) or a reservation the store completed with the customer's pickup code.
- **Idempotent outcome recording:** one Outcome per engaged journey, with an ID derived from the journey; it is created only if absent, so the first verified purchase wins and replays or later purchases add nothing (they keep their own events). NONE is decided only by the process-due sweep, after the attribution window counted from the journey's last activity — never at the moment a hold expires.
- **Time zones in analytics:** "Saturday" means Saturday in the store's timezone: an event at 20:00 UTC on Friday is a Saturday lookup in Mumbai. Every weekday split converts each timestamp with the store's IANA zone.
- **Synthetic data that stays honest:** the demo history is generated deterministically (fixed seed) by the same domain functions as live traffic, every document is flagged `demo_history: true`, the Outcomes screen says so and can exclude it, and live actions are never flagged.

### Architecture

```text
Retailer Console ─PATCH /api/reservations/:id─► FulfilmentService.transition
   └─ ReservationService.retailerTransition → repo.transition(decideRetailerTransition) [one transaction: status + stock]
   └─ notify(): message built from verified facts → sendAndPersist (RESERVATION_UPDATE; SESSION | TEMPLATE; not if opted out)
        refused → find_nearby_stores (skip the refusing store) → pending_proposal → the customer's tap → M5 guardrail path
   └─ COMPLETED → OutcomeService.recordFromReservation (OFFLINE | ALTERNATIVE)
Pipeline reply with an online link → AttributionService.decorate (qs_ref, hash stored)
Demo / Shopify order ─► OrderService.recordOrder(qs_ref) → OutcomeService.recordFromOrder (ONLINE | ALTERNATIVE)
process-due ─► expire holds (+ notice) → OutcomeService.closeExpiredJourneys (NONE after the window)
Brand Console ─► HandoffService (reply as a person / resolve) · InsightsService ← InsightsReader (Firestore; BigQuery in L2)
```

### Files I changed

```text
backend/src/domain/{reservationStatus,reservationMessages,outcomeRules,attributionRef,insights,unmetDemand,mockAgentRules,agentReplies}.ts
backend/src/application/{fulfilmentService,outcomeService,attributionService,handoffService,insightsService,demoHistory,reservationService,orderService,followUpService,conversationModule}.ts
backend/src/ports/{reservations,outcomes,insights,conversationRepositories}.ts
backend/src/adapters/firestore/{reservationRepository,outcomeRepository,insightsReader,conversationRepositories}.ts
backend/src/routes/{reservations,retail,conversations,insights,demoStorefront}.ts, backend/scripts/{seed-demo,demoHistory}.ts
frontend/src/pages/retailer/{RetailerHome,RetailerQueue}.tsx, pages/brand/{OutcomesPage,HandoffPanel,ConversationsPage,SimulatorPhone}.tsx, public/qwikspot-intent.js
```

### Important code paths

```text
decideRetailerTransition (stale → table → reason / pickup code) → applyInventoryPlan, inside FirestoreReservationRepository.transition
FulfilmentService.notify → messageKindFor → sendAndPersist; reoffer → find_nearby_stores(skip) → discoveryReply | noEligibleStoreReply + UNMET_DEMAND
OutcomeService.write → outcomes.createIfAbsent (first wins) → OUTCOME_RECORDED + audit
InsightsService.panels → funnel / conversionByAction / unmetDemand / weekdayPanel + weekdayReading / fillRate / suggestions
```

### What can fail?

```text
Two staff act on the same hold → the second gets 409 STALE_STATUS; nothing changes twice
Wrong pickup code → 422, audited, attempts +1; 5 wrong codes lock completion (refusal still possible)
Customer opted out → no message; the store sees "customer opted out; not notified"
No location / no eligible store after a refusal → the online link or a verified alternative, plus UNMET_DEMAND
Invalid or expired qs_ref → the order is recorded unattributed (never fails)
An order and a completed pickup in one journey → the first is the Outcome; the second stays an event
```

### Security implications

```text
PATCH: RETAIL_ADMIN of the reservation's own store only (another store of the same retailer → 404; brand / platform → 403)
Retail screens show masked customer references only; a refusal note never reaches the customer
qs_ref is random, only its hash is stored, it expires with the attribution window and carries no PII
Human replies: the admin's uid only in the audit log; opt-out and the 24 h window still apply
Insights are brand-scoped; synthetic history is labelled and excludable
```

### What I still do not understand

```text
How Shopify cart attributes survive every checkout path (L2), and how often customers buy on another device.
How Meta categorises these store updates (utility templates) and their approval timing (L2).
```

### Teach-back

A customer holds a product; the store sees it at the top of its queue and confirms, prepares and — when the customer shows their code — completes it, each step changing the reservation and its stock in one safe transaction. Every step sends the customer a short, factual update; if the store has to refuse, the customer is offered the next store that really has it, with one tap. When a purchase is verified — a pickup completed with the code, or an online order that arrived through the conversation's link — Qwikspot records one outcome for that journey; if nothing is bought in time, it records "none". Those outcomes, lookups and refusals become the brand's Outcomes screen, which shows, from counted records only, whether a weekday problem is demand or availability and what to do about it.

### Five-question self-test

| | State machine + optimistic concurrency | Transactional inventory | Attribution vs evidence | Idempotent outcomes | Time zones in analytics | Honest synthetic data |
|---|---|---|---|---|---|---|
| 1. What is it? | An allowed-moves table plus "only if it is still in the status I saw" | Status and stock changed together, all or nothing | A link (qs_ref) vs proof (an order / completed pickup) | One outcome per journey, created only if absent | Converting each timestamp to the store's local day | Generated, flagged, excludable demo data |
| 2. Why needed? | Staff and expiry act concurrently | Stock must never be wrong or negative | A click is not a sale | Webhooks and sweeps repeat | A UTC day is not the store's day | Demos need a past; reports must not lie |
| 3. What goes in? | status + expected_current_status (+ code / reason) | the plan (reserved −q, quantity −q, correction) | the ref from the landing URL; the verified order | journey key + verified evidence | ISO timestamp + IANA timezone | a fixed seed + the live domain functions |
| 4. What changes? | the reservation's status and timestamps | retailInventory quantity / reserved | the order's journey link and its Outcome | outcomes + OUTCOME_RECORDED | which weekday bucket an event counts in | documents marked demo_history: true |
| 5. When it fails? | 409 STALE_STATUS / INVALID_TRANSITION | the transaction aborts; nothing is written | the order is recorded unattributed | the second write is a no-op | wrong buckets if the zone is ignored (tested) | the toggle removes it from every panel |

## M7 — Local E2E, hardening and judge-ready

### What I learned

- **An end-to-end test is a contract with the whole product:** the full-journey test drives the platform, brand, store and customer only through the HTTP API on the emulators, so it fails if any layer — auth chain, pipeline, transactions, notifications, outcomes, insights — breaks the journey, not just one unit.
- **Runtime-agnostic contract suites:** the AI scenarios assert only structured output (action, guardrail status, persisted records, "never" conditions) and take any `AgentRuntime`, so the same suite judges `MockAgentRuntime` now and Gemini in L1 — with a pass rule that tolerates model variance on helpful scenarios (≥ 4/5) but none on safety scenarios (5/5).
- **Fail gracefully, and say what to do next:** a database outage becomes a retryable `503` with a plain sentence, never a stack trace; a failed send is retried with the same request ID and then shown as "Not delivered"; stale store stock is never claimed as fresh — the reply names when it was last updated.
- **Prove security rules with tests that enumerate the code:** the audit-completeness test scans `src/routes` for every mutating route, so a new route without an audit entry fails the build; the index test does the same for multi-field Firestore queries; the log test captures every line of a full journey and searches it for PII.
- **Demo mode without weakening security:** demo users are ordinary users with ordinary scopes; the logins come from configuration at runtime (never the bundle); Reset demo is allowlisted per brand, audited, rate-limited and provably cannot touch another brand.
- **Configuration as a contract:** the gcp profile validates every required setting together and names the missing ones — never their values — so L1 is configuration plus adapters, not code changes.

### Architecture

```text
Judge / demo:check ──HTTP──► routes ── auth (token → principal → scope) ──► services ──► ports ──► adapters
                                                       │
         DEMO_MODE: GET /api/demo/config (public)      ├─ POST /api/brand/demo/reset → DemoResetService
                                                       │     wipe (DemoDataStore) → demo settings → CommerceSyncService
                                                       │     → RetailImportService (judge fixture via FixtureSource)
                                                       │     → generateDemoHistory → DemoDataStore.writeHistory → audit DEMO_RESET
seed:demo / seed:live ─────────────────────────────────┘     (the same rebuild())
Outbound: sendWithRetry (250 ms, 1 s; same outboundRequestId) → FAILED → "Not delivered"
Errors:   gRPC 14 / 4 → 503 SERVICE_UNAVAILABLE (no stack in any response)
```

### Files I changed

```text
backend/test/emulator/full-journey.emulator.test.ts, demo-reset.emulator.test.ts   the journey and Reset on the emulators
backend/test/contracts/agentScenarioSuite.ts, adapterContracts.ts                   runtime-agnostic suites
backend/test/{failurePaths,securityHardening,logHygiene,auditCompleteness,secretsScan,indexCompleteness,seedLive,demoReset}.test.ts
backend/src/application/demoResetService.ts, demoSetup.ts; ports/demoData.ts; adapters/firestore/demoDataStore.ts; adapters/fixtures/
backend/src/routes/demo.ts, health.ts, platform.ts; middleware/errorHandler.ts; config/env.ts (DEMO_*, gcp contract)
backend/src/application/conversation/outbound.ts (retries), simulatorService.ts (replay waits), agent/tools.ts + domain/agentReplies.ts (stale stock)
backend/scripts/demoCheck.ts, seed-live.ts, seedLiveGuard.ts; scripts/secrets-scan.mjs; fixtures/retail/demo-judge-retail.csv
frontend: LoginPage (demo panel), DemoGuide, PlatformHome (onboarding, suspend with reason), SimulatorPhone (judge ref, presets, Not delivered), RetailerHome (stale), lib/labels.ts, components/States.tsx, per-tab sessions
docs: 00 (Change 14), 03 (diagram, scaling), 04, 06 (§14.10), 07 (§17), 08 (§13, §15a), 10, 11, 12 (runbook)
```

### Important code paths

```text
POST /api/brand/demo/reset → brandDemoRouter → DemoResetService.reset (404 off / 403 not allowlisted / 429) → rebuild()
GET  /api/platform/brands  → PlatformAdminService.overview → counts per brand + AuditRepository.latestBrandEventAt
sendAndPersist → sendWithRetry → MESSAGE_SENT { delivery_status }
errorHandler → fromInfrastructure → 503 | 500 envelope (stack only in local server logs)
```

### What can fail?

```text
Reset while judges are mid-journey → their conversations disappear (the dialog says so); stock and history come back
Two resets at once → the 1/min limiter refuses the second
A store's stock file is old → "stale" in the console and a dated qualifier in the reply; the guardrail still re-checks numbers
Database unreachable → 503 with a retry hint; nothing is half-written
A deploy without a required setting → the service refuses to start and names the setting
```

### Security implications

```text
DEMO_MODE never widens a role: Retail / Platform Admins cannot reset; only an allowlisted demo brand can be reset
Demo passwords: runtime config only; secrets:scan fails if one reaches frontend/dist; seed:live refuses the repo's local password
Logs: no emails, phones, names, tokens, pickup codes, qs_ref values or message text (tested over a full journey)
Every mutating route audited (static scan); platform views carry counts only, never customer data
Per-tab sessions: closing a tab signs it out
```

### What I still do not understand

```text
How Gemini's variance will actually land on scenarios 1–7 (L1 runs the suite with runs = 5).
The right Cloud Scheduler → internal process-due design across many brands (L1).
```

### Teach-back

Before a stranger sees Qwikspot, everything they can do must already have been done by a test. M7 runs the whole story — a platform admin creating a brand, the brand setting up its stores, a customer asking for a product today, a store handing it over with a pickup code, and the brand seeing the sale — through the real API, and checks that every failure along the way ends in a clear next step rather than an error page. It proves the security rules by enumerating the code (every route audited, every query indexed, every log line clean) and gives judges a safe shared demo: their own customer per tab, plenty of stock, short holds, and a reset that can only ever touch the demo brand.

### Five-question self-test

| | End-to-end journey test | Runtime-agnostic contract suite | Graceful failure | Enumerating tests (audit / index / logs) | Safe shared demo |
|---|---|---|---|---|---|
| 1. What is it? | One test that drives every role through the HTTP API on the emulators | One scenario set that takes any `AgentRuntime` | Every failure ends in a retryable status and a plain next step | Tests that list the code's routes / queries / log lines and check each | DEMO_MODE logins, judge refs, headroom stock, short holds, Reset |
| 2. Why needed? | Units can all pass while the journey breaks | The mock and Gemini must meet the same bar | Errors happen; stack traces and silence lose users | A new route or query must not slip through unchecked | Many judges, one demo, no cross-talk or dead stock |
| 3. What goes in? | Synthetic users, a CSV, storefront clicks, chat messages | A runtime factory and a run count | The infrastructure error (gRPC code, 5xx, stale timestamp) | The source tree, the index file, a captured logger | Config (`DEMO_*`), the judge fixture, the allowlist |
| 4. What changes? | Nothing outside the emulators | Nothing; it only observes records | The response (503 / FAILED / qualifier), never half-written data | Nothing; it fails the build | Only the allowlisted demo brand's data, audited |
| 5. When it fails? | The broken step names itself (✘ in `demo:check`) | A scenario reports passes x/n and the run details | The person is told to try again; logs keep the detail | The missing entry is named in the failure | 404 off, 403 other brand/role, 429 too soon |
