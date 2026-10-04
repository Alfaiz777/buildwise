import { MessageCircle, Search, ShoppingBag, SlidersHorizontal, Store, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Drawer, ProductThumb } from '../../components/ui';
import { useDemoConfig } from '../../lib/demoConfig';
import { label } from '../../lib/labels';
import { ShopperChat } from '../../lib/shopperApi';
import { ShopperPhone } from './ShopperPhone';
import { ShopperUnavailable } from './ShopperUnavailable';

/**
 * /shop — the brand's demo website with the Qwikspot widget (Change 16; formerly
 * /demo-store). It uses the same dependency-free snippet (/qwikspot-intent.js) that goes
 * into the real Shopify theme in L2, so every click posts exactly the events a real
 * storefront would. "Need it today?" and "Chat on WhatsApp" open the brand's chat: docked
 * beside the page on desktop, full screen (/chat) on phones. Demo-only tools (who is
 * shopping, journey scenarios) live in the "Demo controls" drawer.
 */

export interface IntentTracker {
  init(options: {
    apiBaseUrl: string;
    brandId: string;
    openLink: (link: string | null, prefilled: string) => void;
  }): IntentTracker;
  ids(): { web_session_id: string; visitor_id: string };
  /** M6: the qs_ref this tab arrived with from a "Buy online" link, or null. */
  attributionRef?(): string | null;
  track(type: string, data?: { variantId?: string; searchTerm?: string; entry?: string }): Promise<TrackResult>;
  whatsapp(entry: 'STORE_NEED' | 'CHAT', variantId?: string): Promise<TrackResult>;
  newSession(): void;
  forgetVisitor(): void;
}

interface TrackResult {
  intent_stage: string;
  intent_strength: string;
  intent_type: string;
  whatsapp: { prefilled_text: string; wa_link: string | null; expires_at: string } | null;
}

interface Product {
  product_id: string;
  title: string;
  description: string;
  category: string | null;
  image_url?: string | null;
  variants: { shopify_variant_id: string; title: string; price: number; currency: string }[];
}

interface Shopper {
  shopper_id: string;
  first_name: string | null;
  marketing_consent: 'OPTED_IN' | 'NOT_OPTED_IN';
}

declare global {
  interface Window {
    QwikspotIntent?: IntentTracker;
  }
}

const SHOPPER_KEY = 'qs_demo_shopper';

function loadSnippet(): Promise<IntentTracker> {
  if (window.QwikspotIntent) return Promise.resolve(window.QwikspotIntent);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/qwikspot-intent.js';
    script.onload = () => (window.QwikspotIntent ? resolve(window.QwikspotIntent) : reject(new Error('snippet')));
    script.onerror = () => reject(new Error('Could not load the storefront snippet.'));
    document.head.appendChild(script);
  });
}

const price = (p: number) => `₹${p.toLocaleString('en-IN')}`;
const isDesktop = () => typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 900px)').matches;

type View =
  | { page: 'home' }
  | { page: 'product'; productId: string }
  | { page: 'cart' }
  | { page: 'checkout' }
  | { page: 'done' };

export function ShopPage({ tracker: injected }: { tracker?: IntentTracker }) {
  const demo = useDemoConfig();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const brandId = params.get('brand') ?? demo.shopperDemoBrand;
  const chat = useMemo(() => (brandId ? new ShopperChat(brandId) : null), [brandId]);

  const [tracker, setTracker] = useState<IntentTracker | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [shoppers, setShoppers] = useState<Shopper[]>([]);
  const [shopper, setShopper] = useState<Shopper | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(SHOPPER_KEY) ?? 'null') as Shopper | null;
    } catch {
      return null;
    }
  });
  const [view, setView] = useState<View>({ page: 'home' });
  const [cart, setCart] = useState<{ product: Product; variantId: string } | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [last, setLast] = useState<TrackResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [controls, setControls] = useState(false);
  const [docked, setDocked] = useState<{ prefill: string } | null>(null);

  const openLink = useMemo(
    () => (_link: string | null, prefilled: string) => {
      // The demo runs without real WhatsApp: open the brand's chat with the prefilled text.
      // Desktop: docked beside the store. Phone: full screen. The text travels in the
      // fragment, never the query string, so it stays out of server logs.
      if (isDesktop()) setDocked({ prefill: prefilled });
      else navigate(`/chat?brand=${encodeURIComponent(brandId ?? '')}#${new URLSearchParams({ text: prefilled })}`);
    },
    [navigate, brandId],
  );

  useEffect(() => {
    if (!brandId) return;
    let cancelled = false;
    (injected ? Promise.resolve(injected) : loadSnippet())
      .then((t) => {
        if (cancelled) return;
        t.init({ apiBaseUrl: '', brandId, openLink });
        setTracker(t);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [injected, brandId, openLink]);

  useEffect(() => {
    if (!brandId) return;
    fetch(`/api/demo-storefront/products?brand_id=${encodeURIComponent(brandId)}`)
      .then((r) => r.json())
      .then((j: { products?: Product[] }) => setProducts(j.products ?? []))
      .catch(() => setError('Could not load products. Is the backend running?'));
    fetch('/api/demo-storefront/shoppers')
      .then((r) => r.json())
      .then((j: { shoppers?: Shopper[] }) => setShoppers(j.shoppers ?? []))
      .catch(() => undefined);
  }, [brandId]);

  const record = async (type: string, data?: { variantId?: string; searchTerm?: string; entry?: string }) => {
    if (!tracker) return null;
    try {
      const res = await tracker.track(type, data);
      setLast(res);
      return res;
    } catch {
      setError('The event was not accepted.');
      return null;
    }
  };

  // The first page view of this tab.
  useEffect(() => {
    if (tracker) void record('STOREFRONT_VISIT');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracker]);

  const product = view.page === 'product' ? products?.find((p) => p.product_id === view.productId) : null;

  // "Buy online" links from the chat open a product directly: /shop#product=<product_id>.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('product');
    const match = wanted ? products?.find((p) => p.product_id === wanted) : undefined;
    if (match && tracker) openProduct(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, tracker]);

  const openProduct = (p: Product) => {
    setView({ page: 'product', productId: p.product_id });
    setSelectedVariant(p.variants[0]?.shopify_variant_id ?? null);
    void record('PRODUCT_DETAIL_VIEW', { variantId: p.variants[0]?.shopify_variant_id });
  };

  const signIn = async (s: Shopper) => {
    if (!tracker || !brandId || !chat) return;
    const ids = tracker.ids();
    const res = await fetch('/api/demo-storefront/shopper-sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand_id: brandId, shopper_id: s.shopper_id, ...ids }),
    });
    if (!res.ok) return setError('Sign-in failed.');
    // The chat continues as this demo shopper: the server issues the identity.
    await chat.start(s.shopper_id).catch(() => undefined);
    localStorage.setItem(SHOPPER_KEY, JSON.stringify(s));
    setShopper(s);
    setDocked(null);
    setControls(false);
    setNotice(
      `Signed in as ${s.first_name} (${s.marketing_consent === 'OPTED_IN' ? 'opted in to messages' : 'not opted in'}).`,
    );
  };

  const guest = async () => {
    tracker?.forgetVisitor();
    localStorage.removeItem(SHOPPER_KEY);
    setShopper(null);
    await chat?.start(null).catch(() => undefined);
    setDocked(null);
    setControls(false);
    setNotice('Continuing as a guest: a new anonymous visitor.');
    void record('STOREFRONT_VISIT');
  };

  const placeOrder = async () => {
    if (!tracker || !cart || !brandId) return;
    const res = await fetch('/api/demo-storefront/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand_id: brandId,
        web_session_id: tracker.ids().web_session_id,
        shopify_variant_id: cart.variantId,
        ...(tracker.attributionRef?.() ? { qs_ref: tracker.attributionRef!() } : {}),
      }),
    });
    if (!res.ok) return setError('Could not place the order.');
    setCart(null);
    setView({ page: 'done' });
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    if (search.trim()) void record('SEARCH', { searchTerm: search.trim() });
  };

  /** Replays a journey as real events through the snippet, in a fresh browsing session. */
  const scenario = async (steps: [string, { variantId?: string; searchTerm?: string; entry?: string }?][]) => {
    if (!tracker) return;
    tracker.newSession();
    for (const [type, data] of steps) await record(type, data);
    setNotice(`Scenario recorded in a new session. Watch it in the Brand Console.`);
  };

  if (!demo.loaded && !params.get('brand')) return <p className="status page">Loading…</p>;
  if (!brandId || !chat) return <ShopperUnavailable />;

  const hero = products?.find((p) => p.title === 'Vitamin C Glow Serum') ?? products?.[0];
  const heroVariant = hero?.variants[0]?.shopify_variant_id;
  const SCENARIOS: [string, [string, { variantId?: string; searchTerm?: string; entry?: string }?][]][] = [
    ['1. Visit → leave', [['STOREFRONT_VISIT']]],
    ['2. Search → leave', [['STOREFRONT_VISIT'], ['SEARCH', { searchTerm: 'vitamin c serum' }]]],
    [
      '3. Product view → leave',
      [
        ['STOREFRONT_VISIT'],
        ['PRODUCT_VIEW', { variantId: heroVariant }],
        ['PRODUCT_DETAIL_VIEW', { variantId: heroVariant }],
      ],
    ],
    [
      '4. Product → add to cart → leave',
      [
        ['STOREFRONT_VISIT'],
        ['PRODUCT_DETAIL_VIEW', { variantId: heroVariant }],
        ['VARIANT_SELECTED', { variantId: heroVariant }],
        ['ADD_TO_CART', { variantId: heroVariant }],
      ],
    ],
    [
      '5. Product → checkout → leave',
      [
        ['STOREFRONT_VISIT'],
        ['PRODUCT_DETAIL_VIEW', { variantId: heroVariant }],
        ['ADD_TO_CART', { variantId: heroVariant }],
        ['CHECKOUT_STARTED', { variantId: heroVariant }],
      ],
    ],
    [
      '6. "Need it today?" (don\'t send the message)',
      [
        ['STOREFRONT_VISIT'],
        ['PRODUCT_DETAIL_VIEW', { variantId: heroVariant }],
        ['WHATSAPP_CLICK', { entry: 'STORE_NEED', variantId: heroVariant }],
      ],
    ],
  ];

  return (
    <div className={`shop ${docked ? 'shop--docked' : ''}`}>
      <p className="demo-ribbon">Demo storefront · synthetic data</p>
      <header className="shop-header">
        <button type="button" className="shop-brand" onClick={() => setView({ page: 'home' })}>
          <img src="/demo-products/demo-beauty-co-logo.png" alt="" width={32} height={32} />
          <span>Demo Beauty Co</span>
        </button>
        <form className="shop-search" onSubmit={onSearch} role="search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Search products"
            placeholder="Search serums, sunscreen…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        <div className="shop-actions">
          <span className="shop-who small">{shopper ? `Hi, ${shopper.first_name}` : 'Guest'}</span>
          <button
            type="button"
            className="shop-icon"
            onClick={() => setView({ page: 'cart' })}
            aria-label={`Cart, ${cart ? 1 : 0} item`}
          >
            <ShoppingBag size={20} aria-hidden="true" />
            {cart && <span className="shop-count">1</span>}
          </button>
          <button
            type="button"
            className="ui-button ui-button--secondary ui-button--sm"
            onClick={() => setControls(true)}
          >
            <SlidersHorizontal size={16} aria-hidden="true" /> Demo controls
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" className="shop-alert error">
          {error}
        </p>
      )}
      {notice && (
        <p className="shop-alert notice" role="status">
          {notice}
        </p>
      )}

      <div className="shop-layout">
        <main className="shop-main">
          {view.page === 'home' && (
            <>
              <section className="shop-hero">
                <h1>Skincare that works, near you.</h1>
                <p>Order online — or pick it up today at a partner store.</p>
              </section>
              <h2 className="shop-h2">All products</h2>
              {!products && <p className="muted">Loading products…</p>}
              {products?.length === 0 && <p className="muted">No products yet. Run npm run seed:demo first.</p>}
              <div className="shop-grid">
                {products?.map((p) => (
                  <button key={p.product_id} type="button" className="shop-card" onClick={() => openProduct(p)}>
                    <ProductThumb src={p.image_url} name={p.title} size={180} />
                    <strong>{p.title}</strong>
                    <span className="muted small">{p.category}</span>
                    <span className="shop-price">{p.variants[0] ? `from ${price(p.variants[0].price)}` : ''}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {product && (
            <section className="shop-product">
              <ProductThumb src={product.image_url} name={product.title} size={360} />
              <div className="shop-product__info">
                <p className="muted small">{product.category}</p>
                <h1>{product.title}</h1>
                <p>{product.description}</p>
                <fieldset className="shop-sizes">
                  <legend>Size</legend>
                  {product.variants.map((v) => (
                    <label key={v.shopify_variant_id} className="shop-size">
                      <input
                        type="radio"
                        name="size"
                        value={v.shopify_variant_id}
                        checked={selectedVariant === v.shopify_variant_id}
                        onChange={() => {
                          setSelectedVariant(v.shopify_variant_id);
                          void record('VARIANT_SELECTED', { variantId: v.shopify_variant_id });
                        }}
                      />
                      <span>
                        {v.title} · {price(v.price)}
                      </span>
                    </label>
                  ))}
                </fieldset>
                <button
                  type="button"
                  className="ui-button ui-button--primary shop-buy"
                  onClick={() => {
                    if (!selectedVariant) return;
                    setCart({ product, variantId: selectedVariant });
                    void record('ADD_TO_CART', { variantId: selectedVariant });
                    setNotice(`${product.title} added to your bag.`);
                  }}
                >
                  Add to bag
                </button>
                <aside className="qs-widget" aria-label="Get it today">
                  <button
                    type="button"
                    className="qs-widget__primary"
                    onClick={() => void tracker?.whatsapp('STORE_NEED', selectedVariant ?? undefined)}
                  >
                    <Store size={18} aria-hidden="true" /> Need it today? Check a store near you
                  </button>
                  <button
                    type="button"
                    className="qs-widget__secondary"
                    onClick={() => void tracker?.whatsapp('CHAT', selectedVariant ?? undefined)}
                  >
                    <MessageCircle size={18} aria-hidden="true" /> Chat on WhatsApp
                  </button>
                  <span className="qs-widget__powered">Powered by Qwikspot</span>
                </aside>
              </div>
            </section>
          )}

          {view.page === 'cart' && (
            <section className="shop-panel">
              <h1>Your bag</h1>
              {!cart ? (
                <p className="muted">Your bag is empty.</p>
              ) : (
                <>
                  <div className="shop-line">
                    <ProductThumb src={cart.product.image_url} name={cart.product.title} size={56} />
                    <span>
                      {cart.product.title} ·{' '}
                      {cart.product.variants.find((v) => v.shopify_variant_id === cart.variantId)?.title}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ui-button ui-button--primary"
                    onClick={() => {
                      setView({ page: 'checkout' });
                      void record('CHECKOUT_STARTED', { variantId: cart.variantId });
                    }}
                  >
                    Checkout
                  </button>
                </>
              )}
            </section>
          )}

          {view.page === 'checkout' && cart && (
            <section className="shop-panel">
              <h1>Checkout</h1>
              <p className="muted small">Demo checkout: no payment, no personal details.</p>
              <button type="button" className="ui-button ui-button--primary" onClick={() => void placeOrder()}>
                Place order
              </button>
            </section>
          )}

          {view.page === 'done' && (
            <section className="shop-panel">
              <h1>Order placed</h1>
              <p>Thank you! Any pending follow-up for this session is now suppressed.</p>
            </section>
          )}
        </main>

        {docked && (
          <aside className="shop-dock" aria-label="Chat">
            <button
              type="button"
              className="ui-icon-button shop-dock__close"
              aria-label="Close chat"
              onClick={() => setDocked(null)}
            >
              <X size={18} aria-hidden="true" />
            </button>
            <ShopperPhone chat={chat} initialDraft={docked.prefill} />
          </aside>
        )}
      </div>

      <Drawer open={controls} title="Demo controls" onClose={() => setControls(false)}>
        <div className="shop-controls">
          <h3>Who is shopping?</h3>
          <p className="muted small">
            A guest is anonymous: intent is recorded, but nobody can be messaged. A signed-in demo shopper mirrors a
            store account with marketing consent (L2: Shopify). The chat continues as that shopper.
          </p>
          <div className="shop-controls__list">
            {shoppers.map((s) => (
              <button
                key={s.shopper_id}
                type="button"
                className="ui-button ui-button--secondary"
                onClick={() => void signIn(s)}
              >
                Sign in as demo shopper: {s.first_name} (
                {s.marketing_consent === 'OPTED_IN' ? 'opted in' : 'not opted in'})
              </button>
            ))}
            <button type="button" className="ui-button ui-button--ghost" onClick={() => void guest()}>
              Continue as guest
            </button>
          </div>
          <h3>Journey scenarios</h3>
          <p className="muted small">
            Each starts a new browsing session and posts the same events a shopper would. Then leave: the follow-up (if
            any) becomes due after the configured delay.
          </p>
          <div className="shop-controls__list">
            {SCENARIOS.map(([name, steps]) => (
              <button
                key={name}
                type="button"
                className="ui-button ui-button--secondary"
                onClick={() => void scenario(steps)}
              >
                {name}
              </button>
            ))}
          </div>
          {last && (
            <p className="small" aria-label="Last intent">
              Detected: <span className="ui-pill ui-pill--primary">{label(last.intent_type)}</span>{' '}
              <span className="ui-pill ui-pill--neutral">stage: {label(last.intent_stage)}</span>{' '}
              <span className="ui-pill ui-pill--neutral">{label(last.intent_strength)}</span>
            </p>
          )}
        </div>
      </Drawer>
    </div>
  );
}
