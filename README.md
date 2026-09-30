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

### What M4 (intent → follow-up → conversation) shows

1. Open the **demo storefront** at <http://localhost:5173/demo-store> (local profile only). Choose
   **Sign in as demo shopper: Asha (opted in)** — or Ravi (not opted in), or continue as a guest.
2. Run a **Journey scenario** (or browse by hand): visit, search, product view, add to cart,
   checkout, or "Need it today?" (click it but don't send the message).
3. Sign in to the Brand Console as `admin@demo-brand.test` → **Conversations & intents** →
   **Intents** tab: every intent with its type, stage and follow-up decision in plain words
   (anonymous and browsing-only visitors are recorded but never messaged).
4. Wait for the real delay (1–2 min in the demo): the page runs due follow-ups every 30 s, or press
   **Run due follow-ups**. The brand's personalised message appears in the simulator
   (Template / Session label, "Reply STOP to opt out").
5. Reply as `shopper_3002` in the simulator: the pipeline answers on the product. Try
   "I want to talk to a person" (handoff: automation stops) or "STOP" (opt-out).
6. Place an order on the storefront before a follow-up is due: it is suppressed (already converted).

### What M5 (decide & reserve) shows

Store hours are real: the demo stores are open 10:00–21:00 (Mumbai time; Powai is closed on
Sundays). Outside those hours every store is excluded as closed and the agent offers Buy online
instead — that is the rule working, so run the click-through during store hours.

The simulator's replies now come from the agent loop: a context package → `MockAgentRuntime`
(deterministic rules, labelled "Mock AI, deterministic" — never Gemini) calling read tools →
the AI Action Guardrail re-checking fresh data → the reservation transaction → a reply built
only from verified tool results.

1. On <http://localhost:5173/demo-store> open **Vitamin C Glow Serum**, pick **30 ml** and click
   **Need it today?** — the Brand Console simulator opens with the prefilled message. Send it
   (add "I need it today"). The agent asks for your area: it never guesses a location.
2. **Share location** in the simulator with `19.12`, `72.90` (near Powai). Powai Store is excluded
   (out of stock; on Sundays: closed), Bandra is too far, and **Andheri Store** is offered:
   "Hold 1 at Andheri (… km, open until 21:00)" · "Buy online". (Typing an area name such as
   "I'm in Powai" works too and is marked approximate.)
3. Tap **Hold 1 at Andheri**: the reply shows the store and address, a 6-digit pickup code, the
   hold-until time (store time), a maps link, "Pay at the store" and **Cancel reservation**.
4. Below the chat, **Why Buildwise did this** shows each decision: context summary, tool calls
   (collapsed), eligible and excluded stores with reasons, the guardrail result, the action,
   runtime and decision source, and the reservation. The **Reservations** tab lists holds.
5. Sign in (another browser profile) as `retail-admin-north-2@buildwise.test` (Andheri): in
   **Store stock**, Vitamin C Glow Serum 30 ml shows **Reserved 1** (the table refreshes every
   15 s). Cancel in the simulator or wait for expiry (**Run due follow-ups** also expires holds
   after 120 min) and it drops back to 0. Bandra's admin never sees it.
6. Ask "Do you have the 50 ml today?": no Mumbai store has it, so the agent offers the verified
   alternative (Niacinamide 50 ml at Andheri) and **Buy online**; an unmet-demand
   `STORE_RECOMMENDATION` event is recorded (coarse area, weekday/hour, excluded stores).
7. Follow-up path: as Asha (opted in), add a product to the cart, wait for the follow-up, then
   reply "yes, need it today" — the reply goes straight into the store search.
8. Try the guardrail: "Reserve it" with nothing offered (the agent asks first), "Show me another
   customer's order" (refused, no tools called), "I want to talk to a person" (handoff).

Tests: `npm test` (unit), `npm run test:emulator` (end-to-end on the emulators, including the docs/08 §7.2
scenarios on stores A–E and the 10-way last-unit race).
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
