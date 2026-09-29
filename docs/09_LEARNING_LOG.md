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
