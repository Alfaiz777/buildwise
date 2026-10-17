import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import type { ApiClient } from '../../api/client';
import { errorMessage } from '../../components/ConsoleShell';
import { AiButton, Button, Card, Skeleton } from '../../components/ui';
import { AiLabel, DataUsed, isAnswer, useAskQwikspot, type AskScopeValue, type AssistantAnswer } from './askQwikspot';

/**
 * L5: the AI pieces placed on Brand Console pages. Each loads on its own after the page, so
 * the page never waits for Gemini; each shows whether Gemini wrote it ("AI summary") or the
 * rules did ("Quick summary"), and the data it used.
 */

/**
 * A console's brief, for the period and choice on screen: the Brand Console's "This week in
 * brief" (what happened, the biggest win and problem, one next action) or the Store Console's
 * "Today at your store".
 */
export function AiBriefCard({ url, title, days, includeHistory }: AskScopeValue & { url: string; title: string }) {
  const api = useApi();
  const { ask } = useAskQwikspot();
  const [brief, setBrief] = useState<AssistantAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A Quick summary is the fallback when the AI was slow (a timeout) or unavailable: ask for the
  // AI brief once more in the background and swap it in. Once per card, so never a loop.
  const [retrying, setRetrying] = useState(false);
  const retried = useRef(false);
  const load = useCallback(
    (refresh = false) => {
      setLoading(true);
      setError(null);
      api
        .get<AssistantAnswer>(`${url}?days=${days}&include_history=${includeHistory}${refresh ? '&refresh=true' : ''}`)
        .then((b) => (isAnswer(b) ? setBrief(b) : setError('invalid brief')))
        .catch((err: unknown) => setError(errorMessage(err)))
        .finally(() => setLoading(false));
    },
    [api, url, days, includeHistory],
  );
  useEffect(() => load(), [load]);
  useEffect(() => {
    if (brief?.source !== 'QUICK_SUMMARY' || retried.current) return;
    retried.current = true;
    setRetrying(true);
    api
      .get<AssistantAnswer>(`${url}?days=${days}&include_history=${includeHistory}&refresh=true`)
      .then((b) => {
        if (isAnswer(b) && b.source === 'AI') setBrief(b);
      })
      .catch(() => undefined) // the Quick summary stays
      .finally(() => setRetrying(false));
  }, [brief, api, url, days, includeHistory]);

  if (error && !brief) return null; // the rest of the page still tells the story
  return (
    <Card className="ai-card" title={title} actions={brief ? <AiLabel source={brief.source} /> : undefined}>
      {!brief ? (
        <Skeleton lines={3} label="Writing the brief" />
      ) : (
        <div className="ai-card__body">
          <p>{brief.answer}</p>
          <div className="ai-card__actions">
            {brief.next_action && (
              <Link className="ui-button ui-button--primary ui-button--sm" to={brief.next_action.path}>
                {brief.next_action.label} →
              </Link>
            )}
            <AiButton size="sm" quiet onClick={() => ask()}>
              Ask a follow-up
            </AiButton>
            <Button
              variant="ghost"
              size="sm"
              loading={loading}
              icon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={() => load(true)}
            >
              Refresh
            </Button>
          </div>
          {retrying && (
            <p className="small muted" role="status">
              Writing the AI brief…
            </p>
          )}
          <p className="ask-used small muted">
            {days === 7 ? 'Last 7 days' : 'Last 28 days'} ·{' '}
            {includeHistory ? 'including synthetic demo history' : 'live activity only'}
          </p>
          <DataUsed used={brief.used} />
        </div>
      )}
    </Card>
  );
}

/**
 * A conversation's summary, loaded once per conversation and version (`key`): the inbox items
 * and the open conversation share one request. At most 2 load at a time, so a long Handoff
 * inbox never fires a burst of requests. The backend keeps an AI summary until a new message.
 */
const summaries = new Map<string, Promise<AssistantAnswer>>();
let loading = 0;
const queue: (() => void)[] = [];
const MAX_LOADING = 2;

export function loadConversationSummary(
  api: ApiClient,
  conversationId: string,
  key: unknown,
): Promise<AssistantAnswer> {
  const id = `${conversationId}|${String(key ?? '')}`;
  const cached = summaries.get(id);
  if (cached) return cached;
  const run = () =>
    api
      .get<AssistantAnswer>(`/api/brand/conversations/${encodeURIComponent(conversationId)}/summary`)
      .then((s) => {
        if (!isAnswer(s)) throw new Error('invalid summary');
        return s;
      })
      .finally(() => {
        loading--;
        queue.shift()?.();
      });
  const promise = new Promise<AssistantAnswer>((resolve, reject) => {
    const start = () => {
      loading++;
      run().then(resolve, reject);
    };
    if (loading < MAX_LOADING) start();
    else queue.push(start);
  });
  // A failed load is not kept: the next open retries.
  promise.catch(() => summaries.delete(id));
  summaries.set(id, promise);
  return promise;
}

/** Tests only: forget the loaded summaries. */
export const forgetConversationSummaries = () => summaries.clear();

/** Conversations: 2 lines on what the shopper wanted and what happened; a handoff brief for the person taking over. */
export function ConversationSummary({
  conversationId,
  refreshKey,
  showHandoffBrief = true,
}: {
  conversationId: string;
  refreshKey?: unknown;
  /** False where the handoff brief is already shown (the "Needs a person" panel). */
  showHandoffBrief?: boolean;
}) {
  const api = useApi();
  const [summary, setSummary] = useState<AssistantAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setSummary(null);
    setFailed(false);
    loadConversationSummary(api, conversationId, refreshKey)
      .then((s) => live && setSummary(s))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [api, conversationId, refreshKey]);

  if (failed) return null;
  return (
    <section className="ai-card ui-card ui-card--padded" aria-label="Conversation summary">
      {!summary ? (
        <Skeleton lines={2} label="Summarising the conversation" />
      ) : (
        <div className="ai-card__body">
          <AiLabel source={summary.source} />
          <p>{summary.answer}</p>
          {showHandoffBrief && summary.handoff_brief && (
            <div className="ai-card__handoff">
              <strong className="small">Handoff brief</strong>
              <p>{summary.handoff_brief}</p>
            </div>
          )}
          <p className="ask-used small muted">
            Based on: <a href="#conversation-messages">Messages</a> ·{' '}
            <a href="#conversation-decisions">Why Qwikspot did this</a>
          </p>
        </div>
      )}
    </section>
  );
}

/** "Ask about this": opens the drawer with the question filled in and asked. */
export function AskAboutThis({ question, label }: { question: string; label: string }) {
  const { ask } = useAskQwikspot();
  return (
    <AiButton size="sm" quiet className="ask-about" aria-label={label} onClick={() => ask(question)}>
      Ask about this
    </AiButton>
  );
}
