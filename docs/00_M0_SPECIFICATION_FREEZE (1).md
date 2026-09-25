# Buildwise — M0 Specification Freeze

**Status:** M0 revised draft for final approval before coding  
**Prototype target:** Working, judge-testable prototype by **13 October 2026**  
**Product name:** Buildwise  
**Primary customer channel:** WhatsApp  
**Primary online commerce system:** Shopify  
**Primary physical-retail input:** Brand-provided retail store/inventory data (CSV/XLSX for MVP)  
**Backend language:** Node.js + TypeScript  
**Agent framework:** Google ADK for TypeScript  
**Primary AI:** Gemini on Vertex AI  

---

## 1. Purpose of M0

M0 exists to freeze the product definition before implementation.

The goal is not to design every screen or write production code. The goal is to establish one authoritative specification that Claude Code, Gemini, Antigravity, and the team can use without repeatedly redefining the product.

### M0 rule

> **No feature implementation should change the product definition without updating and approving the relevant specification first.**

The eight core specification files are:

```text
01_PRODUCT_SOURCE_OF_TRUTH.md
02_MVP_SPEC.md
03_TECH_ARCHITECTURE.md
04_DATA_MODEL.md
05_AI_AGENT_SPEC.md
06_INTEGRATION_CONTRACTS.md
07_SECURITY_SPEC.md
08_TEST_PLAN.md
```

`09_LEARNING_LOG.md` is the companion learning file.

The PDFs and research documents remain reference material. The Markdown specification pack is the implementation source of truth.

---

# 2. Product in one sentence

> **Buildwise connects a D2C brand's online customer intent with its physical retail availability through an AI-powered WhatsApp commerce agent, helping customers take the most relevant next step—online purchase, local store purchase/reservation, assistance, or human handoff—while giving the brand and retailer a connected view of the resulting outcome.**

---

# 3. Core product loop

```text
Digital Intent
      ↓
Context
(customer + product + location + timing + retail)
      ↓
AI Decision
      ↓
Conversational Action
(WhatsApp)
      ↓
Online Purchase OR Store Reservation/Purchase
      ↓
Retailer Fulfillment
      ↓
Outcome
      ↓
Brand Intelligence
```

Short form:

> **Intent → Context → AI Decision → Action → Purchase → Learn**

---

# 4. The product thesis

The product is NOT:

- a generic chatbot
- a WhatsApp broadcast tool
- a recommendation engine
- a store locator
- a Shopify analytics clone
- a customer dashboard
- a full POS
- a CRM
- a full ERP

The product IS:

> **A decision and engagement layer that uses online customer intent plus physical retail context to create a more useful next step for customers and a measurable business outcome for brands.**

---

# 5. Primary users

## Brand

The D2C brand is the primary buyer/operator.

Typical Buildwise brand users:

- Brand Admin
- Commerce/Growth/Marketing user
- Operations user

Their goal is to understand and act on customer opportunities across digital and physical commerce.

## Retailer

A physical store connected to the brand.

Typical retailer users:

- Store Manager
- Store Staff

Their goal is to receive actionable customer requests and fulfill them correctly.

## Customer

A shopper who has demonstrated meaningful product intent and interacts with the brand through WhatsApp.

The customer does **not** need a Buildwise account or customer dashboard for the MVP.

The customer experience is **WhatsApp-first**, with small contextual web pages used only when a richer task genuinely requires a web interface.

---

# 6. Atomic product decision

> **When a customer has meaningful purchase intent but has not completed the online purchase, should Buildwise intervene, and what is the most helpful next action given the customer's intent, product, location, timing, and current physical retail availability?**

Possible outcomes:

```text
NO_ACTION
EDUCATE
COMPARE
ONLINE_PURCHASE
STORE_DISCOVERY
STORE_RESERVATION
ALTERNATIVE_PRODUCT
HUMAN_HANDOFF
```

---

# 7. Core product principles

### Principle 1 — Customer first

Do not optimize for sending more messages.

Optimize for making the customer's next step more useful.

### Principle 2 — Context before action

The AI must understand the situation before recommending an action.

### Principle 3 — Verified facts, AI reasoning

Deterministic systems provide verified facts.

Gemini reasons over those facts.

### Principle 4 — WhatsApp-first, not WhatsApp-only

WhatsApp is the primary customer channel.

A small contextual web page may be opened when WhatsApp is not the best interface for the task.

### Principle 5 — Shopify is online-commerce source of truth

Buildwise may normalize relevant Shopify data into Firestore for application use, but does not replace Shopify as the merchant's online commerce system.

### Principle 6 — Retail data is separate from Shopify

Physical retail inventory and store information are maintained in Buildwise for the MVP.

### Principle 7 — AI cannot bypass business controls

Gemini proposes; deterministic policy/authorization layers decide whether an action can execute.

### Principle 8 — Measure outcomes

A message is not the business outcome.

The system should connect:

```text
intent → intervention → reservation/purchase → outcome
```

### Principle 9 — Minimum necessary context

The AI should receive enough context to be useful, not unrestricted access to the entire customer, brand, or retailer dataset.

### Principle 10 — One continuous customer relationship

The customer should experience Buildwise as a brand assistant that remembers relevant context within the authorized journey, not as a sequence of disconnected automations.

---

# 8. Scope boundary for the 13 October prototype

The prototype must demonstrate one complete, credible vertical journey.

### Required working journey

```text
Brand connected to Shopify
        ↓
Relevant Shopify data synchronized
        ↓
Retail store/inventory data imported
        ↓
Products mapped across online + retail
        ↓
Customer intent enters Buildwise
        ↓
Buildwise constructs customer/product/retail context
        ↓
Gemini + ADK determines next-best action
        ↓
WhatsApp customer conversation
        ↓
Customer chooses online purchase OR store reservation
        ↓
Backend validates action
        ↓
Retailer receives action
        ↓
Outcome recorded
        ↓
Brand sees the resulting intelligence
```

### Explicit MVP exclusions

- Instagram
- full customer dashboard
- full POS integrations
- automated nationwide retail synchronization
- full CRM
- full CDP
- generic product recommendation platform
- autonomous advertising-budget changes
- autonomous inventory purchasing
- complex multi-agent system
- production-scale omnichannel infrastructure
- dozens of third-party integrations
- alternative customer messaging channels as part of the MVP

### Approved prototype fallback

If Meta/WhatsApp cannot be used reliably during prototype testing, the fallback customer channel is:

> **Buildwise Web Conversation Simulator**

The simulator must use the **same Cloud Run → ADK → Gemini → tools → next-best-action backend path** as WhatsApp. It is a testing interface, not a second product direction.

---

# 9. Technology ownership

```text
React + TypeScript
= Brand/Retailer product experience + contextual customer web pages when required

Firebase
= application hosting + authentication

Cloud Run
= backend APIs, integrations, orchestration and policy enforcement

Node.js + TypeScript + Express
= primary backend implementation stack

Firestore
= Buildwise operational state

Google ADK for TypeScript
= agent orchestration/tools

Gemini on Vertex AI
= intent understanding, reasoning, next-best action, response generation

Shopify
= online commerce source

WhatsApp Cloud API
= primary customer conversation channel

Retail CSV/XLSX
= physical retail network input for MVP

BigQuery
= historical/event analytics

Looker
= optional brand business intelligence layer for MVP

Cloud Storage
= uploaded retail files and assets

Secret Manager
= secrets

Cloud Logging / Audit Logs
= observability/audit
```

### Looker MVP decision

Looker is **optional for the 13 October MVP**.

The Brand Console must remain functional without Looker.

The core brand intelligence can be powered by Firestore aggregations and/or BigQuery-backed application views. Looker may be added when it strengthens the final demonstration without threatening prototype stability.

---

# 10. Source-of-truth hierarchy

If two documents conflict:

```text
01_PRODUCT_SOURCE_OF_TRUTH.md
        ↓
02_MVP_SPEC.md
        ↓
03_TECH_ARCHITECTURE.md
        ↓
04_DATA_MODEL.md
        ↓
05_AI_AGENT_SPEC.md
        ↓
06_INTEGRATION_CONTRACTS.md
        ↓
07_SECURITY_SPEC.md
        ↓
08_TEST_PLAN.md
```

Technical documents must not silently change the product decision.

If implementation discovers a genuine contradiction, stop the affected work, record the issue, update the relevant specification, and obtain approval before continuing.

---

# 11. M0 decisions added after architecture review

The following decisions are now part of the M0 freeze candidate.

## 11.1 Customer contextual web pages

Customer task pages such as:

```text
/reservation/:id
/pickup/:id
```

must not rely on a guessable resource ID alone.

They must use:

- short-lived opaque authorization tokens or an equivalent signed authorization mechanism
- server-side validation
- expiration
- binding to the authorized customer/session and intended resource
- minimum necessary information exposure
- no sensitive customer data in query strings

The preferred flow is:

```text
WhatsApp
   ↓
customer requests a contextual page
   ↓
Cloud Run creates a short-lived opaque token
   ↓
customer opens contextual web page
   ↓
backend validates token + expiry + resource binding
   ↓
minimum required information is shown
```

## 11.2 WhatsApp fallback

Primary customer channel:

> WhatsApp Cloud API

Prototype fallback:

> Buildwise Web Conversation Simulator

Do not add Instagram, SMS, email, or another customer messaging channel to the MVP merely as a fallback.

## 11.3 Customer intent source

Shopify is not assumed to provide a perfect native “high intent” label.

For the prototype, customer-intent events are produced by controlled Buildwise instrumentation and deterministic rules.

Example events:

```text
product_view
product_detail_view
cart_add
checkout_start
whatsapp_click
```

Example prototype state:

```text
No meaningful intent
        ↓
Interested
        ↓
High intent
```

The exact thresholds are deterministic prototype logic. Gemini must not invent the underlying behavioral facts.

## 11.4 Retail upload boundary

Supported MVP retail file size:

> **Up to 10 MB per CSV/XLSX file.**

Flow:

```text
Browser
   ↓
Cloud Storage
   ↓
Cloud Run ingestion
   ↓
validate
   ↓
normalize
   ↓
SKU mapping
   ↓
Firestore
```

Future production architecture may introduce asynchronous/streaming processing for larger datasets.

## 11.5 Looker boundary

Looker is an optional MVP enhancement.

It must not become a blocking dependency for the core customer → AI → retailer → outcome workflow.

---

# 12. Shopify integration boundary

Shopify is the source of truth for Buildwise's **online commerce context**.

The Buildwise integration should conceptually provide:

```text
getProducts()
getProduct()
getCustomer()
getOrder()
getInventory()
getLocations()
```

The application should use a provider abstraction such as:

```text
CommerceProvider
    ├── MockCommerceProvider
    └── ShopifyCommerceProvider
```

The MVP should support one controlled Shopify development-store integration and should not assume that the merchant-owned client-credentials model is a universal multi-merchant SaaS onboarding mechanism.

Initial sync:

```text
Shopify
   ↓
authentication
   ↓
products / variants / customers / orders / inventory / locations
   ↓
normalize
   ↓
Firestore
```

Ongoing sync:

```text
Shopify event/webhook
   ↓
Cloud Run
   ↓
validate + normalize
   ↓
Firestore update
```

Stable identifiers such as SKU/variant identifiers should be preferred over product-name matching.

---

# 13. Retail integration boundary

Retail data provides the physical-commerce reality that Shopify does not own.

Expected fields may include:

```text
store_id
store_name
city
address
latitude
longitude
store_hours
sku
quantity
offline_price
```

The critical mapping is:

```text
Shopify Product/Variant
        ↕
Canonical SKU
        ↕
Retail SKU
        ↓
Retail Store Inventory
```

Do not use product names as the primary identity-matching mechanism.

Unmatched/ambiguous records should be surfaced for resolution rather than silently guessed.

---

# 14. WhatsApp integration boundary

WhatsApp is the primary customer interaction channel.

The intended flow is:

```text
Customer
   ↓
WhatsApp
   ↓
Meta Cloud API
   ↓
Buildwise webhook
   ↓
Cloud Run
   ↓
customer resolution
   ↓
customer/brand/retail context
   ↓
ADK + Gemini
   ↓
next-best action
   ↓
AI Action Guardrail
   ↓
WhatsApp response / controlled action
```

The production onboarding direction is Meta Embedded Signup so a D2C brand connects its own WhatsApp Business Account and phone number to Buildwise.

The AI should not send arbitrary messages without respecting WhatsApp policy, consent/opt-in requirements, template requirements, and the customer-service conversation window.

The backend must explicitly track relevant message/conversation state.

---

# 15. Customer experience boundary

There is **no full customer dashboard** in the MVP.

Customer experience is:

```text
Shopify website
      ↓
relevant intent/context
      ↓
WhatsApp
      ↓
AI conversation
      ↓
personalized next-best action
      ↓
online checkout
OR
store reservation
      ↓
retailer fulfillment
```

Small contextual web pages may be used when a task is better served by a richer interface, such as:

```text
nearby store selection
reservation confirmation
pickup status
```

The rule is:

> **WhatsApp is the customer's primary interface; Buildwise web pages appear only when they materially improve completion of a task.**

---

# 16. AI decision boundary

The agent follows:

```text
UNDERSTAND
      ↓
CONTEXTUALIZE
      ↓
DECIDE
      ↓
ACT
      ↓
LEARN
```

Gemini can reason about:

```text
Should I intervene?
What is the customer trying to accomplish?
What problem/friction is blocking the purchase?
Should I educate?
Should I compare?
Should I recommend online purchase?
Should I recommend local pickup?
Should I find another store?
Should I suggest an alternative product?
Should I hand off to a human?
```

Deterministic code remains responsible for:

```text
customer identity
SKU identity
inventory
store distance
store hours
reservation validity
permissions
business rules
transaction execution
```

Gemini must not directly write to sensitive operational state or bypass authorization.

---

# 17. AI customer-context boundary

The AI should receive a controlled context package containing only relevant information.

Conceptually:

```text
CUSTOMER WORLD
+
BRAND WORLD
+
RETAIL WORLD
        ↓
CONTROLLED CONTEXT PACKAGE
        ↓
GEMINI
```

Example context may include:

```text
customer lifecycle
relevant preference
current intent
current product
customer location where authorized/needed
previous relevant conversation
brand policy
store availability
store hours
reservation capability
```

Do not pass unrelated customer history, credentials, payment details, or internal retailer/brand information merely because it is available.

---

# 18. Security boundary

Core security controls:

```text
Tenant isolation
+
RBAC
+
Minimum necessary context
+
Secret management
+
AI Action Guardrail
+
Audit trail
```

The security rule is:

> **AI may understand broadly enough to personalize, but it may act only within narrowly authorized boundaries.**

Example:

```text
Gemini:
“Reserve one unit at Store A.”

        ↓

Backend policy checks:

Is customer authorized?
Is brand/tenant correct?
Is SKU valid?
Is inventory available?
Is store eligible?
Is reservation permitted?

        ↓

ALLOW / BLOCK / HUMAN APPROVAL
```

---

# 19. Data boundary

Firestore is the current operational state for Buildwise.

BigQuery is the historical/event analytics layer.

Looker is the optional BI presentation layer.

Conceptually:

```text
Firestore
= current operational state

BigQuery
= event/outcome history

Looker
= business intelligence
```

The application must not become dependent on Looker for transactional operations.

---

# 20. Testing boundary

The product must be testable as both independent components and one connected journey.

Required testing categories:

```text
Unit
Integration
AI behavior/evaluation
Security
Browser/E2E
Production smoke test
```

Core happy path:

```text
Shopify
 ↓
Customer intent
 ↓
WhatsApp / simulator
 ↓
Gemini
 ↓
Store matching
 ↓
Inventory validation
 ↓
Customer chooses pickup
 ↓
Retailer
 ↓
Completed pickup
 ↓
Brand
 ↓
Analytics
```

---

# 21. M0 approval checklist

Before moving to M1, the team must agree that:

- [ ] Product problem is frozen
- [ ] Target users are frozen
- [ ] Atomic decision is frozen
- [ ] MVP customer journey is frozen
- [ ] Brand console scope is frozen
- [ ] Retailer console scope is frozen
- [ ] WhatsApp-first customer experience is frozen
- [ ] No customer dashboard is part of the MVP
- [ ] Contextual web-page security rules are defined
- [ ] Shopify role is frozen
- [ ] Shopify prototype authentication/onboarding assumption is understood
- [ ] Retail-data role is frozen
- [ ] Retail SKU mapping rule is frozen
- [ ] Retail upload limit is frozen at 10 MB for MVP
- [ ] Customer-intent instrumentation approach is frozen
- [ ] WhatsApp simulator fallback is frozen
- [ ] Gemini role is frozen
- [ ] Deterministic vs AI responsibilities are frozen
- [ ] Node.js + TypeScript backend stack is frozen
- [ ] ADK for TypeScript is frozen as the agent framework
- [ ] Data model is frozen enough to start implementation
- [ ] Integration interfaces are frozen
- [ ] Security boundaries are frozen
- [ ] Looker is clearly optional for the MVP
- [ ] Test strategy is defined
- [ ] No coding agent is allowed to redefine the product during implementation

---

# 22. Four-tool operating rule

## ChatGPT

Product owner, specification reviewer and learning mentor.

## Gemini

Google AI / Google Cloud architecture specialist.

## Claude Code

Primary implementation owner and main codebase maintainer.

## Antigravity

High-value verification, browser testing, integration testing, security attack testing and deployment/judge simulation.

### Critical rule

> **Only Claude Code continuously owns the main implementation.**

Antigravity should not independently rebuild large sections of the product.

---

# 23. Learning-while-building rule

For every major feature:

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
Read the code
  ↓
Teach back
  ↓
Verify
```

Target:

> **70% building / 30% learning**

Do not turn the M0 specification into a tutorial syllabus.

The learning happens immediately before the feature that needs it.

Use `09_LEARNING_LOG.md` to record:

```text
What is it?
Why does Buildwise need it?
How does data flow through it?
Where is it implemented?
What can fail?
What are the security implications?
What do I still not understand?
```

---

# 24. Git/repository M0 boundary

The canonical specification pack should live in the Buildwise GitHub repository.

Repository structure at M0:

```text
Buildwise/
│
├── docs/
│   ├── 01_PRODUCT_SOURCE_OF_TRUTH.md
│   ├── 02_MVP_SPEC.md
│   ├── 03_TECH_ARCHITECTURE.md
│   ├── 04_DATA_MODEL.md
│   ├── 05_AI_AGENT_SPEC.md
│   ├── 06_INTEGRATION_CONTRACTS.md
│   ├── 07_SECURITY_SPEC.md
│   ├── 08_TEST_PLAN.md
│   └── 09_LEARNING_LOG.md
│
├── frontend/
├── backend/
├── agent/
├── infrastructure/
├── tests/
├── README.md
├── .gitignore
└── .env.example
```

M0 commits should be atomic and understandable. Examples:

```text
docs(product): add Buildwise product source of truth
docs(mvp): add MVP specification
docs(architecture): freeze Node.js TypeScript architecture
docs(data): define Buildwise data model
docs(ai): define Gemini ADK agent boundaries
docs(integrations): define Shopify WhatsApp and retail contracts
docs(security): define security specification
docs(test): define test plan
docs(learning): add learn-while-building log

docs(security): define contextual customer page authorization
docs(whatsapp): define prototype simulator fallback
docs(intent): define deterministic prototype intent instrumentation
docs(retail): define retail upload limits and storage flow
docs(analytics): move Looker to optional MVP integration

docs(m0): freeze specification after architecture review
```

Do not create artificial commits for every keystroke. Commit meaningful logical changes.

The M0 endpoint should be marked with a tag such as:

```text
m0-spec-freeze
```

---

# 25. Final M0 gate

M0 is complete only when:

> **A developer who did not participate in the original research could read these files and understand what Buildwise is, what the MVP does, what it does not do, how AI participates, what external systems are integrated, how security works, and how success will be tested.**

In addition, the team must have completed three read-only architecture checks:

```text
Gemini
→ Google AI / Cloud review

Claude Code
→ repository/specification consistency review

Antigravity
→ architecture verification review
```

These checks do not authorize those tools to redefine the product.

They exist to find contradictions, implementation risks and missing boundaries **before** feature implementation starts.

---

# 26. M0 completion condition

M0 can be marked:

> **M0 — SPECIFICATION FROZEN**

only after all of the following are true:

```text
☑ Canonical specification files committed
☑ Node.js + TypeScript architecture confirmed
☑ Gemini review completed
☑ Claude Code read-only review completed
☑ Antigravity read-only verification completed
☑ Customer task-page token security defined
☑ WhatsApp fallback simulator defined
☑ Deterministic intent instrumentation defined
☑ Retail upload boundary defined
☑ Looker MVP boundary defined
☑ No unresolved architecture contradiction
☑ No secrets committed
☑ Team approves product/MVP boundaries
```

After this gate, implementation may begin from the approved specification rather than from the original research PDFs.

---

# 27. M0 operating principle

> **Freeze the decision, not the implementation.**

The architecture may evolve when implementation produces evidence of a better technical solution, but a change must be explicit, documented, reviewed, and kept consistent with the product source of truth.

The goal is a working real-world prototype—not a perfect architecture diagram.

Buildwise's product foundation remains:

```text
ONLINE COMMERCE
Shopify
      +
PHYSICAL RETAIL
Retail data
      +
CUSTOMER CONVERSATION
WhatsApp
      +
AI REASONING
Gemini + ADK
      +
OPERATIONAL EXECUTION
Cloud Run + Firestore
      +
BUSINESS INTELLIGENCE
BigQuery + optional Looker
```

And the core loop remains:

> **Digital Intent → Context → AI Decision → Conversational Action → Retail/Online Purchase → Outcome → Brand Intelligence.**
