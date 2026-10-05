import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { Badge, Card, EmptyState, ErrorState, Skeleton } from '../../components/ui';
import { label } from '../../lib/labels';
import { formatDateTime } from '../brand/types';
import { PeriodControls } from './PlatformHome';
import {
  ACTION_TEXT,
  FLAG_TEXT,
  pctText,
  REFUSAL_WORDS,
  type AuditEvent,
  type Brand,
  type BrandNetwork,
  type StoreRow,
} from './platformTypes';

const refusalText = (r: Record<string, number>) =>
  Object.entries(r)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${REFUSAL_WORDS[k] ?? k} ${n}`)
    .join(', ') || '—';

function StoreTable({ stores }: { stores: StoreRow[] }) {
  if (stores.length === 0) return <p className="muted small">No stores yet.</p>;
  return (
    <div className="ui-table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Store</th>
            <th scope="col">Store Admin</th>
            <th scope="col">Stock</th>
            <th scope="col">Holds</th>
            <th scope="col">Picked up</th>
            <th scope="col">Refused</th>
            <th scope="col">Expired</th>
            <th scope="col">Completion</th>
            <th scope="col">Fill rate</th>
            <th scope="col">Health</th>
          </tr>
        </thead>
        <tbody>
          {stores.map((s) => (
            <tr key={s.store_id}>
              <td>
                {s.store_name}
                <div className="muted small">
                  {s.city} · {label(s.status)}
                </div>
              </td>
              <td>{s.store_admin_provisioned ? 'Yes' : <span className="muted">Not yet</span>}</td>
              <td className="small">
                {s.stock.freshness === 'NONE'
                  ? 'None'
                  : `${s.stock.freshness === 'FRESH' ? 'Fresh' : 'Stale'} · ${formatDateTime(s.stock.updated_at)}`}
              </td>
              <td>{s.holds}</td>
              <td>{s.completed}</td>
              <td className="small">{refusalText(s.refused)}</td>
              <td>{s.expired}</td>
              <td>{pctText(s.completion_pct)}</td>
              <td>
                {pctText(s.fill_pct)}
                <div className="muted small">of {s.nearest_lookups} as nearest</div>
              </td>
              <td>
                {s.flags.length === 0 ? (
                  <Badge tone="success">Healthy</Badge>
                ) : (
                  <ul className="plain flags">
                    {s.flags.map((f) => (
                      <li key={f} title={FLAG_TEXT[f].explain}>
                        <Badge tone="warning">{FLAG_TEXT[f].label}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Platform Console → Retail network (docs/11 §3; Change 16, UI-5): one brand's retailers
 * and stores with counts, rates and health flags. Never a customer, a stock line or a
 * Store Admin's identity — only whether one exists.
 */
export function PlatformNetwork() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const [days, setDays] = useState<7 | 28>(7);
  const [includeHistory, setIncludeHistory] = useState(true);
  const brands = useLoad(useCallback(() => api.get<{ brands: Brand[] }>('/api/platform/brands'), [api]));
  // Opens on the brand with the most stores unless one was chosen (e.g. from "N stores flagged").
  const biggest = [...(brands.data?.brands ?? [])].sort(
    (a, b) => (b.onboarding?.stores.total ?? 0) - (a.onboarding?.stores.total ?? 0),
  )[0];
  const brandId = params.get('brand') ?? biggest?.brand_id ?? null;
  const network = useLoad(
    useCallback(
      () =>
        brandId
          ? api.get<BrandNetwork>(
              `/api/platform/brands/${encodeURIComponent(brandId)}/network?days=${days}&include_history=${includeHistory}`,
            )
          : Promise.resolve(null),
      [api, brandId, days, includeHistory],
    ),
  );
  const n = network.data;
  const all = n ? [...n.retailers.flatMap((r) => r.stores), ...n.unassigned_stores] : [];
  const flagged = all.filter((s) => s.flags.length > 0).length;

  return (
    <ConsoleShell>
      <Card
        title="Retail network"
        description="Each brand's retailers and stores — counts, rates and health only. Never customers or stock lines."
      >
        <div className="overview-head">
          <label className="small">
            Brand{' '}
            <select
              value={brandId ?? ''}
              onChange={(e) => setParams({ brand: e.target.value })}
              aria-label="Brand"
              disabled={!brands.data}
            >
              {brands.data?.brands.map((b) => (
                <option key={b.brand_id} value={b.brand_id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <PeriodControls days={days} onDays={setDays} includeHistory={includeHistory} onHistory={setIncludeHistory} />
        {network.error && <ErrorState message={network.error} onRetry={network.reload} />}
        {brands.data?.brands.length === 0 && <EmptyState>No brands yet.</EmptyState>}
        {brandId && !n && !network.error && <Skeleton lines={3} />}
        {n && (
          <p className={flagged ? 'notice small' : 'muted small'} role="status">
            {flagged ? `${flagged} of ${all.length} stores need attention.` : `All ${all.length} stores look healthy.`}
          </p>
        )}
      </Card>
      {n?.retailers.map((r) => (
        <Card key={r.retailer_id} title={r.name} description={r.status !== 'ACTIVE' ? label(r.status) : undefined}>
          <StoreTable stores={r.stores} />
        </Card>
      ))}
      {n && n.unassigned_stores.length > 0 && (
        <Card title="Stores without a retailer">
          <StoreTable stores={n.unassigned_stores} />
        </Card>
      )}
      {n && (
        <Card title="What the flags mean">
          <dl className="settings-list">
            {Object.values(FLAG_TEXT).map((f) => (
              <div key={f.label} className="contents">
                <dt>{f.label}</dt>
                <dd>{f.explain}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}
    </ConsoleShell>
  );
}

const RESULT_TONE = { SUCCESS: 'success', DENIED: 'warning', FAILED: 'danger' } as const;

/** Platform Console → Audit: brand names, who (role), what, why and the result. */
export function PlatformAudit() {
  const api = useApi();
  const audit = useLoad(useCallback(() => api.get<{ events: AuditEvent[] }>('/api/platform/audit?limit=200'), [api]));
  const [brand, setBrand] = useState('');
  const [result, setResult] = useState('');
  const events = audit.data?.events ?? [];
  const brands = useMemo(
    () => [
      ...new Map(
        events
          .filter((e) => e.target_brand_id)
          .map((e) => [e.target_brand_id!, e.target_brand_name ?? e.target_brand_id!]),
      ).entries(),
    ],
    [events],
  );
  const shown = events.filter(
    (e) => (!brand || e.target_brand_id === brand) && (!result || (e.result ?? 'SUCCESS') === result),
  );
  return (
    <ConsoleShell>
      <Card
        title="Audit"
        description="Every platform action: who did it (by role), to which brand, why, and the result."
      >
        <div className="overview-head">
          <label className="small">
            Brand{' '}
            <select value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Filter by brand">
              <option value="">All brands</option>
              {brands.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="small">
            Result{' '}
            <select value={result} onChange={(e) => setResult(e.target.value)} aria-label="Filter by result">
              <option value="">Any result</option>
              <option value="SUCCESS">Success</option>
              <option value="DENIED">Denied</option>
              <option value="FAILED">Failed</option>
            </select>
          </label>
        </div>
        {audit.error && <ErrorState message={audit.error} onRetry={audit.reload} />}
        {!audit.data && !audit.error && <Skeleton lines={4} />}
        {audit.data && shown.length === 0 && <EmptyState>No platform actions yet.</EmptyState>}
        {shown.length > 0 && (
          <div className="ui-table-wrap">
            <table aria-label="Platform audit">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Brand</th>
                  <th scope="col">Action</th>
                  <th scope="col">By</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.audit_id}>
                    <td className="small">{e.timestamp ? formatDateTime(e.timestamp) : 'just now'}</td>
                    <td>{e.target_brand_name ?? e.target_brand_id ?? '—'}</td>
                    <td>{ACTION_TEXT[e.action] ?? label(e.action)}</td>
                    <td>{label(e.actor_role ?? 'SYSTEM')}</td>
                    <td className="small">{e.reason_code ?? '—'}</td>
                    <td>
                      <Badge tone={RESULT_TONE[e.result ?? 'SUCCESS']}>{label(e.result ?? 'SUCCESS')}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </ConsoleShell>
  );
}

interface Health {
  status: string;
  version: string;
  commit: string | null;
  profile: string;
  adapters?: { agent_runtime: 'MOCK' | 'GEMINI'; channels: string[]; commerce: 'MOCK' | 'SHOPIFY' };
}

/** Platform Console → System: how Qwikspot runs right now, from GET /api/health. */
export function PlatformSystem() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    fetch('/api/health')
      .then((r) => (r.ok ? (r.json() as Promise<Health>) : Promise.reject(new Error(String(r.status)))))
      .then(setHealth)
      .catch(() => setError('The backend health check did not answer.'));
  }, []);
  useEffect(load, [load]);
  const a = health?.adapters;
  const whatsapp = a?.channels.includes('WHATSAPP');
  return (
    <ConsoleShell>
      <Card title="How Qwikspot runs today" description="Read from the backend's health check. No secrets are shown.">
        {error && <ErrorState message={error} onRetry={load} />}
        {!health && !error && <Skeleton lines={4} />}
        {health && (
          <dl className="settings-list">
            <dt>Status</dt>
            <dd>
              <Badge tone={health.status === 'ok' ? 'success' : 'danger'}>
                {health.status === 'ok' ? 'Running' : health.status}
              </Badge>
            </dd>
            <dt>Profile</dt>
            <dd>
              <strong>{health.profile}</strong> —{' '}
              {health.profile === 'local'
                ? 'emulators and synthetic data on this machine.'
                : 'Google Cloud (Cloud Run, Firestore).'}
            </dd>
            <dt>AI runtime</dt>
            <dd>
              {a?.agent_runtime === 'GEMINI' ? (
                <>
                  <strong>Gemini</strong> — the agent decides with Gemini; the deterministic safety checks still run.
                </>
              ) : (
                <>
                  <strong>Mock AI</strong> — deterministic rules use the same tools and safety checks Gemini will use.
                </>
              )}
            </dd>
            <dt>Customer channel</dt>
            <dd>
              {whatsapp ? (
                <>
                  <strong>WhatsApp</strong> (with the simulator as the fallback).
                </>
              ) : (
                <>
                  <strong>Simulator</strong> — the shopper demo's chat; WhatsApp when it is connected.
                </>
              )}
            </dd>
            <dt>Commerce</dt>
            <dd>
              {a?.commerce === 'SHOPIFY' ? (
                <>
                  <strong>Shopify</strong> — catalogue and orders from the brand's store.
                </>
              ) : (
                <>
                  <strong>Mock catalogue</strong> — a synthetic Shopify-shaped catalogue; Shopify when connected.
                </>
              )}
            </dd>
            <dt>Version</dt>
            <dd className="mono">
              {health.version}
              {health.commit ? ` · ${health.commit}` : ''}
            </dd>
          </dl>
        )}
      </Card>
    </ConsoleShell>
  );
}
