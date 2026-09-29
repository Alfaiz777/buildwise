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
| `local` | Main development path, M2–M7 | Firestore + Auth emulators, `LocalFileStorageProvider`, `MockCommerceProvider`, `SimulatorMessagingProvider`, `MockAgentRuntime`, `LocalEventSink` |
| `gcp` | Live phases L1–L3, final judged prototype | Cloud Run (backend), Firebase Hosting (frontend), Firestore, Firebase Auth, `GCSFileStorageProvider` (Cloud Storage), Secret Manager, `ShopifyCommerceProvider` (Shopify development store), `WhatsAppMessagingProvider` (WhatsApp Cloud API) + `SimulatorMessagingProvider`, `AdkGeminiAgentRuntime` (Gemini on Vertex AI through ADK for TypeScript), `BigQueryEventSink`, Looker where required |

The full mapping and the selection mechanism are in `03_TECH_ARCHITECTURE.md` §2.2. In `gcp` the simulator stays enabled as the judge-testable customer channel (`BRAND_ADMIN` only). Product knowledge is passed to Gemini in context; there is no RAG pipeline (`00` §11.8 Change 10).

**Dates:** the prototype is complete by **15 Oct 2026** and submitted on **18 Oct 2026**.

---

# 3. Main milestone sequence (local profile)

Each milestone is implemented, tested and reviewed before the next one starts. The sequence was consolidated by `00` §11.8 Change 10.

| # | Milestone | Scope (spec references) |
|---|---|---|
| M1 | Repository + foundation ✅ | React/Vite, Express, Firebase Auth, auth chain, Docker/Cloud Run config |
| M2 | Foundation alignment ✅ | The three scoped roles `PLATFORM_ADMIN` / `BRAND_ADMIN` / `RETAIL_ADMIN` (`07` §4); Retailer entity (`04` §8a); profile config + composition root + the five provider ports (`03` §2.1–§2.2, `06` §1.1–§6a); Platform Admin minimum (brands, each brand's single Brand Admin, platform audit); brand provisioning (retailers; one Retail Admin per store); console shells per interface. **M2.1:** store-level retail scope, `GET /api/retail/stores/:storeId`, `11_INTERFACE_CONTRACT.md`. **M2.2:** one retailer → many stores, store-based Retail Admin provisioning (`00` §11.8 Change 9) |
| M3 | Catalog & store truth | *(old M3 + M4)* `CommerceProvider` + `MockCommerceProvider` catalogue sync into Firestore (products, variants, product `tags` / `attributes`, `IntegrationConnection`); `FileStorageProvider` (local); CSV retail ingestion (`04` §9.1–§9.2) including store → retailer ownership (one retailer, many stores; same domain rule as M2); SKU mapping (`04` §8.1, §19); store truth rules (distance, open-now, availability, eligibility); Brand Console catalogue / import / setup views; Retailer Console store stock |
| M4 | Intent → conversation | *(old M5 + M6)* `POST /api/intents`; deterministic intent stage (`04` §11.2); web → WhatsApp handshake token (`06` §10.1); `ConversationPipeline` steps 1–5 and 9–10 (`03` §8.2); `SimulatorMessagingProvider`; `POST /api/channels/simulator/messages`; identity resolution, handshake token binding, conversation state, consent/window policy, idempotency, persistence. Until M5 the agent step uses the deterministic fallback reply (`03` §16.2). |
| M5 | Decide & reserve | *(old M7 + M8)* `MockAgentRuntime`; `AgentDecision` contract (`05` §8); `ToolExecutor` and the agent tools; AI Action Guardrail; deterministic fallback; pipeline steps 6–8; reservation transaction + expiry (`03` §15) with `pickup_code` / `customer_eta`; `create_reservation` / `cancel_reservation` tools; unmet local demand on `STORE_RECOMMENDATION`. Contextual pages (`/nearby-stores`, `/reservation/:id`, `/pickup/:id`, page tokens `07` §16) are **deferred**. |
| M6 | Store fulfilment & outcomes | *(old M9 + M10)* Retailer Console reservation queue, status transitions and refusal (`cancelled_by` / `cancel_reason`) for the `RETAIL_ADMIN`'s one store; outcome recording (`04` §16; pipeline step 11 and reservation completion); online-order attribution reference; `EventSink` (`LocalEventSink`); Brand Console insight views and human-handoff queue |
| M7 | Local E2E + hardening | *(old M11 + M12)* Platform views (`07` §4.2); rate limiting (`07` §17); reliability rules (`03` §16); audit completeness; full journey (`08` §12) on the local profile; AI scenarios on `MockAgentRuntime` as pipeline/guardrail tests; security tests |

---

# 4. Live phases (after M7)

| # | Phase | Scope |
|---|---|---|
| L1 | Live deploy | GCP project; Cloud Run (backend) + Firebase Hosting (frontend) with real Firebase Auth and Firestore; Cloud Storage (`GCSFileStorageProvider`); Secret Manager; Gemini on Vertex AI via ADK for TypeScript (`AdkGeminiAgentRuntime`); deploy the M7 build with the `gcp` profile |
| L2 | Live integrations | WhatsApp Cloud API (`WhatsAppMessagingProvider`), Shopify development store (`ShopifyCommerceProvider`), BigQuery (`BigQueryEventSink`); provider contract tests against the real adapters |
| L3 | Live E2E | Live E2E journey (`08` §12); final AI evaluation on `AdkGeminiAgentRuntime` (`08` §7); reservation race on real Firestore; production smoke test (`08` §14) |

The judged prototype runs the `gcp` profile with a real Shopify development store, real Meta WhatsApp and Gemini. The simulator remains available in `gcp` as the judge-testable channel.

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
