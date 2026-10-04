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
  ['brand-insights', 'brand', '/brand/outcomes'],
  ['store-today', 'store', '/store'],
  ['platform-overview', 'platform', '/platform'],
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const written = [];
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
  }
} finally {
  await browser.close();
}
console.log(written.join('\n'));
