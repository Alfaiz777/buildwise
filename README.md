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

M1 — Repository + GCP Foundation

The M0 specification is frozen (`docs/`, tag `m0-spec-freeze`).
M1 provides the authenticated React → Cloud Run → Firestore foundation.
No commerce features are implemented yet.

## Repository

```text
frontend/        React + TypeScript + Vite (Brand/Retail console shell, Firebase Auth)
backend/         Node.js 24 + TypeScript + Express API for Cloud Run
infrastructure/  Firestore rules, Cloud Build config, deploy scripts, GCP setup guide
docs/            Frozen specification (source of truth)
```

## Quick start

Requires Node.js 24 and Java 21+ (for the Firebase emulators).

```bash
npm install
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
npm run emulators            # terminal 1
npm run seed:user -- --email admin@demo.test --password 'demo-password-1' \
  --brand-id brand_demo --brand-name "Demo Brand" --role BRAND_ADMIN
npm run dev:backend          # terminal 2
npm run dev:frontend         # terminal 3 → http://localhost:5173
```

Tests: `npm test` (unit) and `npm run test:emulator` (auth chain + Firestore rules).
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
