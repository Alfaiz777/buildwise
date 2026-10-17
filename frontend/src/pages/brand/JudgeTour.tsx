import { Check, ChevronDown, ExternalLink, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { QrCode } from '../../components/ui/QrCode';
import type { ConversationRow, IntentSummary, ReservationRow } from './conversationTypes';
import type { ShopifyStore } from './shopifyStore';
import { useAskQwikspot } from './askQwikspot';
import { DemoGuide } from './DemoGuide';
import './tour.css';

/** Dispatched on window by the header's "?" to show the tour again. */
export const SHOW_TOUR = 'qs:show-tour';

interface TourState {
  /** When this viewer started the tour: only live activity after it ticks a step. */
  started: string;
  done: Record<number, boolean>;
  collapsed: boolean;
  dismissed: boolean;
}

const key = (brandId: string) => `qs_judge_tour:${brandId}`;

function read(brandId: string): TourState {
  try {
    const raw = window.localStorage.getItem(key(brandId));
    if (raw) {
      const s = JSON.parse(raw) as Partial<TourState>;
      if (typeof s.started === 'string') {
        return { started: s.started, done: s.done ?? {}, collapsed: !!s.collapsed, dismissed: !!s.dismissed };
      }
    }
  } catch {
    // storage blocked or unreadable: start fresh for this page view
  }
  const phone = typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 768px)').matches;
  return { started: new Date().toISOString(), done: {}, collapsed: phone, dismissed: false };
}

function write(brandId: string, s: TourState) {
  try {
    window.localStorage.setItem(key(brandId), JSON.stringify(s));
  } catch {
    // storage blocked: the tour remembers nothing past this page view
  }
}

const STEPS = [
  'Open the AquaSkin store and look at a product',
  'Tap “Need it today?” and send the WhatsApp message',
  'Watch it in Conversations and see the hold reach the store',
  'Ask Qwikspot how your brand did',
] as const;

/**
 * "Try the live demo" (UI-P3; Shopify flow): a compact floating checklist for judges, shown only
 * to the demo brand's Brand Admin (DEMO_MODE). The journey runs on the brand's real Shopify
 * store: open it (or scan its QR), look at a product, tap "Need it today?" and send the
 * WhatsApp message, watch the chat and the hold arrive, ask Qwikspot. Steps tick themselves
 * from what the console already loads — a live storefront intent, conversation or hold that
 * started after the tour did — or by hand. It collapses to a pill ("2/4"), can be dismissed and
 * comes back from the header's "?". The full judge script and Reset demo sit inside it.
 */
export function JudgeTour({ brandId, store }: { brandId: string; store: ShopifyStore | null }) {
  const api = useApi();
  const { ask } = useAskQwikspot();
  const { pathname } = useLocation();
  const [state, setState] = useState<TourState>(() => read(brandId));
  const [live, setLive] = useState({ intent: false, conversation: false, hold: false });
  const [showQr, setShowQr] = useState(false);
  const update = useCallback(
    (change: (s: TourState) => TourState) =>
      setState((s) => {
        const next = change(s);
        write(brandId, next);
        return next;
      }),
    [brandId],
  );

  // What happened since the tour started (live records only), checked on every page change.
  useEffect(() => {
    let gone = false;
    const after = (iso: string | null | undefined) => !!iso && iso > state.started;
    Promise.allSettled([
      api.get<{ conversations: ConversationRow[] }>('/api/brand/conversations'),
      api.get<{ reservations: ReservationRow[] }>('/api/reservations?limit=50'),
      api.get<{ intents: IntentSummary[] }>('/api/brand/intents'),
    ]).then(([c, r, i]) => {
      if (gone) return;
      setLive({
        intent: i.status === 'fulfilled' && i.value.intents.some((x) => after(x.last_event_at)),
        conversation:
          c.status === 'fulfilled' &&
          c.value.conversations.some((x) => !x.demo_history && after(x.last_inbound_at ?? x.last_message_at)),
        hold: r.status === 'fulfilled' && r.value.reservations.some((x) => !x.demo_history && after(x.created_at)),
      });
    });
    return () => {
      gone = true;
    };
  }, [api, pathname, state.started]);

  useEffect(() => {
    const show = () => update((s) => ({ ...s, dismissed: false, collapsed: false }));
    window.addEventListener(SHOW_TOUR, show);
    return () => window.removeEventListener(SHOW_TOUR, show);
  }, [update]);

  const auto: Record<number, boolean> = {
    0: live.intent || live.conversation,
    1: live.conversation,
    2: live.hold,
  };
  // A step seen once stays ticked (the data may move on, e.g. the hold is picked up).
  useEffect(() => {
    const newly = Object.entries(auto).filter(([i, v]) => v && !state.done[Number(i)]);
    if (newly.length) update((s) => ({ ...s, done: { ...s.done, ...Object.fromEntries(newly) } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.intent, live.conversation, live.hold]);

  if (state.dismissed) return null;
  const done = STEPS.filter((_, i) => state.done[i]).length;
  const tick = (i: number, value = true) => update((s) => ({ ...s, done: { ...s.done, [i]: value } }));

  if (state.collapsed) {
    return (
      <button
        type="button"
        className="tour-pill"
        onClick={() => update((s) => ({ ...s, collapsed: false }))}
        aria-label={`Try the live demo: ${done} of ${STEPS.length} steps done. Open the checklist`}
      >
        <Sparkles size={16} aria-hidden="true" /> Try the live demo
        <span className="tour-pill__count">
          {done}/{STEPS.length}
        </span>
      </button>
    );
  }

  const action = (i: number) => {
    switch (i) {
      case 0:
        return store ? (
          <span className="tour-step__links">
            <a
              className="tour-step__link"
              href={store.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => tick(0)}
            >
              Open the store <ExternalLink size={12} aria-hidden="true" />
            </a>
            <button
              type="button"
              className="ui-link-button tour-step__link"
              aria-expanded={showQr}
              onClick={() => setShowQr((v) => !v)}
            >
              {showQr ? 'Hide the QR' : 'Or scan it with your phone'}
            </button>
            {showQr && (
              <span className="tour-step__qr">
                <QrCode value={store.url} size={132} label={`QR code for ${store.url}`} />
                <span className="small muted">{store.domain}</span>
              </span>
            )}
          </span>
        ) : (
          <span className="small muted">Connect your Shopify store in Settings first.</span>
        );
      case 1:
        return (
          <span className="small muted">
            On a computer, scan the QR under the button: WhatsApp opens on your phone with the message ready.
          </span>
        );
      case 2:
        return (
          <span className="tour-step__links">
            <Link className="tour-step__link" to="/brand/conversations">
              Go to Conversations →
            </Link>
            <a className="tour-step__link" href="/login?as=store" target="_blank" rel="noopener noreferrer">
              Store sign-in <ExternalLink size={12} aria-hidden="true" />
            </a>
          </span>
        );
      default:
        return (
          <button
            type="button"
            className="ui-link-button tour-step__link"
            onClick={() => {
              tick(3);
              ask('How did my brand do this week?');
            }}
          >
            Ask now →
          </button>
        );
    }
  };

  return (
    <aside className="tour" aria-label="Try the live demo">
      <header className="tour__head">
        <Sparkles size={16} aria-hidden="true" className="tour__mark" />
        <strong>Try the live demo</strong>
        <span className="tour__count" aria-label={`${done} of ${STEPS.length} done`}>
          {done}/{STEPS.length}
        </span>
        <button
          type="button"
          className="ui-icon-button"
          aria-label="Collapse the checklist"
          onClick={() => update((s) => ({ ...s, collapsed: true }))}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ui-icon-button"
          aria-label="Close the checklist"
          onClick={() => update((s) => ({ ...s, dismissed: true }))}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="tour__progress" aria-hidden="true">
        <span style={{ width: `${(done / STEPS.length) * 100}%` }} />
      </div>
      <ol className="tour__steps">
        {STEPS.map((text, i) => (
          <li key={text} className={`tour-step${state.done[i] ? ' is-done' : ''}`}>
            <button
              type="button"
              role="checkbox"
              aria-checked={!!state.done[i]}
              aria-label={text}
              className="tour-step__tick"
              onClick={() => tick(i, !state.done[i])}
            >
              {state.done[i] && <Check size={12} aria-hidden="true" />}
            </button>
            <span className="tour-step__text">
              {text}
              {action(i)}
            </span>
          </li>
        ))}
      </ol>
      <DemoGuide store={store} />
    </aside>
  );
}
