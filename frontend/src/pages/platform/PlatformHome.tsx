import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { Card, ErrorState, KpiTile, Skeleton } from '../../components/ui';
import { formatPrice } from '../brand/types';
import { nextStep, pctText, type Brand, type NetworkResponse } from './platformTypes';

/** Period and synthetic-history controls shared by the platform's aggregate pages. */
export function PeriodControls(props: {
  days: 7 | 28;
  onDays: (d: 7 | 28) => void;
  includeHistory: boolean;
  onHistory: (v: boolean) => void;
}) {
  return (
    <div className="overview-head">
      <div className="filters" role="group" aria-label="Period">
        {([7, 28] as const).map((n) => (
          <button
            key={n}
            type="button"
            className={props.days === n ? '' : 'secondary'}
            aria-pressed={props.days === n}
            onClick={() => props.onDays(n)}
          >
            Last {n} days
          </button>
        ))}
      </div>
      <label className="small">
        <input type="checkbox" checked={props.includeHistory} onChange={(e) => props.onHistory(e.target.checked)} />{' '}
        Include synthetic history
      </label>
    </div>
  );
}

/**
 * Platform Console → Overview (docs/11 §3; Change 16, UI-5): what Qwikspot achieves across
 * every brand, as aggregates — never a customer. Each tile is defined in docs/11 §3.
 */
export function PlatformHome() {
  const api = useApi();
  const [days, setDays] = useState<7 | 28>(7);
  const [includeHistory, setIncludeHistory] = useState(true);
  const network = useLoad(
    useCallback(
      () => api.get<NetworkResponse>(`/api/platform/network?days=${days}&include_history=${includeHistory}`),
      [api, days, includeHistory],
    ),
  );
  const brands = useLoad(useCallback(() => api.get<{ brands: Brand[] }>('/api/platform/brands'), [api]));
  const d = network.data;
  const t = d?.totals;
  const synthetic = !!d && d.demo_history.included && d.demo_history.records > 0;
  const attention = (brands.data?.brands ?? [])
    .map((b) => ({
      brand: b,
      step: nextStep(b),
      flagged: d?.brands.find((x) => x.brand_id === b.brand_id)?.stores_flagged ?? 0,
    }))
    .filter((x) => x.step !== 'Live.' || x.flagged > 0);

  return (
    <ConsoleShell>
      <PeriodControls days={days} onDays={setDays} includeHistory={includeHistory} onHistory={setIncludeHistory} />
      {network.error && <ErrorState message={network.error} onRetry={network.reload} />}
      {!t && !network.error && <Skeleton lines={2} label="Loading results" />}
      {t && (
        <section className="kpi-grid" aria-label="Across all brands">
          <KpiTile label="Active brands" value={t.brands_active} sub={`${t.retailers} retailers`} />
          <KpiTile label="Stores live" value={t.stores_live} sub={`of ${t.stores_total} stores`} />
          <KpiTile label="Holds" value={t.holds} sub="reserved at a store" synthetic={synthetic} />
          <KpiTile label="Store pickups" value={t.pickups} sub="offline sales" synthetic={synthetic} />
          <KpiTile
            label="Offline sales value"
            value={formatPrice(t.offline_value.amount, t.offline_value.currency)}
            sub="quantity × store price"
            estimated
            synthetic={synthetic}
          />
          <KpiTile
            label="Attributed online orders"
            value={t.online_orders}
            sub={`${formatPrice(t.online_value.amount, t.online_value.currency)} est.`}
            synthetic={synthetic}
          />
          <KpiTile label="Completion" value={pctText(t.completion_pct)} sub="of finished holds" synthetic={synthetic} />
          <KpiTile label="Fill rate" value={pctText(t.fill_pct)} sub="nearest store had stock" synthetic={synthetic} />
          <KpiTile
            label="Unmet demand"
            value={t.unmet_demand}
            sub="lookups no store could serve"
            synthetic={synthetic}
          />
          <KpiTile label="Follow-ups sent" value={t.follow_ups_sent} synthetic={synthetic} />
        </section>
      )}
      {synthetic && (
        <p className="muted small">
          Includes synthetic demo history ({d!.demo_history.records} generated records). Untick to see only live
          activity. Counts only — the platform never sees customers.
        </p>
      )}

      <Card title="Brands needing attention">
        {!brands.data ? (
          <Skeleton lines={2} />
        ) : attention.length === 0 ? (
          <p className="attention-empty">
            <CheckCircle2 size={18} aria-hidden="true" /> Every brand is live and no store is flagged.
          </p>
        ) : (
          <ul className="attention-list">
            {attention.map(({ brand, step, flagged }) => (
              <li key={brand.brand_id} className="attention attention--warning">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>
                  <strong>{brand.name}</strong>
                  {step !== 'Live.' && <> — {step} </>}
                  {flagged > 0 && (
                    <>
                      {' '}
                      <Link to={`/platform/network?brand=${encodeURIComponent(brand.brand_id)}`}>
                        {flagged} store{flagged === 1 ? '' : 's'} flagged →
                      </Link>
                    </>
                  )}
                  {step !== 'Live.' && flagged === 0 && <Link to="/platform/brands">Open brands →</Link>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </ConsoleShell>
  );
}
