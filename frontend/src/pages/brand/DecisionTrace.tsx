import { Badge } from '../../components/ui';
import { label } from '../../lib/labels';
import { EXCLUSION_TEXT, GUARDRAIL_TEXT, humanize, type Recommendation } from './conversationTypes';
import { formatDateTime } from './types';
import { safetyLabel, whySentence } from './whySentence';

const RUNTIME_TEXT: Record<string, string> = { MOCK: 'Mock AI · deterministic', ADK_GEMINI: 'Gemini' };

/**
 * "Why Qwikspot did this" (docs/11 §4; Change 16, UI-3): for each decision, newest first,
 * one plain sentence built from the trace, the safety check in words and the runtime. The
 * technical trace — context, store table, tool calls — sits under "Technical details".
 */
export function DecisionTrace({ recommendations }: { recommendations: Recommendation[] }) {
  if (recommendations.length === 0) return null;
  const newestFirst = [...recommendations].reverse();
  return (
    <div className="decision-trace">
      <h3>Why Qwikspot did this</h3>
      {newestFirst.map((r) => {
        const safety = safetyLabel(r);
        return (
          <article key={r.recommendation_id} className="trace-card" aria-label={label(r.action)}>
            <header className="trace-card__head">
              <strong>{label(r.action)}</strong> <Badge tone={safety.tone}>{safety.text}</Badge>{' '}
              <Badge>{RUNTIME_TEXT[r.runtime] ?? r.runtime}</Badge>
              {r.decision_source !== 'AGENT' && <Badge tone="warning">Safe fallback reply</Badge>}
              <span className="muted small"> {formatDateTime(r.proposed_at)}</span>
            </header>
            <p className="why-sentence">{whySentence(r)}</p>
            <details className="small">
              <summary>Technical details</summary>
              <p className="small">{r.rationale_summary}</p>
              {r.trace ? <TraceBody r={r} /> : <p className="muted small">No trace recorded for this decision.</p>}
            </details>
          </article>
        );
      })}
    </div>
  );
}

function TraceBody({ r }: { r: Recommendation }) {
  const t = r.trace!;
  const summary = t.context_summary;
  return (
    <>
      <dl className="small">
        <dt>Context</dt>
        <dd>
          {summary.intent_type ? humanize(String(summary.intent_type)) : 'no storefront intent'}
          {' · '}location: {humanize(String(summary.location ?? 'none'))}
          {' · '}
          {String(summary.messages ?? 0)} recent messages
          {summary.pending_proposal ? ' · a hold was on offer' : ''}
        </dd>
        <dt>Guardrail</dt>
        <dd>
          {t.guardrail.status === 'BLOCKED'
            ? (GUARDRAIL_TEXT[t.guardrail.reason_code ?? ''] ?? humanize(t.guardrail.reason_code ?? 'blocked'))
            : t.guardrail.checked
              ? `Allowed after re-checking ${humanize(t.guardrail.checked)} on fresh data.`
              : 'Allowed (nothing to write).'}
        </dd>
        {t.fallback_reason && (
          <>
            <dt>Fallback</dt>
            <dd>The agent runtime failed ({humanize(t.fallback_reason)}); the fixed safe reply was used.</dd>
          </>
        )}
        {t.repaired && (
          <>
            <dt>Repair</dt>
            <dd>The first output was invalid; one repair attempt succeeded.</dd>
          </>
        )}
        {r.reservation && (
          <>
            <dt>Reservation</dt>
            <dd>
              {r.reservation.store_name} · {humanize(r.reservation.status)} · pickup code{' '}
              <span className="mono">{r.reservation.pickup_code}</span> · expires{' '}
              {formatDateTime(r.reservation.expires_at)}
            </dd>
          </>
        )}
      </dl>

      {(t.eligible.length > 0 || t.excluded.length > 0) && (
        <table className="small">
          <thead>
            <tr>
              <th>Store</th>
              <th>Distance</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {t.eligible.map((s) => (
              <tr key={`e-${s.variant_id}-${s.store_id}`}>
                <td>{s.store_name}</td>
                <td>{s.distance_km} km</td>
                <td>eligible</td>
              </tr>
            ))}
            {t.excluded.map((s) => (
              <tr key={`x-${s.variant_id}-${s.store_id}`} className="muted">
                <td>{s.store_name}</td>
                <td>{s.distance_km === null ? '—' : `${s.distance_km} km`}</td>
                <td>excluded: {EXCLUSION_TEXT[s.reason] ?? humanize(s.reason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details className="small">
        <summary>Tool calls ({t.tool_calls.length})</summary>
        {t.tool_calls.length === 0 ? (
          <p className="muted">No tools were called.</p>
        ) : (
          <ol>
            {t.tool_calls.map((c) => (
              <li key={c.call_id}>
                <span className="mono">{c.tool}</span> · {c.kind === 'WRITE' ? 'write' : 'read'} · {humanize(c.status)}
                {c.reason_code && ` (${humanize(c.reason_code)})`} · {c.duration_ms} ms
                <div className="muted mono">{JSON.stringify(c.output_summary)}</div>
              </li>
            ))}
          </ol>
        )}
      </details>
    </>
  );
}
