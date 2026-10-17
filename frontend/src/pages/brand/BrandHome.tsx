import { AlertTriangle, CalendarDays, CheckCircle2, Info, Lightbulb, MapPin, Store, UserRound } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, errorMessage, useLoad } from '../../components/ConsoleShell';
import { Card, ErrorState, RingGauge, Skeleton, Tip, useToast } from '../../components/ui';
import { AskAction, PageHeader, PeriodControls } from '../platform/PlatformChrome';
import type { ConversationRow, ReservationRow } from './conversationTypes';
import { AiBriefCard, AskAboutThis } from './AiCards';
import { AskScope } from './askQwikspot';
import { storesNamedIn, type InsightsResponse } from './InsightsPage';
import { JourneyFunnel } from './JourneyFunnel';
import { attentionItems, kpis, type AttentionItem } from './overview';
import type { BrandSettings } from './SettingsPage';
import { SetupChecklist } from './SetupChecklist';
import type { BrandStore, CatalogResponse, Connection } from './types';
import './brand.css';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** One "needs your attention" card: the problem in words and the one thing to do about it. */
interface AttentionCard extends AttentionItem {
  action: string;
  icon: ReactNode;
}

function attentionCards(items: AttentionItem[], handoffs: number, d: InsightsResponse | null): AttentionCard[] {
  const cards: AttentionCard[] = items.map((a) => {
    if (a.key === 'handoff')
      return {
        ...a,
        action: `Open ${handoffs} handoff${handoffs === 1 ? '' : 's'} →`,
        icon: <UserRound size={18} aria-hidden="true" />,
      };
    if (a.key.startsWith('refusal-'))
      return { ...a, action: 'Review refused holds →', icon: <AlertTriangle size={18} aria-hidden="true" /> };
    if (a.key.startsWith('stale-'))
      return { ...a, action: 'Open the store →', icon: <Store size={18} aria-hidden="true" /> };
    return { ...a, action: 'Review mapping →', icon: <AlertTriangle size={18} aria-hidden="true" /> };
  });
  // UI-P3: the area where shoppers asked most with no store in stock (from the insights already loaded).
  const top = d ? [...d.unmet_demand].sort((a, b) => b.count - a.count)[0] : undefined;
  if (top) {
    const area = titleCase(top.area);
    cards.push({
      key: `unmet-${top.sku}-${top.area}`,
      text: `${top.label} was asked for ${top.count} time${top.count === 1 ? '' : 's'} in ${area} with no store in stock`,
      to: '/brand/insights#demand',
      tone: 'warning',
      action: `Review unmet demand in ${area} →`,
      icon: <MapPin size={18} aria-hidden="true" />,
    });
  }
  return cards;
}

/**
 * Brand Console → Overview (docs/11 §4; UI-3; UI-P3 layout): is Qwikspot turning online
 * shoppers into store sales? The AI brief and what needs the brand now, above the fold; the
 * shopper journey as the hero; four headline numbers; what we're seeing, as cards to ask
 * about. Every number is a field of GET /api/brand/insights; nothing new is computed except
 * the overall fill rate (stores' "had it" over "nearest", the same counts as Insights).
 */
export function BrandHome() {
  const api = useApi();
  const toast = useToast();
  const [days, setDays] = useState<7 | 28>(7);
  const [includeHistory, setIncludeHistory] = useState(true);
  const insights = useLoad(
    useCallback(
      () => api.get<InsightsResponse>(`/api/brand/insights?days=${days}&include_history=${includeHistory}`),
      [api, days, includeHistory],
    ),
  );
  const conversations = useLoad(
    useCallback(() => api.get<{ conversations: ConversationRow[] }>('/api/brand/conversations'), [api]),
  );
  const reservations = useLoad(
    useCallback(() => api.get<{ reservations: ReservationRow[] }>('/api/reservations?view=history&limit=200'), [api]),
  );
  const stores = useLoad(useCallback(() => api.get<{ stores: BrandStore[] }>('/api/brand/stores'), [api]));
  const catalog = useLoad(useCallback(() => api.get<CatalogResponse>('/api/products'), [api]));
  const settings = useLoad(useCallback(() => api.get<BrandSettings>('/api/brand/settings'), [api]));
  const connections = useLoad(
    useCallback(() => api.get<{ connections: Connection[] }>('/api/brand/connections'), [api]),
  );
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncCatalog = () => {
    setSyncing(true);
    setError(null);
    api
      .post('/api/integrations/shopify/sync', {})
      .then(() => toast.show('Catalog synced.'))
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => {
        setSyncing(false);
        connections.reload();
        catalog.reload();
      });
  };

  const d = insights.data;
  const history = d?.demo_history.included && d.demo_history.records > 0 ? d.demo_history.records : 0;
  const attention =
    conversations.data && reservations.data && stores.data && catalog.data
      ? attentionItems({
          conversations: conversations.data.conversations,
          reservations: reservations.data.reservations,
          stores: stores.data.stores,
          freshnessHours: settings.data?.retail_freshness_hours ?? null,
          mappingIssues: catalog.data.mapping_summary.needs_attention,
          now: Date.now(),
        })
      : null;
  const handoffs = conversations.data?.conversations.filter((c) => c.human_handoff).length ?? 0;
  const cards = attention ? attentionCards(attention, handoffs, d ?? null) : null;
  const suggestion = d?.suggestions[0] ?? null;
  const suggestionStores = suggestion ? storesNamedIn(suggestion.text, stores.data?.stores ?? []) : [];
  const tiles = d ? Object.fromEntries(kpis(d).map((k) => [k.key, k])) : {};
  const nearest = d?.fill_rate.reduce((n, f) => n + f.nearest, 0) ?? 0;
  const hadStock = d?.fill_rate.reduce((n, f) => n + f.had_stock, 0) ?? 0;
  const fillPct = nearest === 0 ? null : Math.round((hadStock / nearest) * 100);
  const conversionPct =
    tiles.conversion && tiles.conversion.value !== '—' ? Number.parseInt(tiles.conversion.value) : null;
  const unmet = d ? [...d.unmet_demand].sort((a, b) => b.count - a.count)[0] : undefined;

  return (
    <ConsoleShell>
      <AskScope days={days} includeHistory={includeHistory} />
      <PageHeader
        title="Overview"
        purpose="Is Qwikspot turning your online shoppers into store sales? The journey, the results and what to fix."
        action={<AskAction label="Ask how your brand did" question="How did my brand do this week?" />}
      />
      <PeriodControls
        days={days}
        onDays={setDays}
        includeHistory={includeHistory}
        onHistory={setIncludeHistory}
        demoRecords={history}
        demoTip={`These numbers include synthetic demo history (${history} generated records). Choose "Live only" to see only live activity.`}
      >
        {d && (
          <Tip text={`Weekdays and times in store time (${d.period.timezone}).`}>
            <Info size={16} aria-label={`Weekdays and times in store time (${d.period.timezone}).`} />
          </Tip>
        )}
      </PeriodControls>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="bh-top">
        <div className="bh-top__brief">
          <AiBriefCard
            url="/api/brand/assistant/brief"
            title={days === 7 ? 'This week in brief' : 'The last 28 days in brief'}
            days={days}
            includeHistory={includeHistory}
          />
        </div>
        <Card title="Needs your attention" className="bh-attention">
          {!cards ? (
            <Skeleton lines={2} />
          ) : cards.length === 0 ? (
            <p className="bh-attention__empty">
              <CheckCircle2 size={20} aria-hidden="true" /> Nothing needs you right now.
            </p>
          ) : (
            <ul className="bh-attention__list">
              {cards.map((a) => (
                <li key={a.key} className={`bh-alert bh-alert--${a.tone}`}>
                  <span className="bh-alert__icon">{a.icon}</span>
                  <span className="bh-alert__text">{a.text}</span>
                  <Link className="bh-alert__action" to={a.to} aria-label={`${a.action.replace(' →', '')}: ${a.text}`}>
                    {a.action}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {insights.error && <ErrorState message={insights.error} onRetry={insights.reload} />}
      {!d && !insights.error && <Skeleton lines={3} label="Loading results" />}
      {d && (
        <section className="bh-results" aria-label="Results">
          <Card
            title="Shopper journey"
            description="From a shopper's intent on your website to a pickup in store. Each stage opens its list."
            className="bh-journey"
          >
            <JourneyFunnel funnel={d.funnel} />
          </Card>
          <div className="bh-kpis">
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Value of purchases</span>
              <span className="pf-tile__value">
                {tiles.value?.value ?? '—'}
                {tiles.value && <span className="pf-tile__est">est.</span>}
              </span>
              <span className="pf-tile__sub">{tiles.value?.sub ?? 'no recorded value yet'}</span>
            </div>
            <div className="pf-tile pf-tile--lg pf-tile--ring">
              <RingGauge pct={conversionPct} size={52} />
              <div>
                <span className="pf-tile__label">Conversion</span>
                <span className="pf-tile__value pf-tile__value--sm">{tiles.conversion?.value ?? '—'}</span>
                <span className="pf-tile__sub">{tiles.conversion?.sub}</span>
              </div>
            </div>
            <div className="pf-tile pf-tile--lg pf-tile--ring">
              <RingGauge pct={fillPct} size={52} />
              <div>
                <span className="pf-tile__label">Fill rate</span>
                <span className="pf-tile__value pf-tile__value--sm">{fillPct === null ? '—' : `${fillPct}%`}</span>
                <span className="pf-tile__sub">
                  {nearest === 0 ? 'no store lookups yet' : `the nearest store had it ${hadStock} of ${nearest} times`}
                </span>
              </div>
            </div>
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Follow-ups sent</span>
              <span className="pf-tile__value">{d.funnel.follow_ups_sent}</span>
              <span className="pf-tile__sub">to shoppers who left</span>
            </div>
          </div>
        </section>
      )}

      {d && (
        <section className="bh-seeing" aria-labelledby="bh-seeing-title">
          <h2 id="bh-seeing-title" className="bh-section-title">
            What we&apos;re seeing
          </h2>
          <ul className="bh-insights">
            <li className="bh-insight">
              <CalendarDays size={20} aria-hidden="true" className="bh-insight__icon" />
              <p className="reading">{d.weekday.reading.text}</p>
              <AskAboutThis
                label="Ask about the weekday pattern"
                question={`What does this weekday pattern mean for my brand? ${d.weekday.reading.text}`}
              />
            </li>
            {suggestion && (
              <li className="bh-insight">
                <Lightbulb size={20} aria-hidden="true" className="bh-insight__icon bh-insight__icon--warning" />
                <p>
                  <strong>Suggested:</strong> {suggestion.text}{' '}
                  {suggestionStores.map((s) => (
                    <Link key={s.store_id} to={`/brand/network#store-${s.store_id}`}>
                      Open {s.store_name} →
                    </Link>
                  ))}
                </p>
                <AskAboutThis
                  label="Ask about this suggestion"
                  question={`How should I act on this suggestion? ${suggestion.text}`}
                />
              </li>
            )}
            {unmet && (
              <li className="bh-insight">
                <MapPin size={20} aria-hidden="true" className="bh-insight__icon bh-insight__icon--danger" />
                <p>
                  Shoppers in {titleCase(unmet.area)} asked for {unmet.label} {unmet.count} time
                  {unmet.count === 1 ? '' : 's'} on {cap(unmet.weekday)}s and no store had it.
                </p>
                <AskAboutThis
                  label="Ask about unmet demand"
                  question="Where am I missing demand, and what should I do about it?"
                />
              </li>
            )}
          </ul>
          <Link to="/brand/insights" className="small">
            See all insights →
          </Link>
        </section>
      )}

      <SetupChecklist
        connection={connections.data?.connections.find((c) => c.provider === 'SHOPIFY') ?? null}
        catalog={catalog.data}
        stores={stores.data?.stores ?? null}
        syncing={syncing}
        onSync={syncCatalog}
      />
    </ConsoleShell>
  );
}
