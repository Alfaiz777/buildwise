# Buildwise — Product Source of Truth

## Status

**M0 — Frozen product definition**

---

# 1. Product name

**Buildwise**

---

# 2. Product category

AI-powered omnichannel commerce intelligence and engagement for D2C brands with online commerce and physical retail presence.

---

# 3. Problem

A D2C customer can demonstrate meaningful purchase intent online without completing the online transaction.

At the same time, the brand may have relevant products available through nearby physical retail stores.

These two realities are often disconnected:

```text
ONLINE
customer intent
product interest
website journey
Shopify commerce

        vs.

OFFLINE
store location
physical availability
store hours
retail fulfillment
```

The problem Buildwise targets is the missed opportunity between them.

Instead of treating a high-intent online customer as simply “lost,” Buildwise can use relevant context to determine whether another purchase path—especially a nearby retail path—would be more useful.

---

# 4. Product thesis

> **Connect online customer intent with nearby physical retail availability to create a personalized, low-friction path to purchase, while feeding offline outcomes back into brand intelligence.**

---

# 5. Product promise

> **Turn meaningful online customer intent into the most relevant next purchase step.**

The next step may be:

- help
- education
- comparison
- online purchase
- nearby store discovery
- store reservation
- alternative product
- human assistance
- no intervention

---

# 6. Primary buyer

D2C brands that:

- operate a Shopify-based online store
- have a physical retail/distributor/store network
- want to connect digital customer intent with offline availability
- want a more contextual customer engagement layer
- need visibility into digital-to-offline outcomes

---

# 7. Personas

## Brand

### Brand Admin

Needs:

- connection setup
- permissions
- store network
- integration health
- high-level outcomes

### Growth/Commerce/Marketing

Needs:

- customer intent
- AI-assisted opportunities
- conversations
- intervention outcomes
- online vs offline conversion

### Operations

Needs:

- retail availability
- reservations
- store activity
- operational exceptions

## Retailer

### Store Manager

Needs:

- incoming reservations
- product
- quantity
- customer ETA
- fulfillment state

### Store Staff

Needs:

- simple operational action
- reservation details
- pickup status

## Customer

Needs:

- quick answers
- relevant recommendations
- product confidence
- convenience
- availability
- store pickup when useful
- human help when AI should stop

The customer primarily interacts through WhatsApp.

---

# 8. Customer experience principle

> **WhatsApp is the customer interface; Buildwise is the intelligence behind it.**

The customer should feel:

> “I am talking to the brand and the brand understands what I need.”

They should not feel:

> “A CRM rule triggered a promotional WhatsApp message.”

---

# 9. Brand experience

Buildwise Brand Console:

```text
Overview
Customer Intent
AI Conversations
Recovered Opportunities
Retail Network
Store Availability
Reservations
Offline Conversions
AI Performance
```

The brand console should explain:

- what happened
- why Buildwise intervened
- what action was chosen
- whether the customer converted
- where the conversion happened

---

# 10. Retailer experience

Buildwise Retail Console:

```text
Reservations
Incoming Customers
Store Inventory
Pickup Queue
Customer ETA
Completed Pickups
```

A retailer should receive operational context, not the customer's entire identity graph.

---

# 11. Core journey

```text
CUSTOMER

Shopify / brand website
        ↓
Meaningful intent
        ↓
WhatsApp
        ↓
AI understands
        ↓
AI gathers relevant context
        ↓
AI selects next-best action
        ↓
Customer acts
        ↓
Online purchase OR store reservation
        ↓
Retailer fulfills if applicable
        ↓
Outcome recorded
```

---

# 12. Core decision

> **Should Buildwise intervene, and if so, what is the most helpful next action for this customer in this context?**

The system should not assume that every high-intent customer needs the same action.

---

# 13. Personalization definition

Personalization in Buildwise is contextual, not cosmetic.

The system may use:

```text
customer identity/lifecycle
+
intent
+
product
+
relevant history/preferences
+
location
+
time
+
store availability
+
store hours
+
retail fulfillment capability
+
brand rules
```

to determine the next action.

Example:

```text
“I need it today.”
→ local store

“Is this good for oily skin?”
→ education

“Which one should I buy?”
→ guided comparison

“When will it arrive?”
→ delivery information

“I want a person.”
→ human handoff
```

---

# 14. AI definition

Buildwise is not “AI because a chatbot is included.”

The AI must perform meaningful reasoning across multiple contexts:

```text
Customer World
+
Brand World
+
Retail World
        ↓
Gemini
        ↓
Next-Best Action
```

AI responsibilities:

- intent understanding
- conversation understanding
- context synthesis
- intervention decision
- next-best-action selection
- personalized response generation
- human-handoff decision

---

# 15. Deterministic responsibility

The application is responsible for verified facts and execution:

- customer identity
- tenant
- permissions
- product/SKU identity
- distance
- inventory
- store hours
- reservation validity
- business rules
- API calls
- database writes
- outcome recording

---

# 16. Outcome model

Buildwise measures outcomes rather than message volume.

Core outcome types:

```text
NO_ACTION
CONVERSATION_STARTED
PRODUCT_EDUCATION
ONLINE_PURCHASE
STORE_RESERVATION
STORE_PURCHASE
ALTERNATIVE_PURCHASE
HUMAN_HANDOFF
NO_CONVERSION
```

---

# 17. Product boundaries

Buildwise is not:

- a Shopify replacement
- a POS
- a warehouse management system
- a generic marketing automation platform
- a generic chatbot
- a generic store locator
- a full CRM
- a complete customer data platform

---

# 18. Product success for the prototype

The prototype succeeds if a judge can observe:

```text
Shopify context
→ customer intent
→ AI understands context
→ WhatsApp conversation
→ store/online decision
→ verified action
→ retailer interaction
→ outcome
→ brand intelligence
```

and understand why Buildwise exists.
