import { Sparkles } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { errorMessage } from '../../components/ConsoleShell';
import { Badge, Button, Drawer } from '../../components/ui';
import './askQwikspot.css';

/**
 * "Ask Qwikspot" — one drawer for every console (L5 Brand Console, L6 Store Console), opened
 * from the header on every page (or from an "Ask about this" button with the question filled
 * in). A console supplies its AskConfig: where to ask, which page a path is, the suggested
 * questions per page and where each part of the data is shown. Answers are Gemini's (labelled
 * "AI summary") or, when Gemini is slow or fails, the rules "Quick summary" from the same
 * data — within 20 s either way.
 */

export type ConsolePage = 'OVERVIEW' | 'CONVERSATIONS' | 'RESERVATIONS' | 'INSIGHTS' | 'NETWORK' | 'SETTINGS';

export interface AssistantAnswer {
  answer: string;
  handoff_brief: string | null;
  next_action: { label: string; page: string; path: string } | null;
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

/** Where each part of the brand data an answer used is shown in the Brand Console. */
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

/** A reply is shown only if it has the answer's shape (an old backend or an error page never crashes a console). */
export const isAnswer = (a: unknown): a is AssistantAnswer =>
  !!a && typeof (a as AssistantAnswer).answer === 'string' && typeof (a as AssistantAnswer).source === 'string';

/** What a console tells the drawer. */
export interface AskConfig {
  /** Where questions are posted. */
  askPath: string;
  /** The page a path belongs to (sent with the question). */
  pageOf(pathname: string): string;
  /** The suggested questions on a page. */
  suggestions(page: string): string[];
  /** Where each part of the data an answer used is shown. */
  sourceLinks: Record<string, { label: string; to: string }>;
  /** Whose data the answers come from: "your brand's", "your store's". */
  dataOf: string;
  placeholder: string;
}

/** The Brand Console's Ask Qwikspot (L5). */
export const BRAND_ASK: AskConfig = {
  askPath: '/api/brand/assistant/ask',
  pageOf,
  suggestions: (page) => SUGGESTED_QUESTIONS[page as ConsolePage] ?? SUGGESTED_QUESTIONS.OVERVIEW,
  sourceLinks: SOURCE_LINKS,
  dataOf: "your brand's",
  placeholder: 'Ask about your stores, holds, chats or demand…',
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
export function DataUsed({ used = [] }: { used?: string[] }) {
  const { config } = useContext(Ctx);
  const links = [
    ...new Map(
      used
        .map((u) => config.sourceLinks[u])
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

/** What the page shows: its period and whether synthetic demo history counts. Answers use the same. */
export interface AskScopeValue {
  days: 7 | 28;
  includeHistory: boolean;
}
export const DEFAULT_ASK_SCOPE: AskScopeValue = { days: 7, includeHistory: true };

interface AskContext {
  config: AskConfig;
  /** Opens the drawer, optionally with a question filled in. */
  ask(question?: string): void;
  /** A page tells the drawer what it shows (via <AskScope>). */
  setScope(scope: AskScopeValue): void;
}

const Ctx = createContext<AskContext>({ config: BRAND_ASK, ask: () => undefined, setScope: () => undefined });

/**
 * Placed inside a page (within its ConsoleShell): the drawer answers for this period and
 * synthetic-history choice, so the AI talks about the numbers the page shows.
 */
export function AskScope({ days, includeHistory }: AskScopeValue) {
  const { setScope } = useContext(Ctx);
  useEffect(() => {
    setScope({ days, includeHistory });
    return () => setScope(DEFAULT_ASK_SCOPE);
  }, [days, includeHistory, setScope]);
  return null;
}

/** "Last 7 days · live activity only" — what an answer covers. */
export const scopeText = (s: AskScopeValue) =>
  `Last ${s.days} days · ${s.includeHistory ? 'including synthetic demo history' : 'live activity only'}`;

/** Pages call this for "Ask about this"; outside a console with Ask Qwikspot it does nothing. */
export const useAskQwikspot = () => useContext(Ctx);

/** Mounted by the console shell (Brand, Store): the drawer and the header button's state. */
export function AskQwikspotProvider({
  config,
  children,
}: {
  config: AskConfig;
  children: (open: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ question: string; at: number } | null>(null);
  const [scope, setScope] = useState<AskScopeValue>(DEFAULT_ASK_SCOPE);
  const value = useMemo<AskContext>(
    () => ({
      config,
      ask: (question) => {
        setPrefill(question ? { question, at: Date.now() } : null);
        setOpen(true);
      },
      setScope: (next) =>
        setScope((current) =>
          current.days === next.days && current.includeHistory === next.includeHistory ? current : next,
        ),
    }),
    [config],
  );
  return (
    <Ctx.Provider value={value}>
      {children(() => value.ask())}
      <AskQwikspotDrawer open={open} prefill={prefill} scope={scope} config={config} onClose={() => setOpen(false)} />
    </Ctx.Provider>
  );
}

type Status = 'idle' | 'reading' | 'writing' | 'done' | 'error';

function AskQwikspotDrawer({
  open,
  prefill,
  scope,
  config,
  onClose,
}: {
  open: boolean;
  prefill: { question: string; at: number } | null;
  scope: AskScopeValue;
  config: AskConfig;
  onClose: () => void;
}) {
  const api = useApi();
  const { pathname } = useLocation();
  const page = config.pageOf(pathname);
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
        .post<AssistantAnswer>(config.askPath, {
          question: text,
          page,
          days: scope.days,
          include_history: scope.includeHistory,
        })
        .then((a) => {
          if (run.current !== id) return;
          if (!isAnswer(a)) {
            setError('Ask Qwikspot could not answer just now. Please try again.');
            setStatus('error');
            return;
          }
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
    [api, page, scope, config.askPath],
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
        Answers come only from {config.dataOf} Qwikspot data. Qwikspot can explain and suggest; it never changes
        anything.
      </p>
      <p className="small ask-scope">{scopeText(scope)}</p>
      <div className="ask-suggestions" role="group" aria-label="Suggested questions">
        {config.suggestions(page).map((q) => (
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
          placeholder={config.placeholder}
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
