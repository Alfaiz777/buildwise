#!/usr/bin/env node
/**
 * npm run shopify:snippet — builds integrations/shopify/qwikspot.liquid (the one file a brand
 * pastes into its Shopify theme) from the Liquid template and qwikspot-shopify.js.
 * `--check` fails if the committed snippet is out of date (used by the tests).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../integrations/shopify/', import.meta.url));
const MARKER = '/*__QWIKSPOT_SHOPIFY_JS__*/';

export function buildSnippet() {
  const template = readFileSync(`${dir}qwikspot.liquid.template`, 'utf8').replace(/\r\n/g, '\n');
  const js = readFileSync(`${dir}qwikspot-shopify.js`, 'utf8').replace(/\r\n/g, '\n').trim();
  if (!template.includes(MARKER)) throw new Error('qwikspot.liquid.template has no script marker');
  // Liquid would read "{{" / "{%" inside the script: the JS must not contain them.
  if (/\{\{|\{%/.test(js)) throw new Error('qwikspot-shopify.js must not contain "{{" or "{%" (Liquid)');
  // Shopify's theme editor reads "<script" or "</" inside the script as HTML and reports the tag unclosed.
  if (/<script|<\//i.test(js)) throw new Error('qwikspot-shopify.js must not contain "<script" or "</" (write "<\\/")');
  return template.replace(MARKER, js);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = `${dir}qwikspot.liquid`;
  const built = buildSnippet();
  if (process.argv.includes('--check')) {
    const current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    if (current !== built) {
      console.error('integrations/shopify/qwikspot.liquid is out of date: run npm run shopify:snippet');
      process.exit(1);
    }
    console.log('✔ qwikspot.liquid is up to date');
  } else {
    writeFileSync(target, built);
    console.log(`✔ wrote ${target}`);
  }
}
