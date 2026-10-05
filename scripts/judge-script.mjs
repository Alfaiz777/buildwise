#!/usr/bin/env node
/**
 * The 10-minute judge script, automated (Interface Refresh UI-6). It starts with
 * **Reset demo** and then performs every step through the UI only — no API calls, no
 * manual steps — at desktop (1440 px) and phone (390 px) widths, writing the committed
 * screenshot set to docs/screenshots/ (JPEG, quality 80). Any step that does not happen
 * fails the run: this is the proof that the script works from a fresh reset.
 *
 *   BASE_URL=http://localhost:5173 node scripts/judge-script.mjs
 *
 * Needs the local stack (emulators, seed:demo, backend, Vite) and the demo logins.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD ?? 'qwikspot-demo-1';
const OUT = process.env.OUT_DIR ?? 'docs/screenshots';
const T = 25_000;
const USERS = {
  brand: 'admin@demo-brand.test',
  store: 'retail-admin-north-2@qwikspot.test',
  platform: 'platform@qwikspot.test',
};
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
/** The demo brand's follow-up timing: 1 min inactivity + 2 min cart-abandonment delay. */
const FOLLOW_UP_DUE_MS = 3 * 60_000 + 15_000;

const written = [];
const step = (n, text) => console.log(`  ${n}. ${text}`);

async function shot(page, name, vp, fullPage = false) {
  await page.waitForTimeout(600);
  // A full-page capture repeats sticky bars mid-image; un-stick them for the picture only.
  const unstick = fullPage
    ? await page.addStyleTag({ content: '.shell-top, .shell-nav, .shop-header { position: static !important; }' })
    : null;
  const file = `${OUT}/${name}-${vp.name}.jpg`;
  await page.screenshot({ path: file, fullPage, type: 'jpeg', quality: 80 });
  await unstick?.evaluate((el) => el.remove());
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error(`${file}: horizontal page scroll`);
  written.push(file);
}

async function signedIn(browser, vp, user) {
  const page = await (await browser.newContext({ viewport: { width: vp.width, height: vp.height } })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(USERS[user]);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: T });
  // The role banner is shown once per console; dismiss it so every shot shows the work.
  await page
    .getByRole('button', { name: 'Dismiss this note' })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  return page;
}

async function anonymous(browser, vp) {
  return (await browser.newContext({ viewport: { width: vp.width, height: vp.height } })).newPage();
}

async function run(browser, vp) {
  console.log(`\n${vp.name} (${vp.width} px)`);
  const brand = await signedIn(browser, vp, 'brand');

  step(0, 'Reset demo (Brand Console → Overview → Demo guide)');
  await brand.goto(`${BASE}/brand`);
  await brand.getByRole('button', { name: 'Reset demo' }).click();
  await brand.getByRole('button', { name: 'Yes, reset the demo' }).click();
  await brand.getByText(/Demo reset:/).waitFor({ timeout: 90_000 });

  step(1, 'Landing → "See it as a shopper"');
  const shopper = await anonymous(browser, vp);
  await shopper.goto(`${BASE}/`);
  await shopper
    .getByRole('link', { name: /See it as a shopper/ })
    .first()
    .waitFor({ timeout: T });
  await shot(shopper, '01-landing', vp);
  await shopper.goto(`${BASE}/shop`);
  await shopper
    .getByRole('button', { name: /Vitamin C Glow Serum/ })
    .first()
    .waitFor({ timeout: T });
  await shot(shopper, '02-shop', vp);

  step(2, 'Vitamin C Glow Serum 30 ml → "Need it today?" → send');
  await shopper
    .getByRole('button', { name: /Vitamin C Glow Serum/ })
    .first()
    .click();
  await shot(shopper, '03-shop-product', vp, true);
  await shopper.getByRole('button', { name: /Need it today\? Check a store near you/ }).click();
  const chat = shopper.getByRole('region', { name: /^Chat with / });
  await chat.waitFor({ timeout: T });
  await chat.getByRole('button', { name: 'Send' }).click();
  await chat.locator('.wa-msg--in').first().waitFor({ timeout: T });

  step(3, '📍 Near Powai → Hold at Andheri → the pickup pass');
  await chat.getByRole('button', { name: 'Share location' }).click();
  await chat.getByRole('menuitem', { name: /Near Powai/ }).click();
  const hold = chat.getByRole('button', { name: /^Hold at Andheri|^Hold here/ }).last();
  await hold.waitFor({ timeout: T });
  await shot(shopper, '04-chat-store-found', vp);
  await hold.click();
  await chat.getByText('On hold for you').waitFor({ timeout: T });
  await shot(shopper, '05-chat-pickup-pass', vp);
  const code = /Pickup code:\s*(\d{6})/.exec(await chat.innerText())?.[1];
  if (!code) throw new Error('no pickup code in the chat');

  step(4, 'Store login (Andheri) → Confirm → Mark ready → Customer arrived → Complete with the code');
  const store = await signedIn(browser, vp, 'store');
  await store.goto(`${BASE}/store`);
  await store.getByRole('region', { name: 'Next up' }).waitFor({ timeout: T });
  await shot(store, '06-store-next-up', vp, true);
  await store.getByRole('button', { name: 'Confirm' }).first().click();
  await chat.getByText(/confirmed your hold/).waitFor({ timeout: T });
  await shot(shopper, '07-chat-store-update', vp);
  for (const action of ['Mark ready', 'Customer arrived']) {
    await store.getByRole('button', { name: action }).first().click();
    await store
      .getByText(/customer notified|Nothing else waiting|Next up:/)
      .first()
      .waitFor({ timeout: T });
    await store.waitForTimeout(500);
  }
  await store.getByPlaceholder("Customer's pickup code").first().fill(code);
  await store.getByRole('button', { name: 'Complete' }).first().click();
  await store
    .getByText(/Completed/)
    .first()
    .waitFor({ timeout: T });
  await store.goto(`${BASE}/store/history`);
  await store.getByText('Picked up — in-store purchase').first().waitFor({ timeout: T });
  await shot(store, '08-store-history', vp);

  step(5, 'Brand login → Conversations: the journey ends on the pickup, with the why-sentence');
  await brand.goto(`${BASE}/brand/conversations`);
  await brand
    .getByRole('button', { name: /sim:judge_/ })
    .first()
    .click();
  await brand
    .getByText(/Picked up at Andheri Store — in-store purchase/)
    .first()
    .waitFor({ timeout: T });
  await brand
    .getByText(/Powai Store \([\d.]+ km\) is out of stock/)
    .first()
    .waitFor({ timeout: T });
  await shot(brand, '09-brand-journey', vp, true);

  step(6, 'Insights');
  await brand.goto(`${BASE}/brand/insights`);
  await brand.getByRole('img', { name: /Journey funnel/ }).waitFor({ timeout: T });
  await shot(brand, '10-brand-insights', vp, true);
  await brand.goto(`${BASE}/brand`);
  await brand.getByRole('region', { name: 'Results' }).waitFor({ timeout: T });
  await shot(brand, '11-brand-overview', vp, true);

  step(7, 'Shop: Demo controls → Sign in as Asha → add to bag → leave; then Process due work now');
  const asha = await anonymous(browser, vp);
  await asha.goto(`${BASE}/shop`);
  await asha.getByRole('button', { name: /Demo controls/ }).click();
  await asha.getByRole('button', { name: /Sign in as demo shopper: Asha/ }).click();
  await asha.getByText(/Signed in as Asha/).waitFor({ timeout: T });
  await asha
    .getByRole('button', { name: /Vitamin C Glow Serum/ })
    .first()
    .click();
  await asha.getByRole('button', { name: 'Add to bag' }).click();
  await asha.getByText(/added to your bag/).waitFor({ timeout: T });
  const leftAt = Date.now();
  console.log('     … waiting for the follow-up to become due (about 3 minutes)');
  await asha.waitForTimeout(Math.max(0, leftAt + FOLLOW_UP_DUE_MS - Date.now()));
  await brand.goto(`${BASE}/brand/conversations`);
  // As a judge would: press "Process due work now", then look at Asha's chat; if the
  // follow-up is not there yet, wait a little and press again (up to about 2 minutes).
  // Each result line is printed, so a real failure shows why.
  let arrived = false;
  for (let attempt = 1; attempt <= 8 && !arrived; attempt++) {
    await brand.getByRole('button', { name: 'Process due work now' }).click();
    const line = brand.locator('p.notice', { hasText: 'Due work processed' }).first();
    await line.waitFor({ timeout: T });
    console.log(`     press ${attempt}: ${await line.innerText()}`);
    await asha.goto(`${BASE}/chat?brand=brd_demo`);
    arrived = await asha
      .getByText('Reply STOP to opt out.', { exact: false })
      .waitFor({ timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!arrived) await brand.waitForTimeout(15_000);
  }
  if (!arrived) throw new Error("the cart follow-up never reached Asha's chat");
  await shot(asha, '12-chat-follow-up', vp);

  step(8, 'Platform login → Overview, Retail network, System');
  const platform = await signedIn(browser, vp, 'platform');
  await platform.goto(`${BASE}/platform`);
  await platform.getByRole('region', { name: 'Across all brands' }).waitFor({ timeout: T });
  await shot(platform, '13-platform-overview', vp, true);
  await platform.goto(`${BASE}/platform/network?brand=brd_demo`);
  await platform.getByText(/stores need attention|stores look healthy/).waitFor({ timeout: T });
  await shot(platform, '14-platform-network', vp, true);
  await platform.goto(`${BASE}/platform/system`);
  await platform
    .getByText(/Mock AI|Gemini/)
    .first()
    .waitFor({ timeout: T });
  await shot(platform, '15-platform-system', vp);

  for (const context of browser.contexts()) await context.close();
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const started = Date.now();
    await run(browser, vp);
    console.log(`  ✔ judge script passed at ${vp.name} in ${Math.round((Date.now() - started) / 1000)} s`);
    // Reset demo is limited to once a minute per brand.
    await new Promise((r) => setTimeout(r, Math.max(0, started + 65_000 - Date.now())));
  }
} finally {
  await browser.close();
}
console.log(`\n${written.length} screenshots:\n${written.join('\n')}`);
