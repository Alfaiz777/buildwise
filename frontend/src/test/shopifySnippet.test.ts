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
  ids: ReturnType<typeof vi.fn>;
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

function load(options: { html?: string; config?: Record<string, unknown>; available?: boolean } = {}): Fake {
  document.body.innerHTML = `${options.html ?? PRODUCT_PAGE}<script id="qwikspot-config" type="application/json">${config(options.config)}</script>`;
  const fake: Fake = {
    init: vi.fn(),
    track: vi.fn(() => Promise.resolve({ accepted: true, whatsapp_available: options.available ?? true })),
    whatsapp: vi.fn(),
    ids: vi.fn(() => ({ web_session_id: 'ws_test_session01', visitor_id: 'vis_test_visitor1' })),
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

describe('Shopify snippet — "Need it today?" and the WhatsApp bubble are links to GET /api/wa', () => {
  const need = () => document.querySelector<HTMLAnchorElement>('a.qs-need')!;
  const bubble = () => document.querySelector<HTMLAnchorElement>('a.qs-bubble')!;
  const params = (a: HTMLAnchorElement) => Object.fromEntries(new URL(a.href).searchParams);

  it('the button sits under Add to cart, with "Powered by Qwikspot"; the bubble is on the page', () => {
    load();
    const buttons = document.querySelector('.product-form__buttons')!;
    expect(buttons.nextElementSibling).toBe(need());
    expect(need()).toHaveTextContent('Need it today? Ask on WhatsApp');
    expect(need().nextElementSibling).toHaveTextContent('Powered by Qwikspot');
    expect(bubble()).toHaveAttribute('aria-label', 'Chat on WhatsApp');
  });

  it('each link points at the redirect with the brand, the entry, the chosen variant and the two random ids', () => {
    load();
    expect(need().href.startsWith('https://app.qwikspot.example/api/wa?')).toBe(true);
    expect(params(need())).toEqual({
      brand: 'brd_demo',
      entry: 'STORE_NEED',
      variant: '111',
      session: 'ws_test_session01',
      visitor: 'vis_test_visitor1',
    });
    expect(params(bubble())).toMatchObject({ entry: 'CHAT', variant: '111' });
    expect(need().referrerPolicy).toBe('strict-origin-when-cross-origin'); // the redirect checks the store's origin
  });

  it('choosing another size updates both links before the tap', async () => {
    load();
    const input = document.querySelector<HTMLInputElement>('[name="id"]')!;
    input.value = '222';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(params(need()).variant).toBe('222');
    expect(params(bubble()).variant).toBe('222');
  });

  it('on a computer: a new tab (target=_blank, rel=noopener); on a phone: the same tab, so the WhatsApp app opens', () => {
    load();
    expect(need().target).toBe('_blank');
    expect(need().rel).toBe('noopener');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36',
    );
    delete (window as { __qwikspotShopify?: boolean }).__qwikspotShopify;
    load();
    expect(need().target).toBe('');
    expect(bubble().target).toBe('');
  });

  it('a tap navigates at once: no API call first, the default action is kept; GA4 gets the click; "Opening WhatsApp…"', () => {
    vi.useFakeTimers();
    const gtag = vi.fn();
    (window as unknown as { gtag: typeof gtag }).gtag = gtag;
    const fake = load();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    // jsdom does not navigate; the point is that nothing cancels the link's own navigation.
    need().addEventListener('click', (e) => e.preventDefault());
    need().dispatchEvent(click);
    expect(fake.whatsapp).not.toHaveBeenCalled();
    expect(gtag).toHaveBeenCalledWith('event', 'qwikspot_whatsapp_click', {
      entry: 'STORE_NEED',
      item_id: '111',
      item_name: 'Mineral Sunscreen SPF 50',
    });
    expect(need()).toHaveTextContent('Opening WhatsApp…');
    vi.advanceTimersByTime(3000);
    expect(need()).toHaveTextContent('Need it today? Ask on WhatsApp');
    vi.useRealTimers();
  });

  it('hidden only when Qwikspot answers whatsapp_available: false — never because a request failed', async () => {
    load({ available: false });
    await tick();
    expect(need().style.display).toBe('none');
    expect(bubble().style.display).toBe('none');

    delete (window as { __qwikspotShopify?: boolean }).__qwikspotShopify;
    window.sessionStorage.clear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = load();
    failing.track.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    const input = document.querySelector<HTMLInputElement>('[name="id"]')!;
    input.value = '555';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    await tick();
    expect(need().style.display).toBe('');
    expect(bubble().style.display).toBe('');
    expect(warn).toHaveBeenCalledWith('[Qwikspot] storefront events are not reaching Qwikspot: blocked (CORS/network)');
  });

  it('one quiet DevTools warning per page with the HTTP status when an event is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = load();
    fake.track.mockImplementation(() => Promise.reject({ status: 403, error: { code: 'ORIGIN_NOT_ALLOWED' } }));
    const input = document.querySelector<HTMLInputElement>('[name="id"]')!;
    for (const id of ['601', '602']) {
      input.value = id;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      await tick();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[Qwikspot] storefront events are not reaching Qwikspot: HTTP 403 ORIGIN_NOT_ALLOWED',
    );
  });

  it('the bubble stays above a bar the theme fixes to the bottom (Savor’s sticky Add to cart)', () => {
    load({
      html: `${PRODUCT_PAGE}<div class="sticky-add-to-cart" style="position:fixed;bottom:0;left:0;right:0;height:72px"></div>`,
    });
    const bar = document.querySelector<HTMLElement>('.sticky-add-to-cart')!;
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({
      top: window.innerHeight - 72,
      bottom: window.innerHeight,
      height: 72,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: window.innerHeight - 72,
      toJSON: () => ({}),
    });
    window.dispatchEvent(new Event('resize'));
    return new Promise<void>((done) =>
      setTimeout(() => {
        expect(bubble().style.bottom).toBe('calc(84px + env(safe-area-inset-bottom, 0px))');
        done();
      }, 250),
    );
  });

  it('pages other than a product: only the bubble, without a variant', () => {
    load({ html: '<main></main>', config: { template: 'index', product: null } });
    expect(document.querySelector('.qs-need')).toBeNull();
    expect(params(bubble())).toEqual({
      brand: 'brd_demo',
      entry: 'CHAT',
      session: 'ws_test_session01',
      visitor: 'vis_test_visitor1',
    });
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
