# Buildwise — Interface Contract

Status: added in M2.1, updated in M2.2 and M3 (post-M0, `00_M0_SPECIFICATION_FREEZE.md` §11.8 Changes 8–10).

This document states, for each of the four frozen interfaces, who uses it, what it may show and do **today (end of M3)**, and how it behaves when it is empty, unauthorized, loading or failing. It describes the current contract only. It adds no features, and it never overrides `01`–`08`: roles and scopes come from `04_DATA_MODEL.md` §4, routes from `06_INTEGRATION_CONTRACTS.md` §14, and enforcement from `07_SECURITY_SPEC.md` §4.

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
| Unauthorized | A second Retail Admin for a store → `409 RETAIL_ADMIN_ALREADY_PROVISIONED` (no user, no setup link). Store without a retailer → `409 STORE_HAS_NO_RETAILER`. Another brand's store or retailer → `404`. |

## 5. Retailer Console

| Item | Contract |
|---|---|
| Role / scope | `RETAIL_ADMIN`, exactly one physical store: `brand_id` + `retailer_id` + `store_id`, verified at sign-in against `RetailStore.retail_admin_user_id` and `RetailStore.retailer_id`. |
| Purpose | Allow a `RETAIL_ADMIN` to operate exactly one physical store (in later milestones: the customer reservations sent to it). |
| Data (M3) | Retailer name and the one store: name, ID, city, address, status, hours. **Store stock** (read-only): SKU, product, quantity, reserved, available, last updated. |
| Actions (M3) | None beyond viewing. |
| Routes | `GET /api/me` (returns `store_id` and a single `store`), `GET /api/retail/stores/:storeId`, `GET /api/retail/stores/:storeId/inventory` (own store only). |
| Out of scope | Any other store, **including other stores of the same retailer** (`404`); another retailer or brand (`404`); brand routes and platform routes (`403`); a store picker or a list of the retailer's stores; store staff; editing store data. |
| Empty state | Store stock: "No stock has been imported for this store yet. Your brand imports it from its retail file." Reservations: "appear here in a later milestone". There is no "no store" state: a Retail Admin without a valid store is refused at sign-in (`403 USER_MISCONFIGURED`). |
| Unauthorized | Retailer `INACTIVE` → `403 RETAILER_INACTIVE`. Brand suspended → `403 BRAND_INACTIVE`. User document not matching the store's recorded admin or retailer → `403 USER_MISCONFIGURED`. |

## 6. Customer AI Channel / WhatsApp

| Item | Contract |
|---|---|
| Principal / scope | The customer is a channel principal resolved from the channel identity inside one brand. It is **not** a role, never has a `users/{uid}` document and never signs in to a console. |
| Purpose | WhatsApp-only customer interaction: continue the customer's product journey conversationally (`01`, `05`). The simulator is the local stand-in for WhatsApp, and contextual pages open from the conversation; neither is a separate customer app. |
| Data (M2) | None user-facing. The backend has the conversation pipeline foundation (fixed stage order, `03` §8.2) and the simulator messaging adapter, exercised by tests only. |
| Actions (M2) | None user-facing. The simulator and the channel flow arrive in M4; contextual pages are deferred (`00` §11.8 Change 10). |
| Out of scope | Any console route: a `users/{uid}` claiming `CUSTOMER` is refused with `403 USER_MISCONFIGURED` everywhere. Any other customer's conversation, context or resources. Admin roles and provisioning. |
| Empty / loading / error | Defined with the channel flow in M4. WhatsApp failures fall back per `00` §11.2. |
| Unauthorized | The customer is identified by channel identity or page token, never by Firebase Auth (`07` §4.3). The simulator is operated by the brand's `BRAND_ADMIN` inside its own brand; `PLATFORM_ADMIN` and `RETAIL_ADMIN` have no customer-conversation access (`07` §4.0). |
