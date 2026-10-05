#!/usr/bin/env node
/**
 * docs/JUDGE_TEST_PLAN.md, run for real in a browser (judge-test fixes). Every story a–h,
 * the privacy checks p1–p6 and the phone check, through the UI only, each story starting
 * from **Reset demo** where the plan says so. Prints the plan's results table (Pass / Fail
 * with notes) and exits non-zero if any row fails. On a failure the page is saved to
 * .screenshots/judge-test-plan/ (git-ignored).
 *
 *   BASE_URL=http://localhost:5173 node scripts/judge-test-plan.mjs [a b c …]
 *
 * Needs the local stack (emulators, seed:demo, backend, Vite on the demo brand's allowed
 * origin) and the demo logins. Takes about 20 minutes: Reset is limited to once a minute,
 * and stories e and g wait for the 3-minute follow-up timing.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD ?? 'qwikspot-demo-1';
const FAIL_DIR = '.screenshots/judge-test-plan';
const T = 25_000;
const USERS = {
  brand: 'admin@demo-brand.test',
  andheri: 'retail-admin-north-2@qwikspot.test',
  bandra: 'retail-admin-north-1@qwikspot.test',
  platform: 'platform@qwikspot.test',
};
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
/** 1 min inactivity + 2 min cart-abandonment delay, and a little slack. */
const FOLLOW_UP_DUE_MS = 3 * 60_000 + 15_000;

let browser;
let lastReset = 0;
const results = [];
const only = new Set(process.argv.slice(2));

class Check extends Error {}
const must = (cond, message) => {
  if (!cond) throw new Check(message);
};
const log = (text) => console.log(`     ${text}`);

async function page(viewport = DESKTOP) {
  return (await browser.newContext({ viewport })).newPage();
}

async function login(user, viewport = DESKTOP) {
  const p = await page(viewport);
  await p.goto(`${BASE}/login`);
  await p.getByLabel('Email').fill(USERS[user]);
  await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: T });
  await p
    .getByRole('button', { name: 'Dismiss this note' })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  return p;
}

const text = async (p) => (await p.locator('body').innerText()).replace(/\s+/g, ' ');
const seeText = (p, pattern, timeout = T) =>
  p
    .getByText(pattern)
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);
async function expectText(p, pattern, what, timeout = T) {
  must(await seeText(p, pattern, timeout), `${what}: did not see ${pattern}`);
}
async function noHorizontalScroll(p, where) {
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  must(over <= 0, `${where}: the page scrolls sideways by ${over} px`);
}

/** Reset demo from the Brand Console (at most once a minute). */
async function reset(brand) {
  const wait = lastReset + 62_000 - Date.now();
  if (wait > 0) {
    log(`… waiting ${Math.ceil(wait / 1000)} s (Reset demo works once a minute)`);
    await brand.waitForTimeout(wait);
  }
  await brand.goto(`${BASE}/brand`);
  await brand.getByRole('button', { name: 'Reset demo' }).click();
  await brand.getByRole('button', { name: 'Yes, reset the demo' }).click();
  await brand.getByText(/Demo reset:/).waitFor({ timeout: 90_000 });
  lastReset = Date.now();
}

/** /shop → the serum's product page. */
async function serumPage(p) {
  await p.goto(`${BASE}/shop`);
  await p
    .getByRole('button', { name: /Vitamin C Glow Serum/ })
    .first()
    .click({ timeout: T });
  await p.getByRole('button', { name: /Need it today\? Check a store near you/ }).waitFor({ timeout: T });
}

/** The chat region (docked on desktop, /chat on a phone). */
const chatOf = (p) => p.getByRole('region', { name: /^Chat with / });
const bubbles = (chat) => chat.locator('.wa-msg--in');
const lastBubble = (chat) => bubbles(chat).last();

/** Product page → "Need it today?" → Send → the brand's first reply. */
async function startChat(p) {
  await p.getByRole('button', { name: /Need it today\? Check a store near you/ }).click();
  const chat = chatOf(p);
  await chat.waitFor({ timeout: T });
  await chat.getByRole('button', { name: 'Send' }).click();
  await bubbles(chat).first().waitFor({ timeout: T });
  return chat;
}

async function shareLocation(chat, place) {
  await chat.getByRole('button', { name: 'Share location' }).click();
  await chat.getByRole('menuitem', { name: new RegExp(place) }).click();
}

async function say(chat, message) {
  const before = await chat.locator('.wa-msg').count();
  await chat.getByLabel('Message', { exact: true }).fill(message);
  await chat.getByRole('button', { name: 'Send' }).click();
  await chat.locator('.wa-msg').nth(before).waitFor({ timeout: T });
}

/** Waits up to `ms` for a new brand message; returns how many arrived. */
async function newBubbles(chat, before, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await bubbles(chat).count()) > before) break;
    await chat.page().waitForTimeout(500);
  }
  return (await bubbles(chat).count()) - before;
}

async function kpi(p, label) {
  const tile = p.locator('.ui-kpi').filter({ has: p.locator('.ui-kpi__label', { hasText: new RegExp(`^${label}$`) }) });
  await tile.first().waitFor({ timeout: T });
  const value = await tile.first().locator('.ui-kpi__value').innerText();
  return Number(value.replace(/[^\d.]/g, ''));
}

async function platformTiles(p, labels) {
  await p.goto(`${BASE}/platform`);
  await p.getByRole('region', { name: 'Across all brands' }).waitFor({ timeout: T });
  const out = {};
  for (const l of labels) out[l] = await kpi(p, l);
  return out;
}

/** Opens the newest conversation whose customer ref matches. */
async function openConversation(brand, refPattern) {
  await brand.goto(`${BASE}/brand/conversations`);
  const item = brand.getByRole('button', { name: refPattern }).first();
  await item.waitFor({ timeout: T });
  await item.click();
  await brand
    .getByText(/^Conversation with /)
    .first()
    .waitFor({ timeout: T });
}

async function processDue(brand) {
  await brand.getByRole('button', { name: 'Process due work now' }).click();
  const line = brand.locator('p.notice', { hasText: 'Due work processed' }).first();
  await line.waitFor({ timeout: T });
  return line.innerText();
}

/** Demo controls → "Sign in as demo shopper: <name>" or "Continue as guest". */
async function signInShopper(p, who) {
  await p.goto(`${BASE}/shop`);
  await p.getByRole('button', { name: /Demo controls/ }).click();
  if (who === 'guest') {
    await p.getByRole('button', { name: 'Continue as guest' }).click();
    await p.waitForTimeout(1_000);
    return;
  }
  await p.getByRole('button', { name: new RegExp(`Sign in as demo shopper: ${who}`) }).click();
  await p.getByText(new RegExp(`Signed in as ${who}`)).waitFor({ timeout: T });
}

async function addSerumToBag(p) {
  await p
    .getByRole('button', { name: /Vitamin C Glow Serum/ })
    .first()
    .click();
  await p.getByRole('button', { name: 'Add to bag' }).click();
  await p.getByText(/added to your bag/).waitFor({ timeout: T });
}

async function story(id, title, run) {
  if (only.size && !only.has(id) && !only.has(id[0])) return;
  console.log(`\n▶ ${id} — ${title}`);
  const started = Date.now();
  const notes = [];
  try {
    await run((n) => {
      notes.push(n);
      log(n);
    });
    results.push({ id, title, pass: true, notes });
    console.log(`  ✔ ${id} passed in ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (err) {
    const message = err instanceof Check ? err.message : `${err.name}: ${err.message.split('\n')[0]}`;
    notes.push(`FAILED: ${message}`);
    results.push({ id, title, pass: false, notes });
    console.log(`  ✘ ${id} failed: ${message}`);
    await mkdir(FAIL_DIR, { recursive: true });
    for (const [i, context] of browser.contexts().entries())
      for (const [j, p] of context.pages().entries())
        await p.screenshot({ path: `${FAIL_DIR}/${id}-${i}-${j}.png`, fullPage: true }).catch(() => undefined);
  } finally {
    for (const context of browser.contexts()) await context.close();
  }
}

/* ------------------------------------------------------------------ the stories */

/** a + b share a run (b continues from a); `vp` is DESKTOP or PHONE. */
async function storiesAB(vp, note, { withB = true, platformCheck = true } = {}) {
  const brand = await login('brand', vp);
  await reset(brand);
  note('Reset demo: "Demo reset: …" shown');
  const platform = platformCheck ? await login('platform', vp) : null;
  const store = await login('andheri', vp);
  await store.goto(`${BASE}/store`);

  // a1–a2
  const shopper = await page(vp);
  await shopper.goto(`${BASE}/`);
  await expectText(shopper, /becomes a same-day pickup/, 'a1 landing copy');
  const link = shopper.getByRole('link', { name: /See it as a shopper/ }).first();
  must((await link.getAttribute('href'))?.startsWith('/shop'), 'a1: "See it as a shopper" does not open /shop');
  await serumPage(shopper);
  const product = await text(shopper);
  for (const s of ['30 ml · ₹795', '50 ml · ₹1,195', 'Add to bag', 'Chat on WhatsApp', 'Powered by Qwikspot'])
    must(product.includes(s), `a2: product page lacks "${s}"`);
  if (vp === PHONE) await noHorizontalScroll(shopper, 'phone product page');

  // a3–a4
  await shopper.getByRole('button', { name: /Need it today\? Check a store near you/ }).click();
  if (vp === PHONE) {
    await shopper.waitForURL(/\/chat/, { timeout: T });
    note('phone: "Need it today?" opens the chat full screen at /chat');
  }
  const chat = chatOf(shopper);
  await chat.waitFor({ timeout: T });
  await expectText(shopper, /Demo Beauty Co/, 'a3 chat header');
  must(
    (await chat.getByLabel('Message', { exact: true }).inputValue()).trim().length > 0,
    'a3: the message box is empty',
  );
  await chat.getByRole('button', { name: 'Send' }).click();
  await bubbles(chat).first().waitFor({ timeout: T });
  await brand.goto(`${BASE}/brand/conversations`);
  await brand
    .getByRole('button', { name: /sim:judge_/ })
    .first()
    .waitFor({ timeout: T });
  note('a4: the brand sees the new sim:judge_… conversation');

  // a5: the choice — pick up today vs home delivery
  await shareLocation(chat, 'Near Powai');
  const pickup = chat.getByRole('button', { name: 'Pick up today' }).last();
  await pickup.waitFor({ timeout: T });
  const card = await lastBubble(chat).innerText();
  must(/Pick up today at Andheri Store, 7\.6 km · open until \d\d:\d\d/.test(card), `a5: card says ${card}`);
  must(card.includes('Home delivery in 4–5 days'), 'a5: no "Home delivery in 4–5 days" line');
  must(card.includes('Powered by Qwikspot'), 'a5: no footer on the store card');
  must(!/Powai Store/.test(card), 'a5: Powai (out of stock) offered');
  const labels = await lastBubble(chat).locator('.wa-choice').allInnerTexts();
  must(
    JSON.stringify(labels.map((l) => l.trim())) === JSON.stringify(['Pick up today', 'Home delivery']),
    `a5: buttons ${labels}`,
  );
  must(await lastBubble(chat).locator('.wa-header-image').count(), 'a5: no product image');
  note(
    'a5: "Pick up today at Andheri Store, 7.6 km · open until …" vs "Home delivery in 4–5 days"; buttons Pick up today · Home delivery; footer',
  );

  // b8 compares the Platform tiles from just before the hold.
  const before = platform ? await platformTiles(platform, ['Holds', 'Store pickups']) : null;

  // a6: the pickup pass
  await pickup.click();
  await chat.getByText('On hold for you').waitFor({ timeout: T });
  const pass = await lastBubble(chat).innerText();
  const code = /Pickup code:\s*(\d{6})/.exec(pass)?.[1];
  must(code, 'a6: no 6-digit pickup code');
  for (const s of [
    'Andheri Store',
    'pay at the store',
    "The store will confirm when it's ready.",
    'Prefer delivery? Home delivery in 4–5 days.',
  ])
    must(pass.includes(s), `a6: pass lacks "${s}"`);
  must(/Held until (\w+ )?\d\d:\d\d \(store time\)/.test(pass), 'a6: no held-until time');
  await expectText(shopper, 'Open in Maps', 'a6 location card');
  must(await chat.getByRole('button', { name: 'Cancel reservation' }).count(), 'a6: no Cancel reservation');
  note(`a6: pickup pass with code ${code}, held until (store time), "Prefer delivery? Home delivery in 4–5 days."`);
  if (vp === PHONE) await noHorizontalScroll(shopper, 'phone chat');

  await store.reload();
  await store.getByRole('region', { name: 'Next up' }).waitFor({ timeout: T });
  await expectText(store, /1 × Vitamin C Glow Serum 30 ml/, 'a6 store Today');
  note('a6: the hold is in Andheri Today → Next up');
  if (!withB) return;

  // b1
  const next = await text(store);
  must(/Customer •••• \w{4}/.test(next), 'b1: no masked customer');
  must(
    next.includes(
      'Powai Store was closer but out of stock. You were the nearest store with stock — 7.6 km from the customer.',
    ),
    'b1: "why this hold came to you" text differs',
  );
  must(!/latitude|longitude|sim:judge/.test(next), 'b1: customer data on the store page');
  if (vp === PHONE) await noHorizontalScroll(store, 'phone store Today');
  note('b1: masked customer and "Powai Store was closer but out of stock … 7.6 km"');
  // b2–b5
  await store.getByRole('button', { name: 'Confirm' }).first().click();
  await chat.getByText(/Andheri Store confirmed your hold/).waitFor({ timeout: T });
  note('b2: "Andheri Store confirmed your hold" in the chat');
  await store.getByRole('button', { name: 'Mark ready' }).first().click();
  await chat.getByText(/Ready at Andheri Store/).waitFor({ timeout: T });
  note('b3: "Ready at Andheri Store … Show code" in the chat');
  await store.waitForTimeout(800);
  const beforeArrived = await bubbles(chat).count();
  await store.getByRole('button', { name: 'Customer arrived' }).first().click();
  await store.getByPlaceholder("Customer's pickup code").first().waitFor({ timeout: T });
  await expectText(store, /Ask for the 6-digit code in their WhatsApp/, 'b4 hint');
  must((await newBubbles(chat, beforeArrived, 5_000)) === 0, 'b4: "Customer arrived" sent a chat message');
  note('b4: pickup-code box; no chat message after "Customer arrived"');
  await store.getByPlaceholder("Customer's pickup code").first().fill(code);
  await store.getByRole('button', { name: 'Complete' }).first().click();
  await store
    .getByText(/Completed/)
    .first()
    .waitFor({ timeout: T });
  must((await newBubbles(chat, beforeArrived, 8_000)) === 1, 'b5: expected exactly one message after Complete');
  const thanks = await lastBubble(chat).innerText();
  must(
    /^Thanks for picking up Vitamin C Glow Serum 30 ml at Andheri Store\. Enjoy it! — Demo Beauty Co/.test(
      thanks.trim(),
    ),
    `b5: thank-you text: ${thanks}`,
  );
  must(!thanks.includes('Qwikspot'), 'b5: the thank-you carries "Qwikspot"');
  note('b5: Completed; one thank-you "Thanks for picking up … — Demo Beauty Co", no footer');
  await store.goto(`${BASE}/store/history`);
  await expectText(store, 'Picked up — in-store purchase', 'b5 history');

  // b6–b7
  await openConversation(brand, /sim:judge_/);
  await expectText(brand, /Picked up at Andheri Store — in-store purchase/, 'b6 journey');
  await expectText(brand, /Powai Store \([\d.]+ km\) is out of stock/, 'b6 why');
  if (vp === PHONE) await noHorizontalScroll(brand, 'phone brand conversation');
  note('b6: journey ends "Picked up at Andheri Store — in-store purchase"; why names Powai out of stock');
  await brand.goto(`${BASE}/brand/reservations`);
  await expectText(brand, /Picked up — in-store purchase/, 'b7 reservations');
  note('b7: Reservations row "Picked up — in-store purchase"');

  // b8
  if (platform) {
    const after = await platformTiles(platform, ['Holds', 'Store pickups']);
    must(after.Holds === before.Holds + 1, `b8: Holds ${before.Holds} → ${after.Holds}`);
    must(
      after['Store pickups'] === before['Store pickups'] + 1,
      `b8: Store pickups ${before['Store pickups']} → ${after['Store pickups']}`,
    );
    note(
      `b8: Platform Holds ${before.Holds} → ${after.Holds}, Store pickups ${before['Store pickups']} → ${after['Store pickups']}`,
    );
  }
}

async function storyC(note) {
  const brand = await login('brand');
  await reset(brand);
  const bandra = await login('bandra');
  const andheri = await login('andheri');
  const shopper = await page();
  await serumPage(shopper);
  const chat = await startChat(shopper);
  await shareLocation(chat, 'Near Bandra');
  await chat.getByRole('button', { name: 'Pick up today' }).last().waitFor({ timeout: T });
  const card = await lastBubble(chat).innerText();
  must(/Pick up today at Bandra Store, 0\.\d km/.test(card), `c1: card ${card}`);
  must(card.includes('Home delivery in 4–5 days'), 'c1: no delivery line');
  const labels = (await lastBubble(chat).locator('.wa-choice').allInnerTexts()).map((l) => l.trim());
  must(JSON.stringify(labels) === JSON.stringify(['Pick up today', 'Home delivery', 'Other stores']), `c1: ${labels}`);
  note('c1: Bandra 0.7 km card with Pick up today · Home delivery · Other stores');
  await chat.getByRole('button', { name: 'Pick up today' }).last().click();
  await chat.getByText('On hold for you').waitFor({ timeout: T });
  await bandra.goto(`${BASE}/store`);
  await bandra.getByRole('region', { name: 'Next up' }).waitFor({ timeout: T });
  note('c2: pickup pass; the hold in Bandra Next up');

  // c3: refuse
  await bandra
    .getByLabel(/^Refusal reason for /)
    .first()
    .selectOption({ label: 'Not actually in stock' });
  await bandra.getByRole('button', { name: 'Refuse' }).first().click();
  await expectText(bandra, /Cancelled \(customer notified\)/, 'c3 notice');
  await chat
    .getByText(/Sorry — Bandra Store can't fulfil your reservation for Vitamin C Glow Serum 30 ml after all\./)
    .waitFor({ timeout: T });
  const offer = await lastBubble(chat).innerText();
  must(/Pick up today at Andheri Store/.test(offer), `c3: re-offer ${offer}`);
  must(!/not actually|NOT_ACTUALLY/i.test(offer), 'c3: the store reason reached the shopper');
  must(
    !(await lastBubble(chat)
      .getByRole('button', { name: /Bandra/ })
      .count()),
    'c3: Bandra offered again',
  );
  note('c3: apology, then Andheri offered (Pick up today); no reason shown to the shopper');
  await bandra.goto(`${BASE}/store/history`);
  await expectText(bandra, /Refused: Not actually in stock/, 'c3 history');

  // c4
  await chat.getByRole('button', { name: 'Pick up today' }).last().click();
  await chat.getByText('On hold for you').last().waitFor({ timeout: T });
  await andheri.goto(`${BASE}/store`);
  await andheri.getByRole('region', { name: 'Next up' }).waitFor({ timeout: T });
  await expectText(
    andheri,
    /Bandra Store couldn't fulfil the customer's hold, so it came to you — 8\.\d km from the customer\./,
    'c4 why',
  );
  note(
    `c4: Andheri's why: "Bandra Store couldn't fulfil the customer's hold, so it came to you — 8.x km from the customer."`,
  );

  // c5
  await openConversation(brand, /sim:judge_/);
  await expectText(brand, /Bandra Store refused: not actually in stock/i, 'c5 journey');
  await brand.goto(`${BASE}/brand`);
  await expectText(brand, /Bandra Store refused 1 hold in the last 24 h — not actually in stock/i, 'c5 attention');
  await brand.goto(`${BASE}/brand/reservations?filter=refused`);
  await expectText(brand, /Refused: not actually in stock/i, 'c5 reservations');
  note('c5: journey, Overview attention and Reservations → Refused all show the refusal');

  // c6: right away, no process-due
  await bandra.goto(`${BASE}/store/demand`);
  await expectText(bandra, 'When you were the nearest store', 'c6 section');
  const demand = await text(bandra);
  must(
    /Holds you refused: ?Not actually in stock 1/i.test(demand),
    'c6: "Holds you refused: Not actually in stock 1" missing',
  );
  note('c6: Bandra Demand shows "Holds you refused: Not actually in stock 1" immediately');
}

async function storyC2(note) {
  // The fix-2 case: Near Powai → Andheri refuses → Bandra (10.6 km) still offered.
  const brand = await login('brand');
  await reset(brand);
  const andheri = await login('andheri');
  const bandra = await login('bandra');
  const shopper = await page();
  await serumPage(shopper);
  const chat = await startChat(shopper);
  await shareLocation(chat, 'Near Powai');
  await chat.getByRole('button', { name: 'Pick up today' }).last().click();
  await chat.getByText('On hold for you').waitFor({ timeout: T });
  await andheri.goto(`${BASE}/store`);
  await andheri.getByRole('region', { name: 'Next up' }).waitFor({ timeout: T });
  await andheri
    .getByLabel(/^Refusal reason for /)
    .first()
    .selectOption({ label: 'Damaged' });
  await andheri.getByRole('button', { name: 'Refuse' }).first().click();
  await chat.getByText(/Sorry — Andheri Store can't fulfil/).waitFor({ timeout: T });
  const offer = await lastBubble(chat).innerText();
  must(
    offer.includes('No other store near you has it. The nearest one is Bandra Store, 10.6 km away.'),
    `c7: ${offer}`,
  );
  must(offer.includes('Pick up today at Bandra Store, 10.6 km'), 'c7: no Bandra pickup line');
  must(offer.includes('Home delivery in 4–5 days'), 'c7: no delivery line');
  const labels = (await lastBubble(chat).locator('.wa-choice').allInnerTexts()).map((l) => l.trim());
  must(JSON.stringify(labels) === JSON.stringify(['Pick up today', 'Home delivery']), `c7: buttons ${labels}`);
  note('c7: beyond 10 km: "The nearest one is Bandra Store, 10.6 km away" with Pick up today · Home delivery');
  await chat.getByRole('button', { name: 'Pick up today' }).last().click();
  await chat.getByText('On hold for you').last().waitFor({ timeout: T });
  must((await lastBubble(chat).innerText()).includes('Bandra Store'), 'c7: pass not for Bandra');
  await bandra.goto(`${BASE}/store`);
  await expectText(
    bandra,
    /Andheri Store couldn't fulfil the customer's hold, so it came to you — 10\.6 km from the customer\./,
    'c7 why',
  );
  note('c7: the hold at Bandra is allowed; Bandra sees "Andheri Store couldn\'t fulfil … 10.6 km"');
}

async function storyD(note) {
  const brand = await login('brand');
  await reset(brand);
  const platform = await login('platform');
  const before = (await platformTiles(platform, ['Attributed online orders']))['Attributed online orders'];
  await brand.goto(`${BASE}/brand/insights`);
  await brand.getByRole('img', { name: /Journey funnel/ }).waitFor({ timeout: T });
  const onlineBefore = Number(/online order (\d+)/.exec(await text(brand))?.[1] ?? NaN);
  const shopper = await page();
  await serumPage(shopper);
  const chat = await startChat(shopper);
  await shareLocation(chat, 'Near Powai');
  await chat.getByRole('button', { name: 'Home delivery' }).last().click();
  await chat.getByText(/You can order Vitamin C Glow Serum online here:/).waitFor({ timeout: T });
  const reply = await lastBubble(chat).innerText();
  const url = /(http:\/\/\S+qs_ref=\S+)/.exec(reply)?.[1];
  must(url && url.includes('#product=prd_1001'), `d2: ${reply}`);
  note('d2: "Home delivery" → "You can order Vitamin C Glow Serum online here: …?qs_ref=…#product=prd_1001"');
  const popup = shopper.context().waitForEvent('page');
  await lastBubble(chat).getByRole('link').first().click();
  const shop = await popup;
  await shop.getByRole('button', { name: 'Add to bag' }).waitFor({ timeout: T });
  note('d3: the link opens the serum page');
  await shop.getByRole('button', { name: 'Add to bag' }).click();
  await shop.getByRole('button', { name: /^Cart, 1 item/ }).click();
  await shop.getByRole('button', { name: 'Checkout' }).click();
  await shop.getByRole('button', { name: 'Place order' }).click();
  await expectText(shop, 'Order placed', 'd4');
  note('d4: Order placed');
  await openConversation(brand, /sim:judge_/);
  await expectText(brand, /Ordered online · ₹795 est\./, 'd5 journey');
  note('d5: journey ends "Ordered online · ₹795 est."');
  await brand.goto(`${BASE}/brand/insights`);
  await brand.getByRole('img', { name: /Journey funnel/ }).waitFor({ timeout: T });
  const onlineAfter = Number(/online order (\d+)/.exec(await text(brand))?.[1] ?? NaN);
  must(onlineAfter === onlineBefore + 1, `d6: Insights online orders ${onlineBefore} → ${onlineAfter}`);
  note(`d6: Insights online orders ${onlineBefore} → ${onlineAfter}`);
  const after = (await platformTiles(platform, ['Attributed online orders']))['Attributed online orders'];
  must(after === before + 1, `d7: Platform online orders ${before} → ${after}`);
  note(`d7: Platform attributed online orders ${before} → ${after}`);
}

async function storyE(note) {
  const brand = await login('brand');
  await reset(brand);
  const asha = await page();
  await signInShopper(asha, 'Asha');
  await addSerumToBag(asha);
  const ravi = await page();
  await signInShopper(ravi, 'Ravi');
  await addSerumToBag(ravi);
  const guest = await page();
  await signInShopper(guest, 'guest');
  await addSerumToBag(guest);
  const leftAt = Date.now();
  note('e1/e2/e5/e6: Asha, Ravi and a guest each added the serum and left');
  await brand.goto(`${BASE}/brand/conversations`);
  await brand.getByRole('tab', { name: 'Intents' }).click();
  await expectText(brand, /Cart abandonment/, 'e2 intents');
  log('… waiting for the follow-ups to become due (about 3 minutes); the Conversations page stays open');
  await brand.waitForTimeout(Math.max(0, leftAt + FOLLOW_UP_DUE_MS - Date.now()));
  // The open Conversations page runs due work itself every 30 s: the follow-up may already be out.
  let arrived = false;
  const lines = [];
  for (let attempt = 1; attempt <= 8 && !arrived; attempt++) {
    lines.push(await processDue(brand));
    await asha.goto(`${BASE}/chat?brand=brd_demo`);
    arrived = await seeText(asha, 'Reply STOP to opt out.', 8_000);
    if (!arrived) await brand.waitForTimeout(15_000);
  }
  note(`e3: ${lines.join(' / ')}`);
  must(arrived, "e4: the follow-up never reached Asha's chat");
  const ashaChat = chatOf(asha);
  const followUps = await ashaChat.locator('.wa-msg--in', { hasText: 'Reply STOP to opt out.' }).count();
  must(followUps === 1, `e4: Asha has ${followUps} follow-ups`);
  const f = await ashaChat.locator('.wa-msg--in', { hasText: 'Reply STOP to opt out.' }).innerText();
  must(f.includes('Hi, this is Demo Beauty Co. You still have Vitamin C Glow Serum (30 ml) in your cart.'), `e4: ${f}`);
  for (const b of ['Find a store near me', 'Buy online', 'Talk to a person', 'Powered by Qwikspot'])
    must(f.includes(b), `e4: follow-up lacks "${b}"`);
  note("e4: exactly one follow-up in Asha's chat, with the three quick replies and the footer");
  await brand.goto(`${BASE}/brand/conversations`);
  await brand.getByRole('tab', { name: 'Intents' }).click();
  await expectText(brand, 'The customer has not opted in to messages.', 'e5 Ravi reason');
  await expectText(brand, 'Anonymous visitor: no known, reachable customer to message.', 'e6 guest reason');
  for (const p of [ravi, guest]) {
    await p.goto(`${BASE}/chat?brand=brd_demo`);
    must(!(await seeText(p, 'Reply STOP to opt out.', 3_000)), 'e5/e6: a follow-up reached Ravi or the guest');
  }
  note('e5/e6: Ravi and the guest got none; Intents give the reasons');
}

async function storyF(note) {
  const brand = await login('brand');
  await reset(brand);
  const shopper = await page();
  await serumPage(shopper);
  await shopper.getByRole('button', { name: /Chat on WhatsApp/ }).click();
  const chat = chatOf(shopper);
  await chat.waitFor({ timeout: T });
  await chat.getByLabel('Message', { exact: true }).fill('');
  await say(chat, 'I want to talk to a person');
  await chat
    .getByText(/I've asked a member of the Demo Beauty Co team to take over this conversation/)
    .waitFor({ timeout: T });
  const ack = lastBubble(chat);
  must(
    (await ack.innerText()).includes(
      "Thanks. I've asked a member of the Demo Beauty Co team to take over this conversation. They will reply here.",
    ),
    'f1: acknowledgement text',
  );
  must((await ack.locator('.wa-footer').count()) === 0, 'f1: the acknowledgement has a footer');
  note('f1: acknowledgement, no "Powered by Qwikspot" footer');
  await brand.goto(`${BASE}/brand`);
  await expectText(brand, /1 customer is waiting for a person — longest \d+ min/, 'f1 attention');
  must(await brand.getByLabel(/1 waiting for a person/).count(), 'f1: no nav badge');
  note('f1: Overview attention line and the nav badge');
  const before = await bubbles(chat).count();
  await say(chat, 'Is it good for oily skin?');
  must((await newBubbles(chat, before, 5_000)) === 0, 'f2: an automated reply arrived during handoff');
  note('f2: no automated reply while a person owns it');
  await brand.goto(`${BASE}/brand/conversations`);
  await brand.getByRole('button', { name: 'Needs a person' }).click();
  await brand
    .getByRole('button', { name: /needs a person · waiting/ })
    .first()
    .click();
  await brand.getByLabel('Reply as a person').fill('Hi, this is the Demo Beauty Co team. Yes, it suits oily skin.');
  await brand.getByRole('button', { name: 'Send reply' }).click();
  await expectText(brand, 'Team member', 'f3 label');
  await chat.getByText('Hi, this is the Demo Beauty Co team. Yes, it suits oily skin.').waitFor({ timeout: T });
  const human = lastBubble(chat);
  must((await human.locator('.wa-footer').count()) === 0, 'f3: the human reply has a footer');
  must(!/admin@demo-brand/.test(await text(shopper)), 'f3: the team member identity reached the shopper');
  note('f3: the reply reaches the shopper from the brand, no footer, no team identity');
  await brand.getByRole('button', { name: 'Resolve and return to assistant' }).click();
  await brand.waitForTimeout(1_000);
  must(!(await brand.getByLabel(/waiting for a person/).count()), 'f4: nav badge still shown');
  const n = await bubbles(chat).count();
  await say(chat, 'Is this good for oily skin?');
  must((await newBubbles(chat, n, 10_000)) >= 1, 'f4: no automated reply after Resolve');
  note('f4: badge gone; automated replies again');
}

async function storyG(note) {
  const brand = await login('brand');
  await reset(brand);
  const asha = await page();
  await signInShopper(asha, 'Asha');
  await asha
    .getByRole('button', { name: /Vitamin C Glow Serum/ })
    .first()
    .click();
  await asha.getByRole('button', { name: /Chat on WhatsApp/ }).click();
  const chat = chatOf(asha);
  await chat.waitFor({ timeout: T });
  await chat.getByLabel('Message', { exact: true }).fill('');
  const before = await bubbles(chat).count();
  await say(chat, 'STOP');
  must((await newBubbles(chat, before, 5_000)) === 0, 'g1: STOP got a reply');
  await say(chat, 'Do you have it in 50 ml?');
  must((await newBubbles(chat, before, 5_000)) === 0, 'g2: a reply after STOP');
  note('g1/g2: STOP and the next message get no reply');
  await asha
    .getByRole('button', { name: 'Close chat' })
    .click()
    .catch(() => undefined);
  await asha.getByRole('button', { name: 'Add to bag' }).click();
  await asha.getByText(/added to your bag/).waitFor({ timeout: T });
  const leftAt = Date.now();
  await brand.goto(`${BASE}/brand/conversations`);
  await brand.getByRole('tab', { name: 'Intents' }).click();
  await expectText(brand, 'The customer opted out.', 'g3 reason');
  note('g3: Intents reason "The customer opted out."');
  log('… waiting the follow-up timing (about 3 minutes)');
  await brand.waitForTimeout(Math.max(0, leftAt + FOLLOW_UP_DUE_MS - Date.now()));
  const line = await processDue(brand);
  must(/0 follow-ups sent/.test(line), `g4: ${line}`);
  await asha.goto(`${BASE}/chat?brand=brd_demo`);
  must(!(await seeText(asha, 'Reply STOP to opt out.', 3_000)), 'g4: a follow-up reached Asha after STOP');
  note(`g4: ${line}; nothing in Asha's chat`);
  await openConversation(brand, /sim:shopper_3002_/);
  await expectText(brand, 'STOP', 'g5 transcript');
  must(!(await brand.getByLabel('Reply as a person').count()), 'g5: a Reply as a person box is shown');
  note('g5: the transcript shows STOP and no reply; no Reply-as-a-person box');
}

async function storyH(note) {
  const brand = await login('brand');
  await brand.goto(`${BASE}/brand/insights`);
  await brand.getByRole('img', { name: /Journey funnel/ }).waitFor({ timeout: T });
  await expectText(brand, /Includes synthetic demo history \(\d+ generated records\)/, 'h1 notice');
  await expectText(brand, /problem day/, 'h1 weekday chart');
  await expectText(brand, /This looks like an availability problem, not a demand problem\./, 'h1 sentence');
  note('h1: synthetic notice, funnel, weekday reading with a problem day');
  await expectText(brand, 'Suggested next actions', 'h2 suggestions');
  await expectText(brand, /Open Andheri Store →/, 'h2 link');
  await expectText(brand, 'Unmet local demand', 'h2 unmet');
  note('h2: suggestions with "Open Andheri Store →", unmet demand');
  const withHistory = await text(brand);
  await brand.getByLabel('Include synthetic demo history').uncheck();
  await brand.waitForTimeout(2_500);
  must((await text(brand)) !== withHistory, 'h3: numbers did not change without synthetic history');
  note('h3: unticking synthetic history changes the numbers');
  const andheri = await login('andheri');
  await andheri.goto(`${BASE}/store/demand`);
  await expectText(andheri, 'Missed demand', 'h4');
  await expectText(andheri, /problem day/, 'h4 chart');
  await expectText(andheri, /From Demo Beauty Co/, 'h4 suggestions');
  note('h4: Andheri Demand: missed demand, weekday chart with problem day, suggestions');
  const bandra = await login('bandra');
  await bandra.goto(`${BASE}/store/demand`);
  await expectText(bandra, 'When you were the nearest store', 'h5');
  must(
    !/Andheri Store/.test(await text(bandra)) || !/Open Andheri Store/.test(await text(bandra)),
    'h5: Andheri suggestions on Bandra',
  );
  note('h5: Bandra sees only its own slice');
}

/* ------------------------------------------------------------------ privacy */

async function p1(note) {
  const a = await page();
  const b = await page();
  for (const [p, secret] of [
    [a, 'secret from window 1'],
    [b, 'secret from window 2'],
  ]) {
    await signInShopper(p, 'Asha');
    await p
      .getByRole('button', { name: /Vitamin C Glow Serum/ })
      .first()
      .click();
    await p.getByRole('button', { name: /Chat on WhatsApp/ }).click();
    const chat = chatOf(p);
    await chat.waitFor({ timeout: T });
    await chat.getByLabel('Message', { exact: true }).fill('');
    await say(chat, secret);
  }
  await a.waitForTimeout(5_000);
  const ta = await text(a);
  const tb = await text(b);
  must(ta.includes('secret from window 1') && !ta.includes('secret from window 2'), 'p1: window 1 sees window 2');
  must(tb.includes('secret from window 2') && !tb.includes('secret from window 1'), 'p1: window 2 sees window 1');
  const brand = await login('brand');
  await brand.goto(`${BASE}/brand/conversations`);
  await brand
    .getByRole('button', { name: /sim:shopper_3002_/ })
    .first()
    .waitFor({ timeout: T });
  const refs = new Set(
    (await brand.getByRole('button', { name: /sim:shopper_3002_/ }).allInnerTexts()).map(
      (t) => /sim:shopper_3002_\w+/.exec(t)?.[0],
    ),
  );
  must(refs.size >= 2, `p1: ${refs.size} Asha conversations`);
  note(`p1: each window sees only its own message; ${refs.size} different Asha conversations`);
}

async function p2p3(note) {
  const brand = await login('brand');
  await reset(brand);
  const shopper = await page();
  await serumPage(shopper);
  const chat = await startChat(shopper);
  await shareLocation(chat, 'Near Powai');
  await chat.getByRole('button', { name: 'Pick up today' }).last().click();
  await chat.getByText('On hold for you').waitFor({ timeout: T });
  const bandra = await login('bandra');
  for (const path of ['/store', '/store/history', '/store/demand']) {
    await bandra.goto(`${BASE}${path}`);
    await bandra.waitForTimeout(1_500);
    const t = await text(bandra);
    must(
      !/1 × Vitamin C Glow Serum 30 ml.*Andheri/.test(t) && !t.includes('7.6 km'),
      `p2: Bandra ${path} shows Andheri's hold`,
    );
  }
  must(!(await bandra.getByRole('combobox', { name: /store/i }).count()), 'p2: a store picker exists');
  note('p2: Bandra Today/History/Demand never show the Andheri hold; no store picker');
  const andheri = await login('andheri');
  await andheri.goto(`${BASE}/store`);
  await andheri.getByRole('region', { name: 'Next up' }).waitFor({ timeout: T });
  const t = await text(andheri);
  must(/Customer •••• \w{4}/.test(t), 'p3: no masked customer');
  must(
    !/sim:|judge_|19\.1\d|72\.9|Need it today|latitude|longitude/.test(t),
    'p3: customer identity, location or messages shown',
  );
  note('p3: only "Customer •••• XXXX"; no ref, coordinates or messages');
}

async function p4(note) {
  const platform = await login('platform');
  for (const path of ['/platform', '/platform/brands', '/platform/network?brand=brd_demo', '/platform/audit']) {
    await platform.goto(`${BASE}${path}`);
    await platform.waitForTimeout(2_000);
    const t = (await text(platform)).replace('platform@qwikspot.test', '');
    must(!/@/.test(t), `p4: an email on ${path}`);
    must(!/sim:|shopper_3002|judge_|\+91|Pickup code|\b\d{6}\b.*pickup/i.test(t), `p4: customer data on ${path}`);
  }
  note('p4: Overview, Brands, Retail network, Audit: counts and names only; the only email is the header');
}

async function p5(note) {
  const routes = { brand: '/brand', andheri: '/store', platform: '/platform' };
  for (const [user, home] of Object.entries(routes)) {
    const p = await login(user);
    for (const target of Object.values(routes)) {
      await p.goto(`${BASE}${target}`);
      await p.waitForTimeout(1_000);
      must(new URL(p.url()).pathname.startsWith(home), `p5: ${user} at ${target} → ${p.url()}`);
    }
  }
  note('p5: each role typing /brand, /store, /platform lands back in its own console');
}

async function p6(note) {
  const p = await page();
  for (const target of ['/brand', '/store', '/platform']) {
    await p.goto(`${BASE}${target}`);
    await p.waitForURL(/\/login/, { timeout: T });
  }
  note('p6: signed out, /brand, /store and /platform go to the sign-in page');
}

async function resetTwice(note) {
  const brand = await login('brand');
  await reset(brand);
  await brand.getByRole('button', { name: 'Reset demo' }).click();
  await brand.getByRole('button', { name: 'Yes, reset the demo' }).click();
  await expectText(brand, 'The demo was just reset. Try again in a minute. (RATE_LIMITED)', 'second reset');
  note('a second Reset within a minute: "The demo was just reset. Try again in a minute. (RATE_LIMITED)"');
}

/* ------------------------------------------------------------------ run */

browser = await chromium.launch();
const started = Date.now();
try {
  await story('setup', 'Setup and Reset demo (incl. a second Reset within a minute)', resetTwice);
  await story('a+b', 'a — Intent capture, same-day pickup; b — Store fulfils, all screens update', (n) =>
    storiesAB(DESKTOP, n),
  );
  await story('c', 'c — Store refusal, next store offered', storyC);
  await story('c7', 'c (fix 2) — Refusal with no store within 10 km: the farther store is still offered', storyC2);
  await story('d', 'd — Online purchase attributed', storyD);
  await story('e', 'e — Cart follow-up, opted-in only', storyE);
  await story('f', 'f — Human handoff, no footer on human replies', storyF);
  await story('g', 'g — Opt-out stops follow-ups', storyG);
  await story('h', 'h — Demand insights (brand and store)', storyH);
  await story('p1', 'p1 — Two "Asha" windows isolated', p1);
  await story('p2', 'p2 + p3 — Store cannot see another store; never sees the customer', p2p3);
  await story('p4', 'p4 — Platform shows totals only', p4);
  await story('p5', 'p5 — Roles kept out of other consoles', p5);
  await story('p6', 'p6 — Signed-out access needs login', p6);
  await story('phone', 'Phone — stories a and b at 390 px', (n) => storiesAB(PHONE, n, { platformCheck: false }));
} finally {
  await browser.close();
}

console.log(`\nResults (${Math.round((Date.now() - started) / 60_000)} min)\n`);
console.log('| Story / check | Pass / Fail | Notes |\n|---|---|---|');
for (const r of results)
  console.log(`| ${r.title} | ${r.pass ? 'Pass' : '**Fail**'} | ${r.notes.join('; ').replace(/\|/g, '\\|')} |`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
