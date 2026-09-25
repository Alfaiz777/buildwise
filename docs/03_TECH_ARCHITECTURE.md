# Buildwise — Technical Architecture

## Status

**M0 — Frozen target architecture**

---

# 1. Architecture principle

Buildwise is a Google Cloud-native application with external commerce systems integrated through controlled backend services.

```text
Customer
  WhatsApp
     ↓
Buildwise backend
     ↓
AI agent + commerce context
     ↓
Verified action
     ↓
Retailer / Shopify
```

---

# 2. High-level architecture

```
                         BUILDWISE
                            │
                ┌───────────┴───────────┐
                ↓                       ↓
          BRAND CONSOLE          RETAILER CONSOLE
          React + TypeScript     React + TypeScript
                │                       │
                └───────────┬───────────┘
                            ↓
                       Firebase
                    Hosting + Auth
                            ↓
                        Cloud Run
                   Node.js + TypeScript
                         Express
                            │
          ┌─────────────────┼─────────────────┐
          ↓                 ↓                 ↓
      Firestore          ADK + Gemini    Business Rules
                            │
                       Vertex AI
                            │
       ┌────────────────────┼────────────────────┐
       ↓                    ↓                    ↓
    Shopify             WhatsApp             Retail
       │                    │                    │
       └────────────────────┼────────────────────┘
                            ↓
                       Buildwise Context
                            ↓
                        Next Action
                            ↓
                       Outcome Events
                            ↓
                         BigQuery
                            ↓
                          Looker
```

---

# 3. Frontend

Technology:

**React + TypeScript + Vite**

Responsibilities:

- Brand Console
- Retailer Console
- contextual task pages
- authentication UI
- connection setup
- conversation/operation views
- status and error states

The customer does not receive a full Buildwise dashboard.

# 4. Backend:

Technology:

- Node.js 24
- TypeScript
- Express

Agent:

- Google ADK for TypeScript

---

# 5. Firebase

## Firebase Hosting

Hosts the web application.

## Firebase Authentication

Identity for:

- brand users
- retailer users
- team members

Customer identity for WhatsApp is handled through the customer/channel identity model rather than requiring a Buildwise customer portal.

---

# 6. Cloud Run

Cloud Run is the central backend runtime.

Responsibilities:

- API endpoints
- Shopify integration
- WhatsApp webhook handling
- retail-file processing orchestration
- customer context assembly
- AI orchestration
- authorization
- business rules
- reservation workflow
- audit events
- analytics event emission

Cloud Run is the service boundary between the web application, external services, data layer and AI layer.

---

# 7. Firestore

Firestore is the operational application database.

Store:

```text
brands
users
connections
customers
products
productVariants
stores
retailInventory
customerIntents
conversations
aiRecommendations
reservations
outcomes
auditEvents
```

Use tenant-aware document paths and server-side authorization.

---

# 8. AI architecture

```text
Customer input
      ↓
Cloud Run
      ↓
Context builder
      ↓
ADK
      ↓
Gemini
      ↓
Tool calls where required
      ↓
Structured decision
      ↓
Action guardrail
      ↓
Backend action
```

---

# 9. External systems

## Shopify

Source of truth for online commerce.

## WhatsApp Cloud API

Customer communication channel.

## Retail file

Source for physical store/inventory information in MVP.

---

# 10. Data/analytics architecture

Operational:

```text
Firestore
```

Historical/event:

```text
BigQuery
```

Visualization:

```text
Looker
```

The frontend may still display key metrics directly where needed.

Looker is the business-intelligence layer, not the primary customer/retailer application UI.

---

# 11. File storage

Cloud Storage:

- retail uploads
- product assets
- store assets
- demo datasets
- generated reports where needed

Firestore stores metadata/references.

---

# 12. Secrets

Use:

**Google Secret Manager**

for:

- external API credentials
- access tokens
- webhook secrets
- application secrets

Never expose sensitive credentials to React.

---

# 13. Optional components

These are not required for the first working MVP:

```text
Pub/Sub
Vertex AI Search
Cloud SQL
AlloyDB
advanced Looker modeling
```

They may be introduced only when a concrete requirement justifies them.

---

# 14. Final responsibility split

```text
React
→ experience

Firebase
→ identity + hosting

Cloud Run
→ backend + orchestration + policies

Firestore
→ current application state

ADK
→ agent orchestration

Gemini
→ reasoning + language + next-best action

Shopify
→ online commerce source

WhatsApp
→ customer channel

Retail data
→ physical commerce input

BigQuery
→ historical analytics

Looker
→ brand BI
```
