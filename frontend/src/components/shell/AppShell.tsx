import { HelpCircle, LogOut, Menu as MenuIcon, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useApi } from '../../api/apiContext';
import { useAuth } from '../../auth/authContext';
import { useLoad } from '../ConsoleShell';
import { label } from '../../lib/labels';
import { Wordmark } from './Wordmark';
import { CONSOLE_NAME, NAV } from './nav';
import { RoleBanner, useRoleBanner } from './RoleBanner';
import { AiButton, Tip } from '../ui';
import { AskQwikspotProvider, BRAND_ASK } from '../../pages/brand/askQwikspot';
import { storeAsk } from '../../pages/retailer/storeAsk';
import { PLATFORM_ASK } from '../../pages/platform/platformAsk';
import { JudgeTour, SHOW_TOUR } from '../../pages/brand/JudgeTour';
import { useShopifyStore } from '../../pages/brand/shopifyStore';
import { StoreButton } from '../../pages/brand/StoreButton';

/** Dispatched on window when a page resolves or changes what the nav badge counts. */
export const WAITING_CHANGED = 'qwikspot:waiting-changed';

/** Dispatched on window when a page changed what the nav counts (UI-4). */
export const QUEUE_CHANGED = 'qs:queue-changed';

/** Whose data "Ask Qwikspot" answers from, per console (the header button's label). */
const ASK_DATA_OF = { BRAND: "your brand's", RETAIL: "your store's", PLATFORM: "the platform's" } as const;

/**
 * The frame of every console (UI-0): header, left sidebar on desktop, bottom tab bar on
 * phones, a role accent and the first-visit role banner. Scope comes from /api/me only.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const { signOut } = useAuth();
  // UI-P2: the Store header leads with the store ("Wellness Mart · Satellite"); the brand and
  // retailer are a small second line. UI-P1: the Platform header names the role instead.
  const context = me.scope === 'BRAND' ? me.brand_name : null;
  const store =
    me.scope === 'RETAIL'
      ? {
          name: me.store.area ? `${me.store.store_name} · ${me.store.area}` : me.store.store_name,
          via: `${me.brand_name} · ${me.retailer_name}`,
        }
      : null;
  const platform = me.scope === 'PLATFORM';
  const brand = me.scope === 'BRAND';
  // The role chip (in the role colour) and "?" to reopen the welcome note: every console (UI-P3).
  const roleChip = true;
  // On a phone the sidebar collapses into a menu (Platform, UI-P1; Brand, UI-P3).
  const collapsible = platform || brand;
  const banner = useRoleBanner(me.scope);
  // UI-P1: on a phone the Platform sidebar collapses into a menu.
  const [navOpen, setNavOpen] = useState(false);
  const nav = NAV[me.scope];
  // One config per store (a new object each render would re-run every page's <AskScope>).
  const storeId = me.scope === 'RETAIL' ? me.store.store_id : null;
  const storeConfig = useMemo(() => (storeId ? storeAsk(storeId) : null), [storeId]);
  const api = useApi();
  // The demo brand's Brand Admin gets the judge's checklist (DEMO_MODE only).
  const demo = useLoad(
    useCallback(
      () =>
        me.scope === 'BRAND'
          ? api.get<{ reset_available: boolean }>('/api/brand/demo')
          : Promise.resolve({ reset_available: false }),
      [api, me.scope],
    ),
  );
  const shopperDemo = me.scope === 'BRAND' && demo.data?.reset_available === true;
  // The brand's real Shopify store (from its connection): "Open <brand> store" and its QR.
  const shopify = useShopifyStore(me.scope === 'BRAND');
  // UI-3: conversations waiting for a person (Brand); UI-4: holds waiting for confirmation (Store).
  const waiting = useLoad(
    useCallback(async (): Promise<number> => {
      if (me.scope === 'BRAND') {
        const r = await api.get<{ conversations: { human_handoff: boolean }[] }>('/api/brand/conversations');
        return r.conversations.filter((c) => c.human_handoff).length;
      }
      if (me.scope === 'RETAIL') {
        const r = await api.get<{ reservations: { status: string }[] }>('/api/reservations?view=active');
        return r.reservations.filter((x) => x.status === 'PENDING').length;
      }
      return 0;
    }, [api, me.scope]),
  );
  const handoffs = me.scope === 'BRAND' ? (waiting.data ?? 0) : 0;
  const pending = me.scope === 'RETAIL' ? (waiting.data ?? 0) : 0;
  // Refreshed on every page change, so the count stays current while the admin works.
  const { pathname } = useLocation();
  const reloadWaiting = waiting.reload;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (me.scope !== 'PLATFORM') reloadWaiting();
  }, [pathname, me.scope, reloadWaiting]);
  // …and when a page changes what is waiting without a navigation (e.g. Resolve on a handoff).
  useEffect(() => {
    const onChanged = () => reloadWaiting();
    window.addEventListener(WAITING_CHANGED, onChanged);
    return () => window.removeEventListener(WAITING_CHANGED, onChanged);
  }, [reloadWaiting]);
  // UI-6: the tab title names the page and the console ("Today · Store Console · Qwikspot").
  useEffect(() => {
    const item = [...nav]
      .filter((n) => (n.end ? pathname === n.to : pathname === n.to || pathname.startsWith(`${n.to}/`)))
      .sort((a, b) => b.to.length - a.to.length)[0];
    document.title = `${item ? `${item.label} · ` : ''}${CONSOLE_NAME[me.scope]} · Qwikspot`;
  }, [pathname, nav, me.scope]);
  // A page can ask for a fresh count (e.g. the store's queue changed): window event.
  useEffect(() => {
    const onChange = () => reloadWaiting();
    window.addEventListener(QUEUE_CHANGED, onChange);
    return () => window.removeEventListener(QUEUE_CHANGED, onChange);
  }, [reloadWaiting]);

  const shell = (openAsk: (() => void) | null) => (
    <div className={`shell shell--${me.scope.toLowerCase()}${navOpen ? ' shell--nav-open' : ''}`}>
      <header className="shell-top">
        <div className="shell-top__brand">
          {collapsible && (
            <button
              type="button"
              className="ui-icon-button shell-top__menu"
              aria-label={navOpen ? 'Close menu' : 'Menu'}
              aria-expanded={navOpen}
              onClick={() => setNavOpen((v) => !v)}
            >
              {navOpen ? <X size={18} aria-hidden="true" /> : <MenuIcon size={18} aria-hidden="true" />}
            </button>
          )}
          <Wordmark />
          <span className="shell-top__console">{CONSOLE_NAME[me.scope]}</span>
          {context && <span className="shell-top__context">{context}</span>}
          {store && (
            <span className="shell-top__store">
              <strong className="shell-top__store-name">{store.name}</strong>
              <span className="shell-top__store-via">{store.via}</span>
            </span>
          )}
          {roleChip && (
            <span className="shell-top__chip">
              <span className="shell-role">{label(me.role)}</span>
              {platform && <span className="shell-top__team">{' · Qwikspot team'}</span>}
            </span>
          )}
          {platform && (
            <Tip
              className="shell-top__privacy"
              text="The platform never sees shoppers, phones, messages or stock lines"
            >
              <ShieldCheck size={14} aria-hidden="true" />
              <span>Totals only · no customer data</span>
            </Tip>
          )}
        </div>
        <div className="shell-top__user">
          {openAsk && (
            <AiButton
              size="sm"
              className="shell-ask"
              onClick={openAsk}
              aria-label={`Ask Qwikspot about ${ASK_DATA_OF[me.scope]} data`}
            >
              Ask Qwikspot
            </AiButton>
          )}
          {roleChip && (!banner.open || shopperDemo) && (
            <button
              type="button"
              className="ui-icon-button"
              aria-label="Show the welcome note"
              title={shopperDemo ? 'Show the welcome note and the demo checklist' : 'Show the welcome note'}
              onClick={() => {
                banner.show();
                // UI-P3: "?" also brings back the judge's "Try the live demo" checklist.
                if (shopperDemo) window.dispatchEvent(new Event(SHOW_TOUR));
              }}
            >
              <HelpCircle size={18} aria-hidden="true" />
            </button>
          )}
          {shopify && me.scope === 'BRAND' && <StoreButton store={shopify} brandName={me.brand_name} />}
          <span className="shell-top__email">{me.user.email ?? me.user.user_id}</span>
          <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => void signOut()}>
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </header>
      <nav className="shell-nav" aria-label={CONSOLE_NAME[me.scope]}>
        <ul>
          {nav.map(({ to, label: text, icon: Icon, end, badge }) => (
            <li key={to}>
              <NavLink to={to} end={end} className="shell-nav__link" onClick={() => setNavOpen(false)}>
                <Icon size={18} aria-hidden="true" />
                <span>{text}</span>
                {badge === 'handoffs' && handoffs > 0 && (
                  <span className="shell-nav__badge" aria-label={`${handoffs} waiting for a person`}>
                    {handoffs}
                  </span>
                )}
                {badge === 'pending' && pending > 0 && (
                  <span className="shell-nav__badge" aria-label={`${pending} new holds to confirm`}>
                    {pending}
                  </span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="shell-body">
        <RoleBanner me={me} open={banner.open} onDismiss={banner.dismiss} />
        <main className="shell-main">{children}</main>
      </div>
      {shopperDemo && me.scope === 'BRAND' && <JudgeTour brandId={me.brand_id} store={shopify} />}
    </div>
  );
  // L5/L6/L7: every console carries "Ask Qwikspot" — the header button and the drawer (and
  // "Ask about this" on the Brand Console's pages).
  const askConfig = me.scope === 'BRAND' ? BRAND_ASK : me.scope === 'RETAIL' ? storeConfig : PLATFORM_ASK;
  return askConfig ? (
    <AskQwikspotProvider config={askConfig}>{(open) => shell(open)}</AskQwikspotProvider>
  ) : (
    shell(null)
  );
}
