import { Sparkles } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { errorMessage } from '../../components/ConsoleShell';
import { Badge, Button, Drawer } from '../../components/ui';
import './askQwikspot.css';

/**
 * L5 "Ask Qwikspot" — the brand agent in the Brand Console. One drawer, opened from the header
 * on every page (or from an "Ask about this" button with the question filled in). It knows the
 * page, so its suggested questions change with it. Answers come from POST
 * /api/brand/assistant/ask: Gemini's (labelled "AI summary") or, when Gemini is slow or
 * fails, the rules "Quick summary" from the same data — within 20 s either way.
 */

export type ConsolePage = 'OVERVIEW' | 'CONVERSATIONS' | 'RESERVATIONS' | 'INSIGHTS' | 'NETWORK' | 'SETTINGS';

export interface AssistantAnswer {
  answer: string;
  handoff_brief: string | null;
  next_action: { label: string; page: ConsolePage; path: string } | null;
  used: string[];
  source: 'AI' | 'QUICK_SUMMARY';
  generated_at: string;
  latency_ms: number;
}

/** The page a Brand Console path belongs to. */
export function pageOf(pathname: string): ConsolePage {
  if (pathname.startsWith('/brand/conversations')) return 'CONVERSATIONS';
  if (pathname.startsWith('/brand/reservations')) return 'RESERVATIONS';
  if (pathname.startsWith('/brand/insights') || pathname.startsWith('/brand/outcomes')) return 'INSIGHTS';
  if (pathname.startsWith('/brand/network')) return 'NETWORK';
  if (pathname.startsWith('/brand/settings')) return 'SETTINGS';
  return 'OVERVIEW';
}

/** Suggested questions per page (docs/05 §18). */
export const SUGGESTED_QUESTIONS: Record<ConsolePage, string[]> = {
  OVERVIEW: ['How did we do this week?', 'What should I fix first?'],
  CONVERSATIONS: ['Why did chats end without a hold this week?', 'Show me chats where the shopper refused a store'],
  RESERVATIONS: ['Which holds are at risk?', 'Which store is slowest to accept?'],
  INSIGHTS: [
    'Which product is losing the most demand?',
    'Compare Satellite and Navrangpura',
    'What should I restock before Saturday?',
  ],
  NETWORK: ['Which store needs attention?', 'Where should I add a store?'],
  SETTINGS: ['What does Qwikspot do automatically for me?'],
};

/** Where each part of the data an answer used is shown in the console. */
const SOURCE_LINKS: Record<string, { label: string; to: string }> = {
  totals: { label: 'Insights', to: '/brand/insights' },
  unmet_demand: { label: 'Insights', to: '/brand/insights' },
  suggestions: { label: 'Insights', to: '/brand/insights' },
  weekday_reading: { label: 'Insights', to: '/brand/insights' },
  stores: { label: 'Network', to: '/brand/network' },
  holds_now: { label: 'Reservations', to: '/brand/reservations' },
  conversations_now: { label: 'Conversations', to: '/brand/conversations' },
  conversation: { label: 'This conversation', to: '' },
};

/** "AI summary" (Gemini) or "Quick summary" (the rules, from the same data). */
export function AiLabel({ source }: { source: AssistantAnswer['source'] }) {
  return source === 'AI' ? (
    <Badge tone="info">
      <Sparkles size={12} aria-hidden="true" /> AI summary
    </Badge>
  ) : (
    <Badge tone="neutral">Quick summary</Badge>
  );
}

/** "Based on: Insights · Network" — links to the data an answer used. */
export function DataUsed({ used }: { used: string[] }) {
  const links = [
    ...new Map(
      used
        .map((u) => SOURCE_LINKS[u])
        .filter(Boolean)
        .map((l) => [l!.label, l!]),
    ).values(),
  ];
  const pages = links.filter((l) => l.to);
  if (pages.length === 0) return null;
  return (
    <p className="ask-used small muted">
      Based on:{' '}
      {pages.map((l, i) => (
        <span key={l.label}>
          {i > 0 && ' · '}
          <Link to={l.to}>{l.label}</Link>
        </span>
      ))}
    </p>
  );
}

interface AskContext {
  /** Opens the drawer, optionally with a question filled in. */
  ask(question?: string): void;
}

const Ctx = createContext<AskContext>({ ask: () => undefined });

/** Pages call this for "Ask about this"; outside the Brand Console it does nothing. */
export const useAskQwikspot = () => useContext(Ctx);

/** Mounted by the Brand Console shell: the drawer and the header button's state. */
export function AskQwikspotProvider({ children }: { children: (open: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ question: string; at: number } | null>(null);
  const value = useMemo<AskContext>(
    () => ({
      ask: (question) => {
        setPrefill(question ? { question, at: Date.now() } : null);
        setOpen(true);
      },
    }),
    [],
  );
  return (
    <Ctx.Provider value={value}>
      {children(() => value.ask())}
      <AskQwikspotDrawer open={open} prefill={prefill} onClose={() => setOpen(false)} />
    </Ctx.Provider>
  );
}

type Status = 'idle' | 'reading' | 'writing' | 'done' | 'error';

function AskQwikspotDrawer({
  open,
  prefill,
  onClose,
}: {
  open: boolean;
  prefill: { question: string; at: number } | null;
  onClose: () => void;
}) {
  const api = useApi();
  const { pathname } = useLocation();
  const page = pageOf(pathname);
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);

  const submit = useCallback(
    (q: string) => {
      const text = q.trim();
      if (text.length < 2) return;
      const id = ++run.current;
      setAsked(text);
      setAnswer(null);
      setError(null);
      setStatus('reading');
      // The data pack takes about a second; then the model writes.
      const step = setTimeout(() => run.current === id && setStatus('writing'), 1_200);
      api
        .post<AssistantAnswer>('/api/brand/assistant/ask', { question: text, page })
        .then((a) => {
          if (run.current !== id) return;
          setAnswer(a);
          setStatus('done');
        })
        .catch((err: unknown) => {
          if (run.current !== id) return;
          setError(errorMessage(err));
          setStatus('error');
        })
        .finally(() => clearTimeout(step));
    },
    [api, page],
  );

  // "Ask about this": the question is filled in and asked at once.
  useEffect(() => {
    if (open && prefill) {
      setQuestion(prefill.question);
      submit(prefill.question);
    }
  }, [open, prefill, submit]);

  const busy = status === 'reading' || status === 'writing';
  return (
    <Drawer open={open} title="Ask Qwikspot" onClose={onClose}>
      <p className="muted small">
        Answers come only from your brand's Qwikspot data. Qwikspot can explain and suggest; it never changes anything.
      </p>
      <div className="ask-suggestions" role="group" aria-label="Suggested questions">
        {SUGGESTED_QUESTIONS[page].map((q) => (
          <button
            key={q}
            type="button"
            className="ask-chip"
            disabled={busy}
            onClick={() => {
              setQuestion(q);
              submit(q);
            }}
          >
            {q}
          </button>
        ))}
      </div>
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(question);
        }}
      >
        <label className="sr-only" htmlFor="ask-question">
          Your question
        </label>
        <input
          id="ask-question"
          value={question}
          maxLength={300}
          placeholder="Ask about your stores, holds, chats or demand…"
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button type="submit" loading={busy} disabled={question.trim().length < 2}>
          Ask
        </Button>
      </form>
      <div className="ask-result" aria-live="polite">
        {asked && <p className="ask-question small">“{asked}”</p>}
        {status === 'reading' && <p className="muted small">Reading your data…</p>}
        {status === 'writing' && <p className="muted small">Writing the answer…</p>}
        {status === 'error' && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {answer && (
          <article className="ask-answer">
            <AiLabel source={answer.source} />
            <p>{answer.answer}</p>
            {answer.next_action && (
              <Link
                className="ui-button ui-button--secondary ui-button--sm"
                to={answer.next_action.path}
                onClick={onClose}
              >
                {answer.next_action.label} →
              </Link>
            )}
            <DataUsed used={answer.used} />
          </article>
        )}
      </div>
    </Drawer>
  );
}
