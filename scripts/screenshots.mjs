#!/usr/bin/env node
/**
 * Playwright screenshots of every screen at desktop (1440 px) and phone (390 px) widths,
 * for the Interface Refresh phase reviews. Needs a running local stack (emulators, seed,
 * backend, Vite). Output: .screenshots/<phase>/ (git-ignored; UI-6 commits the final set).
 *
 *   BASE_URL=http://localhost:5173 node scripts/screenshots.mjs ui-0
 *
 * Demo logins: DEMO_PASSWORD (default: the local seed password) and the seeded emails.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const phase = process.argv[2] ?? 'latest';
const BASE = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD ?? 'qwikspot-demo-1';
const OUT = `.screenshots/${phase}`;
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const USERS = {
  brand: 'admin@demo-brand.test',
  store: 'retail-admin-north-2@qwikspot.test',
  platform: 'platform@qwikspot.test',
};

/** [file name, user or null, path, optional action before the shot, only on this viewport] */
const SHOTS = [
  ['landing', null, '/'],
  ['landing-menu', null, '/', (p) => p.getByRole('button', { name: 'Menu' }).click(), 'phone'],
  ['login-brand', null, '/login?as=brand'],
  ['login-store', null, '/login?as=store'],
  ['login-team', null, '/login?as=platform'],
  ['ui-kit-light', null, '/ui-kit'],
  ['ui-kit-dark', null, '/ui-kit', (p) => p.getByRole('button', { name: /Dark theme/ }).click()],
  ['landing-signed-in', 'brand', '/'],
  ['brand-overview-banner', 'brand', '/brand'],
  ['brand-overview', 'brand', '/brand', (p) => p.getByRole('button', { name: 'Dismiss this note' }).click()],
  ['brand-conversations', 'brand', '/brand/conversations'],
  ['shop-home', null, '/shop'],
  ['shop-controls', null, '/shop', (p) => p.getByRole('button', { name: /Demo controls/ }).click()],
  ['chat-empty', null, '/chat?brand=brd_demo'],
  ['brand-insights', 'brand', '/brand/insights'],
  ['brand-reservations', 'brand', '/brand/reservations'],
  ['brand-network', 'brand', '/brand/network'],
  ['brand-settings', 'brand', '/brand/settings'],
  ['store-today', 'store', '/store'],
  ['store-history', 'store', '/store/history'],
  ['store-stock', 'store', '/store/stock'],
  ['store-demand', 'store', '/store/demand'],
  ['platform-overview', 'platform', '/platform'],
  ['platform-brands', 'platform', '/platform/brands'],
  ['platform-network', 'platform', '/platform/network'],
  ['platform-audit', 'platform', '/platform/audit'],
  ['platform-system', 'platform', '/platform/system'],
];

/** Phases from UI-2 on run the shopper journey (and the follow-up) as part of the shots. */
const SHOPPER_PHASES = ['ui-2', 'ui-3', 'ui-4', 'ui-5', 'ui-6'];
const T = 20_000;
const shot = async (page, name, vp, fullPage = false) => {
  await page.waitForTimeout(500);
  const file = `${OUT}/${name}-${vp.name}.png`;
  await page.screenshot({ path: file, fullPage });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  written.push(`${file}${overflow ? '  ⚠ horizontal page scroll' : ''}`);
};

/**
 * UI-2 shopper journey as a guest: product page → "Need it today?" (docked chat on desktop,
 * /chat on phones) → Near Powai → store found → other stores (list sheet) → hold (pickup
 * pass) → the store confirms in its own tab → the store update appears in the chat.
 */
async function shopperJourney(vp, newPage, storePage, brandPage) {
  // UI-4: the store has Today open before the hold arrives, to show the new-hold alert.
  await storePage.goto(`${BASE}/store`);
  await storePage.getByRole('region', { name: 'Last 7 days' }).waitFor({ timeout: T });
  const page = await newPage();
  await page.goto(`${BASE}/shop`);
  await page
    .getByRole('button', { name: /Vitamin C Glow Serum/ })
    .first()
    .click();
  await shot(page, 'shop-product', vp, true);
  await page.getByRole('button', { name: /Need it today\? Check a store near you/ }).click();
  const chat = page.getByRole('region', { name: /^Chat with / });
  await chat.waitFor({ timeout: T });
  await shot(page, vp.name === 'desktop' ? 'shop-chat-docked' : 'chat-prefilled', vp);
  await chat.getByRole('button', { name: 'Send' }).click();
  await chat.locator('.wa-msg--in').first().waitFor({ timeout: T });
  await chat.getByRole('button', { name: 'Share location' }).click();
  await chat.getByRole('menuitem', { name: /Near Powai/ }).click();
  await chat
    .getByRole('button', { name: /^Hold / })
    .last()
    .waitFor({ timeout: T });
  await shot(page, 'chat-store-found', vp);
  // Near Bandra several stores qualify: the reply offers "Other stores" → a list.
  await chat.getByRole('button', { name: 'Share location' }).click();
  await chat.getByRole('menuitem', { name: /Near Bandra/ }).click();
  await chat
    .locator('.wa-msg--in')
    .nth(3)
    .waitFor({ timeout: T })
    .catch(() => undefined);
  await page.waitForTimeout(500);
  const other = chat.getByRole('button', { name: 'Other stores' });
  if (
    await other
      .last()
      .isEnabled()
      .catch(() => false)
  ) {
    await other.last().click();
    await chat
      .getByRole('button', { name: /Choose a store/ })
      .last()
      .click();
    const sheet = page.getByRole('dialog', { name: 'Choose a store' });
    await sheet.waitFor({ timeout: T });
    await shot(page, 'chat-list-sheet', vp);
    const andheri = sheet.getByRole('button', { name: /Andheri/ });
    await ((await andheri.count()) ? andheri.first() : sheet.locator('.wa-row').first()).click();
  } else {
    console.error('(no "Other stores" offered: list shot skipped)');
    await chat
      .getByRole('button', { name: /^Hold / })
      .last()
      .click();
  }
  await chat.getByText('On hold for you').waitFor({ timeout: T });
  await shot(page, 'chat-pickup-pass', vp);
  await storePage.getByRole('button', { name: 'Refresh' }).first().click();
  try {
    await storePage
      .getByText(/New hold:/)
      .first()
      .waitFor({ timeout: T });
    await shot(storePage, 'store-new-hold', vp);
  } catch {
    console.error('(no new-hold toast: alert shot skipped)');
  }
  const confirm = storePage.getByRole('button', { name: 'Confirm' }).first();
  try {
    await confirm.waitFor({ timeout: T });
    await confirm.click();
    await storePage
      .getByText(/Confirmed \(customer notified\)/)
      .first()
      .waitFor({ timeout: T });
    await shot(storePage, 'store-next-up', vp, true);
    await chat.getByText(/confirmed your hold/).waitFor({ timeout: T });
    await shot(page, 'chat-store-update', vp);
    // UI-3: finish the pickup, so the brand's journey timeline ends on the outcome.
    const code = /Pickup code:\s*(\d{6})/.exec(await chat.innerText())?.[1];
    for (const action of ['Mark ready', 'Customer arrived']) {
      const button = storePage.getByRole('button', { name: action }).first();
      await button.waitFor({ timeout: T });
      await button.click();
      await storePage.waitForTimeout(800);
    }
    if (code) {
      await storePage.getByPlaceholder("Customer's pickup code").first().fill(code);
      await storePage.getByRole('button', { name: 'Complete' }).first().click();
      await storePage.waitForTimeout(1_000);
    }
  } catch {
    console.error('(no Andheri hold to fulfil: store update / pickup skipped)');
  }
  await brandPage.goto(`${BASE}/brand/conversations`);
  await brandPage
    .getByRole('button', { name: /sim:judge_/ })
    .first()
    .click();
  await brandPage.getByRole('log', { name: 'Messages' }).waitFor({ timeout: T });
  await brandPage
    .getByText(/in-store purchase/)
    .first()
    .waitFor({ timeout: T })
    .catch(() => undefined);
  await shot(brandPage, 'brand-journey', vp, true);
  await brandPage.getByText('Technical details').first().click();
  await shot(brandPage, 'brand-why-technical', vp, true);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const written = [];
let followUpChat = null; // Asha's session (sessionStorage), reused for the follow-up shot
const startedAt = Date.now();
try {
  for (const vp of VIEWPORTS) {
    const contexts = {};
    const pageFor = async (user) => {
      // One browser context per user: sessions are per tab, banners per browser.
      if (!contexts[user ?? 'anon']) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await context.newPage();
        if (user) {
          await page.goto(`${BASE}/login`);
          await page.getByLabel('Email').fill(USERS[user]);
          await page.getByLabel('Password').fill(PASSWORD);
          await page.getByRole('button', { name: 'Sign in' }).click();
          await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
        }
        contexts[user ?? 'anon'] = page;
      }
      return contexts[user ?? 'anon'];
    };
    // A Store account signing in from the Brand tab: lands in the Store Console with a toast.
    {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      await page.goto(`${BASE}/login?as=brand`);
      await page.getByLabel('Email').fill(USERS.store);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByText('This is a Store account').waitFor({ timeout: 20_000 });
      const file = `${OUT}/login-mismatch-toast-${vp.name}.png`;
      await page.screenshot({ path: file });
      written.push(file);
      await context.close();
    }
    // A signed-in, opted-in demo shopper starts checkout and leaves (desktop pass only):
    // the follow-up becomes due after the demo brand's delay; it is shot at the end.
    let asha = null;
    if (SHOPPER_PHASES.includes(phase) && vp.name === 'desktop') {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      asha = await context.newPage();
      await asha.goto(`${BASE}/shop`);
      await asha.getByRole('button', { name: /Demo controls/ }).click();
      await asha.getByRole('button', { name: /Sign in as demo shopper: Asha/ }).click();
      await asha.getByText(/Signed in as Asha/).waitFor({ timeout: T });
      await asha.getByRole('button', { name: /Demo controls/ }).click();
      await asha.getByRole('button', { name: /5\. Product → checkout → leave/ }).click();
      await asha.getByText(/Scenario recorded/).waitFor({ timeout: T });
    }
    for (const [name, user, path, before, only] of SHOTS) {
      if (only && only !== vp.name) continue;
      const page = await pageFor(user);
      await page.goto(`${BASE}${path}`);
      // Pages that poll (store queue, conversations) never go fully idle: wait briefly, then shoot.
      await page
        .waitForLoadState('networkidle', { timeout: 8_000 })
        .catch(() => console.error(`(still loading: ${name})`));
      if (before) await before(page);
      await page.waitForTimeout(400);
      const file = `${OUT}/${name}-${vp.name}.png`;
      await page.screenshot({ path: file, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      written.push(`${file}${overflow ? '  ⚠ horizontal page scroll' : ''}`);
    }
    if (SHOPPER_PHASES.includes(phase)) {
      const newPage = async () =>
        (await browser.newContext({ viewport: { width: vp.width, height: vp.height } })).newPage();
      await shopperJourney(vp, newPage, await pageFor('store'), await pageFor('brand'));
      if (asha) {
        // Inactivity (1 min) + delay (1 min) with a margin, then the brand runs due follow-ups.
        const wait = startedAt + 150_000 - Date.now();
        if (wait > 0) await asha.waitForTimeout(wait);
        const brand = await pageFor('brand');
        await brand.goto(`${BASE}/brand/conversations`);
        await brand.getByRole('button', { name: 'Process due work now' }).click();
        await brand
          .getByText(/Due work processed:/)
          .first()
          .waitFor({ timeout: T });
        followUpChat = await asha.evaluate(() => sessionStorage.getItem('qs_shopper_session:brd_demo'));
      }
      if (followUpChat) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        await context.addInitScript((v) => sessionStorage.setItem('qs_shopper_session:brd_demo', v), followUpChat);
        const page = await context.newPage();
        await page.goto(`${BASE}/chat?brand=brd_demo`);
        try {
          await page.getByText('Reply STOP to opt out.', { exact: false }).waitFor({ timeout: T });
          await shot(page, 'chat-follow-up', vp);
        } catch {
          console.error('(no follow-up in the chat: follow-up shot skipped)');
        }
      }
    }
  }
} finally {
  await browser.close();
}
console.log(written.join('\n'));
