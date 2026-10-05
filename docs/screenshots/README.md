# Screenshots — the 10-minute judge script

Every image here was taken by `scripts/judge-script.mjs`, which starts with **Reset demo** and then performs the judge script through the UI only, at desktop (1440 px) and phone (390 px) widths. All data is synthetic: Demo Beauty Co, its Mumbai stores and four weeks of flagged demo history.

Run it yourself on the local stack (emulators, `seed:demo`, backend, Vite): `BASE_URL=http://localhost:5173 node scripts/judge-script.mjs`.

| # | Surface | Step | What it shows | Desktop | Phone |
|---|---|---|---|---|---|
| 01 | Landing | 1 | What Qwikspot does, the Brand and Store doors, "See it as a shopper" | [desktop](01-landing-desktop.jpg) | [phone](01-landing-phone.jpg) |
| 02 | Shopper demo | 1 | The brand's demo store, products with self-made illustrations | [desktop](02-shop-desktop.jpg) | [phone](02-shop-phone.jpg) |
| 03 | Shopper demo | 2 | The product page with the Qwikspot widget: "Need it today?", "Chat on WhatsApp", "Powered by Qwikspot" | [desktop](03-shop-product-desktop.jpg) | [phone](03-shop-product-phone.jpg) |
| 04 | Chat | 3 | Near Powai: Powai is out of stock, so Andheri is offered — image header, facts, reply buttons, footer | [desktop](04-chat-store-found-desktop.jpg) | [phone](04-chat-store-found-phone.jpg) |
| 05 | Chat | 3 | The pickup pass: pickup code, held until (store time), pay at the store, the store's location card | [desktop](05-chat-pickup-pass-desktop.jpg) | [phone](05-chat-pickup-pass-phone.jpg) |
| 06 | Store Console | 4 | Today: the value strip, **Next up** with one big action, and why this hold came to the store | [desktop](06-store-next-up-desktop.jpg) | [phone](06-store-next-up-phone.jpg) |
| 07 | Chat | 4 | The store's confirmation arrives in the shopper's chat | [desktop](07-chat-store-update-desktop.jpg) | [phone](07-chat-store-update-phone.jpg) |
| 08 | Store Console | 4 | History after Complete: "Picked up — in-store purchase" | [desktop](08-store-history-desktop.jpg) | [phone](08-store-history-phone.jpg) |
| 09 | Brand Console | 5 | The conversation's journey (website → chat → decision → hold → store steps → pickup), the chat as the customer saw it, and why Andheri was offered | [desktop](09-brand-journey-desktop.jpg) | [phone](09-brand-journey-phone.jpg) |
| 10 | Brand Console | 6 | Insights: funnel with step conversion, weekday chart with the problem day, suggestions linked to the store | [desktop](10-brand-insights-desktop.jpg) | [phone](10-brand-insights-phone.jpg) |
| 11 | Brand Console | 6 | Overview: results first, what needs attention, the demo guide | [desktop](11-brand-overview-desktop.jpg) | [phone](11-brand-overview-phone.jpg) |
| 12 | Chat | 7 | Asha (her own synthetic customer) gets the cart follow-up with quick replies | [desktop](12-chat-follow-up-desktop.jpg) | [phone](12-chat-follow-up-phone.jpg) |
| 13 | Platform Console | 8 | Overview: results across brands as counts, brands needing attention | [desktop](13-platform-overview-desktop.jpg) | [phone](13-platform-overview-phone.jpg) |
| 14 | Platform Console | 8 | Retail network: stores with counts and health flags — never a customer | [desktop](14-platform-network-desktop.jpg) | [phone](14-platform-network-phone.jpg) |
| 15 | Platform Console | 8 | System: how Qwikspot runs today (Mock AI, simulator, mock catalogue), version | [desktop](15-platform-system-desktop.jpg) | [phone](15-platform-system-phone.jpg) |

JPEG, quality 80. The full review sets of each phase (every screen and state, PNG) are produced by `scripts/screenshots.mjs` into the git-ignored `.screenshots/`.
