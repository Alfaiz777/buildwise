import { MessageCircleQuestion, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { errorMessage } from '../../components/ConsoleShell';
import { Button, Card, Skeleton } from '../../components/ui';
import { AiLabel, DataUsed, useAskQwikspot, type AssistantAnswer } from './askQwikspot';

/**
 * L5: the AI pieces placed on Brand Console pages. Each loads on its own after the page, so
 * the page never waits for Gemini; each shows whether Gemini wrote it ("AI summary") or the
 * rules did ("Quick summary"), and the data it used.
 */

/** Overview: what happened this period, the biggest win and problem, and one next action. */
export function AiBriefCard() {
  const api = useApi();
  const { ask } = useAskQwikspot();
  const [brief, setBrief] = useState<AssistantAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(
    (refresh = false) => {
      setLoading(true);
      setError(null);
      api
        .get<AssistantAnswer>(`/api/brand/assistant/brief${refresh ? '?refresh=true' : ''}`)
        .then(setBrief)
        .catch((err: unknown) => setError(errorMessage(err)))
        .finally(() => setLoading(false));
    },
    [api],
  );
  useEffect(() => load(), [load]);

  if (error && !brief) return null; // the rest of the page still tells the story
  return (
    <Card
      className="ai-card"
      title="This week in brief"
      actions={brief ? <AiLabel source={brief.source} /> : undefined}
    >
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
            <Button
              variant="ghost"
              size="sm"
              icon={<MessageCircleQuestion size={16} aria-hidden="true" />}
              onClick={() => ask()}
            >
              Ask a follow-up
            </Button>
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
          <DataUsed used={brief.used} />
        </div>
      )}
    </Card>
  );
}

/** Conversations: 2 lines on what the shopper wanted and what happened; a handoff brief for the person taking over. */
export function ConversationSummary({ conversationId, refreshKey }: { conversationId: string; refreshKey?: unknown }) {
  const api = useApi();
  const [summary, setSummary] = useState<AssistantAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setSummary(null);
    setFailed(false);
    api
      .get<AssistantAnswer>(`/api/brand/conversations/${encodeURIComponent(conversationId)}/summary`)
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
          {summary.handoff_brief && (
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
    <button type="button" className="secondary small ask-about" aria-label={label} onClick={() => ask(question)}>
      Ask about this
    </button>
  );
}
