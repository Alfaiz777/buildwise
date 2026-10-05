#!/usr/bin/env node
/**
 * Renders the demo catalogue's product illustrations (Change 16, UI-2). Self-made: simple
 * parametrised SVG shapes (dropper bottle, jar, tube, pump bottle) in each product's
 * colours — no third-party photos or artwork. Writes the SVG sources and 600×600 PNGs
 * (WhatsApp image headers need PNG/JPEG) to frontend/public/demo-products/.
 *
 *   node scripts/render-product-images.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = new URL('../frontend/public/demo-products/', import.meta.url);

/** [slug, short name, shape, product colour, background, accent] */
const PRODUCTS = [
  ['vitamin-c-glow-serum', 'Vitamin C', 'dropper', '#f59a0b', '#fff4dc', '#b45c09'],
  ['niacinamide-clarifying-serum', 'Niacinamide', 'dropper', '#2f9e7a', '#e3f6ee', '#17614a'],
  ['hyaluronic-hydra-serum', 'Hyaluronic', 'dropper', '#3d7fd6', '#e6f0fc', '#1f4f94'],
  ['ceramide-barrier-cream', 'Ceramide', 'jar', '#e48b6b', '#fdeee7', '#9c4a2c'],
  ['oil-free-gel-moisturiser', 'Gel Moist.', 'jar', '#4fb3a9', '#e2f5f3', '#226b64'],
  ['mineral-sunscreen-spf-50', 'SPF 50', 'tube', '#f2c230', '#fff8de', '#8a6a00'],
  ['ultra-light-gel-sunscreen-spf-50', 'Gel SPF 50', 'tube', '#7cc6e8', '#e8f6fc', '#2b6f8f'],
  ['gentle-foaming-cleanser', 'Foaming', 'pump', '#8fbf4d', '#eef7e2', '#4b6b1e'],
  ['salicylic-clear-cleanser', 'Salicylic', 'pump', '#5b6ee1', '#eceffd', '#2f3a8f'],
  ['overnight-repair-night-cream', 'Night Repair', 'jar', '#7b5ea7', '#f0ebf8', '#45306b'],
];

const label = (x, y, w, name, accent) => `
  <rect x="${x}" y="${y}" width="${w}" height="92" rx="10" fill="#ffffff" opacity="0.94"/>
  <text x="${x + w / 2}" y="${y + 34}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="15" font-weight="700" letter-spacing="1.5" fill="${accent}">DEMO BEAUTY</text>
  <text x="${x + w / 2}" y="${y + 68}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="${name.length > 10 ? 24 : 28}" font-weight="700" fill="#1c2430">${name}</text>`;

const SHAPES = {
  dropper: (c, name, a) => `
    <rect x="262" y="70" width="76" height="70" rx="14" fill="#2a2f36"/>
    <rect x="276" y="132" width="48" height="40" fill="#3b4451"/>
    <rect x="200" y="168" width="200" height="330" rx="42" fill="${c}"/>
    <rect x="222" y="190" width="26" height="250" rx="13" fill="#ffffff" opacity="0.28"/>
    ${label(220, 300, 160, name, a)}`,
  jar: (c, name, a) => `
    <rect x="150" y="178" width="300" height="70" rx="18" fill="#2a2f36"/>
    <rect x="160" y="236" width="280" height="220" rx="40" fill="${c}"/>
    <rect x="182" y="258" width="22" height="170" rx="11" fill="#ffffff" opacity="0.28"/>
    ${label(200, 300, 200, name, a)}`,
  tube: (c, name, a) => `
    <path d="M220 110 h160 l-14 330 h-132 z" fill="${c}"/>
    <rect x="220" y="96" width="160" height="26" rx="6" fill="#ffffff" opacity="0.65"/>
    <rect x="256" y="440" width="88" height="70" rx="12" fill="#2a2f36"/>
    <rect x="236" y="130" width="18" height="290" rx="9" fill="#ffffff" opacity="0.28"/>
    ${label(228, 230, 144, name, a)}`,
  pump: (c, name, a) => `
    <rect x="300" y="64" width="90" height="22" rx="8" fill="#2a2f36"/>
    <rect x="286" y="80" width="28" height="70" fill="#2a2f36"/>
    <rect x="262" y="142" width="76" height="44" rx="10" fill="#3b4451"/>
    <rect x="196" y="180" width="208" height="320" rx="44" fill="${c}"/>
    <rect x="218" y="204" width="24" height="250" rx="12" fill="#ffffff" opacity="0.28"/>
    ${label(216, 300, 168, name, a)}`,
};

const svgFor = ([
  ,
  name,
  shape,
  colour,
  bg,
  accent,
]) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
  <rect width="600" height="600" fill="${bg}"/>
  <circle cx="470" cy="120" r="70" fill="${colour}" opacity="0.14"/>
  <circle cx="110" cy="480" r="90" fill="${colour}" opacity="0.10"/>
  <ellipse cx="300" cy="528" rx="170" ry="22" fill="#000000" opacity="0.08"/>
  ${SHAPES[shape](colour, name, accent)}
</svg>
`;

await mkdir(new URL('src/', OUT), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
for (const product of PRODUCTS) {
  const svg = svgFor(product);
  await writeFile(new URL(`src/${product[0]}.svg`, OUT), svg);
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page
    .locator('svg')
    .screenshot({ path: new URL(`${product[0]}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  console.log(`✔ ${product[0]}.png`);
}
// The demo brand's logo for the chat header: a simple monogram (self-made).
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">
  <rect width="240" height="240" rx="120" fill="#fbae2c"/>
  <circle cx="120" cy="120" r="96" fill="none" stroke="#ffffff" stroke-width="6" opacity="0.6"/>
  <text x="120" y="146" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="84"
        font-weight="700" fill="#3d2300">DB</text>
</svg>
`;
await writeFile(new URL('src/demo-beauty-co-logo.svg', OUT), logo);
await page.setViewportSize({ width: 240, height: 240 });
await page.setContent(`<html><body style="margin:0">${logo}</body></html>`);
await page.locator('svg').screenshot({
  path: new URL('demo-beauty-co-logo.png', OUT).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  omitBackground: true,
});
console.log('✔ demo-beauty-co-logo.png');
await browser.close();
