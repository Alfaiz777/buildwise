import { CalendarDays, CheckCircle2, FileWarning, Info, Lightbulb, MapPin } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { Badge, Card, ErrorState, ProductThumb, RingGauge, Skeleton, Tip } from '../../components/ui';
import { label } from '../../lib/labels';
import { AskAction, PageHeader, PeriodControls } from '../platform/PlatformChrome';
import { AskScope } from './askQwikspot';
import { AskAboutThis } from './AiCards';
import { humanize } from './conversationTypes';
import { FunnelTable, WeekdayChart } from './InsightCharts';
import { JourneyFunnel } from './JourneyFunnel';
import type { BrandStore } from './types';
import './brand.css';
import './insights.css';

export interface InsightsResponse {
  period: { days: number; from: string; to: string; timezone: string };
  demo_history: { included: boolean; records: number };
  funnel: {
    intents: number;
    follow_ups_sent: number;
    conversations: number;
    store_recommendations: number;
    reservations: number;
    completed: number;
    outcomes: Record<string, number>;
    /** UI-3: recorded value of purchase outcomes (est.). Absent on older backends. */
    value?: { amount: number; currency: string | null };
  };
  conversion_by_action: {
    action: string;
    intended: string[] | null;
    outcomes: number;
    recorded: Record<string, number>;
    converted: number;
    rate_pct: number | null;
  }[];
  unmet_demand: {
    sku: string;
    label: string;
    area: string;
    weekday: string;
    count: number;
    reasons: Record<string, number>;
  }[];
  weekday: {
    days: {
      weekday: string;
      lookups: number;
      no_store: number;
      no_store_pct: number;
      reservations: number;
      completions: number;
    }[];
    reading: { kind: string; text: string; peak_weekday?: string };
  };
  fill_rate: {
    store_id: string;
    store_name: string;
    weekday: string;
    nearest: number;
    had_stock: number;
    fill_pct: number;
    refusals: Record<string, number>;
  }[];
  suggestions: { rule: string; text: string; evidence: { kind: string; ids: string[] } }[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
/** Purchase types and refusal/exclusion reasons in words. */
const WORDS: Record<string, string> = {
  OFFLINE: 'in-store purchase',
  ONLINE: 'online order',
  ALTERNATIVE: 'alternative product',
  NONE: 'no purchase',
  OUT_OF_STOCK: 'out of stock',
  TOO_FAR: 'too far',
  CLOSED: 'closed',
  INACTIVE: 'store inactive',
  RESERVATIONS_DISABLED: 'reservations off',
  NOT_ACTUALLY_IN_STOCK: 'not actually in stock',
  DAMAGED: 'damaged',
  STORE_CLOSING_EARLY: 'closing early',
  OTHER: 'other',
};
const words = (k: string) => WORDS[k] ?? humanize(k);
const reasons = (r: Record<string, number>) =>
  Object.entries(r)
    .map(([k, v]) => `${words(k)} ${v}`)
    .join(', ') || '—';

/** The stores a suggestion names (by name), so it can link to the store's row in Network. */
export function storesNamedIn(text: string, stores: Pick<BrandStore, 'store_id' | 'store_name'>[]) {
  return stores.filter((s) => s.store_name && text.includes(s.store_name));
}

/** A "Show as table" switch for a visual section (tables stay for accessibility and tests). */
function TableToggle({ table, onToggle }: { table: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="ui-link-button small in-toggle" onClick={onToggle}>
      {table ? 'Show as chart' : 'Show as table'}
    </button>
  );
}

const health = (pct: number) => (pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'danger');
const RULE_ICON: Record<string, typeof Lightbulb> = {
  STOCK_UNMET_AREA: MapPin,
  RAISE_STOCK_BEFORE_PEAK: CalendarDays,
  REUPLOAD_STOCK: FileWarning,
};
const SECTIONS = [
  { id: 'funnel', label: 'Funnel' },
  { id: 'demand', label: 'Demand' },
  { id: 'actions', label: 'Actions' },
  { id: 'stores', label: 'Stores' },
];

/**
 * Brand Console → Insights (docs/11 §4; Change 13 F8, Change 16 UI-3; UI-P3 layout). Every
 * number is a count over stored records; the reading and suggestions are fixed rules over those
 * numbers (no AI text). Each panel is drawn — the journey, the shared weekday chart, ranked bars
 * — with its table one click away ("Show as table"). An in-page nav jumps between sections.
 */
export function InsightsPage() {
  const api = useApi();
  const [days, setDays] = useState<7 | 28>(7);
  const [includeHistory, setIncludeHistory] = useState(true);
  const [tables, setTables] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setTables((t) => ({ ...t, [k]: !t[k] }));
  const stores = useLoad(useCallback(() => api.get<{ stores: BrandStore[] }>('/api/brand/stores'), [api]));
  const data = useLoad(
    useCallback(
      () => api.get<InsightsResponse>(`/api/brand/insights?days=${days}&include_history=${includeHistory}`),
      [api, days, includeHistory],
    ),
  );
  const d = data.data;
  const history = d?.demo_history.included && d.demo_history.records > 0 ? d.demo_history.records : 0;
  const areaOf = (storeId: string) => stores.data?.stores.find((s) => s.store_id === storeId)?.area ?? null;
  const storeInArea = (area: string) =>
    stores.data?.stores.find((s) => (s.area ?? '').toLowerCase() === area.toLowerCase()) ?? null;

  // Fill rate by store: the stores' rows added up over the weekdays, worst first.
  const byStore = new Map<string, { store_id: string; store_name: string; nearest: number; had: number }>();
  for (const f of d?.fill_rate ?? []) {
    const g = byStore.get(f.store_id) ?? { store_id: f.store_id, store_name: f.store_name, nearest: 0, had: 0 };
    g.nearest += f.nearest;
    g.had += f.had_stock;
    byStore.set(f.store_id, g);
  }
  const fill = [...byStore.values()]
    .map((g) => ({ ...g, pct: g.nearest === 0 ? 0 : Math.round((g.had / g.nearest) * 100) }))
    .sort((a, b) => a.pct - b.pct || b.nearest - a.nearest);
  const unmet = [...(d?.unmet_demand ?? [])].sort((a, b) => b.count - a.count);
  const grouped = new Map<
    string,
    {
      key: string;
      sku: string;
      label: string;
      area: string;
      count: number;
      weekdays: string[];
      reasons: Record<string, number>;
    }
  >();
  for (const u of unmet) {
    const key = `${u.area}|${u.sku}`;
    const g = grouped.get(key) ?? {
      key,
      sku: u.sku,
      label: u.label,
      area: u.area,
      count: 0,
      weekdays: [],
      reasons: {},
    };
    g.count += u.count;
    if (!g.weekdays.includes(u.weekday)) g.weekdays.push(u.weekday);
    for (const [r, n] of Object.entries(u.reasons)) g.reasons[r] = (g.reasons[r] ?? 0) + n;
    grouped.set(key, g);
  }
  const ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const ranked = [...grouped.values()].sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));
  const daysText = (days: string[]) =>
    days.length === 1
      ? `${cap(days[0]!)}s`
      : [...days]
          .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
          .map((x) => cap(x).slice(0, 3))
          .join(', ');
  const maxUnmet = Math.max(1, ...ranked.map((u) => u.count));
  const suggestions = [...(d?.suggestions ?? [])].sort((a, b) => b.evidence.ids.length - a.evidence.ids.length);

  return (
    <ConsoleShell>
      <AskScope days={days} includeHistory={includeHistory} />
      <PageHeader
        title="Insights"
        purpose="Where shoppers wanted your products, whether a store had them, and what to fix next."
        action={<AskAction label="Ask what to fix first" question="What should I fix first, based on my insights?" />}
      />
      <PeriodControls
        days={days}
        onDays={setDays}
        includeHistory={includeHistory}
        onHistory={setIncludeHistory}
        demoRecords={history}
        demoTip={`Includes synthetic demo history (${history} generated records). Choose "Live only" to see only live activity.`}
      >
        {d && (
          <Tip text={`Weekdays in store time (${d.period.timezone}).`}>
            <Info size={16} aria-label={`Weekdays in store time (${d.period.timezone}).`} />
          </Tip>
        )}
      </PeriodControls>
      <nav className="in-nav" aria-label="Insights sections">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.label}
          </a>
        ))}
      </nav>
      {data.error && <ErrorState message={data.error} onRetry={data.reload} />}
      {!d && !data.error && <Skeleton lines={4} />}

      {d && (
        <>
          <Card
            id="funnel"
            title="Journey funnel"
            description="How many shoppers reached each step, and the share that went on."
          >
            {tables.funnel ? (
              <FunnelTable
                steps={[
                  { label: 'Storefront intents', value: d.funnel.intents },
                  { label: 'Follow-ups sent', value: d.funnel.follow_ups_sent },
                  { label: 'Conversations', value: d.funnel.conversations },
                  { label: 'Store offers', value: d.funnel.store_recommendations },
                  { label: 'Holds', value: d.funnel.reservations },
                  { label: 'Pickups', value: d.funnel.completed },
                ]}
              />
            ) : (
              <JourneyFunnel funnel={d.funnel} large />
            )}
            <div className="in-foot">
              <ul className="in-outcomes" aria-label="Outcomes">
                {Object.entries(d.funnel.outcomes).map(([k, v]) => (
                  <li key={k}>
                    <strong>{v}</strong> {words(k)}
                  </li>
                ))}
                <li>
                  <strong>{d.funnel.follow_ups_sent}</strong> follow-ups sent
                </li>
              </ul>
              <TableToggle table={!!tables.funnel} onToggle={() => toggle('funnel')} />
            </div>
          </Card>

          <Card id="demand" title="Demand vs availability by weekday">
            <p className="reading" data-kind={d.weekday.reading.kind}>
              {d.weekday.reading.text}
            </p>
            <WeekdayChart
              days={d.weekday.days}
              problemDay={
                d.weekday.reading.kind === 'AVAILABILITY_PROBLEM' ? (d.weekday.reading.peak_weekday ?? null) : null
              }
              caption="Weekdays in store time."
            />
            <details className="small">
              <summary>Reservations and pickups by day</summary>
              <table aria-label="Reservations by weekday">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Reservations</th>
                    <th>Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {d.weekday.days.map((day) => (
                    <tr key={day.weekday}>
                      <td>{cap(day.weekday)}</td>
                      <td>{day.reservations}</td>
                      <td>{day.completions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </Card>

          <Card
            title="Unmet local demand"
            description="Areas where shoppers asked and no store had it, most missed first."
          >
            {unmet.length === 0 ? (
              <p className="in-positive">
                <CheckCircle2 size={18} aria-hidden="true" /> Every store lookup in this period found a store with
                stock.
              </p>
            ) : tables.unmet ? (
              <table aria-label="Unmet local demand">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Area</th>
                    <th>Day</th>
                    <th>Lookups</th>
                    <th>Why stores were excluded</th>
                  </tr>
                </thead>
                <tbody>
                  {unmet.map((u) => (
                    <tr key={`${u.sku}-${u.area}-${u.weekday}`}>
                      <td>{u.label}</td>
                      <td>{cap(u.area)}</td>
                      <td>{cap(u.weekday)}</td>
                      <td>{u.count}</td>
                      <td className="small">{reasons(u.reasons)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <ol className="in-rank" aria-label="Unmet local demand, most missed first">
                {ranked.map((u, i) => {
                  const near = storeInArea(u.area);
                  return (
                    <li key={u.key} className={i === 0 ? 'is-top' : undefined}>
                      <ProductThumb src={null} name={u.label} size={32} />
                      <div className="in-rank__body">
                        <span>
                          <strong>{titleCase(u.area)}</strong> · {u.label}
                        </span>
                        <span className="in-bar" aria-hidden="true">
                          <span
                            className="in-bar__fill in-bar__fill--missed"
                            style={{ width: `${(u.count / maxUnmet) * 100}%` }}
                          />
                        </span>
                        <span className="small muted">
                          {daysText(u.weekdays)} · {reasons(u.reasons)}
                          {near ? ` · nearest store here: ${near.store_name}` : ''}
                        </span>
                      </div>
                      <span className="in-rank__count">
                        {u.count}
                        <span className="sr-only"> lookups</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
            {unmet.length > 0 && <TableToggle table={!!tables.unmet} onToggle={() => toggle('unmet')} />}
          </Card>

          <Card
            id="actions"
            title="Suggested next actions"
            description="Ranked by how much evidence is behind each. Shown to you only — nothing is sent to stores."
          >
            {suggestions.length === 0 ? (
              <p className="in-positive">
                <CheckCircle2 size={18} aria-hidden="true" /> No suggestions for this period.
              </p>
            ) : (
              <ul className="in-actions">
                {suggestions.map((s) => {
                  const Icon = RULE_ICON[s.rule] ?? Lightbulb;
                  return (
                    <li key={`${s.rule}-${s.evidence.ids[0]}`} className="in-action">
                      <span className="in-action__icon" aria-hidden="true">
                        <Icon size={18} />
                      </span>
                      <div className="in-action__body">
                        <p>{s.text}</p>
                        <div className="small suggestion-links">
                          <Badge tone="neutral">
                            Based on {s.evidence.ids.length}{' '}
                            {s.evidence.kind === 'EVENTS' ? 'store lookups' : 'reservations'}
                          </Badge>
                          {storesNamedIn(s.text, stores.data?.stores ?? []).map((store) => (
                            <Link key={store.store_id} to={`/brand/network#store-${store.store_id}`}>
                              Open {store.store_name} →
                            </Link>
                          ))}
                          <AskAboutThis
                            label={`Ask Qwikspot about: ${s.text}`}
                            question={`About this suggestion: "${s.text}" Why is this happening, and what should I do first?`}
                          />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card
            title="Did the recommendation convert?"
            description="Of the journeys that ended, how many bought what the AI aimed for."
          >
            {d.conversion_by_action.length === 0 ? (
              <p className="muted">No recorded outcomes in this period yet.</p>
            ) : tables.conversion ? (
              <table aria-label="Conversion by action">
                <thead>
                  <tr>
                    <th>Recommended action</th>
                    <th>Aims for</th>
                    <th>Outcomes</th>
                    <th>Recorded</th>
                    <th>Converted</th>
                  </tr>
                </thead>
                <tbody>
                  {d.conversion_by_action.map((c) => (
                    <tr key={c.action}>
                      <td>{label(c.action)}</td>
                      <td>{c.intended ? c.intended.map(words).join(' or ') : '—'}</td>
                      <td>{c.outcomes}</td>
                      <td className="small">{reasons(c.recorded)}</td>
                      <td>{c.rate_pct === null ? '—' : `${c.converted} (${c.rate_pct}%)`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <ul className="in-bars" aria-label="Conversion by action">
                {d.conversion_by_action.map((c) => (
                  <li key={c.action}>
                    <span className="in-bars__label">
                      {label(c.action)}
                      <span className="small muted">
                        {' '}
                        · aims for {c.intended ? c.intended.map(words).join(' or ') : '—'}
                      </span>
                    </span>
                    <span className="in-bar" aria-hidden="true">
                      <span
                        className={`in-bar__fill in-bar__fill--${c.rate_pct === null ? 'neutral' : health(c.rate_pct)}`}
                        style={{ width: `${c.rate_pct ?? 0}%` }}
                      />
                    </span>
                    <span className="in-bars__value">
                      {c.rate_pct === null ? '—' : `${c.rate_pct}%`}
                      <span className="small muted">
                        {' '}
                        {c.converted} of {c.outcomes}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {d.conversion_by_action.length > 0 && (
              <TableToggle table={!!tables.conversion} onToggle={() => toggle('conversion')} />
            )}
          </Card>

          <Card
            id="stores"
            title="Fill rate by store"
            description="When a store was the nearest, how often it had what the shopper asked for. Worst first."
          >
            {d.fill_rate.length === 0 ? (
              <p className="muted">No store lookups in this period yet.</p>
            ) : tables.fill ? (
              <table aria-label="Fill rate by store">
                <thead>
                  <tr>
                    <th>Store</th>
                    <th>Day</th>
                    <th>Was the nearest</th>
                    <th>Had stock</th>
                    <th>Refusals</th>
                  </tr>
                </thead>
                <tbody>
                  {d.fill_rate.map((f) => (
                    <tr key={`${f.store_id}-${f.weekday}`}>
                      <td>{f.store_name}</td>
                      <td>{cap(f.weekday)}</td>
                      <td>{f.nearest}</td>
                      <td>
                        {f.had_stock} ({f.fill_pct}%)
                      </td>
                      <td className="small">{reasons(f.refusals)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <ol className="in-fill" aria-label="Fill rate by store, worst first">
                {fill.map((f) => (
                  <li key={f.store_id} className={`in-fill--${health(f.pct)}`}>
                    <RingGauge pct={f.pct} size={40} />
                    <div className="in-fill__body">
                      <strong>{f.store_name}</strong>
                      <span className="small muted">
                        {areaOf(f.store_id) ? `${titleCase(areaOf(f.store_id)!)} · ` : ''}had it {f.had} of {f.nearest}{' '}
                        times
                      </span>
                      <span className="in-bar" aria-hidden="true">
                        <span
                          className={`in-bar__fill in-bar__fill--${health(f.pct)}`}
                          style={{ width: `${f.pct}%` }}
                        />
                      </span>
                    </div>
                    <span className="in-fill__pct">{f.pct}%</span>
                  </li>
                ))}
              </ol>
            )}
            {d.fill_rate.length > 0 && <TableToggle table={!!tables.fill} onToggle={() => toggle('fill')} />}
          </Card>
        </>
      )}
    </ConsoleShell>
  );
}
