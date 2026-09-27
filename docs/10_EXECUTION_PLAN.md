# Buildwise — Execution Plan

## Status

**Approved post-M0 execution strategy** (recorded in `00_M0_SPECIFICATION_FREEZE.md` §11.8).

This document defines **how** Buildwise is built: the execution profiles, the milestone sequence and the rules for external integration spikes.

It does not change **what** Buildwise is. The product, journey, AI role and target architecture are defined in `01`–`08`.

---

# 1. Strategy

> **Build the complete core product locally first. Then cut over to Google Cloud and real integrations.**

There is **one** logical Buildwise architecture. The domain and application logic is identical in every profile. Only infrastructure and integration **adapters** change (`03_TECH_ARCHITECTURE.md` §2.2).

GCP setup is **not** a blocker for any local milestone.

---

# 2. Execution profiles

| Profile | Purpose | Adapters |
|---|---|---|
| `local` | Main development path, M2–M12 | Firestore + Auth emulators, `LocalFileStorageProvider`, `MockCommerceProvider`, `SimulatorMessagingProvider`, `MockAgentRuntime`, `LocalEventSink` |
| `gcp` | Cutover, real integrations, final judged prototype | Firestore, Firebase Auth, Cloud Run, Firebase Hosting, `GCSFileStorageProvider`, `ShopifyCommerceProvider`, `WhatsAppMessagingProvider` (+ `SimulatorMessagingProvider` as the approved fallback), `AdkGeminiAgentRuntime`, `BigQueryEventSink`, Secret Manager, Looker where required |

The full mapping and the selection mechanism are in `03_TECH_ARCHITECTURE.md` §2.2.

---

# 3. Main milestone sequence (local profile)

Each milestone is implemented, tested and reviewed before the next one starts.

| # | Milestone | Scope (spec references) |
|---|---|---|
| M1 | Repository + foundation ✅ | React/Vite, Express, Firebase Auth, auth chain, Docker/Cloud Run config |
| M2 | Foundation alignment | Scoped roles (`07` §4); Retailer entity (`04` §8a); profile config + composition root + the five provider ports (`03` §2.1–§2.2, `06` §1.1–§6a); Platform Admin minimum (brands, first Brand Admin, platform audit); brand provisioning (members, retailers, retailer users, store assignment); console shells per interface |
| M3 | Commerce data | `CommerceProvider` + `MockCommerceProvider`; sync into Firestore; product/variant views in the Brand Console |
| M4 | Retail network ingestion | `FileStorageProvider` (local); CSV/XLSX ingestion (`04` §9.1–§9.2); SKU mapping; retail views |
| M5 | Customer intent | `POST /api/intents`; deterministic intent stage (`04` §11.2); web → WhatsApp handshake token **issuance** (`06` §10.1). Token binding happens in the pipeline (M6). |
| M6 | Conversation pipeline + simulator channel | `ConversationPipeline` steps 1–5 and 9–10 (`03` §8.2); `SimulatorMessagingProvider`; `POST /api/channels/simulator/messages`; identity resolution, handshake token binding, conversation state, consent/window policy, idempotency, persistence. The agent step invokes the `AgentRuntime` port defined in M2. Until M7, no runtime is registered, so the pipeline records the inbound message and uses the deterministic fallback reply (`03` §16.2). There is no separate or fake AI flow. |
| M7 | Agent runtime + tools + guardrail | `MockAgentRuntime`; `AgentDecision` contract (`05` §8); `ToolExecutor` and the read/lookup agent tools; AI Action Guardrail; deterministic fallback; pipeline steps 6–8. Reservation tools arrive in M8. |
| M8 | Reservations + contextual pages | Reservation transaction + expiry (`03` §15); `create_reservation` / `cancel_reservation` tools; page tokens (`07` §16); `/nearby-stores`, `/reservation/:id`, `/pickup/:id` |
| M9 | Retailer Console | Reservation queue, status transitions, inventory view, retailer scope |
| M10 | Outcomes + brand intelligence | Outcome recording (`04` §16; pipeline step 11 and reservation completion); `EventSink` (`LocalEventSink`); Brand Console insight views |
| M11 | Platform Admin Console + hardening | Platform views (`07` §4.2); rate limiting (`07` §17); reliability rules (`03` §16); audit completeness |
| M12 | Local end-to-end verification | Full journey (`08` §12) on the local profile; AI scenarios on `MockAgentRuntime` as pipeline/guardrail tests; security tests |

---

# 4. GCP cutover and live verification (after M12)

| # | Phase | Scope |
|---|---|---|
| G1 | GCP cutover | Project, Firestore, Firebase Auth, Cloud Run, Hosting, Cloud Storage (`GCSFileStorageProvider`), Secret Manager; deploy the M12 build with the `gcp` profile |
| G2 | Real integrations | `ShopifyCommerceProvider`, `WhatsAppMessagingProvider`, `AdkGeminiAgentRuntime`, `BigQueryEventSink`; provider contract tests against real adapters |
| G3 | Final live verification | Live E2E journey (`08` §12); final AI evaluation on `AdkGeminiAgentRuntime` (`08` §7); reservation race on real Firestore; production smoke test (`08` §14) |

The judged prototype runs the `gcp` profile with real Shopify, real Meta WhatsApp and Gemini.

---

# 5. External integration spikes

Small, isolated risk-reduction experiments may run **in parallel** with the main sequence:

```text
S1  Shopify auth/API feasibility
S2  Meta WhatsApp onboarding/API feasibility
S3  ADK + Gemini TypeScript feasibility
```

Rules:

- A spike never blocks a local milestone.
- A spike never replaces the local implementation, and it lives outside the main code path. It uses throwaway code or a feature branch, or a single adapter behind its port.
- A spike never requires a full GCP deployment.
- A spike never redesigns the product.
- Findings are recorded in the relevant spec (`06` for integrations, `05` for the agent) and in `09_LEARNING_LOG.md`.

---

# 6. Definition of done per milestone

- Behavior matches the referenced specification sections.
- Unit tests pass, and emulator tests pass where Firestore/Auth are involved.
- No domain or application logic depends on a specific adapter.
- No secrets in code; no client-side Firestore access.
- Learning notes are updated (`09_LEARNING_LOG.md`).
- The milestone is reviewed before the next one starts.
