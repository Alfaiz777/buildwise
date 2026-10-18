import {
  BookOpen,
  MapPin,
  MessageCircle,
  PackageCheck,
  Repeat,
  Scale,
  ShieldCheck,
  ShoppingBag,
  UserRound,
} from 'lucide-react';
import { Badge } from '../../components/ui';
import { label } from '../../lib/labels';
import { humanize, type Recommendation } from './conversationTypes';
import { formatDateTime } from './types';
import { safetyLabel, whySentence } from './whySentence';

const RUNTIME_TEXT: Record<string, string> = { MOCK: 'Mock AI · deterministic', ADK_GEMINI: 'Gemini (Vertex AI)' };

const BACKUP_CAUSE: Record<string, string> = {
  TIMEOUT: 'Gemini timeout',
  RUNTIME_ERROR: 'Gemini error',
  INVALID_OUTPUT: 'an invalid Gemini answer',
};

/** L3: Gemini failed for this message and the deterministic mock answered instead. */
export const backupLabel = (reason: string | null | undefined) =>
  `Mock AI (backup after ${BACKUP_CAUSE[reason ?? ''] ?? 'a Gemini failure'})`;

/** The agent's tools in plain words, as small chips on each decision (UI-P3). */
const TOOL_WORDS: Record<string, string> = {
  find_nearby_stores: 'Nearest stores',
  check_store_inventory: 'Stock check',
  create_reservation: 'Hold',
  cancel_reservation: 'Cancel hold',
  get_product_context: 'Product info',
  get_brand_policy: 'Brand policy',
  get_customer_history: 'Past chats',
  get_store: 'Store details',
  get_store_hours: 'Store hours',
};

/** The safety check that ran before acting, in words (only when one ran). */
const CHECK_WORDS: Record<string, string> = {
  OFFERED_STORES: 'Verified stock only',
  CREATE_RESERVATION: 'Stock re-checked',
  CANCEL_RESERVATION: 'Hold verified',
};

const ACTION_ICON: Record<string, typeof MapPin> = {
  STORE_DISCOVERY: MapPin,
  STORE_RESERVATION: PackageCheck,
  ONLINE_PURCHASE: ShoppingBag,
  HUMAN_HANDOFF: UserRound,
  EDUCATE: BookOpen,
  COMPARE: Scale,
  ALTERNATIVE_PRODUCT: Repeat,
};

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * "Why Qwikspot did this" (docs/11 §4; Change 16, UI-3; UI-P3 timeline): each decision as a
 * step on a vertical timeline, newest first — an icon, one plain sentence built from the
 * trace, the tools it used and the safety check as small chips, the runtime and the time. The raw
 * trace (context, store table, tool calls) stays in the API for audits but is not shown here.
 */
export function DecisionTrace({ recommendations }: { recommendations: Recommendation[] }) {
  if (recommendations.length === 0) return null;
  const newestFirst = [...recommendations].reverse();
  return (
    <div className="decision-trace">
      <h3>Why Qwikspot did this</h3>
      <ol className="trace-timeline">
        {newestFirst.map((r) => {
          const safety = safetyLabel(r);
          const Icon = ACTION_ICON[r.action] ?? MessageCircle;
          const tools = [...new Set((r.trace?.tool_calls ?? []).map((c) => TOOL_WORDS[c.tool] ?? humanize(c.tool)))];
          const check = r.trace?.guardrail.checked ? CHECK_WORDS[r.trace.guardrail.checked] : undefined;
          return (
            <li key={r.recommendation_id} className={`trace-step trace-step--${safety.tone}`}>
              <span className="trace-step__icon" aria-hidden="true">
                <Icon size={16} />
              </span>
              <article className="trace-card" aria-label={label(r.action)}>
                <header className="trace-card__head">
                  <strong>{label(r.action)}</strong> <Badge tone={safety.tone}>{safety.text}</Badge>{' '}
                  {r.decision_source === 'RULES_TAP' ? (
                    <Badge>Rules (button tap)</Badge>
                  ) : r.decision_source === 'AGENT_BACKUP' ? (
                    <Badge tone="warning">{backupLabel(r.trace?.fallback_reason)}</Badge>
                  ) : (
                    <>
                      <Badge>{RUNTIME_TEXT[r.runtime] ?? r.runtime}</Badge>
                      {r.decision_source !== 'AGENT' && <Badge tone="warning">Safe fallback reply</Badge>}
                    </>
                  )}
                  <time
                    className="trace-card__time muted small"
                    dateTime={r.proposed_at}
                    title={formatDateTime(r.proposed_at)}
                  >
                    {timeOf(r.proposed_at)}
                  </time>
                </header>
                <p className="why-sentence">{whySentence(r)}</p>
                {(tools.length > 0 || check) && (
                  <ul className="trace-chips" aria-label="Used">
                    {tools.map((t) => (
                      <li key={t} className="trace-chip">
                        {t}
                      </li>
                    ))}
                    {check && (
                      <li className="trace-chip trace-chip--safe">
                        <ShieldCheck size={12} aria-hidden="true" /> {check}
                      </li>
                    )}
                  </ul>
                )}
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
