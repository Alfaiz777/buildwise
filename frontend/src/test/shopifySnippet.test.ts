/**
 * L4: the Shopify theme snippet (integrations/shopify/qwikspot-shopify.js, inlined into
 * qwikspot.liquid) on a Savor / Dawn-style product page in jsdom, with QwikspotIntent stubbed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tests run from frontend/; the snippet lives in integrations/shopify at the repository root.
const ROOT = join(process.cwd(), '..', 'integrations', 'shopify');
const SNIPPET = readFileSync(join(ROOT, 'qwikspot-shopify.js'), 'utf8');
const LIQUID = readFileSync(join(ROOT, 'qwikspot.liquid'), 'utf8');
const GID = 'gid://shopify/ProductVariant/';

interface Fake {
  init: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
  whatsapp: ReturnType<typeof vi.fn>;
}

const PRODUCT_PAGE = `
  <div class="product__info">
    <div class="price">₹649</div>
    <form action="/cart/add" method="post">
      <input type="hidden" name="id" value="111">
      <div class="product-form__buttons"><button type="submit" name="add">Add to cart</button></div>
    </form>
  </div>`;

function config(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    apiBaseUrl: 'https://app.qwikspot.example',
    brandId: 'brd_demo',
    template: 'product',
    product: { title: 'Mineral Sunscreen SPF 50', variant: 111 },
    searchTerms: null,
    cartVariant: null,
    ...over,
  });
}

function load(options: { html?: string; config?: Record<string, unknown>; link?: string | null } = {}): Fake {
  document.body.innerHTML = `${options.html ?? PRODUCT_PAGE}<script id="qwikspot-config" type="application/json">${config(options.config)}</script>`;
  const link = options.link === undefined ? 'https://wa.me/910000000001?text=Hi' : options.link;
  const fake: Fake = {
    init: vi.fn(),
    track: vi.fn(() => Promise.resolve({ accepted: true })),
    whatsapp: vi.fn(() => Promise.resolve({ whatsapp: link ? { wa_link: link, prefilled_text: 'Hi' } : null })),
  };
  (window as unknown as { QwikspotIntent: Fake }).QwikspotIntent = fake;
  new Function(SNIPPET)();
  return fake;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const calls = (fake: Fake) => fake.track.mock.calls.map(([type, data]) => [type, data ?? {}]);

beforeEach(() => {
  delete (window as { __qwikspotShopify?: boolean }).__qwikspotShopify;
  window.sessionStorage.clear();
  delete (window as { gtag?: unknown }).gtag;
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Shopify snippet — tracking (only variant GIDs and search words)', () => {
  it('product page: init with the store settings, one visit per session, the product view with the variant GID', async () => {
    const fake = load();
    expect(fake.init).toHaveBeenCalledWith(
      expect.objectContaining({ apiBaseUrl: 'https://app.qwikspot.example', brandId: 'brd_demo' }),
    );
    expect(calls(fake)).toEqual([
      ['STOREFRONT_VISIT', {}],
      ['PRODUCT_DETAIL_VIEW', { variantId: `${GID}111` }],
    ]);
    // Another page in the same session: no second visit.
    delete (window as { __qwikspotShopify?: boolean }).__qwikspotShopify;
    const again = load();
    expect(calls(again).map(([t]) => t)).toEqual(['PRODUCT_DETAIL_VIEW']);
  });

  it('choosing another size sends VARIANT_SELECTED (the theme changes the id input / ?variant=)', async () => {
    const fake = load();
    const input = document.querySelector<HTMLInputElement>('[name="id"]')!;
    input.value = '222';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(calls(fake).at(-1)).toEqual(['VARIANT_SELECTED', { variantId: `${GID}222` }]);
    window.history.replaceState({}, '', '?variant=222');
    await tick();
    expect(calls(fake).filter(([t]) => t === 'VARIANT_SELECTED')).toHaveLength(1); // same variant: once
  });

  it('add to cart: an AJAX /cart/add call and a form submit for the same variant count once', async () => {
    const original = vi.fn(async () => new Response('{}'));
    window.fetch = original as unknown as typeof fetch;
    const fake = load();
    await window.fetch('/cart/add.js', { method: 'POST', body: JSON.stringify({ id: 111, quantity: 1 }) });
    expect(original).toHaveBeenCalled(); // the theme's request still goes through, unchanged
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(calls(fake).filter(([t]) => t === 'ADD_TO_CART')).toEqual([['ADD_TO_CART', { variantId: `${GID}111` }]]);
  });

  it('search results page: SEARCH with the words; cart page: CHECKOUT_STARTED with the first line’s variant', () => {
    const search = load({
      html: '<div></div>',
      config: { template: 'search', product: null, searchTerms: 'sunscreen' },
    });
    expect(calls(search)).toContainEqual(['SEARCH', { searchTerm: 'sunscreen' }]);

    window.sessionStorage.clear();
    delete (window as { __qwikspotShopify?: boolean }).__qwikspotShopify;
    const cart = load({
      html: '<form action="/cart"><button type="submit" name="checkout">Check out</button></form>',
      config: { template: 'cart', product: null, cartVariant: 333 },
    });
    document.querySelector<HTMLButtonElement>('[name="checkout"]')!.click();
    expect(calls(cart)).toContainEqual(['CHECKOUT_STARTED', { variantId: `${GID}333` }]);
  });

  it('never sends anything but event types, variant GIDs and search words', async () => {
    const fake = load();
    const input = document.querySelector<HTMLInputElement>('[name="id"]')!;
    input.value = '222';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    for (const [, data] of calls(fake)) {
      for (const key of Object.keys(data as object)) expect(['variantId', 'searchTerm']).toContain(key);
    }
  });

  it('failures are silent: a rejected event or a missing config does not throw', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = PRODUCT_PAGE;
    expect(() => new Function(SNIPPET)()).not.toThrow(); // no config element at all
    delete (window as { __qwikspotShopify?: boolean }).__qwikspotShopify;
    const fake = load();
    fake.track.mockImplementation(() => Promise.reject(new Error('offline')));
    const input = document.querySelector<HTMLInputElement>('[name="id"]')!;
    input.value = '444';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    await tick();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('Shopify snippet — "Need it today?" and the WhatsApp bubble', () => {
  it('the button sits under Add to cart, with "Powered by Qwikspot"; the bubble is on the page', () => {
    load();
    const buttons = document.querySelector('.product-form__buttons')!;
    expect(buttons.nextElementSibling).toHaveTextContent('Need it today? Ask on WhatsApp');
    expect(buttons.nextElementSibling!.nextElementSibling).toHaveTextContent('Powered by Qwikspot');
    expect(document.querySelector('[aria-label="Chat on WhatsApp"]')).toBeInTheDocument();
  });

  it('on a computer: opens a tab during the click, then sends it to the wa.me link; GA4 gets the click, no ids or tokens', async () => {
    const tab = { location: { href: '' }, opener: {} as unknown, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
    const gtag = vi.fn();
    (window as unknown as { gtag: typeof gtag }).gtag = gtag;
    const fake = load();
    const input = document.querySelector<HTMLInputElement>('[name="id"]')!;
    input.value = '222';
    (document.querySelector('.qs-need') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith('', '_blank'); // inside the click: not a blocked popup
    expect(fake.whatsapp).toHaveBeenCalledWith('STORE_NEED', `${GID}222`);
    await tick();
    expect(tab.location.href).toBe('https://wa.me/910000000001?text=Hi');
    expect(tab.opener).toBeNull();
    expect(gtag).toHaveBeenCalledWith('event', 'qwikspot_whatsapp_click', {
      entry: 'STORE_NEED',
      item_id: '222',
      item_name: 'Mineral Sunscreen SPF 50',
    });

    (document.querySelector('.qs-bubble') as HTMLButtonElement).click();
    expect(fake.whatsapp).toHaveBeenLastCalledWith('CHAT', `${GID}222`);
  });

  it('on a phone: no popup — the page goes to the wa.me link so the WhatsApp app opens', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile',
    );
    const open = vi.spyOn(window, 'open');
    vi.spyOn(console, 'error').mockImplementation(() => {}); // jsdom cannot navigate
    const fake = load();
    (document.querySelector('.qs-need') as HTMLButtonElement).click();
    await tick();
    expect(open).not.toHaveBeenCalled();
    expect(fake.whatsapp).toHaveBeenCalledWith('STORE_NEED', `${GID}111`);
  });

  it('no WhatsApp number connected (no wa_link): both entry points disappear and the blank tab closes', async () => {
    const tab = { location: { href: '' }, opener: {}, close: vi.fn() };
    vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
    load({ link: null });
    (document.querySelector('.qs-bubble') as HTMLButtonElement).click();
    await tick();
    expect(tab.close).toHaveBeenCalled();
    expect((document.querySelector('.qs-need') as HTMLElement).style.display).toBe('none');
    expect((document.querySelector('.qs-bubble') as HTMLElement).style.display).toBe('none');
  });

  it('pages other than a product: only the bubble, and it asks without a product', () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    const fake = load({ html: '<main></main>', config: { template: 'index', product: null } });
    expect(document.querySelector('.qs-need')).toBeNull();
    (document.querySelector('.qs-bubble') as HTMLButtonElement).click();
    expect(fake.whatsapp).toHaveBeenCalledWith('CHAT', undefined);
  });
});

describe('Shopify snippet — helpers and the Liquid file', () => {
  it('variant ids become the GIDs the backend stores; cart request bodies are read in every shape', () => {
    load();
    const h = (
      window as unknown as {
        __qwikspotShopifyHelpers: {
          gid: (v: unknown) => unknown;
          numeric: (v: unknown) => unknown;
          variantFromBody: (v: unknown) => unknown;
        };
      }
    ).__qwikspotShopifyHelpers;
    expect(h.gid('123')).toBe(`${GID}123`);
    expect(h.gid(`${GID}9`)).toBe(`${GID}9`);
    expect(h.gid('abc')).toBeNull();
    expect(h.gid(null)).toBeNull();
    expect(h.numeric(`${GID}55`)).toBe('55');
    const form = new FormData();
    form.set('id', '77');
    expect(h.variantFromBody(form)).toBe('77');
    expect(h.variantFromBody('id=88&quantity=1')).toBe('88');
    expect(h.variantFromBody(JSON.stringify({ items: [{ id: 99 }] }))).toBe(99);
  });

  it('qwikspot.liquid holds exactly this script (rebuild with npm run shopify:snippet) and the two settings', () => {
    expect(LIQUID.replace(/\r\n/g, '\n')).toContain(SNIPPET.replace(/\r\n/g, '\n').trim());
    expect(LIQUID).toContain("assign qs_api = 'https://app.qwikspot.urbanlyfe.in'");
    expect(LIQUID).toContain("assign qs_brand = 'brd_demo'");
    expect(LIQUID).toContain('id="qwikspot-config"');
    expect(LIQUID).not.toMatch(/customer\.(email|phone|name|first_name)|cart\.token/);
  });
});
