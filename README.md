# Buildwise

AI-powered omnichannel commerce intelligence for D2C brands.

Buildwise connects:

- Shopify online commerce
- WhatsApp customer conversations
- physical retail inventory
- AI-powered customer intent understanding
- next-best-action reasoning
- retailer fulfillment
- cross-channel business intelligence

## Current Status

M2 — Foundation alignment (local-first)

The specification is in `docs/` (see `docs/10_EXECUTION_PLAN.md` for the milestone plan).
M2 provides the three scoped roles (PLATFORM_ADMIN / BRAND_ADMIN / RETAIL_ADMIN), the provider ports and local
adapters, execution profiles, the conversation-pipeline structure and minimal console
shells. No commerce, conversation or AI features are implemented yet.

## Repository

```text
frontend/        React + TypeScript + Vite: Platform Admin, Brand and Retailer console shells
backend/         Node.js 24 + TypeScript + Express API (domain / application / ports / adapters)
infrastructure/  Firestore rules, Cloud Build config, deploy scripts, GCP setup guide
docs/            Specification (source of truth)
```

## Quick start (local profile — no Google Cloud needed)

Requires Node.js 24 and Java 21+ (for the Firebase emulators). No `.env` files are needed.

```bash
npm install
npm run emulators            # terminal 1: Auth + Firestore emulators (UI: http://127.0.0.1:4000)
npm run seed:demo            # terminal 2: users, catalogue sync and demo CSV import (emulators only)
npm run dev:backend          # terminal 2
npm run dev:frontend         # terminal 3 → http://localhost:5173
```

Demo users (password `buildwise-demo-1`). The MVP has three internal roles and exactly one
operator per scope: one Platform Admin, one Brand Admin per brand (provisioned by the Platform
Admin) and at most one Retail Admin per store (provisioned by the Brand Admin, per store). A
retailer may own many stores, but a Retail Admin operates only its own store — Bandra and Andheri
both belong to North Retail, and each admin sees only its store (no multi-store access, no store
staff). Customers never sign in (they use the WhatsApp customer channel). Powai Store (North
Retail) and Koregaon Park Store (Pune Retail) have no Retail Admin, so the Brand Console's per-store
"Provision Retail Admin" flow can be tried; it shows the local password-setup link to open.

| Email | Role | Lands in |
|---|---|---|
| `platform@buildwise.test` | PLATFORM_ADMIN | `/platform` |
| `admin@demo-brand.test` | BRAND_ADMIN | `/brand` (Demo Beauty Co) |
| `retail-admin-north-1@buildwise.test` | RETAIL_ADMIN | `/retailer`: Bandra Store only (North Retail) |
| `retail-admin-north-2@buildwise.test` | RETAIL_ADMIN | `/retailer`: Andheri Store only (North Retail) |
| `admin@other-brand.test` | BRAND_ADMIN | `/brand` (Other Brand Ltd), for tenant-isolation checks |

Interfaces and what each one shows today: [docs/11_INTERFACE_CONTRACT.md](docs/11_INTERFACE_CONTRACT.md).

### What M3 (catalog & store truth) shows

`seed:demo` syncs the synthetic "Demo Beauty Co" catalogue (10 products, 18 variants) through the
mock commerce provider, then runs the real retail import on
[`backend/fixtures/retail/demo-retail.csv`](backend/fixtures/retail/demo-retail.csv): four stores,
their stock and SKU mappings. That file contains two invalid rows and one unknown SKU on purpose, so
the import report shows real row errors.

- **Brand Console** (`admin@demo-brand.test`): setup checklist, catalog & SKU mapping, "Sync
  catalog", CSV upload with import history and row-error reports, and per-store SKU counts.
- **Retailer Console** (`retail-admin-north-1@buildwise.test`): the read-only stock of Bandra Store
  only (Vitamin C Glow Serum 30 ml: 3 in stock — Andheri has 5 and Powai 0, but this admin never
  sees them).
- Try your own upload: edit a copy of the demo CSV (e.g. change a quantity or add a row with
  `store_hours.monday` = `21:00-10:00`) and import it from the Brand Console.

Uploaded files and import reports are stored under `backend/.data/files` (local profile).

Tests: `npm test` (unit), `npm run test:emulator` (end-to-end on the emulators).
Deployment: see [infrastructure/README.md](infrastructure/README.md).

## Core Loop

Digital Intent
→ Context
→ AI Decision
→ Conversational Action
→ Online / Retail Purchase
→ Outcome
→ Brand Intelligence

## Technology

- React + TypeScript
- Node.js + TypeScript
- Firebase
- Firestore
- Cloud Run
- Google ADK
- Gemini on Vertex AI
- BigQuery
- Looker (optional for the MVP — the Brand Console works without it)
