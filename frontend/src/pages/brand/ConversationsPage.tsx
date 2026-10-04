import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, errorMessage, Section, useLoad } from '../../components/ConsoleShell';
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
import { ReservationsPanel } from './ReservationsPanel';
import { ChatThread } from '../../components/chat/ChatThread';
import { EmptyState } from '../../components/ui';
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

/**
 * Brand Console → "Conversations & intents" (docs/11 §4): conversation list with filters,
 * an Intents tab (every intent, anonymous and not-eligible included), a Reservations tab
 * (M5), the conversation detail with the "Intent & follow-up" panel and the "Why Qwikspot
 * did this" decision trace, and the read-only transcript — the shopper's own chat, with
 * internal labels. The simulator left the Brand Console in UI-2 (Change 16): shoppers chat
 * on /chat; the Brand Admin replies as a person only during a handoff.
 */
export function ConversationsPage({ autoPoll = false }: { autoPoll?: boolean }) {
  const api = useApi();
  const [tab, setTab] = useState<'CONVERSATIONS' | 'INTENTS' | 'RESERVATIONS'>('CONVERSATIONS');
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useLoad(
    useCallback(() => api.get<{ conversations: ConversationRow[] }>('/api/brand/conversations'), [api]),
  );
  const intents = useLoad(useCallback(() => api.get<{ intents: IntentSummary[] }>('/api/brand/intents'), [api]));

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        setDetail(await api.get<ConversationDetail>(`/api/brand/conversations/${id}`));
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [api],
  );

  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  const refresh = () => {
    list.reload();
    intents.reload();
    setReloadKey((k) => k + 1);
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
          setLastRun(
            `Due follow-ups: ${r.sent} sent, ${r.suppressed} suppressed, ${r.abandoned} sessions marked abandoned.` +
              (expired ? ` ${expired} reservation hold(s) expired.` : ''),
          );
          list.reload();
          intents.reload();
          setReloadKey((k) => k + 1);
          if (selected) void loadDetail(selected);
        }
      } catch (err) {
        if (!silent) setError(errorMessage(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, selected, loadDetail],
  );

  // LOCAL PROFILE ONLY: poll every 30 s while the console is open (no scheduler in M4).
  useEffect(() => {
    if (!autoPoll) return;
    const id = setInterval(() => void runDue(true), 30_000);
    return () => clearInterval(id);
  }, [autoPoll, runDue]);

  const rows = (list.data?.conversations ?? []).filter((r) => matches(r, filter));
  const selectedRow = list.data?.conversations.find((r) => r.conversation_id === selected) ?? null;

  return (
    <ConsoleShell>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="conversations-layout">
        <Section title="Conversations & intents">
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
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'RESERVATIONS'}
              onClick={() => setTab('RESERVATIONS')}
            >
              Reservations
            </button>
            <button type="button" className="secondary" onClick={refresh}>
              Refresh
            </button>
            <button type="button" onClick={() => void runDue(false)}>
              Run due follow-ups
            </button>
          </div>
          {lastRun && <p className="notice small">{lastRun}</p>}
          <p className="muted small">
            Follow-ups are sent only when due{autoPoll ? '; this page checks every 30 seconds (local profile)' : ''}.
          </p>

          {tab === 'CONVERSATIONS' ? (
            <>
              <div className="filters">
                {FILTERS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={filter === value ? '' : 'secondary'}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {list.error && <p className="error">{list.error}</p>}
              {list.data && rows.length === 0 && (
                <p className="muted">No conversations here yet. Send a message from the simulator to start one.</p>
              )}
              <ul className="conversation-list">
                {rows.map((r) => (
                  <li key={r.conversation_id}>
                    <button
                      type="button"
                      className={`conversation-item ${r.conversation_id === selected ? 'selected' : ''}`}
                      onClick={() => setSelected(r.conversation_id)}
                    >
                      <strong>{r.customer_ref}</strong> <span className="muted small">{humanize(r.channel)}</span>
                      {r.human_handoff && (
                        <span className="badge warn">
                          needs a person{r.handoff_at ? ` · ${waitingFor(r.handoff_at, Date.now())}` : ''}
                        </span>
                      )}
                      <div className="small">
                        {r.intent ? (
                          <>
                            {humanize(r.intent.intent_type)}
                            {r.intent.product_title && ` · ${r.intent.product_title}`}
                            {r.intent.follow_up && ` · follow-up ${humanize(r.intent.follow_up.status)}`}
                          </>
                        ) : (
                          <span className="muted">no storefront intent</span>
                        )}
                      </div>
                      <div className="muted small">{formatDateTime(r.last_message_at)}</div>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : tab === 'INTENTS' ? (
            <IntentsTable intents={intents.data?.intents ?? null} error={intents.error} />
          ) : (
            <ReservationsPanel reloadKey={reloadKey} />
          )}
        </Section>

        <Section title={selectedRow ? `Conversation with ${selectedRow.customer_ref}` : 'Conversation'}>
          {detail ? (
            <div className="transcript">
              <ChatThread messages={detail.messages} mode="brand" />
            </div>
          ) : (
            <EmptyState>
              Select a conversation to read it exactly as the customer sees it. New chats arrive from the shopper demo
              and WhatsApp.
            </EmptyState>
          )}
          {detail?.human_handoff && (
            <HandoffPanel
              conversationId={detail.conversation_id}
              handoffAt={detail.handoff_at}
              onChanged={() => {
                list.reload();
                void loadDetail(detail.conversation_id);
              }}
            />
          )}
          {detail && <IntentPanel intent={detail.intent} events={detail.web_events} conversation={detail} />}
          {detail && <DecisionTrace recommendations={detail.recommendations} />}
        </Section>
      </div>
    </ConsoleShell>
  );
}

function IntentsTable({ intents, error }: { intents: IntentSummary[] | null; error: string | null }) {
  if (error) return <p className="error">{error}</p>;
  if (intents && intents.length === 0) {
    return <p className="muted">No storefront intents yet. Browse the demo storefront to create some.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Who</th>
          <th>Intent</th>
          <th>Stage</th>
          <th>Product</th>
          <th>Follow-up</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {intents?.map((i) => (
          <tr key={i.intent_id}>
            <td className={i.anonymous ? 'muted' : ''}>{i.who}</td>
            <td>{humanize(i.intent_type)}</td>
            <td>{humanize(i.intent_stage)}</td>
            <td>{i.product_title ?? i.matched_category ?? '—'}</td>
            <td>{i.follow_up ? humanize(i.follow_up.status) : '—'}</td>
            <td className="small">
              {i.follow_up ? (REASON_TEXT[i.follow_up.reason] ?? humanize(i.follow_up.reason)) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
