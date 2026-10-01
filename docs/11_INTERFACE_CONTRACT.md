# Buildwise — Interface Contract

Status: added in M2.1, updated in M2.2, M3 and M4 (post-M0, `00_M0_SPECIFICATION_FREEZE.md` §11.8 Changes 8–11).

This document states, for each of the four frozen interfaces, who uses it, what it may show and do **today (end of M4)**, and how it behaves when it is empty, unauthorized, loading or failing. It describes the current contract only. It adds no features, and it never overrides `01`–`08`: roles and scopes come from `04_DATA_MODEL.md` §4, routes from `06_INTEGRATION_CONTRACTS.md` §14, and enforcement from `07_SECURITY_SPEC.md` §4.

Interface names are frozen:

| Interface | Role / principal | Scope |
|---|---|---|
| Platform Admin Console | `PLATFORM_ADMIN` | platform (no tenant) |
| Brand Console | `BRAND_ADMIN` | one brand |
| Retailer Console | `RETAIL_ADMIN` | one physical store: `brand_id` + `retailer_id` + `store_id` |
| Customer AI Channel / WhatsApp | customer (channel principal, not a role) | own conversation, context and resources |

## 1. Ownership model the interfaces rely on

```text
Platform Admin ──provisions──► Brand Admin   (exactly one per brand)
Brand Admin    ──provisions──► Retail Admin  (at most one per store, provisioned per store)

Brand                       e.g. Dot & Key
 └── Retailer               e.g. Nykaa (retail business / partner)
      ├── Store A ── RETAIL_ADMIN_A        Mumbai Store    ── Retail Admin A
      ├── Store B ── RETAIL_ADMIN_B        Delhi Store     ── Retail Admin B
      └── Store C ── (not provisioned)     Ahmedabad Store ── not provisioned
```

- One Brand Admin per brand, provisioned only by the Platform Admin.
- A retailer may own **many** stores. Each store belongs to exactly one retailer (`RetailStore.retailer_id`, `04` §8a).
- Each store has at most one Retail Admin (`RetailStore.retail_admin_user_id`), provisioned only by the Brand Admin, from that store.
- Each Retail Admin operates exactly one store. Retail access is store-level: brand, retailer and store must all match. Retail Admin A cannot access Store B, even though both stores belong to the same retailer.
- No multi-store Retail Admin, no store picker, no store-staff role.
- Stores and their retailer come from the retail/store data flow (retail ingestion, M3). There is no manual store-ID entry in any console.

All scope is resolved by the backend from the verified Firebase ID token and `users/{uid}` (`07` §4.1). No interface sends, or is trusted to send, a `brand_id`, `retailer_id` or `store_id` that defines its own scope. A hand-edited `users/{uid}` grants nothing: a Retail Admin is accepted only as the recorded admin of the store it names.

## 2. Shared states (all three consoles)

| State | Behaviour |
|---|---|
| Loading | Firebase session restore: "Loading…". Account resolution (`GET /api/me`): "Loading your account…". Nothing scoped is rendered before `/api/me` answers. |
| Not signed in | Redirect to `/login`. |
| Signed in but refused by the backend | `401`/`403` from `/api/me` (`USER_NOT_PROVISIONED`, `USER_DISABLED`, `USER_MISCONFIGURED`, `BRAND_INACTIVE`, `RETAILER_INACTIVE`): an error card with the message and request reference, plus Sign out. No console is shown. |
| Wrong console for the scope | Visiting another scope's path redirects to the user's own console. The backend independently answers `403` on another scope's route area. |
| Out-of-scope resource | `404 NOT_FOUND`, identical to "does not exist" (`07` §4.1). Nothing about the resource is leaked. |
| API error inside a console | The section shows the error message inline; the rest of the console stays usable. Retryable errors (`503`) can be retried by reloading. |

## 3. Platform Admin Console

| Item | Contract |
|---|---|
| Role / scope | `PLATFORM_ADMIN`, platform scope. Never reads or edits tenant commerce data. |
| Purpose | Onboard brands and provision their single `BRAND_ADMIN`. |
| Data (M2) | Brand list: name, ID, status, the brand's Brand Admin (or "not provisioned"). Latest platform audit events. |
| Actions (M2) | Create a brand. Provision a brand's single Brand Admin: the response carries the local password-setup link, shown for hand-over. Suspend / reactivate a brand (with reason). |
| Routes | `GET/POST /api/platform/brands`, `PATCH /api/platform/brands/:brandId`, `POST /api/platform/brands/:brandId/admins`, `GET /api/platform/audit`. |
| Out of scope | Any `/api/brand/*`, `/api/brands/*`, `/api/retail/*` data; retailers, stores, customers, conversations; provisioning Retail Admins; replacing an admin. |
| Empty state | No brands: empty table plus the "Create brand" form. Every brand has its admin: the provisioning form is not shown. |
| Unauthorized | Non-platform users never see it (redirect). Its routes answer `403 FORBIDDEN` to other scopes. A second Brand Admin for a brand → `409 BRAND_ADMIN_ALREADY_PROVISIONED`, and no setup link is generated. |

## 4. Brand Console

| Item | Contract |
|---|---|
| Role / scope | `BRAND_ADMIN`, exactly its own brand. |
| Purpose | Manage one brand's retailer network and store-level Retail Admin provisioning. |
| Data (M3) | **Setup checklist** at the top: Catalog synced (product / variant counts, last sync) → Stores & stock imported (stores with stock, "stock as of") → SKU mapping (auto-matched / need attention) → Retail Admins provisioned (x of y stores). **Catalog & mapping:** products → variants (SKU, price, mapping status, stores stocking it) and the retail SKUs needing attention. **Retail import:** import history and the report of each import with its row errors. The brand's Brand Admin (read-only). The retail hierarchy: each retailer, then its stores (name, ID, city, status, SKU count, last stock update), then each store's Retail Admin (email) or "Not provisioned". A count of stores not yet associated with a retailer. |
| Actions (M3) | "Sync catalog" (runs the wired commerce provider; mock locally). "Upload and import" a retail CSV (create import → upload the file → process → report). Create a retailer. On a store **without** a Retail Admin: "Provision Retail Admin" → enter the admin's email → the backend creates the `RETAIL_ADMIN` bound to that store's `brand_id` + `retailer_id` + `store_id` and returns the local password-setup link, which the console displays. A store **with** a Retail Admin shows that admin and no provisioning action. |
| Routes | `GET /api/brands/:brandId` (own brand), `GET /api/brand/users`, `GET/POST /api/brand/retailers`, `GET /api/brand/stores`, `POST /api/brand/stores/:storeId/admins`, `POST /api/integrations/shopify/sync`, `GET /api/brand/connections`, `GET /api/products`, `POST/GET /api/brand/retail-imports`, `POST /api/brand/retail-imports/:importId/process`, `GET /api/brand/retail-imports/:importId`, and locally the upload target `PUT /api/local-files/uploads/:uploadId`. `PATCH /api/brand/stores/:storeId` exists backend-only (no UI). |
| Out of scope | Other brands (`404`); platform routes (`403`); Retailer Console routes (`403`); creating another Brand Admin; retailer-wide Retail Admins; entering store IDs; assigning stores by hand; resolving SKU mappings by hand; XLSX files; store staff. Customers, conversations, reservations and analytics arrive in later milestones. |
| Empty state | Each unchecked checklist step is the empty state with its action ("Sync catalog", "Import a retail CSV", "Review mapping", "Provision per store"). No products: "No products yet. Sync the catalog from your commerce store." No imports: "No imports yet." No retailers: "No retailers yet." plus "Create retailer". A retailer without stores: "No stores yet. Stores arrive through the retail CSV import." Every store has its Retail Admin: no provisioning action is shown. |
| Errors | A rejected import shows its `failure_code` (e.g. `MISSING_COLUMNS`); rejected rows are listed with line, store, SKU, code and message (first 50). A failed sync shows its normalized error in the checklist. |
| Conversations & intents (M4) | A second area, `/brand/conversations` ("Conversations & intents", linked from the Overview). **List:** each conversation with the customer's display ref (e.g. `sim:shopper_3002`, never a phone number), channel, "needs a person" flag, bound product, intent type and follow-up status; filters All / Needs a person / Follow-up scheduled / Sent / Not eligible. **Intents tab:** every storefront intent, anonymous ones included (shown only as an opaque `visitor ……` reference), with type, stage, product and the follow-up status and reason in plain words — this shows why nothing was sent. **Detail:** the chat and an "Intent & follow-up" panel answering: what did the customer do (storefront events with times); what intent was detected (type, stage, strength); was a follow-up eligible and why / why not; when was it due (live countdown); was it sent and as what (Template / Session message); did the customer reply, ask for a person, opt out or order. **Simulator:** a phone-style chat headed with the brand's display name and "WhatsApp (simulated)"; pick or type a synthetic customer ref, send text, share a location, tap reply options; prefilled from the URL fragment when opened from the demo storefront; bubbles distinguish customer messages, automated replies and proactive follow-ups (with the Template / Session label); always shows the Simulator badge, the runtime badge ("Mock AI, deterministic" / "Fallback (deterministic)"), and the intent and follow-up status. **Actions:** send as the customer; "Run due follow-ups" (local profile also checks every 30 s while the page is open). Replying as a human agent comes in M6. |
| Decide & reserve (M5) | **"Why Buildwise did this"** under the conversation detail, one card per decision (newest first, expandable): the context summary (intent type, location source, number of recent messages, whether a hold was on offer — never message text or coordinates); the tool calls, collapsed, with status, reason and duration; eligible stores and excluded stores with their reason in plain words (closed now, out of stock, too far, …); the guardrail result (allowed after re-checking on fresh data, or the block reason: out of stock, store closed, not eligible, outside scope, ambiguous); the action; runtime ("Mock AI, deterministic" / "Gemini") and decision source (agent / deterministic fallback, with the failure reason); and the reservation it created (store, status, pickup code, expiry). **Reservations tab:** status, store, product, masked customer ("Customer •••• 4821"), created and expires; read-only. The simulator renders links (maps, "Buy online") and the reply options (Hold · Other stores · Buy online · Cancel reservation). "Run due follow-ups" also expires overdue holds. |
| Handoff queue (M6) | "Needs a person" is a working queue: each row shows "waiting N min" since the handoff. The detail shows the decision trace, a **Reply as a person** box (sent as the brand — `origin = HUMAN_AGENT`; the admin's identity is recorded only in the audit log) and **Resolve and return to assistant**. While a person owns the conversation no automated reply or follow-up is sent. Errors inline: "The customer opted out; no message can be sent", "More than 24 hours since the customer last wrote; a free-text reply is not allowed", "replies as a person need a handoff". Simulator bubbles label store updates ("Store update") and replies as a person ("Team member"). |
| Outcomes & insights (M6) | `/brand/outcomes` (Brand nav). Period toggle (last 7 / 28 days), weekdays in store time, and "Include synthetic demo history" (a notice shows how many generated records are included). Panels: **Journey funnel** (intents → follow-ups sent → conversations → store recommendations → reservations → completed pickups → outcomes by type); **Demand vs availability by weekday** with one rule-based reading sentence; **Suggested next actions** (display only, each with "Based on N store lookups / reservations" and the IDs behind it); **Unmet local demand** (product × area × day, with exclusion reasons); **Did the recommendation convert?** (per action: what it aims for, what was recorded, converted %); **Fill rate by store** (was the nearest store / had stock, refusals by reason). Empty states: "No suggestions for this period.", "Every store lookup in this period found a store with stock.", "No recorded outcomes in this period yet.", "No store lookups in this period yet." Loading: "Loading…". Errors inline. Route `GET /api/brand/insights?days=7|28&include_history=`. |
| Conversations: routes | `POST /api/channels/simulator/messages`, `GET /api/channels/simulator/conversations/:conversationId/messages?after=`, `GET /api/brand/conversations`, `GET /api/brand/conversations/:conversationId` (M5: each recommendation carries `trace`, `guardrail_reason` and its `reservation`), `GET /api/brand/intents?type=&follow_up_status=`, `POST /api/brand/follow-ups/process-due` (M5: also returns `reservations_expired`), `GET /api/reservations` (M5). |
| Conversations: empty / loading / error | No conversations: "No conversations here yet. Send a message from the simulator to start one." No intents: "No storefront intents yet. Browse the demo storefront to create some." No linked intent: "No storefront intent is linked to this conversation." API errors appear inline above the panels; the simulator stays usable. Simulator disabled → `404 CHANNEL_DISABLED`; too many messages → `429`. |
| Unauthorized | A second Retail Admin for a store → `409 RETAIL_ADMIN_ALREADY_PROVISIONED` (no user, no setup link). Store without a retailer → `409 STORE_HAS_NO_RETAILER`. Another brand's store or retailer → `404`. |

## 5. Retailer Console

| Item | Contract |
|---|---|
| Role / scope | `RETAIL_ADMIN`, exactly one physical store: `brand_id` + `retailer_id` + `store_id`, verified at sign-in against `RetailStore.retail_admin_user_id` and `RetailStore.retailer_id`. |
| Purpose | Allow a `RETAIL_ADMIN` to operate exactly one physical store (in later milestones: the customer reservations sent to it). |
| Data (M3) | Retailer name and the one store: name, ID, city, address, status, hours. **Store stock** (read-only): SKU, product, quantity, reserved, available, last updated. M5: **Reserved** rises when a customer holds a product at this store and falls when the hold is cancelled or expires; available = quantity − reserved. |
| Reservation queue (M6) | **Reservations** above the stock: a "This week" strip (reservations · completed · refused · expired, own store only) and two tabs. **Active**: new holds first, then the soonest expiry; each card shows quantity × product · size, status, masked customer ("Customer •••• 4821" — never contact details), created and held-until times in store time with "expires in N min", the customer's ETA if given, the last customer update ("customer notified" / "customer opted out; not notified"), and only the actions allowed now: **Confirm**, **Mark ready**, **Customer arrived**, **Complete** (with the customer's 6-digit pickup code), **Refuse** (reason: Not actually in stock / Damaged / Store closing early / Other + an internal note never shown to the customer). After an action: "<item>: <status> (customer notified). Next up: <item>, expires in N min." New holds get a "New" badge (15 s poll in the local profile; **Refresh** always). **Completed & cancelled**: history with refusal reasons. Errors inline: stale status ("This reservation changed since you loaded it…"), wrong pickup code, locked after 5 wrong codes. Empty: "No reservations waiting. New customer holds appear here automatically." |
| Actions (M3) | M3: none beyond viewing. M5: "Refresh" on the stock table (the local profile also refreshes it every 15 s). M6: the queue's status actions (own store only). |
| Routes | `GET /api/me` (returns `store_id` and a single `store`), `GET /api/retail/stores/:storeId`, `GET /api/retail/stores/:storeId/inventory` and `/summary` (own store only), `GET /api/reservations?view=active|history` (own store only; any other `store_id` returns an empty list), `GET /api/reservations/:id` and `PATCH /api/reservations/:id` (own store only; another store — even of the same retailer — → 404). |
| Out of scope | Any other store, **including other stores of the same retailer** (`404`); another retailer or brand (`404`); brand routes and platform routes (`403`); a store picker or a list of the retailer's stores; store staff; editing store data. |
| Empty state | Store stock: "No stock has been imported for this store yet. Your brand imports it from its retail file." The reservation queue: M6. There is no "no store" state: a Retail Admin without a valid store is refused at sign-in (`403 USER_MISCONFIGURED`). |
| Unauthorized | Retailer `INACTIVE` → `403 RETAILER_INACTIVE`. Brand suspended → `403 BRAND_INACTIVE`. User document not matching the store's recorded admin or retailer → `403 USER_MISCONFIGURED`. |

## 6. Customer AI Channel / WhatsApp

| Item | Contract |
|---|---|
| Principal / scope | The customer is a channel principal resolved from the channel identity inside one brand. It is **not** a role, never has a `users/{uid}` document and never signs in to a console. |
| Purpose | WhatsApp-only customer interaction: continue the customer's product journey conversationally (`01`, `05`). The simulator is the local stand-in for WhatsApp, and contextual pages open from the conversation; neither is a separate customer app. |
| Data (M4) | The customer's own conversation with the brand. Messages come from the brand (its display name), never from "Buildwise". Proactive follow-ups carry "Reply STOP to opt out" and are labelled Template or Session message (`00` §11.8 Change 11, D6). |
| Store updates (M6) | The customer is told at each store step, in the same conversation (SESSION inside 24 h, otherwise the named template): confirmed (pickup code, held until), ready (code, maps link), refused (an apology that never shows the store's reason or note, then a one-tap **Hold 1 at <next eligible store>** and **Buy online**, or the online link / verified alternative when no store qualifies), expired (**Check stores again**). Nothing is sent to a customer who opted out. A **Buy online** link carries an opaque `bw_ref` that links a later order to the conversation. |
| Actions (M5) | Ask about the product (answered only from catalogue attributes, or "I don't have verified information"); compare with its verified alternative; ask for it today / nearby / in another store (share a location or name an area; without either the agent asks); tap **Hold 1 at <store>** to reserve (confirmation with pickup code, hold-until in store time, maps link, "Pay at the store", **Cancel reservation**); **Other stores**; **Buy online**. No eligible store → a verified alternative or the online link. Requests for other customers' data or to ignore instructions are refused. If the agent fails, a fixed safe reply is sent (handoff when enabled). |
| Actions (M4) | Reply in the conversation (every reply runs the ConversationPipeline; in M4 the reply was the deterministic fallback, which stays on the bound product and never claims price, stock or policy). "STOP" opts out and stops automation. Asking for a person hands the conversation to the brand's team and stops automated replies. Locally the channel is the simulator (operated by the Brand Admin); real WhatsApp arrives in L2. Contextual pages are deferred (`00` §11.8 Change 10). |
| Proactive contact | Only a known, opted-in customer (signed-in shopper or returning chatter) can receive a follow-up, only when the brand's policy allows it, never before it is due, at most one per intent and one per 24 h per customer, and never after an order, opt-out, handoff or when the customer is already chatting (`00` §11.8 Change 11, D1/D5). Anonymous visitors are never messaged. |
| Demo storefront (local only) | `/demo-store`, labelled "Demo storefront (local profile)": products, search, product pages with a size picker, cart, checkout and "Place order"; "Sign in as demo shopper" (opted in / not opted in) or "Continue as guest"; "Need it today?" and "Chat with us" open the simulator with the prefilled text; a "Journey scenarios" helper replays six journeys as real events through the storefront snippet. Not routed, and its endpoints not mounted, in the gcp profile. |
| Out of scope | Any console route: a `users/{uid}` claiming `CUSTOMER` is refused with `403 USER_MISCONFIGURED` everywhere. Any other customer's conversation, context or resources. Admin roles and provisioning. |
| Empty / loading / error | Simulator: "No messages yet. Say hello as the customer." A failed send shows the error inline. When the agent runtime cannot answer, the reply is the deterministic fallback (`03` §16.2). WhatsApp failures fall back per `00` §11.2. |
| Unauthorized | The customer is identified by channel identity or page token, never by Firebase Auth (`07` §4.3). The simulator is operated by the brand's `BRAND_ADMIN` inside its own brand; `PLATFORM_ADMIN` and `RETAIL_ADMIN` have no customer-conversation access (`07` §4.0). |
