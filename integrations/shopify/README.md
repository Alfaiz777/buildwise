# Qwikspot on a Shopify store

One theme snippet sends the shopper's steps to Qwikspot (so Qwikspot knows the product and how far
along they are) and adds two ways into WhatsApp:

- **"Need it today? Ask on WhatsApp"** under the Add to cart button on product pages;
- a round **WhatsApp bubble** at the bottom right of every page.

Tapping either opens WhatsApp with a ready message, for example
`Hi AquaSkin! I'd like Mineral Sunscreen SPF 50 (50 g) today. Is it available at a store near me? (ref START_QWIKSPOT_…)`.
When the shopper sends it, Qwikspot links the chat to what they were browsing and answers about that
product straight away. The `(ref …)` part is a one-time code (30 minutes); it contains no personal data.

## Files

| File | What it is |
|---|---|
| `qwikspot.liquid` | **The file to paste into the theme.** Generated — do not edit it by hand. |
| `qwikspot-shopify.js` | The script's source. After a change, run `npm run shopify:snippet` to rebuild `qwikspot.liquid`. |
| `qwikspot.liquid.template` | The Liquid around the script (the two settings and the data Shopify provides). |

The two settings sit at the top of `qwikspot.liquid`:

```liquid
assign qs_api = 'https://app.qwikspot.urbanlyfe.in'   # where Qwikspot runs
assign qs_brand = 'brd_demo'                           # this store's brand id in Qwikspot
```

## Install (Online Store 2.0 themes, e.g. Savor or Dawn)

1. Shopify admin → **Online Store → Themes → … (on the live theme) → Edit code**.
2. **Snippets → Add a new snippet** named `qwikspot`. Paste the whole of `qwikspot.liquid` and **Save**.
3. Open **layout/theme.liquid** and, on the line just before `</body>`, add:

   ```liquid
   {% render 'qwikspot' %}
   ```

   **Save**.
4. In Qwikspot: **Brand Console → Settings → Storefronts allowed to send shopper events → Add a storefront**,
   enter the store's address (for AquaSkin: `https://m6ccxz-wk.myshopify.com`) and press **Add**.
   Until it is on that list, Qwikspot does not record the store's events; the buttons still open the
   brand's WhatsApp chat, but without the product and the reference. If the store also has its own domain
   (e.g. `https://aquaskin.in`), add that too.
5. The brand needs its own WhatsApp number connected in Qwikspot (Settings → Channels: WhatsApp). Without one,
   the two buttons hide themselves as soon as Qwikspot answers the first event.

## How a tap opens WhatsApp

Both entry points are ordinary links to Qwikspot's `/api/wa` redirect (with the brand, the entry, the chosen
size and the two random browser ids). A tap goes there straight away — nothing has to load first — and the
redirect records the click, creates the one-time reference, and sends the shopper on to `wa.me` with the
message. On a phone the link opens in the same tab, so Android and iOS hand it to the WhatsApp app; on a
computer it opens WhatsApp Web in a new tab. The button shows "Opening WhatsApp…" for a few seconds.

The bubble sits at the bottom right, above the phone's home bar, and moves up when the theme shows a bar fixed
to the bottom of the screen (for example Savor's sticky Add to cart), so it never covers the theme's buttons.

## GA4 (optional, reporting only)

Install Shopify's free **Google & YouTube** app (Shopify admin → Apps) and connect a GA4 property. It sends the
standard shop events (view item, add to cart, checkout, purchase). The snippet adds one event of its own when
GA4 is present: `qwikspot_whatsapp_click` with `entry` (`STORE_NEED` or `CHAT`), `item_id` (the numeric variant id)
and `item_name` (the product title). No Qwikspot reference or personal data goes to GA4.

GA4 does not detect intent — it reports totals hours later. Qwikspot's snippet does that in real time.

## Test on a phone

1. Open the store in **Chrome on the phone** (or Safari on an iPhone) → a product → choose a size.
2. Tap **Need it today? Ask on WhatsApp** → the WhatsApp app opens with the message.
3. Send it → the reply names that product (and size) and the nearest store that has it.
4. In the Brand Console → Conversations the chat shows the web intent (product, the steps before WhatsApp).
5. Tap the round WhatsApp bubble on any page → the app opens with "Hi AquaSkin! I have a question about …".

On a computer the button opens WhatsApp Web in a new tab.

## If nothing happens

The snippet never shows errors to shoppers. Open the store on a computer, press **F12 → Console**, and reload:

- `[Qwikspot] storefront events are not reaching Qwikspot: HTTP 403 ORIGIN_NOT_ALLOWED` — the store's address is
  not in Brand Console → Settings → Storefronts allowed to send shopper events (step 4);
- `… HTTP 404 UNKNOWN_VARIANT` — the product is not in Qwikspot's catalogue yet: Settings → Shopify → Sync products;
- `… blocked (CORS/network)` — the browser could not reach Qwikspot (the deployed backend is older than this
  version, an ad blocker, or no connection).

At most one such line appears per page. To test on the phone itself, Chrome's remote debugging
(`chrome://inspect` on a computer with the phone connected by USB) shows the same console.

## What it sends

Only event types (`STOREFRONT_VISIT` once per browser session, `SEARCH` with the search words,
`PRODUCT_DETAIL_VIEW`, `VARIANT_SELECTED`, `ADD_TO_CART`, `CHECKOUT_STARTED`, `WHATSAPP_CLICK`), the product
variant as `gid://shopify/ProductVariant/<id>`, and two random ids the Qwikspot script keeps in the browser
(`web_session_id`, `visitor_id`). Never names, emails, phone numbers, addresses or cart tokens. If Qwikspot
cannot be reached, nothing visible happens — the theme works as before.

## Remove

1. Delete the line `{% render 'qwikspot' %}` from **layout/theme.liquid** and save.
2. Delete the `qwikspot` snippet.
3. Optional: remove the store from Brand Console → Settings → Storefronts allowed to send shopper events.
