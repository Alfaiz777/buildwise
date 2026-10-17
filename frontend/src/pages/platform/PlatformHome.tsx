import { AlertTriangle, ArrowRight, CheckCircle2, OctagonAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { Card, ErrorState, MiniFunnel, ProgressBar, RingGauge, Skeleton } from '../../components/ui';
import { AiBriefCard } from '../brand/AiCards';
import { AskScope } from '../brand/askQwikspot';
import { formatPrice } from '../brand/types';
import { PLATFORM_BRIEF_PATH } from './platformAsk';
import { PageHeader, PeriodControls, plural } from './PlatformChrome';
import { nextStep, pctText, type Brand, type NetworkResponse } from './platformTypes';

export { PeriodControls } from './PlatformChrome';

interface AttentionItem {
  brand: Brand;
  step: string;
  flagged: number;
  /** Red when the brand is blocked (suspended, catalogue sync failed); amber otherwise. */
  blocked: boolean;
}

/** One brand that needs the team's attention, as a card with its one next move. */
function AttentionCard({ item }: { item: AttentionItem }) {
  const { brand, step, flagged, blocked } = item;
  const Icon = blocked ? OctagonAlert : AlertTriangle;
  return (
    <li className={`pf-attention pf-attention--${blocked ? 'danger' : 'warning'}`}>
      <Icon size={18} aria-hidden="true" className="pf-attention__icon" />
      <div className="pf-attention__body">
        <strong>{brand.name}</strong>
        {step !== 'Live.' && <span className="pf-attention__problem">{step}</span>}
        {flagged > 0 && (
          <span className="pf-attention__problem">{plural(flagged, 'store is', 'stores are')} flagged.</span>
        )}
      </div>
      {flagged > 0 ? (
        <Link
          className="ui-button ui-button--secondary ui-button--sm"
          to={`/platform/network?brand=${encodeURIComponent(brand.brand_id)}`}
        >
          Review stores <ArrowRight size={14} aria-hidden="true" />
        </Link>
      ) : (
        <Link
          className="ui-button ui-button--secondary ui-button--sm"
          to={`/platform/brands#brand-${encodeURIComponent(brand.brand_id)}`}
        >
          Open brand <ArrowRight size={14} aria-hidden="true" />
        </Link>
      )}
    </li>
  );
}

/**
 * Platform Console → Overview (docs/11 §3; Change 16, UI-5; UI-P1 layout): what needs the
 * team first ("Network today" and the brands needing attention), then the headline numbers
 * across every brand, then the rates — aggregates only, never a customer. Each tile is
 * defined in docs/11 §3.
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
  const attention: AttentionItem[] = (brands.data?.brands ?? [])
    .map((b) => ({
      brand: b,
      step: nextStep(b),
      flagged: d?.brands.find((x) => x.brand_id === b.brand_id)?.stores_flagged ?? 0,
      blocked: b.status === 'SUSPENDED' || Boolean(b.onboarding?.catalog.failed),
    }))
    .filter((x) => x.step !== 'Live.' || x.flagged > 0)
    .sort((a, b) => Number(b.blocked) - Number(a.blocked));

  // "Start with what needs attention →" (the welcome strip) lands here.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#attention' && brands.data)
      document.getElementById('attention')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [hash, brands.data]);

  return (
    <ConsoleShell>
      <PageHeader
        title="Overview"
        purpose="How every brand on Qwikspot is doing — totals and health, never a customer."
        action={
          <Link className="ui-button ui-button--primary" to="/platform/brands">
            Manage brands
          </Link>
        }
      />
      <PeriodControls
        days={days}
        onDays={setDays}
        includeHistory={includeHistory}
        onHistory={setIncludeHistory}
        demoRecords={d?.demo_history.included ? d.demo_history.records : 0}
      />
      <AskScope days={days} includeHistory={includeHistory} />

      {/* Above the fold: what the network did, and who needs the team. */}
      <div className="pf-top-row">
        {t && (
          <AiBriefCard url={PLATFORM_BRIEF_PATH} title="Network today" days={days} includeHistory={includeHistory} />
        )}
        <Card id="attention" title="Needs attention" className="pf-attention-card">
          {!brands.data ? (
            <Skeleton lines={2} />
          ) : attention.length === 0 ? (
            <p className="pf-attention-empty">
              <CheckCircle2 size={18} aria-hidden="true" /> Every brand is live and no store is flagged.
            </p>
          ) : (
            <ul className="pf-attention-list">
              {attention.map((item) => (
                <AttentionCard key={item.brand.brand_id} item={item} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      {network.error && <ErrorState message={network.error} onRetry={network.reload} />}
      {!t && !network.error && <Skeleton lines={2} label="Loading results" />}
      {t && (
        <section className="pf-tiles" aria-label="Across all brands">
          <div className="pf-tiles__headline">
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Active brands</span>
              <span className="pf-tile__value">{t.brands_active}</span>
              <span className="pf-tile__sub">{plural(t.retailers, 'retailer')}</span>
            </div>
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Stores live</span>
              <span className="pf-tile__value">
                {t.stores_live} <span className="pf-tile__of">of {t.stores_total}</span>
              </span>
              <ProgressBar value={t.stores_live} max={t.stores_total} />
            </div>
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Holds → Store pickups</span>
              <span className="pf-tile__value">
                {t.holds} <span className="pf-tile__arrow">→</span> {t.pickups}
              </span>
              <MiniFunnel from={t.holds} to={t.pickups} />
              <span className="pf-tile__sub">reserved at a store → collected (offline sales)</span>
            </div>
            <div className="pf-tile pf-tile--lg">
              <span className="pf-tile__label">Offline sales value</span>
              <span className="pf-tile__value">
                {formatPrice(t.offline_value.amount, t.offline_value.currency)}
                <span className="pf-tile__est">est.</span>
              </span>
              <span className="pf-tile__sub">quantity × store price</span>
            </div>
          </div>
          <div className="pf-tiles__secondary">
            <div className="pf-tile pf-tile--ring">
              <RingGauge pct={t.completion_pct} />
              <div>
                <span className="pf-tile__label">Completion</span>
                <span className="pf-tile__value pf-tile__value--sm">{pctText(t.completion_pct)}</span>
                <span className="pf-tile__sub">of finished holds</span>
              </div>
            </div>
            <div className="pf-tile pf-tile--ring">
              <RingGauge pct={t.fill_pct} />
              <div>
                <span className="pf-tile__label">Fill rate</span>
                <span className="pf-tile__value pf-tile__value--sm">{pctText(t.fill_pct)}</span>
                <span className="pf-tile__sub">nearest store had stock</span>
              </div>
            </div>
            <div className="pf-tile">
              <span className="pf-tile__label">Attributed online orders</span>
              <span className="pf-tile__value pf-tile__value--sm">{t.online_orders}</span>
              <span className="pf-tile__sub">{formatPrice(t.online_value.amount, t.online_value.currency)} est.</span>
            </div>
            <div className="pf-tile">
              <span className="pf-tile__label">Unmet demand</span>
              <span className="pf-tile__value pf-tile__value--sm">{t.unmet_demand}</span>
              <span className="pf-tile__sub">lookups no store could serve</span>
            </div>
            <div className="pf-tile">
              <span className="pf-tile__label">Follow-ups sent</span>
              <span className="pf-tile__value pf-tile__value--sm">{t.follow_ups_sent}</span>
              <span className="pf-tile__sub">proactive messages</span>
            </div>
          </div>
        </section>
      )}
    </ConsoleShell>
  );
}
