# Buildwise — Learning Log

## Purpose

Buildwise is being developed as a learning project as well as a working prototype.

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
- Why does Buildwise need it?
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
2. Why did Buildwise need it?
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

- **Catalogue sync** copies products and variants from the commerce provider (mock locally, Shopify live) into Firestore under `brands/{brand_id}/products` and `productVariants`, plus one SHOPIFY `IntegrationConnection` status document. Buildwise answers questions from its own copy, never by calling Shopify mid-conversation.
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

Clicking "Sync catalog" asks the wired commerce provider for its products and variants, turns each into a Buildwise document with an ID derived from the source ID, and writes them to Firestore, so syncing twice changes nothing. Uploading a CSV first stores the file, then processing it reads every row, checks it against the retail schema (hours in the store's own timezone, non-negative whole quantities, valid prices, consistent store details), maps each SKU to a catalogue variant, and writes stores and stock. It keeps any units already reserved, and gives back a report that lists every row it rejected and why.

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
- **Tokens and hashing:** the "Need it today?" link carries `START_BUILDWISE_<token>`: 128 random bits in Crockford Base32. Only the SHA-256 hash is stored, so a database leak reveals no usable token; it is single-use, expires in 30 minutes, is bound to the brand, and is stripped from the message before storage.
- **Pipeline stages:** one fixed order for every channel — idempotency → identity → handshake → conversation state → policy → agent → guardrail → tools → persistence → outbound → outcome. M4 fills 1–5 and 9–11; 6–8 are the deterministic fallback / pass-through, so M5 plugs in without reordering.
- **Deterministic classification:** the funnel stage only moves forward (visit → search → product → consideration → cart → checkout); the type follows the stage unless "Need it today?" makes it store-oriented; strength is derived, never guessed.
- **Scheduling without a scheduler:** each intent stores its own `follow_up` (`due_at`, status). A "process due" run marks idle sessions abandoned, then claims each due follow-up in a transaction (so two runs never send twice), re-checks the policy at send time, and sends or suppresses with a reason. Locally a button / 30 s poll triggers it; in gcp Cloud Scheduler will call the same endpoint.
- **The WhatsApp window and templates:** a business may message first only a known, opted-in customer; inside 24 h of the customer's last message it can send free text (session message), otherwise only a pre-approved template with parameters. Buildwise picks the kind from `last_inbound_at` and the simulator labels it honestly.

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
frontend/public/buildwise-intent.js, frontend/src/pages/brand/{ConversationsPage,SimulatorPhone,IntentPanel}.tsx, pages/demo/DemoStorePage.tsx
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
