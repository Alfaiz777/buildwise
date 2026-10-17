import { ArrowLeft, ExternalLink, MessagesSquare, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useApi } from '../../api/apiContext';
import { ChatThread, type ChatEvent } from '../../components/chat/ChatThread';
import { ConsoleShell, errorMessage, useLoad } from '../../components/ConsoleShell';
import { Badge, Button, EmptyState, ProductThumb, Segmented, Timeline, Tip, useToast } from '../../components/ui';
import { label } from '../../lib/labels';
import { useHideSynthetic, withoutSynthetic } from '../../lib/synthetic';
import { ago, PageHeader } from '../platform/PlatformChrome';
import {
  humanize,
  REASON_TEXT,
  type ConversationDetail,
  type ConversationRow,
  type IntentSummary,
  type ReservationRow,
} from './conversationTypes';
import { AskScope } from './askQwikspot';
import { DecisionTrace } from './DecisionTrace';
import { ConversationSummary } from './AiCards';
import { HandoffBrief, HandoffPanel, waitingFor } from './HandoffPanel';
import { IntentPanel } from './IntentPanel';
import { buildJourney } from './journey';
import { useShopifyStore } from './shopifyStore';
import { formatDateTime } from './types';
import './brand.css';
import './conversations.css';

/** What a conversation led to (UI-P3), from the holds the console already loads. */
type Outcome = 'HANDOFF' | 'PICKED_UP' | 'HELD' | 'HOLD_ENDED' | 'NONE';
const OUTCOME_PILL: Record<
  Exclude<Outcome, 'NONE'>,
  { text: string; tone: 'warning' | 'success' | 'info' | 'neutral' }
> = {
  HANDOFF: { text: 'Needs a person', tone: 'warning' },
  PICKED_UP: { text: 'Picked up', tone: 'success' },
  HELD: { text: 'Held', tone: 'info' },
  HOLD_ENDED: { text: 'Hold ended', tone: 'neutral' },
};

function outcomeOf(row: ConversationRow, holds: ReservationRow[]): Outcome {
  if (row.human_handoff) return 'HANDOFF';
  if (holds.some((r) => r.status === 'COMPLETED')) return 'PICKED_UP';
  if (holds.some((r) => r.active)) return 'HELD';
  if (holds.length) return 'HOLD_ENDED';
  return 'NONE';
}

type View = 'ALL' | 'HANDOFF' | 'HELD' | 'NO_HOLD';
const VIEWS: { value: View; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'HANDOFF', label: 'Needs a person' },
  { value: 'HELD', label: 'Held' },
  { value: 'NO_HOLD', label: 'Ended without a hold' },
];
const viewMatches = (o: Outcome, v: View) =>
  v === 'ALL' ||
  (v === 'HANDOFF' && o === 'HANDOFF') ||
  (v === 'HELD' && (o === 'HELD' || o === 'PICKED_UP')) ||
  (v === 'NO_HOLD' && (o === 'NONE' || o === 'HOLD_ENDED'));

/** The follow-up filters (unchanged since M4), as a second, smaller control. */
type FollowUpFilter = 'ANY' | 'SCHEDULED' | 'SENT' | 'NOT_ELIGIBLE';
const FOLLOW_UPS: { value: FollowUpFilter; label: string }[] = [
  { value: 'ANY', label: 'Any' },
  { value: 'SCHEDULED', label: 'Follow-up scheduled' },
  { value: 'SENT', label: 'Sent' },
  { value: 'NOT_ELIGIBLE', label: 'Not eligible' },
];
const followUpMatches = (row: ConversationRow, filter: FollowUpFilter) => {
  const status = row.intent?.follow_up?.status;
  switch (filter) {
    case 'ANY':
      return true;
    case 'SCHEDULED':
      return status === 'SCHEDULED';
    case 'SENT':
      return !!status && ['SENT', 'REPLIED', 'HANDOFF', 'OPTED_OUT', 'CONVERTED'].includes(status);
    case 'NOT_ELIGIBLE':
      return status === 'NOT_ELIGIBLE' || status === 'SUPPRESSED';
  }
};

const initialView = (p: string | null): View =>
  p === 'handoff' ? 'HANDOFF' : p === 'held' ? 'HELD' : p === 'ended' ? 'NO_HOLD' : 'ALL';

/** "SJ" from "sim:shopper_3002", "C" from "Customer •••• 4821": the masked label's initials. */
export function initialsOf(ref: string): string {
  const words = (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref).split(/[^A-Za-z]+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  ).slice(0, 2);
}

export function SyntheticPill() {
  return (
    <span title="Generated 4-week demo history, not a real shopper">
      <Badge>Synthetic</Badge>
    </span>
  );
}

/** UI-P3: the conversation list's marker for generated demo history. */
function DemoPill() {
  return (
    <Tip text="Generated 4-week demo history, not a real shopper">
      <Badge tone="neutral">Demo</Badge>
    </Tip>
  );
}

export function HideSyntheticToggle({
  hide,
  onChange,
  hidden,
}: {
  hide: boolean;
  onChange: (hide: boolean) => void;
  hidden: number;
}) {
  return (
    <p className="synthetic-toggle small">
      <label>
        <input type="checkbox" checked={hide} onChange={(e) => onChange(e.target.checked)} /> Hide synthetic history
      </label>
      {hide && hidden > 0 && <span className="muted"> · {hidden} synthetic records hidden</span>}
    </p>
  );
}

/** Where the journey has got to: intent → conversation → hold → pickup. */
function journeyStep(d: ConversationDetail): number {
  const holds = d.recommendations.filter((r) => r.reservation);
  const picked =
    (d.outcomes ?? []).some((o) => o.purchase_type === 'OFFLINE' && !o.cancelled_at) ||
    holds.some((r) => r.reservation!.status === 'COMPLETED');
  if (picked) return 3;
  if (holds.length) return 2;
  if (d.messages.length) return 1;
  return 0;
}
const STEPS = ['Intent', 'Conversation', 'Hold', 'Pickup'];

function JourneyStepper({ step }: { step: number }) {
  return (
    <ol className="cv-stepper" aria-label="Journey so far">
      {STEPS.map((s, i) => (
        <li
          key={s}
          className={`cv-stepper__step${i < step ? ' is-done' : ''}${i === step ? ' is-current' : ''}`}
          aria-current={i === step ? 'step' : undefined}
        >
          <span className="cv-stepper__dot" aria-hidden="true" />
          {s}
        </li>
      ))}
    </ol>
  );
}

/** System events between the bubbles: holds, the store's steps, a handoff, the outcome. */
function chatEvents(steps: ReturnType<typeof buildJourney>): ChatEvent[] {
  return steps
    .filter((s) => s.id.startsWith('rec-') || s.id.startsWith('res-') || s.id.startsWith('out-') || s.id === 'handoff')
    .filter((s) => !(s.id.startsWith('rec-') && s.title.startsWith('Qwikspot')))
    .map((s) => ({ id: s.id, at: s.at, text: s.title, tone: s.tone }));
}

/**
 * Brand Console → Conversations (docs/11 §4; UI-3; UI-P3 three-pane inbox): the AI showcase.
 * Left, every conversation with its outcome; middle, the chat as the shopper saw it, with its
 * summary, where the journey has got to and what happened between messages; right, "Why
 * Qwikspot did this" as a timeline, the intent and — while a person owns the conversation —
 * the handoff box. On a phone one pane shows at a time, with a back button. The selected
 * conversation is in the URL (?c=).
 */
export function ConversationsPage({ autoPoll = false }: { autoPoll?: boolean }) {
  const me = useMe();
  const api = useApi();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const selected = params.get('c');
  const [tab, setTab] = useState<'CONVERSATIONS' | 'INTENTS'>(
    params.get('tab') === 'intents' ? 'INTENTS' : 'CONVERSATIONS',
  );
  const [view, setView] = useState<View>(initialView(params.get('filter')));
  const [followUp, setFollowUp] = useState<FollowUpFilter>('ANY');
  const [query, setQuery] = useState('');
  const [hideSynthetic, setHideSynthetic] = useHideSynthetic();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const list = useLoad(
    useCallback(() => api.get<{ conversations: ConversationRow[] }>('/api/brand/conversations'), [api]),
  );
  const intents = useLoad(useCallback(() => api.get<{ intents: IntentSummary[] }>('/api/brand/intents'), [api]));
  // The holds behind each conversation's outcome pill (the same list the Reservations page shows).
  const holds = useLoad(
    useCallback(() => api.get<{ reservations: ReservationRow[] }>('/api/reservations?limit=200'), [api]),
  );

  const select = (id: string | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (id) next.set('c', id);
      else next.delete('c');
      return next;
    });

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        setDetail(await api.get<ConversationDetail>(`/api/brand/conversations/${encodeURIComponent(id)}`));
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [api],
  );

  useEffect(() => {
    if (selected) void loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  const refresh = () => {
    setRefreshing(true);
    list.reload();
    intents.reload();
    holds.reload();
    if (selected) void loadDetail(selected);
    setTimeout(() => {
      setRefreshing(false);
      toast.show('Conversations refreshed.');
    }, 500);
  };

  const [lastRun, setLastRun] = useState<string | null>(null);
  const runDue = useCallback(
    async (silent: boolean) => {
      try {
        const r = await api.post<{
          abandoned: number;
          sent: number;
          suppressed: number;
          reservations_expired?: number;
        }>('/api/brand/follow-ups/process-due', {});
        const expired = r.reservations_expired ?? 0;
        if (!silent || r.sent || r.suppressed || r.abandoned || expired) {
          const text =
            `Due work processed: ${r.sent} follow-up${r.sent === 1 ? '' : 's'} sent, ${r.suppressed} suppressed, ` +
            `${r.abandoned} session${r.abandoned === 1 ? '' : 's'} marked abandoned` +
            (expired ? `, ${expired} hold${expired === 1 ? '' : 's'} expired.` : '.');
          setLastRun(text);
          if (!silent) toast.show(text);
          list.reload();
          intents.reload();
          holds.reload();
          if (selected) void loadDetail(selected);
        }
      } catch (err) {
        if (!silent) setError(errorMessage(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, selected, loadDetail],
  );

  // LOCAL PROFILE ONLY: process due work every 30 s while the console is open (no scheduler yet).
  useEffect(() => {
    if (!autoPoll) return;
    const id = setInterval(() => void runDue(true), 30_000);
    return () => clearInterval(id);
  }, [autoPoll, runDue]);

  const all = useMemo(() => list.data?.conversations ?? [], [list.data]);
  // New conversations since the first load slide in with a short highlight.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!list.data) return;
    const ids = all.map((c) => c.conversation_id);
    if (seen.current) {
      const arrived = ids.filter((id) => !seen.current!.has(id));
      if (arrived.length) setFresh((prev) => new Set([...prev, ...arrived]));
    }
    seen.current = new Set(ids);
  }, [list.data, all]);

  const holdsOf = useMemo(() => {
    const m = new Map<string, ReservationRow[]>();
    for (const r of holds.data?.reservations ?? []) {
      if (r.conversation_id) m.set(r.conversation_id, [...(m.get(r.conversation_id) ?? []), r]);
    }
    return m;
  }, [holds.data]);
  const q = query.trim().toLowerCase();
  const { shown, hidden } = withoutSynthetic(
    all.filter(
      (r) =>
        viewMatches(outcomeOf(r, holdsOf.get(r.conversation_id) ?? []), view) &&
        followUpMatches(r, followUp) &&
        (!q || `${r.customer_ref} ${r.intent?.product_title ?? ''}`.toLowerCase().includes(q)),
    ),
    hideSynthetic,
  );
  const selectedRow = all.find((r) => r.conversation_id === selected) ?? null;
  const first = shown[0]?.conversation_id ?? null;
  useEffect(() => {
    if (selected || !first || tab !== 'CONVERSATIONS') return;
    if (!window.matchMedia?.('(min-width: 901px)').matches) return; // a phone starts on the list
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set('c', first);
        return next;
      },
      { replace: true },
    );
  }, [selected, first, tab, setParams]);
  const conversationOfIntent = useMemo(
    () => new Map(all.filter((c) => c.intent).map((c) => [c.intent!.intent_id, c.conversation_id] as [string, string])),
    [all],
  );
  const journey = useMemo(() => (detail ? buildJourney(detail) : []), [detail]);
  // The brand's real Shopify store: where a shopper starts a conversation.
  const store = useShopifyStore(me.scope === 'BRAND');

  return (
    <ConsoleShell>
      <AskScope days={7} includeHistory={!hideSynthetic} />
      <PageHeader
        title="Conversations"
        purpose="Every shopper chat: what they asked, what Qwikspot did, and why."
        action={
          <div className="cv-head-actions">
            <Button
              variant="ghost"
              size="sm"
              loading={refreshing}
              icon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={refresh}
            >
              Refresh
            </Button>
            <Button variant="brand" size="sm" onClick={() => void runDue(false)}>
              Process due work now
            </Button>
          </div>
        }
      />
      <div className="pf-filters cv-filters">
        <Segmented
          label="History"
          value={hideSynthetic ? 'live' : 'all'}
          options={[
            { value: 'live', label: 'Live only' },
            { value: 'all', label: 'Live + demo history' },
          ]}
          onChange={(v) => setHideSynthetic(v === 'live')}
        />
        {hideSynthetic && hidden > 0 && <span className="muted small">{hidden} synthetic records hidden</span>}
        <span className="muted small cv-due-note">
          Due work: sends due follow-ups, marks abandoned sessions and expires overdue holds
          {autoPoll ? '; this page also does it every 30 seconds (local profile)' : ''}.
        </span>
      </div>
      {lastRun && <p className="notice small">{lastRun}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className={`cv${selected ? ' cv--open' : ''}`}>
        {/* ------------------------------------------------ left: the list */}
        <section className="cv-pane cv-list" aria-label="Conversation list">
          <div className="tabs cv-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'CONVERSATIONS'}
              onClick={() => setTab('CONVERSATIONS')}
            >
              Conversations
            </button>
            <button type="button" role="tab" aria-selected={tab === 'INTENTS'} onClick={() => setTab('INTENTS')}>
              Intents
            </button>
          </div>
          {tab === 'CONVERSATIONS' ? (
            <>
              <label className="cv-search">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search conversations"
                  placeholder="Search customer or product"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <Segmented label="Show" value={view} options={VIEWS} onChange={setView} />
              <div className="cv-followups">
                <span className="small muted">Follow-up:</span>
                <Segmented label="Follow-up" value={followUp} options={FOLLOW_UPS} onChange={setFollowUp} />
              </div>
              {list.error && <p className="error">{list.error}</p>}
              {list.data && shown.length === 0 && (
                <EmptyState icon={<MessagesSquare size={22} />}>
                  {all.length === 0 ? (
                    <>
                      No conversations yet. Open your store, tap “Need it today?” on a product and send the WhatsApp
                      message to start one.
                      {store && (
                        <a
                          className="ui-button ui-button--brand ui-button--sm cv-empty-cta"
                          href={store.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open {store.name ?? 'your'} store <ExternalLink size={14} aria-hidden="true" />
                        </a>
                      )}
                    </>
                  ) : (
                    'No conversations match this filter.'
                  )}
                </EmptyState>
              )}
              <ul className="conversation-list cv-rows">
                {shown.map((r) => {
                  const own = holdsOf.get(r.conversation_id) ?? [];
                  const outcome = outcomeOf(r, own);
                  const pill = outcome === 'NONE' ? null : OUTCOME_PILL[outcome];
                  const image = own.find((h) => h.image_url)?.image_url ?? null;
                  const product = r.intent?.product_title ?? own[0]?.product_title ?? null;
                  return (
                    <li key={r.conversation_id} className={fresh.has(r.conversation_id) ? 'cv-row--fresh' : undefined}>
                      <button
                        type="button"
                        className={`conversation-item cv-row ${r.conversation_id === selected ? 'selected' : ''}`}
                        aria-current={r.conversation_id === selected ? 'true' : undefined}
                        onClick={() => select(r.conversation_id)}
                      >
                        <span className="cv-avatar" aria-hidden="true">
                          {initialsOf(r.customer_ref)}
                        </span>
                        <span className="cv-row__body">
                          <span className="cv-row__top">
                            <strong className="cv-row__who">{r.customer_ref}</strong>
                            <span className="cv-row__time small muted">{ago(r.last_message_at)}</span>
                          </span>
                          <span className="cv-row__product small">
                            {product ? (
                              <>
                                <ProductThumb src={image} name={product} size={20} />
                                {product}
                              </>
                            ) : (
                              <span className="muted">Started in the chat</span>
                            )}
                            {r.intent?.follow_up && (
                              <span className="muted"> · follow-up {humanize(r.intent.follow_up.status)}</span>
                            )}
                          </span>
                          <span className="cv-row__pills">
                            {pill && (
                              <Badge tone={pill.tone}>
                                {pill.text}
                                {outcome === 'HANDOFF' && r.handoff_at
                                  ? ` · ${waitingFor(r.handoff_at, Date.now())}`
                                  : ''}
                              </Badge>
                            )}
                            {r.demo_history && <DemoPill />}
                          </span>
                        </span>
                      </button>
                      {/* L9: the handoff brief under each "needs a person" item, loaded after the list. */}
                      {r.human_handoff && (
                        <HandoffBrief conversationId={r.conversation_id} cacheKey={r.last_message_at} compact />
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <IntentsTable
              intents={intents.data?.intents ?? null}
              error={intents.error}
              conversationOf={(id) => conversationOfIntent.get(id) ?? null}
              onOpen={(id) => {
                setTab('CONVERSATIONS');
                select(id);
              }}
            />
          )}
        </section>

        {/* ------------------------------------------------ middle: the chat */}
        <section className="cv-pane cv-chat" aria-label="Chat">
          {!detail ? (
            <EmptyState icon={<MessagesSquare size={22} />}>
              Select a conversation to see the shopper&apos;s journey and read the chat exactly as they saw it.
            </EmptyState>
          ) : (
            <>
              <header className="cv-chat__head">
                <button
                  type="button"
                  className="ui-icon-button cv-back"
                  aria-label="Back to conversations"
                  onClick={() => select(null)}
                >
                  <ArrowLeft size={18} aria-hidden="true" />
                </button>
                <span className="cv-avatar cv-avatar--lg" aria-hidden="true">
                  {initialsOf(detail.customer_ref)}
                </span>
                <div className="cv-chat__who">
                  <h2>
                    Conversation with {detail.customer_ref} {detail.demo_history && <DemoPill />}
                  </h2>
                  {selectedRow?.intent?.product_title && (
                    <span className="small muted">{selectedRow.intent.product_title}</span>
                  )}
                </div>
              </header>
              <JourneyStepper step={journeyStep(detail)} />
              <div className="cv-summary">
                <ConversationSummary
                  conversationId={detail.conversation_id}
                  refreshKey={detail.messages.length}
                  showHandoffBrief={!detail.human_handoff}
                />
              </div>
              <div id="conversation-messages" className="transcript cv-transcript">
                <ChatThread messages={detail.messages} mode="brand" events={chatEvents(journey)} />
              </div>
            </>
          )}
        </section>

        {/* ------------------------------------------------ right: why */}
        <section className="cv-pane cv-why" aria-label="Why Qwikspot did this">
          {detail && (
            <>
              {detail.human_handoff && (
                <HandoffPanel
                  conversationId={detail.conversation_id}
                  handoffAt={detail.handoff_at}
                  refreshKey={detail.messages.length}
                  onChanged={() => {
                    list.reload();
                    void loadDetail(detail.conversation_id);
                  }}
                />
              )}
              <div id="conversation-decisions">
                <DecisionTrace recommendations={detail.recommendations} />
                {detail.recommendations.length === 0 && (
                  <>
                    <h3>Why Qwikspot did this</h3>
                    <p className="muted small">Qwikspot has not made a decision in this conversation yet.</p>
                  </>
                )}
              </div>
              <div className="cv-why__card">
                <IntentPanel intent={detail.intent} events={detail.web_events} conversation={detail} />
              </div>
              <details className="cv-why__card cv-journey" open>
                <summary>
                  <strong>Journey</strong> <span className="muted small">— website → chat → hold → outcome</span>
                </summary>
                {journey.length === 0 ? (
                  <p className="muted small">Nothing recorded yet.</p>
                ) : (
                  <Timeline
                    label="Journey"
                    items={journey.map((s) => ({
                      id: s.id,
                      title: s.title,
                      time: formatDateTime(s.at),
                      detail: s.detail,
                      tone: s.tone,
                    }))}
                  />
                )}
              </details>
            </>
          )}
        </section>
      </div>
    </ConsoleShell>
  );
}

function IntentsTable({
  intents,
  error,
  conversationOf,
  onOpen,
}: {
  intents: IntentSummary[] | null;
  error: string | null;
  conversationOf: (intentId: string) => string | null;
  onOpen: (conversationId: string) => void;
}) {
  if (error) return <p className="error">{error}</p>;
  if (intents && intents.length === 0) {
    return <EmptyState>No storefront intents yet. Browse the shopper demo to create some.</EmptyState>;
  }
  return (
    <div className="ui-table-wrap cv-intents">
      <table>
        <thead>
          <tr>
            <th>Who</th>
            <th>Intent</th>
            <th>Stage</th>
            <th>Product</th>
            <th>Follow-up</th>
            <th>Why</th>
            <th>Chat</th>
          </tr>
        </thead>
        <tbody>
          {intents?.map((i) => {
            const conversation = conversationOf(i.intent_id);
            return (
              <tr key={i.intent_id}>
                <td className={i.anonymous ? 'muted' : ''} data-label="Who">
                  {i.who}
                </td>
                <td data-label="Intent">{label(i.intent_type)}</td>
                <td data-label="Stage">{label(i.intent_stage)}</td>
                <td data-label="Product">{i.product_title ?? i.matched_category ?? '—'}</td>
                <td data-label="Follow-up">{i.follow_up ? label(i.follow_up.status) : '—'}</td>
                <td className="small" data-label="Why">
                  {i.follow_up ? (REASON_TEXT[i.follow_up.reason] ?? humanize(i.follow_up.reason)) : '—'}
                </td>
                <td data-label="Chat">
                  {conversation ? (
                    <button type="button" className="secondary" onClick={() => onOpen(conversation)}>
                      Open chat
                    </button>
                  ) : (
                    <span className="muted small">no chat</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
