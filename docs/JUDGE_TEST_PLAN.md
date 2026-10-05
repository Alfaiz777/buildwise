# Judge test plan — manual

A hands-on test you run yourself, the way a judge would, to check that the five surfaces work together:

- **Landing** (`/`)
- **Shop + chat** (`/shop`, `/chat`) — the shopper demo
- **Store Console** (`/store`)
- **Brand Console** (`/brand`)
- **Platform Console** (`/platform`)

Everything uses synthetic demo data: the brand **Demo Beauty Co**, its Mumbai stores (**Bandra Store**, **Andheri Store**, **Powai Store**) and Pune store (**Koregaon Park Store**), and four weeks of generated history.

Each step says **who acts**, **what to do**, **what you should see** and **what should change on the other screens**. Fill in the results table at the end.

---

## 1. Setup

### 1.1 Start the app locally

You need Node.js 24 and Java 21+. Run each command from the repository root.

```bash
npm install
cp backend/.env.example backend/.env   # turns on DEMO_MODE (demo logins, Reset demo, shopper demo)
npm run emulators       # terminal 1 — Auth + Firestore emulators
npm run seed:demo       # terminal 2 — demo brand, stores, stock, users, 4 weeks of synthetic history
npm run dev:backend     # terminal 2 — API on :8080
npm run dev:frontend    # terminal 3 — http://localhost:5173
```

### 1.2 Demo logins

Open <http://localhost:5173/login>. Under **Try the demo**, each account has a **Use …** button that fills in the form. The password for every account is `qwikspot-demo-1`.

| Who | Email | Login button title |
|---|---|---|
| Brand | `admin@demo-brand.test` | Brand Admin — Demo Beauty Co |
| Store (Andheri) | `retail-admin-north-2@qwikspot.test` | Retail Admin — Andheri Store |
| Store (Bandra) | `retail-admin-north-1@qwikspot.test` | Retail Admin — Bandra Store |
| Platform | `platform@qwikspot.test` | Platform Admin |

The shopper never logs in. In the shop's **Demo controls** you can **Sign in as demo shopper: Asha (opted in)** or **Ravi (not opted in)**, or **Continue as guest**.

Sign-in is **per browser tab**: a new tab starts signed out.

### 1.3 Windows side by side

Open four browser windows (or tabs you can switch between quickly):

| Window | Open | Sign in as |
|---|---|---|
| A — Shopper | <http://localhost:5173/shop> (or the landing page `/`) | no login |
| B — Store | <http://localhost:5173/login?as=store> | Retail Admin — Andheri Store |
| C — Brand | <http://localhost:5173/login?as=brand> | Brand Admin — Demo Beauty Co |
| D — Platform | <http://localhost:5173/login?as=platform> | Platform Admin |

On a wide screen (1440 px), the shop opens the chat **docked to the right of the page**. On a phone width, the chat opens full screen at `/chat`.

### 1.4 Start every story from Reset demo

1. In window C (Brand), go to **Overview** and open the **Demo guide**.
2. Press **Reset demo**.
3. A dialog says "This resets the shared demo for everyone." Press **Yes, reset the demo**.
4. You should see a line that starts "Demo reset: 10 products synced, store stock restored, … synthetic outcomes rebuilt."
5. Reload windows A, B and D.

Reset works at most **once a minute**. A second press within a minute is refused with an error message; wait and press again.

Reset deletes every chat, hold and demo shopper from earlier tests. It keeps the accounts, stores and the audit log.

---

## 2. Demo stories

### Story a — Intent capture: same-day pickup instead of waiting for delivery

| # | Who | Action | Expected on that screen | Expected on other screens |
|---|---|---|---|---|
| a1 | Shopper (A) | Open `/`. Click **See it as a shopper**. | The landing page says a slow delivery "becomes a same-day pickup". The link opens the brand's demo store (a new tab). | — |
| a2 | Shopper | Click **Vitamin C Glow Serum**. | The product page shows sizes **30 ml · ₹795** and **50 ml · ₹1,195**, **Add to bag**, and the Qwikspot widget: **Need it today? Check a store near you**, **Chat on WhatsApp**, "Powered by Qwikspot". | — |
| a3 | Shopper | Keep **30 ml** selected. Click **Need it today? Check a store near you**. | The brand's chat opens ("Demo Beauty Co · usually replies instantly"). The message box already holds a ready-made message. | — |
| a4 | Shopper | Press **Send** (the arrow). | Your message appears on the right. The brand replies on the left. | Brand (C) → **Conversations**: a new conversation `sim:judge_…` appears (press **Refresh** if needed). |
| a5 | Shopper | Press the 📍 pin (**Share location**) and pick **Near Powai**. | A product card with the serum picture. It says *Vitamin C Glow Serum 30 ml* · ₹795, "Available today at **Andheri Store**", the distance and opening time, and "I can hold one for you to pick up and pay at the store." Buttons: **Hold at Andheri** and **Buy online**. Footer: "Powered by Qwikspot". | — |
| a6 | Shopper | Press **Hold at Andheri**. | The pickup pass: "✅ **On hold for you**", 1 × Vitamin C Glow Serum 30 ml, "**Andheri Store**" with its address, "Pickup code: **six digits**", "Held until HH:MM (store time) · pay at the store", "The store will confirm when it's ready." A location card with **Open in Maps**, and a **Cancel reservation** button. | Store (B) → **Today**: within about 15 seconds (or press **Refresh**) a toast "New hold: 1 × Vitamin C Glow Serum 30 ml — confirm it" appears, the hold shows in **Next up**, and the **Today** tab shows a badge **1**. |

**Note:** the chat never promises a delivery time. The "4–5 day delivery" comparison appears only in the landing page copy.

**Pass if:** the chat offers **Andheri Store** (not Powai, which is out of stock), the pickup pass shows a 6-digit code, and the hold appears in Andheri's **Today**.

### Story b — The store fulfils the hold

Continue from story a, without a reset.

| # | Who | Action | Expected on that screen | Expected on other screens |
|---|---|---|---|---|
| b1 | Store (B) | Look at the **Next up** card. | 1 × Vitamin C Glow Serum 30 ml, "New — needs confirming", "Customer •••• XXXX" (masked), held until (store time) and "expires in N min". It also says: **Why this hold came to you:** "Powai Store was closer but out of stock. You were the nearest store with stock — 7.6 km from the customer." | — |
| b2 | Store | Press **Confirm**. | A notice: "1 × Vitamin C Glow Serum 30 ml: Confirmed (customer notified). …" and a toast. The card now offers **Mark ready**. | Shopper chat (A): "✅ **Andheri Store confirmed your hold**", with the pickup code and held-until time (it arrives within about 3 seconds). |
| b3 | Store | Press **Mark ready**. | Status "Ready for pickup". | Shopper chat: "🛍️ **Ready at Andheri Store** … Show code **XXXXXX** at the counter.", plus a location card. |
| b4 | Store | Press **Customer arrived**. | Status "Customer here". A box "Customer's pickup code" appears with the hint "Ask for the 6-digit code in their WhatsApp." | No new chat message (expected). |
| b5 | Store | Type the 6-digit code from the shopper's chat. Press **Complete**. | "…: Completed." The hold leaves **Today**. **History** shows it as "Picked up — in-store purchase". | No new chat message (expected). |
| b6 | Brand (C) | **Conversations** → open the `sim:judge_…` conversation. | The **Journey** timeline runs: Visited the store → Opened Vitamin C Glow Serum → Tapped "Need it today?" → Started a WhatsApp chat → Shared a location → Qwikspot looked for a store → Hold placed at Andheri Store → Andheri Store confirmed the hold → Ready for pickup at Andheri Store → Customer arrived at Andheri Store → **Picked up at Andheri Store — in-store purchase · ₹795 est.** **Why Qwikspot did this** shows a card like "Offered Andheri Store (7.6 km) because Powai Store (0.7 km) is out of stock and Bandra Store (10.6 km) is too far." The **Messages** card shows the chat exactly as the shopper saw it, with labels (AI assistant, Store update). | — |
| b7 | Brand | **Reservations**. | The hold's row: product, Andheri Store, status **Completed**, outcome "Picked up — in-store purchase". Clicking the row opens the conversation. | — |
| b8 | Platform (D) | Before b2, note the Overview tiles **Holds** and **Store pickups**. After b5, reload. | **Holds** and **Store pickups** are each **one higher**. **Retail network** (Demo Beauty Co) → Andheri Store shows **Picked up** one higher. | — |

**Pass if:**
- the store sees the masked customer and the "why" text;
- the chat shows the confirmed and ready updates;
- the brand journey ends with "Picked up at Andheri Store — in-store purchase";
- the platform totals each go up by one.

### Story c — Store refusal: the shopper is offered the next store

Reset first. Use **Near Bandra**, so that Bandra is the nearest store and Andheri is next. From Near Powai, Bandra counts as "too far", so a refusal there would offer only buying online.

| # | Who | Action | Expected on that screen | Expected on other screens |
|---|---|---|---|---|
| c1 | Shopper (A) | Shop → Vitamin C Glow Serum 30 ml → **Need it today? Check a store near you** → **Send** → 📍 **Near Bandra**. | The card offers **Bandra Store** (about 0.7 km) with **Hold at Bandra**, **Other stores** and **Buy online**. | — |
| c2 | Shopper | Press **Hold at Bandra**. | The pickup pass for Bandra Store. | Store window logged in as **Retail Admin — Bandra Store** (window B2): the hold appears in **Next up**. |
| c3 | Store (Bandra) | In **Refuse because…** pick **Not actually in stock**. Press **Refuse**. | "…: Cancelled (customer notified)." **History** shows "Refused: Not actually in stock". | Shopper chat: "Sorry — Bandra Store can't fulfil your reservation for Vitamin C Glow Serum 30 ml after all." It then offers **Andheri Store** with a **Hold at Andheri** button. |
| c4 | Shopper | Press **Hold at Andheri**. | A new pickup pass for Andheri Store. | Andheri's **Today** (window B): the new hold, with a "Why this hold came to you" line. |
| c5 | Brand (C) | **Conversations** → this conversation. **Overview**. **Reservations** (filter **Refused**). | The journey shows "Bandra Store refused: not actually in stock", then the new hold at Andheri. **Overview → Needs your attention**: "Bandra Store refused 1 hold in the last 24 h — not actually in stock". Reservations → **Refused**: the Bandra row, with outcome "Refused: not actually in stock". | — |
| c6 | Store (Bandra) | **Demand**. | Under "When you were the nearest store", the line "Holds you refused: Not actually in stock 1" (with synthetic history included). | — |

**Out of stock without a refusal** is story a: Powai Store is out of stock, so Andheri is offered. In the Brand Console it reads "Powai Store (0.7 km) is out of stock".

**Note:** refusing as **Not actually in stock** also corrects Bandra's stock. Reset before the next story.

**Pass if:**
- after the refusal the shopper is apologised to and offered **Andheri Store**, never Bandra again;
- the reason "not actually in stock" shows for the store (History) and the brand (journey, Overview, Reservations);
- the shopper never sees the store's reason.

### Story d — The shopper buys online instead

Reset first.

| # | Who | Action | Expected on that screen | Expected on other screens |
|---|---|---|---|---|
| d1 | Shopper (A) | Shop → Vitamin C Glow Serum 30 ml → **Need it today? Check a store near you** → **Send** → 📍 **Near Powai**. | The Andheri card with **Hold at Andheri** and **Buy online**. | — |
| d2 | Shopper | Press **Buy online**. | "You can order Vitamin C Glow Serum online here: http://localhost:5173/shop?qs_ref=…#product=prd_1001" | — |
| d3 | Shopper | Click the link. | The demo store opens on the Vitamin C Glow Serum product page. | — |
| d4 | Shopper | **Add to bag** → the bag icon → **Checkout** → **Place order**. | "**Order placed** — Thank you! Any pending follow-up for this session is now suppressed." | — |
| d5 | Brand (C) | **Conversations** → this conversation. | The journey ends with "**Ordered online · ₹795 est.**" | — |
| d6 | Brand | **Insights**. | Under the funnel, "Outcomes: … online order N" is one higher than before d4. | — |
| d7 | Platform (D) | **Overview**. | **Attributed online orders** is one higher. | — |

**Pass if:** the order made through the chat's link is counted as an online order for this conversation (Brand journey), in Insights and on the Platform.

### Story e — Cart abandonment follow-up, only for an opted-in shopper

Reset first. The demo brand sends a cart follow-up when the shopper has been inactive for **1 minute** and the follow-up's **2-minute** delay has passed. Allow about **3 minutes**.

**Note:** while the Brand **Conversations** page is open locally, it also processes due work by itself every 30 seconds. So the follow-up may arrive before you press the button. That is fine.

| # | Who | Action | Expected on that screen | Expected on other screens |
|---|---|---|---|---|
| e1 | Shopper (A) | Shop → **Demo controls** → **Sign in as demo shopper: Asha (opted in)**. | "Signed in as Asha (opted in to messages)." The drawer closes. | — |
| e2 | Shopper | Vitamin C Glow Serum → **Add to bag**. Then do nothing ("leave"). | "Vitamin C Glow Serum added to your bag." | Brand → **Conversations** → **Intents** tab: an intent for Asha's customer (`sim:shopper_3002_…`), Cart abandonment, follow-up **Scheduled**. |
| e3 | Brand (C) | After about 3 minutes: **Conversations** → **Process due work now**. | A toast and a line: "Due work processed: 1 follow-up sent, …". | — |
| e4 | Shopper | Open the chat (**Chat on WhatsApp** on the product page, or `/chat?brand=brd_demo` in the same tab). | A message with the serum picture: "Hi, this is Demo Beauty Co. You still have Vitamin C Glow Serum (30 ml) in your cart. Any questions before you complete your order?" then "Reply STOP to opt out." Buttons: **Find a store near me**, **Buy online**, **Talk to a person**. Footer "Powered by Qwikspot". | Brand: the conversation's **Messages** labels it "Follow-up · Template". |
| e5 | Shopper (new tab or private window) | **Demo controls** → **Sign in as demo shopper: Ravi (not opted in)** → add the serum to the bag → leave. | — | After about 3 minutes, **Process due work now** sends **no** follow-up to Ravi. **Intents** shows the reason "The customer has not opted in to messages." |
| e6 | Shopper (another new tab) | **Continue as guest** → add to bag → leave. | — | No follow-up. **Intents** reason: "Anonymous visitor: no known, reachable customer to message." |

**Pass if:**
- Asha (opted in) gets exactly one follow-up in her own chat;
- Ravi (not opted in) and the guest get none, and the Intents tab says why.

### Story f — Human handoff: the brand takes over

Reset first.

| # | Who | Action | Expected on that screen | Expected on other screens |
|---|---|---|---|---|
| f1 | Shopper (A) | Open a chat (for example, from the product page, **Chat on WhatsApp**). Type "I want to talk to a person" and send it. | "Thanks. I've asked a member of the Demo Beauty Co team to take over this conversation. They will reply here." This message has **no** "Powered by Qwikspot" footer (it is plain text). | Brand (C): the **Conversations** nav item shows a badge. The conversation is marked "needs a person · waiting N min". **Overview → Needs your attention**: "1 customer is waiting for a person — longest N min". |
| f2 | Shopper | Type another question (for example, "Is it good for oily skin?"). | **No** automated reply: a person owns the conversation now. | — |
| f3 | Brand | **Conversations** → filter **Needs a person** → open it. In the **Reply as a person** box, type a reply. Press **Send reply**. | The reply appears in the transcript labelled "Team member". | Shopper chat: the reply arrives **from Demo Beauty Co** with **no "Powered by Qwikspot" footer**. The team member's name or email is never shown. |
| f4 | Brand | Press **Resolve and return to assistant**. | The "needs a person" mark and the nav badge go away. | The shopper's next message gets automated replies again. |

**Pass if:**
- after the handoff, the assistant stops replying;
- the brand's reply reaches the shopper as the brand, with no "Powered by Qwikspot" footer;
- after Resolve, the assistant replies again.

### Story g — Opt-out: no more follow-ups

Reset first.

| # | Who | Action | Expected on that screen | Expected on other screens |
|---|---|---|---|---|
| g1 | Shopper (A) | Shop → **Demo controls** → **Sign in as demo shopper: Asha (opted in)**. Open the chat (**Chat on WhatsApp**). Type **STOP** and send it. | Your "STOP" appears. There is **no reply** (expected: STOP silently opts out). | — |
| g2 | Shopper | Ask anything else in the chat. | **No reply**: automation stops for an opted-out customer. | — |
| g3 | Shopper | Vitamin C Glow Serum → **Add to bag** → leave. | — | Brand → **Intents**: Asha's intent shows the reason "The customer opted out." |
| g4 | Brand (C) | After about 3 minutes: **Process due work now**. | "… 0 follow-ups sent …" for Asha. | Shopper chat: no follow-up arrives. |
| g5 | Brand | Open Asha's conversation. | The **Messages** card shows "STOP" from the customer and no reply after it. There is no **Reply as a person** box (the conversation was not handed to a person). | — |

**Pass if:** after STOP the shopper gets no automated messages and no follow-up, and the brand can see the reason "The customer opted out."

### Story h — Demand insights (weekday / weekend, unmet demand)

No reset needed. This story reads the four weeks of synthetic history.

| # | Who | Action | Expected on that screen | Expected on other screens |
|---|---|---|---|---|
| h1 | Brand (C) | **Insights**, **Last 7 days**, with "Include synthetic demo history" on. | A notice "Includes synthetic demo history (N generated records)". A **Journey funnel** chart with "→ %" step conversions. **Demand vs availability by weekday**: a rule-based sentence such as "Saturday lookups for Vitamin C Glow Serum 30 ml were 1.9× the other days' average, but 80% found no store with stock … This looks like an availability problem, not a demand problem.", and a bar chart with one day marked **problem day**. | — |
| h2 | Brand | Scroll down. | **Suggested next actions**, such as "… ask North Retail to stock Andheri Store", with **Open Andheri Store →** links. **Unmet local demand**: Serum 30 ml / 50 ml near Andheri, by weekday, with the reasons. **Did the recommendation convert?** and **Fill rate by store**. | — |
| h3 | Brand | Untick "Include synthetic demo history". | The numbers drop to live activity only. They may be zero or nearly empty. | — |
| h4 | Store (Andheri) | **Demand**. | **Missed demand** (for example, Vitamin C Glow Serum 30 ml, Saturday, out of stock). **When you were the nearest store**: a weekday chart with the worst day marked **problem day**. **From Demo Beauty Co**: the suggestions that name Andheri Store. | — |
| h5 | Store (Bandra) | **Demand**. | Only Bandra's own rows. Nothing about Andheri's numbers. | — |

**Pass if:** the brand sees a weekday reading with a problem day, plus unmet demand and suggestions; the Andheri store sees its own slice; and turning off synthetic history changes the numbers.

---

## 3. Privacy and isolation checks

| # | Check | How | Pass if |
|---|---|---|---|
| p1 | Two shoppers who are both "Asha" never see each other's chat | Use one **normal** window and one **private/incognito** window. In both: `/shop` → **Demo controls** → **Sign in as demo shopper: Asha (opted in)** → **Chat on WhatsApp**. Send "secret from window 1" in the first and "secret from window 2" in the second. Wait 5 seconds. | Each window shows only its own message. Brand → **Conversations** shows **two different** conversations (`sim:shopper_3002_xxxxxxxx`, with different endings). |
| p2 | A store cannot see another store's data | Sign in as **Retail Admin — Bandra Store** in one window and **Andheri** in another. Place a hold at Andheri (story a). | Bandra's **Today**, **History** and **Demand** never show Andheri's hold or numbers. There is no store picker. |
| p3 | The store never sees who the customer is | Look at any hold card in the Store Console. | Only "Customer •••• XXXX". No name, phone, location, coordinates or chat messages. The "why" line names stores and gives only this store's distance. |
| p4 | The Platform Console shows totals only | Platform → **Overview**, **Brands**, **Retail network**, **Audit**. | Only counts, %, ₹ estimates, store names, cities and Yes/Not yet for Store Admin. No customer names, phone numbers, messages, pickup codes, stock lines or Store Admin emails. The only email on screen is your own, in the header. |
| p5 | Each role is kept out of the other consoles | While signed in as each role, type the other consoles' addresses: `/brand`, `/store`, `/platform`. | You are sent back to your own console: Brand → `/brand`, Store → `/store`, Platform → `/platform`. No other console's page ever shows. |
| p6 | Signed out, the consoles need a login | In a new tab (signed out), open `/brand`, `/store`, `/platform`. | You are sent to the sign-in page. |

---

## 4. Phone check

Set the browser to a phone width: open the developer tools' device toolbar and choose a width of about **390 px**. Reset, then repeat **story a** and **story b**.

- **Shop:** **Need it today? Check a store near you** opens the chat **full screen** (`/chat`), not docked.
- **Chat:** buttons, the "Choose a store" list sheet and the location card fit the screen.
- **Consoles:** they show a bottom tab bar (Store: Today · History · Stock · Demand). Tables scroll inside their card.
- **No sideways scroll:** no page scrolls sideways.

**Pass if:** stories a and b work end to end at phone width, with nothing cut off and no sideways page scroll.

---

## 5. Results

| Story / check | Pass / Fail | Notes |
|---|---|---|
| Setup and Reset demo | | |
| a — Intent capture, same-day pickup | | |
| b — Store fulfils, all screens update | | |
| c — Store refusal, next store offered | | |
| d — Online purchase attributed | | |
| e — Cart follow-up, opted-in only | | |
| f — Human handoff, no footer on human replies | | |
| g — Opt-out stops follow-ups | | |
| h — Demand insights (brand and store) | | |
| p1 — Two "Asha" windows isolated | | |
| p2 — Store cannot see another store | | |
| p3 — Store never sees the customer | | |
| p4 — Platform shows totals only | | |
| p5 — Roles kept out of other consoles | | |
| p6 — Signed-out access needs login | | |
| Phone — story a | | |
| Phone — story b | | |
