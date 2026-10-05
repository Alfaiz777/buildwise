import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { ChatThread } from '../../components/chat/ChatThread';
import { ConsoleShell, errorMessage, useLoad } from '../../components/ConsoleShell';
import { Badge, Card, EmptyState, Timeline, useToast } from '../../components/ui';
import { label } from '../../lib/labels';
import { useHideSynthetic, withoutSynthetic } from '../../lib/synthetic';
import {
  humanize,
  REASON_TEXT,
  type ConversationDetail,
  type ConversationRow,
  type IntentSummary,
} from './conversationTypes';
import { DecisionTrace } from './DecisionTrace';
import { HandoffPanel, waitingFor } from './HandoffPanel';
import { IntentPanel } from './IntentPanel';
import { buildJourney } from './journey';
import { formatDateTime } from './types';

type Filter = 'ALL' | 'HANDOFF' | 'SCHEDULED' | 'SENT' | 'NOT_ELIGIBLE';
const FILTERS: [Filter, string][] = [
  ['ALL', 'All'],
  ['HANDOFF', 'Needs a person'],
  ['SCHEDULED', 'Follow-up scheduled'],
  ['SENT', 'Sent'],
  ['NOT_ELIGIBLE', 'Not eligible'],
];

const matches = (row: ConversationRow, filter: Filter) => {
  const status = row.intent?.follow_up?.status;
  switch (filter) {
    case 'ALL':
      return true;
    case 'HANDOFF':
      return row.human_handoff;
    case 'SCHEDULED':
      return status === 'SCHEDULED';
    case 'SENT':
      return !!status && ['SENT', 'REPLIED', 'HANDOFF', 'OPTED_OUT', 'CONVERTED'].includes(status);
    case 'NOT_ELIGIBLE':
      return status === 'NOT_ELIGIBLE' || status === 'SUPPRESSED';
  }
};

export function SyntheticPill() {
  return (
    <span title="Generated 4-week demo history, not a real shopper">
      <Badge>Synthetic</Badge>
    </span>
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

/**
 * Brand Console → Conversations (docs/11 §4; Change 16, UI-3). The list (filters, waiting
 * badges, synthetic toggle) and Intents tab; the detail shows the journey as one timeline
 * (website → chat → decisions → hold → store steps → outcome), the transcript exactly as
 * the customer saw it, "Why Qwikspot did this" in plain words, and the handoff box only
 * while a person owns the conversation. The selected conversation is in the URL (?c=).
 */
export function ConversationsPage({ autoPoll = false }: { autoPoll?: boolean }) {
  const api = useApi();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const selected = params.get('c');
  const [tab, setTab] = useState<'CONVERSATIONS' | 'INTENTS'>('CONVERSATIONS');
  const [filter, setFilter] = useState<Filter>(params.get('filter') === 'handoff' ? 'HANDOFF' : 'ALL');
  const [hideSynthetic, setHideSynthetic] = useHideSynthetic();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useLoad(
    useCallback(() => api.get<{ conversations: ConversationRow[] }>('/api/brand/conversations'), [api]),
  );
  const intents = useLoad(useCallback(() => api.get<{ intents: IntentSummary[] }>('/api/brand/intents'), [api]));

  const select = (id: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('c', id);
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
    list.reload();
    intents.reload();
    if (selected) void loadDetail(selected);
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

  const all = list.data?.conversations ?? [];
  const { shown, hidden } = withoutSynthetic(
    all.filter((r) => matches(r, filter)),
    hideSynthetic,
  );
  const selectedRow = all.find((r) => r.conversation_id === selected) ?? null;
  const conversationOfIntent = useMemo(
    () => new Map(all.filter((c) => c.intent).map((c) => [c.intent!.intent_id, c.conversation_id] as [string, string])),
    [all],
  );
  const journey = useMemo(() => (detail ? buildJourney(detail) : []), [detail]);

  return (
    <ConsoleShell>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="conversations-layout">
        <Card
          title="Conversations"
          actions={
            <>
              <button type="button" className="secondary" onClick={refresh}>
                Refresh
              </button>
              <button type="button" onClick={() => void runDue(false)}>
                Process due work now
              </button>
            </>
          }
        >
          <p className="muted small">
            Sends due follow-ups, marks abandoned sessions and expires overdue holds
            {autoPoll ? '; this page also does it every 30 seconds (local profile)' : ''}.
          </p>
          {lastRun && <p className="notice small">{lastRun}</p>}
          <div className="tabs" role="tablist">
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
              <div className="filters">
                {FILTERS.map(([value, text]) => (
                  <button
                    key={value}
                    type="button"
                    className={filter === value ? '' : 'secondary'}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {text}
                  </button>
                ))}
              </div>
              <HideSyntheticToggle hide={hideSynthetic} onChange={setHideSynthetic} hidden={hidden} />
              {list.error && <p className="error">{list.error}</p>}
              {list.data && shown.length === 0 && (
                <EmptyState>
                  No conversations here yet. They start when a shopper chats from the shopper demo (or WhatsApp).
                </EmptyState>
              )}
              <ul className="conversation-list">
                {shown.map((r) => (
                  <li key={r.conversation_id}>
                    <button
                      type="button"
                      className={`conversation-item ${r.conversation_id === selected ? 'selected' : ''}`}
                      onClick={() => select(r.conversation_id)}
                    >
                      <strong>{r.customer_ref}</strong> {r.demo_history && <SyntheticPill />}
                      {r.human_handoff && (
                        <span className="badge warn">
                          needs a person{r.handoff_at ? ` · ${waitingFor(r.handoff_at, Date.now())}` : ''}
                        </span>
                      )}
                      <div className="small">
                        {r.intent ? (
                          <>
                            {label(r.intent.intent_type)}
                            {r.intent.product_title && ` · ${r.intent.product_title}`}
                            {r.intent.follow_up && ` · follow-up ${humanize(r.intent.follow_up.status)}`}
                          </>
                        ) : (
                          <span className="muted">Started in the chat</span>
                        )}
                      </div>
                      <div className="muted small">{formatDateTime(r.last_message_at)}</div>
                    </button>
                  </li>
                ))}
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
        </Card>

        <div className="conversation-detail">
          {!detail ? (
            <Card title="Conversation">
              <EmptyState>
                Select a conversation to see the shopper's journey and read the chat exactly as they saw it.
              </EmptyState>
            </Card>
          ) : (
            <>
              <Card
                title={
                  <>
                    Conversation with {detail.customer_ref} {detail.demo_history && <SyntheticPill />}
                  </>
                }
                description={selectedRow?.intent?.product_title ?? undefined}
              >
                {detail.human_handoff && (
                  <HandoffPanel
                    conversationId={detail.conversation_id}
                    handoffAt={detail.handoff_at}
                    onChanged={() => {
                      list.reload();
                      void loadDetail(detail.conversation_id);
                    }}
                  />
                )}
                <h3>Journey</h3>
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
              </Card>
              <Card title="Messages" description="Exactly what the customer saw, with who sent each message.">
                <div className="transcript">
                  <ChatThread messages={detail.messages} mode="brand" />
                </div>
              </Card>
              <Card>
                <DecisionTrace recommendations={detail.recommendations} />
                {detail.recommendations.length === 0 && (
                  <p className="muted small">Qwikspot has not made a decision in this conversation yet.</p>
                )}
              </Card>
              <Card>
                <IntentPanel intent={detail.intent} events={detail.web_events} conversation={detail} />
              </Card>
            </>
          )}
        </div>
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
    <div className="ui-table-wrap">
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
                <td className={i.anonymous ? 'muted' : ''}>{i.who}</td>
                <td>{label(i.intent_type)}</td>
                <td>{label(i.intent_stage)}</td>
                <td>{i.product_title ?? i.matched_category ?? '—'}</td>
                <td>{i.follow_up ? label(i.follow_up.status) : '—'}</td>
                <td className="small">
                  {i.follow_up ? (REASON_TEXT[i.follow_up.reason] ?? humanize(i.follow_up.reason)) : '—'}
                </td>
                <td>
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
