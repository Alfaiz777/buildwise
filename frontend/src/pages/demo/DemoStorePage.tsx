import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * LOCAL PROFILE ONLY: a small demo storefront (docs/00 §11.8 Change 11). It uses the same
 * dependency-free snippet (/qwikspot-intent.js) that goes into the real Shopify theme in
 * L2, so every click here posts exactly the events a real storefront would. It never writes
 * to Firestore itself; orders go through the local-only order endpoint (same path as the
 * L2 orders webhook). WhatsApp is not wired locally, so the WhatsApp buttons open the
 * Brand Console simulator with the prefilled text in the URL fragment.
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
  variants: { shopify_variant_id: string; title: string; price: number; currency: string }[];
}

interface Shopper {
  shopper_id: string;
  first_name: string | null;
  marketing_consent: 'OPTED_IN' | 'NOT_OPTED_IN';
  simulator_customer_ref: string;
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
const label = (v: string) => v.toLowerCase().replace(/_/g, ' ');

type View =
  | { page: 'home' }
  | { page: 'product'; productId: string }
  | { page: 'cart' }
  | { page: 'checkout' }
  | { page: 'done' };

export function DemoStorePage({ tracker: injected }: { tracker?: IntentTracker }) {
  const [params] = useSearchParams();
  const brandId = params.get('brand') ?? 'brd_demo';
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

  const simulatorRef = shopper?.simulator_customer_ref ?? null;
  const openLink = useMemo(
    () => (_link: string | null, prefilled: string) => {
      // Local profile: WhatsApp isn't wired, so hand the prefilled text to the Brand Console simulator
      // in the URL fragment (never the query string, so it stays out of server logs).
      const fragment = new URLSearchParams({
        text: prefilled,
        customer: simulatorRef ?? `guest_${Date.now().toString(36)}`,
      });
      window.open(`/brand/conversations#${fragment.toString()}`, '_blank', 'noopener');
    },
    [simulatorRef],
  );

  useEffect(() => {
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
    fetch(`/api/demo-storefront/products?brand_id=${encodeURIComponent(brandId)}`)
      .then((r) => r.json())
      .then((j: { products?: Product[] }) => setProducts(j.products ?? []))
      .catch(() => setError('Could not load products. Is the backend running with the local profile?'));
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
      setError('The event was not accepted (see the backend log).');
      return null;
    }
  };

  // The first page view of this tab.
  useEffect(() => {
    if (tracker) void record('STOREFRONT_VISIT');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracker]);

  const product = view.page === 'product' ? products?.find((p) => p.product_id === view.productId) : null;

  // "Buy online" links from the chat open a product directly: /demo-store#product=<product_id>.
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
    if (!tracker) return;
    const ids = tracker.ids();
    const res = await fetch('/api/demo-storefront/shopper-sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand_id: brandId, shopper_id: s.shopper_id, ...ids }),
    });
    if (!res.ok) return setError('Sign-in failed.');
    localStorage.setItem(SHOPPER_KEY, JSON.stringify(s));
    setShopper(s);
    setNotice(
      `Signed in as ${s.first_name} (${s.marketing_consent === 'OPTED_IN' ? 'opted in to messages' : 'not opted in'}).`,
    );
  };

  const guest = () => {
    tracker?.forgetVisitor();
    localStorage.removeItem(SHOPPER_KEY);
    setShopper(null);
    setNotice('Continuing as a guest: a new anonymous visitor.');
    void record('STOREFRONT_VISIT');
  };

  const placeOrder = async () => {
    if (!tracker || !cart) return;
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
    setNotice(
      `Scenario recorded in a new session (${tracker.ids().web_session_id.slice(0, 10)}…). Watch it in the Brand Console.`,
    );
  };
  const hero = products?.find((p) => p.title === 'Vitamin C Glow Serum') ?? products?.[0];
  const heroVariant = hero?.variants[0]?.shopify_variant_id;

  return (
    <main className="demo-store">
      <header className="demo-header">
        <div>
          <strong>Demo Beauty Co</strong> <span className="badge">Demo storefront (local profile)</span>
        </div>
        <div className="small">
          {shopper ? (
            <>
              Signed in as {shopper.first_name}{' '}
              <span className="badge">{shopper.marketing_consent === 'OPTED_IN' ? 'opted in' : 'not opted in'}</span>
            </>
          ) : (
            'Guest (anonymous visitor)'
          )}{' '}
          · Cart: {cart ? 1 : 0}
        </div>
      </header>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}

      <section className="panel">
        <h2>Who is shopping?</h2>
        <div className="filters">
          {shoppers.map((s) => (
            <button key={s.shopper_id} type="button" className="secondary" onClick={() => void signIn(s)}>
              Sign in as demo shopper: {s.first_name} (
              {s.marketing_consent === 'OPTED_IN' ? 'opted in' : 'not opted in'})
            </button>
          ))}
          <button type="button" className="secondary" onClick={guest}>
            Continue as guest
          </button>
        </div>
        <p className="muted small">
          A guest is anonymous: intent is recorded, but nobody can be messaged. A signed-in demo shopper mirrors a store
          account with marketing consent (L2: Shopify).
        </p>
      </section>

      <nav className="filters">
        <button type="button" className="secondary" onClick={() => setView({ page: 'home' })}>
          Home
        </button>
        <button type="button" className="secondary" onClick={() => setView({ page: 'cart' })}>
          Cart
        </button>
        <form className="inline" onSubmit={onSearch} role="search">
          <input
            aria-label="Search products"
            placeholder="Search products"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>
      </nav>

      {view.page === 'home' && (
        <section className="panel">
          <h2>Products</h2>
          {!products && <p className="muted">Loading products…</p>}
          {products?.length === 0 && <p className="muted">No products. Run npm run seed:demo first.</p>}
          <div className="product-grid">
            {products?.map((p) => (
              <button key={p.product_id} type="button" className="product-card" onClick={() => openProduct(p)}>
                <strong>{p.title}</strong>
                <span className="muted small">{p.category}</span>
                <span>{p.variants[0] ? `from ${price(p.variants[0].price)}` : ''}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {product && (
        <section className="panel">
          <h2>{product.title}</h2>
          <p>{product.description}</p>
          <label className="small">
            Size{' '}
            <select
              aria-label="Size"
              value={selectedVariant ?? ''}
              onChange={(e) => {
                setSelectedVariant(e.target.value);
                void record('VARIANT_SELECTED', { variantId: e.target.value });
              }}
            >
              {product.variants.map((v) => (
                <option key={v.shopify_variant_id} value={v.shopify_variant_id}>
                  {v.title} · {price(v.price)}
                </option>
              ))}
            </select>
          </label>
          <div className="filters">
            <button
              type="button"
              onClick={() => {
                if (!selectedVariant) return;
                setCart({ product, variantId: selectedVariant });
                void record('ADD_TO_CART', { variantId: selectedVariant });
                setNotice(`${product.title} added to cart.`);
              }}
            >
              Add to cart
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void tracker?.whatsapp('STORE_NEED', selectedVariant ?? undefined)}
            >
              Need it today? Check a store near you
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void tracker?.whatsapp('CHAT', selectedVariant ?? undefined)}
            >
              Chat with us
            </button>
          </div>
        </section>
      )}

      {view.page === 'cart' && (
        <section className="panel">
          <h2>Cart</h2>
          {!cart ? (
            <p className="muted">Your cart is empty.</p>
          ) : (
            <>
              <p>
                {cart.product.title} ·{' '}
                {cart.product.variants.find((v) => v.shopify_variant_id === cart.variantId)?.title}
              </p>
              <button
                type="button"
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
        <section className="panel">
          <h2>Checkout</h2>
          <p className="muted small">Demo checkout: no payment, no personal details.</p>
          <button type="button" onClick={() => void placeOrder()}>
            Place order
          </button>
        </section>
      )}

      {view.page === 'done' && (
        <section className="panel">
          <h2>Order placed</h2>
          <p>Thank you! Any pending follow-up for this session is now suppressed.</p>
        </section>
      )}

      <section className="panel">
        <h2>Journey scenarios</h2>
        <p className="muted small">
          Each button starts a new browsing session and posts the same events a shopper would, through the snippet. Then
          leave: the follow-up (if any) becomes due after the configured delay.
        </p>
        <div className="filters">
          <button type="button" className="secondary" onClick={() => void scenario([['STOREFRONT_VISIT']])}>
            1. Visit → leave
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void scenario([['STOREFRONT_VISIT'], ['SEARCH', { searchTerm: 'vitamin c serum' }]])}
          >
            2. Search → leave
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void scenario([
                ['STOREFRONT_VISIT'],
                ['PRODUCT_VIEW', { variantId: heroVariant }],
                ['PRODUCT_DETAIL_VIEW', { variantId: heroVariant }],
              ])
            }
          >
            3. Product view → leave
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void scenario([
                ['STOREFRONT_VISIT'],
                ['PRODUCT_DETAIL_VIEW', { variantId: heroVariant }],
                ['VARIANT_SELECTED', { variantId: heroVariant }],
                ['ADD_TO_CART', { variantId: heroVariant }],
              ])
            }
          >
            4. Product → add to cart → leave
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void scenario([
                ['STOREFRONT_VISIT'],
                ['PRODUCT_DETAIL_VIEW', { variantId: heroVariant }],
                ['ADD_TO_CART', { variantId: heroVariant }],
                ['CHECKOUT_STARTED', { variantId: heroVariant }],
              ])
            }
          >
            5. Product → checkout → leave
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void scenario([
                ['STOREFRONT_VISIT'],
                ['PRODUCT_DETAIL_VIEW', { variantId: heroVariant }],
                ['WHATSAPP_CLICK', { entry: 'STORE_NEED', variantId: heroVariant }],
              ])
            }
          >
            6. "Need it today?" (don't send the message)
          </button>
        </div>
        {last && (
          <p className="small" aria-label="Last intent">
            Detected: <span className="badge">{label(last.intent_type)}</span>{' '}
            <span className="badge">stage: {label(last.intent_stage)}</span>{' '}
            <span className="badge">{label(last.intent_strength)}</span>
            {last.whatsapp && (
              <>
                {' '}
                · WhatsApp link issued (valid until {new Date(last.whatsapp.expires_at).toLocaleTimeString()}).{' '}
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => openLink(last.whatsapp!.wa_link, last.whatsapp!.prefilled_text)}
                >
                  Open it in the simulator
                </button>
              </>
            )}
          </p>
        )}
      </section>
    </main>
  );
}
