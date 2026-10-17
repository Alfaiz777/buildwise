import {
  CheckCircle2,
  Cloud,
  Cpu,
  EyeOff,
  GitCommitHorizontal,
  HelpCircle,
  MessageCircle,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  ScrollText,
  ShoppingBag,
  UserPlus,
  X,
  Activity,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
  Tabs,
  Timeline,
  Tip,
  useToast,
  type TimelineItem,
} from '../../components/ui';
import { label } from '../../lib/labels';
import { formatDateTime } from '../brand/types';
import { AskScope } from '../brand/askQwikspot';
import { ago, AskAction, PageHeader, PeriodControls, plural } from './PlatformChrome';
import {
  ACTION_TEXT,
  FLAG_TEXT,
  pctText,
  REFUSAL_WORDS,
  type AuditEvent,
  type Brand,
  type BrandNetwork,
  type StoreFlag,
  type StoreRow,
} from './platformTypes';

const FLAGS = Object.keys(FLAG_TEXT) as StoreFlag[];
type HealthFilter = StoreFlag | 'HEALTHY' | null;

/** "1 · closing early" tags, one per refusal reason (none: "—"). */
function Refused({ refused }: { refused: Record<string, number> }) {
  const rows = Object.entries(refused).filter(([, n]) => n > 0);
  if (rows.length === 0) return <span className="muted">—</span>;
  return (
    <span className="pf-tags">
      {rows.map(([k, n]) => (
        <span key={k} className="pf-tag">
          {n} · {REFUSAL_WORDS[k] ?? label(k)}
        </span>
      ))}
    </span>
  );
}

/** A health flag as its pill, explaining itself on hover and focus. */
function FlagPill({ flag }: { flag: StoreFlag }) {
  return (
    <Tip text={FLAG_TEXT[flag].explain}>
      <Badge tone="warning">{FLAG_TEXT[flag].label}</Badge>
    </Tip>
  );
}

function StoreTable({ stores }: { stores: StoreRow[] }) {
  if (stores.length === 0) return <p className="muted small">No stores match.</p>;
  // Stores that need attention first.
  const sorted = [...stores].sort((a, b) => Number(b.flags.length > 0) - Number(a.flags.length > 0));
  return (
    <div className="ui-table-wrap pf-store-table">
      <table className="ui-table">
        <thead>
          <tr>
            <th scope="col">Store</th>
            <th scope="col">Store Admin</th>
            <th scope="col">Stock</th>
            <th scope="col" className="is-numeric">
              Holds
            </th>
            <th scope="col" className="is-numeric">
              Picked up
            </th>
            <th scope="col">Refused</th>
            <th scope="col" className="is-numeric">
              Expired
            </th>
            <th scope="col" className="is-numeric">
              Completion
            </th>
            <th scope="col" className="is-numeric">
              Fill rate
            </th>
            <th scope="col">Health</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.store_id} className={s.flags.length ? 'pf-row--flagged' : undefined}>
              <td data-label="Store">
                <strong>{s.store_name}</strong>
                <div className="muted small">
                  {s.city} · {label(s.status)}
                </div>
              </td>
              <td data-label="Store Admin">
                {s.store_admin_provisioned ? (
                  <span className="pf-yes">
                    <CheckCircle2 size={16} aria-hidden="true" />
                    <span className="sr-only">Yes</span>
                  </span>
                ) : (
                  <Badge tone="warning">Not yet</Badge>
                )}
              </td>
              <td data-label="Stock" className="small">
                {s.stock.freshness === 'NONE' ? (
                  <span className="muted">None</span>
                ) : (
                  <Tip text={formatDateTime(s.stock.updated_at)}>
                    {s.stock.freshness === 'FRESH' ? 'Fresh' : 'Stale'} · {ago(s.stock.updated_at)}
                  </Tip>
                )}
              </td>
              <td data-label="Holds" className="is-numeric">
                {s.holds}
              </td>
              <td data-label="Picked up" className="is-numeric">
                {s.completed}
              </td>
              <td data-label="Refused" className="small">
                <Refused refused={s.refused} />
              </td>
              <td data-label="Expired" className="is-numeric">
                {s.expired}
              </td>
              <td data-label="Completion" className="is-numeric">
                {pctText(s.completion_pct)}
              </td>
              <td data-label="Fill rate" className="is-numeric">
                {s.nearest_lookups === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  <>
                    {pctText(s.fill_pct)}
                    <div className="muted small">of {s.nearest_lookups} as nearest</div>
                  </>
                )}
              </td>
              <td data-label="Health">
                {s.flags.length === 0 ? (
                  <Badge tone="success">Healthy</Badge>
                ) : (
                  <ul className="plain pf-flags">
                    {s.flags.map((f) => (
                      <li key={f}>
                        <FlagPill flag={f} />
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

/** "What do the flags mean?" — a small popover; Escape closes it. */
function FlagsHelp() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Closes with its ✕, on Escape, or on a click anywhere outside it.
  useEffect(() => {
    if (!open) return;
    const close = (focusBack: boolean) => {
      setOpen(false);
      if (focusBack) trigger.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(true);
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && close(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  return (
    <div className="pf-popover" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="pf-popover__trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <HelpCircle size={14} aria-hidden="true" /> What do the flags mean?
      </button>
      {open && (
        <div className="pf-popover__panel" role="dialog" aria-label="What the flags mean">
          <div className="pf-popover__head">
            <strong>What the flags mean</strong>
            <button
              type="button"
              className="ui-icon-button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              autoFocus
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <dl className="pf-popover__list">
            {FLAGS.map((f) => (
              <div key={f}>
                <dt>{FLAG_TEXT[f].label}</dt>
                <dd>{FLAG_TEXT[f].explain}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

/**
 * Platform Console → Retail network (docs/11 §3; Change 16, UI-5; UI-P1 layout): one brand's
 * retailers and stores with counts, rates and health flags; health chips filter the stores.
 * Never a customer, a stock line or a Store Admin's identity — only whether one exists.
 */
export function PlatformNetwork() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const [days, setDays] = useState<7 | 28>(7);
  const [includeHistory, setIncludeHistory] = useState(true);
  const [health, setHealth] = useState<HealthFilter>(null);
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
  useEffect(() => setHealth(null), [brandId]);
  const n = network.data;
  const all = n ? [...n.retailers.flatMap((r) => r.stores), ...n.unassigned_stores] : [];
  const flagged = all.filter((s) => s.flags.length > 0).length;
  const shown = (stores: StoreRow[]) =>
    health === null
      ? stores
      : stores.filter((s) => (health === 'HEALTHY' ? s.flags.length === 0 : s.flags.includes(health)));
  const chips: { id: Exclude<HealthFilter, null>; text: string; count: number; tone: 'warning' | 'success' }[] = [
    ...FLAGS.map((f) => ({
      id: f,
      text: FLAG_TEXT[f].label,
      count: all.filter((s) => s.flags.includes(f)).length,
      tone: 'warning' as const,
    })),
    { id: 'HEALTHY', text: 'Healthy', count: all.length - flagged, tone: 'success' },
  ];
  const brandList = brands.data?.brands ?? [];

  return (
    <ConsoleShell>
      <PageHeader
        title="Retail network"
        purpose="Each brand's retailers and stores — counts, rates and health only, never customers or stock lines."
        action={<AskAction label="Ask about this network" question="Which stores need attention, and why?" />}
      />
      <PeriodControls days={days} onDays={setDays} includeHistory={includeHistory} onHistory={setIncludeHistory}>
        {brandList.length > 0 && brandList.length <= 4 ? (
          <Tabs
            label="Brand"
            items={brandList.map((b) => ({ id: b.brand_id, label: b.name }))}
            value={brandId ?? ''}
            onChange={(id) => setParams({ brand: id })}
          />
        ) : (
          <select
            value={brandId ?? ''}
            onChange={(e) => setParams({ brand: e.target.value })}
            aria-label="Brand"
            disabled={!brands.data}
          >
            {brandList.map((b) => (
              <option key={b.brand_id} value={b.brand_id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </PeriodControls>
      <AskScope days={days} includeHistory={includeHistory} />
      {network.error && <ErrorState message={network.error} onRetry={network.reload} />}
      {brands.data?.brands.length === 0 && <EmptyState>No brands yet.</EmptyState>}
      {brandId && !n && !network.error && <Skeleton lines={3} />}
      {n && (
        <div className="pf-health">
          <p className={flagged ? 'pf-health__status pf-health__status--warn' : 'pf-health__status'} role="status">
            {flagged ? `${flagged} of ${all.length} stores need attention.` : `All ${all.length} stores look healthy.`}
          </p>
          <div className="pf-chips" role="group" aria-label="Filter stores by health">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`pf-chip pf-chip--${c.tone}`}
                aria-pressed={health === c.id}
                disabled={c.count === 0}
                onClick={() => setHealth((h) => (h === c.id ? null : c.id))}
              >
                <span className="pf-chip__count">{c.count}</span> {c.text}
              </button>
            ))}
          </div>
          <FlagsHelp />
        </div>
      )}
      {n?.retailers.map((r) => (
        <Card
          key={r.retailer_id}
          title={r.name}
          description={`${plural(r.stores.length, 'store')}${r.status !== 'ACTIVE' ? ` · ${label(r.status)}` : ''}`}
        >
          <StoreTable stores={shown(r.stores)} />
        </Card>
      ))}
      {n && n.unassigned_stores.length > 0 && (
        <Card title="Stores without a retailer">
          <StoreTable stores={shown(n.unassigned_stores)} />
        </Card>
      )}
    </ConsoleShell>
  );
}

const RESULT_TONE = { SUCCESS: 'success', DENIED: 'warning', FAILED: 'danger' } as const;
const ACTION_ICON: Record<string, ReactNode> = {
  BRAND_CREATED: <Plus size={12} />,
  BRAND_ADMIN_PROVISIONED: <UserPlus size={12} />,
  BRAND_SUSPENDED: <PauseCircle size={12} />,
  BRAND_REACTIVATED: <PlayCircle size={12} />,
};
const AUDIT_EXPLAINED =
  'Every platform action is recorded here: creating, provisioning, suspending and reactivating brands, with who did it and why.';

/** Platform Console → Audit: a timeline of platform actions — what, to which brand, by which role, why, the result. */
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
  const items: TimelineItem[] = shown.map((e) => {
    const outcome = e.result ?? 'SUCCESS';
    return {
      id: e.audit_id,
      tone: RESULT_TONE[outcome],
      icon: <span aria-hidden="true">{ACTION_ICON[e.action] ?? <ScrollText size={12} />}</span>,
      title: (
        <span className="pf-audit__title">
          <span>{ACTION_TEXT[e.action] ?? label(e.action)}</span>
          {(e.target_brand_name ?? e.target_brand_id) && (
            <>
              {' · '}
              <span>{e.target_brand_name ?? e.target_brand_id}</span>
            </>
          )}
        </span>
      ),
      time: e.timestamp ? <Tip text={formatDateTime(e.timestamp)}>{ago(e.timestamp)}</Tip> : 'just now',
      detail: (
        <span className="pf-audit__detail">
          <span>by {label(e.actor_role ?? 'SYSTEM')}</span>
          {e.reason_code && <span className="pf-audit__reason">“{e.reason_code}”</span>}
          <Badge tone={RESULT_TONE[outcome]}>{label(outcome)}</Badge>
        </span>
      ),
    };
  });
  return (
    <ConsoleShell>
      <PageHeader
        title="Audit"
        purpose="Every platform action: what was done, to which brand, by which role, why, and the result."
        action={<AskAction label="What changed today?" question="What changed in the audit log today?" />}
      />
      <div className="pf-filters">
        <select value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Filter by brand">
          <option value="">All brands</option>
          {brands.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select value={result} onChange={(e) => setResult(e.target.value)} aria-label="Filter by result">
          <option value="">Any result</option>
          <option value="SUCCESS">Success</option>
          <option value="DENIED">Denied</option>
          <option value="FAILED">Failed</option>
        </select>
      </div>
      <Card>
        {audit.error && <ErrorState message={audit.error} onRetry={audit.reload} />}
        {!audit.data && !audit.error && <Skeleton lines={4} />}
        {audit.data && shown.length === 0 && <EmptyState icon={<ScrollText size={22} />}>{AUDIT_EXPLAINED}</EmptyState>}
        {shown.length > 0 && <Timeline items={items} label="Platform audit" />}
        {shown.length > 0 && shown.length <= 2 && <p className="muted small pf-audit__more">{AUDIT_EXPLAINED}</p>}
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

/** One part of how Qwikspot runs: an icon, a green (production) or amber (fallback / local) dot, words. */
function StatusTile({
  icon,
  name,
  ok,
  title,
  children,
  mono = false,
}: {
  icon: ReactNode;
  name: string;
  ok: boolean;
  title: ReactNode;
  children?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="pf-status">
      <div className="pf-status__head">
        <span className="pf-status__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="pf-status__name">{name}</span>
        <span className={`pf-dot pf-dot--${ok ? 'ok' : 'warn'}`}>
          <span className="sr-only">{ok ? 'production' : 'fallback'}</span>
        </span>
      </div>
      <strong className={mono ? 'pf-status__title mono' : 'pf-status__title'}>{title}</strong>
      {children && <p className="pf-status__desc">{children}</p>}
    </div>
  );
}

/** Platform Console → System: how Qwikspot runs right now, from GET /api/health. */
export function PlatformSystem() {
  const toast = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  // `announce`: a Refresh press says it checked again (the first load does not).
  const load = useCallback(
    (announce = false) => {
      setError(null);
      setChecking(true);
      fetch('/api/health')
        .then((r) => (r.ok ? (r.json() as Promise<Health>) : Promise.reject(new Error(String(r.status)))))
        .then((h) => {
          setHealth(h);
          setCheckedAt(new Date());
          if (announce) toast.show('Health check refreshed.');
        })
        .catch(() => setError('The backend health check did not answer.'))
        .finally(() => setChecking(false));
    },
    [toast],
  );
  useEffect(() => load(), [load]);
  const a = health?.adapters;
  const whatsapp = a?.channels.includes('WHATSAPP');
  const gemini = a?.agent_runtime === 'GEMINI';
  const shopify = a?.commerce === 'SHOPIFY';
  const cloud = health?.profile !== 'local';
  return (
    <ConsoleShell>
      <PageHeader
        title="System"
        purpose="How Qwikspot runs right now, read from the backend's health check. No secrets are shown."
        action={
          <Button
            variant="brand"
            icon={<RefreshCw size={16} aria-hidden="true" />}
            loading={checking}
            onClick={() => load(true)}
          >
            Refresh
          </Button>
        }
      />
      {checkedAt && (
        <p className="muted small pf-checked" role="status">
          {checking ? 'Checking…' : `Checked at ${checkedAt.toLocaleTimeString('en-GB')}`}
        </p>
      )}
      {error && <ErrorState message={error} onRetry={() => load(true)} />}
      {!health && !error && <Skeleton lines={4} />}
      {health && (
        <section className={`pf-status-grid${checking ? ' is-checking' : ''}`} aria-label="How Qwikspot runs">
          <StatusTile
            icon={<Activity size={18} />}
            name="Status"
            ok={health.status === 'ok'}
            title={health.status === 'ok' ? 'Running' : health.status}
          />
          <StatusTile
            icon={<Cloud size={18} />}
            name="Hosting"
            ok={cloud}
            title={cloud ? 'Google Cloud · Cloud Run + Firestore' : 'This computer (local profile)'}
          >
            {cloud ? `Profile ${health.profile}.` : 'emulators and synthetic data on this machine.'}
          </StatusTile>
          <StatusTile icon={<Cpu size={18} />} name="AI" ok={gemini} title={gemini ? 'Gemini (Vertex AI)' : 'Mock AI'}>
            {gemini
              ? 'Gemini on Vertex AI decides; safety checks run on every reply.'
              : 'deterministic rules use the same tools and safety checks Gemini will use.'}
          </StatusTile>
          <StatusTile
            icon={<MessageCircle size={18} />}
            name="Customer channel"
            ok={Boolean(whatsapp)}
            title={whatsapp ? 'WhatsApp' : 'Simulator'}
          >
            {whatsapp
              ? 'with the simulator as the fallback.'
              : "the shopper demo's chat; WhatsApp when it is connected."}
          </StatusTile>
          <StatusTile
            icon={<ShoppingBag size={18} />}
            name="Commerce"
            ok={shopify}
            title={shopify ? 'Shopify' : 'Mock catalogue'}
          >
            {shopify
              ? "catalogue and orders from the brand's store."
              : 'a synthetic Shopify-shaped catalogue; Shopify when connected.'}
          </StatusTile>
          <StatusTile
            icon={<GitCommitHorizontal size={18} />}
            name="Version"
            ok
            mono
            title={`${health.version}${health.commit ? ` · ${health.commit}` : ''}`}
          />
        </section>
      )}
      <Card className="pf-never" title="What this console can never see">
        <ul className="pf-never__list">
          {["Shoppers' names", 'Phone numbers', 'Messages', 'Pickup codes', 'Per-store stock lines'].map((x) => (
            <li key={x}>
              <EyeOff size={16} aria-hidden="true" /> {x}
            </li>
          ))}
        </ul>
        <p className="small muted">
          The platform sees totals and health only, enforced by the backend, not just hidden in the UI.
        </p>
      </Card>
    </ConsoleShell>
  );
}
