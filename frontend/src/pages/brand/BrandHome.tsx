import { AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, errorMessage, useLoad } from '../../components/ConsoleShell';
import { Card, ErrorState, KpiTile, Skeleton, useToast } from '../../components/ui';
import type { ConversationRow, ReservationRow } from './conversationTypes';
import { DemoGuide } from './DemoGuide';
import { storesNamedIn, type InsightsResponse } from './InsightsPage';
import { attentionItems, kpis } from './overview';
import type { BrandSettings } from './SettingsPage';
import { SetupChecklist } from './SetupChecklist';
import type { BrandStore, CatalogResponse, Connection } from './types';

/**
 * Brand Console → Overview (docs/11 §4; Change 16, UI-3; audit P0-1): results first. KPI
 * tiles from the insights numbers, what needs the brand's attention now, the weekday
 * reading and the top suggestion, the demo guide (demo brand only) and a collapsible
 * setup card that closes itself once everything is done.
 */
export function BrandHome() {
  const me = useMe();
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
  const suggestion = d?.suggestions[0] ?? null;
  const suggestionStores = suggestion ? storesNamedIn(suggestion.text, stores.data?.stores ?? []) : [];

  return (
    <ConsoleShell>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="overview-head">
        <div className="filters" role="group" aria-label="Period">
          {([7, 28] as const).map((n) => (
            <button
              key={n}
              type="button"
              className={days === n ? '' : 'secondary'}
              aria-pressed={days === n}
              onClick={() => setDays(n)}
            >
              Last {n} days
            </button>
          ))}
        </div>
        <label className="small">
          <input type="checkbox" checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} />{' '}
          Include synthetic history
        </label>
        {d && <span className="muted small">Weekdays and times in store time ({d.period.timezone}).</span>}
      </div>

      {insights.error && <ErrorState message={insights.error} onRetry={insights.reload} />}
      {!d && !insights.error && <Skeleton lines={2} label="Loading results" />}
      {d && (
        <section className="kpi-grid" aria-label="Results">
          {kpis(d).map((k) => (
            <KpiTile
              key={k.key}
              label={k.label}
              value={k.value}
              sub={k.sub}
              estimated={k.estimated}
              synthetic={history > 0}
            />
          ))}
        </section>
      )}
      {history > 0 && (
        <p className="muted small">
          These numbers include synthetic demo history ({history} generated records). Untick "Include synthetic history"
          to see only live activity.
        </p>
      )}

      <div className="overview-grid">
        <Card title="Needs your attention">
          {!attention ? (
            <Skeleton lines={2} />
          ) : attention.length === 0 ? (
            <p className="attention-empty">
              <CheckCircle2 size={18} aria-hidden="true" /> Nothing needs you right now.
            </p>
          ) : (
            <ul className="attention-list">
              {attention.map((a) => (
                <li key={a.key} className={`attention attention--${a.tone}`}>
                  <AlertTriangle size={16} aria-hidden="true" />
                  <Link to={a.to}>{a.text}</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="What we're seeing">
          {d ? (
            <>
              <p className="reading">{d.weekday.reading.text}</p>
              {suggestion && (
                <p className="small">
                  <strong>Suggested:</strong> {suggestion.text}{' '}
                  {suggestionStores.map((s) => (
                    <Link key={s.store_id} to={`/brand/network#store-${s.store_id}`}>
                      Open {s.store_name} →
                    </Link>
                  ))}
                </p>
              )}
              <Link to="/brand/insights" className="small">
                See insights <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </>
          ) : (
            <Skeleton lines={2} />
          )}
        </Card>
      </div>

      {me.scope === 'BRAND' && <DemoGuide brandId={me.brand_id} />}

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
