import { ArrowRight, CheckCircle2, Circle, Clock, Copy, Plus, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApi, type ProvisionedUser } from '../../api/apiContext';
import { ConsoleShell, errorMessage, useLoad } from '../../components/ConsoleShell';
import {
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  Menu,
  Skeleton,
  StatusPill,
  Tip,
  useToast,
} from '../../components/ui';
import { label } from '../../lib/labels';
import { formatDateTime } from '../brand/types';
import { ago, PageHeader, plural } from './PlatformChrome';
import { nextStep, pctText, type Brand, type NetworkResponse, type Onboarding } from './platformTypes';

interface Step {
  name: string;
  /** done ✓ green, todo ○ amber, failed ✕ red */
  state: 'done' | 'todo' | 'failed';
  count: string;
  detail: string;
}

/** The onboarding checklist as six steps (counts only, never customer data); same rules as before. */
function stepsOf(o: Onboarding): Step[] {
  const r = o.retail_admins;
  const sku = o.sku_mapping;
  return [
    {
      name: 'Brand Admin',
      state: o.brand_admin_provisioned ? 'done' : 'todo',
      count: o.brand_admin_provisioned ? 'Provisioned' : 'Not yet',
      detail: o.brand_admin_provisioned
        ? 'The brand has its admin.'
        : 'No Brand Admin yet — the platform provisions one.',
    },
    {
      name: 'Catalogue',
      state: o.catalog.failed ? 'failed' : o.catalog.synced ? 'done' : 'todo',
      count: o.catalog.failed ? 'Sync failed' : o.catalog.synced ? `${o.catalog.product_count} products` : 'Not synced',
      detail: o.catalog.failed
        ? 'The last catalogue sync failed.'
        : o.catalog.synced
          ? `Synced${o.catalog.last_sync_at ? ` ${formatDateTime(o.catalog.last_sync_at)}` : ''}.`
          : 'The brand has not synced its catalogue yet.',
    },
    {
      name: 'Stores with stock',
      state: o.stores.with_stock > 0 ? 'done' : 'todo',
      count: `${o.stores.with_stock} of ${o.stores.total}`,
      detail: `${o.stores.with_stock} of ${o.stores.total} stores have stock uploaded.`,
    },
    {
      name: 'SKU mapping',
      state: sku.auto_matched > 0 && sku.needs_attention === 0 ? 'done' : 'todo',
      count: sku.needs_attention > 0 ? `${sku.needs_attention} to fix` : `${sku.auto_matched} matched`,
      detail: `${sku.auto_matched} matched, ${sku.needs_attention} need attention.`,
    },
    {
      name: 'Retail Admins',
      state: r.stores_with_retailer > 0 && r.provisioned === r.stores_with_retailer ? 'done' : 'todo',
      count: `${r.provisioned} of ${r.stores_with_retailer}`,
      detail: `Store Admins for ${r.provisioned} of ${r.stores_with_retailer} stores with a retailer.`,
    },
    {
      name: 'Channel',
      state: o.channel.whatsapp_number_configured || o.channel.simulator ? 'done' : 'todo',
      count: o.channel.whatsapp_number_configured ? 'WhatsApp' : 'Simulator',
      detail: o.channel.whatsapp_number_configured ? 'WhatsApp number set, simulator' : 'simulator only',
    },
  ];
}

const STEP_ICON = { done: CheckCircle2, todo: Circle, failed: XCircle } as const;
const STEP_WORD = { done: 'done', todo: 'to do', failed: 'failed' } as const;

function Stepper({ o }: { o: Onboarding }) {
  return (
    <ol className="pf-stepper" aria-label="Onboarding">
      {stepsOf(o).map((s) => {
        const Icon = STEP_ICON[s.state];
        return (
          <li key={s.name} className={`pf-step pf-step--${s.state}`}>
            <Tip text={s.detail}>
              <Icon size={18} aria-hidden="true" className="pf-step__icon" />
              <span className="pf-step__text">
                <span className="pf-step__name">{s.name}</span>
                <span className="pf-step__count">{s.count}</span>
              </span>
              <span className="sr-only"> ({STEP_WORD[s.state]})</span>
            </Tip>
          </li>
        );
      })}
    </ol>
  );
}

/** The provisioning result with its hand-over link and a Copy button. */
function ProvisionedNotice({ result }: { result: ProvisionedUser | null }) {
  const toast = useToast();
  if (!result) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.password_setup_link);
      toast.show('Setup link copied.');
    } catch {
      toast.show('Copy failed — select the link and copy it.', 'error');
    }
  };
  return (
    <div className="notice" role="status">
      Provisioned <strong>{result.email}</strong> as {label(result.role)}. Hand over this password-setup link:
      <code className="link">{result.password_setup_link}</code>
      <button type="button" className="secondary" onClick={() => void copy()}>
        <Copy size={14} aria-hidden="true" /> Copy link
      </button>
    </div>
  );
}

/** "Waiting for the brand to …" → "Waiting for AquaSkin to …". */
const personal = (step: string, name: string) => step.replace(/\bthe brand\b/, name);

function BrandCard({
  brand,
  row,
  onSuspend,
  onReactivate,
  onProvision,
}: {
  brand: Brand;
  row: NetworkResponse['brands'][number] | null;
  onSuspend: () => void;
  onReactivate: () => void;
  onProvision: (email: string) => Promise<ProvisionedUser | null>;
}) {
  const step = nextStep(brand);
  const [provisioning, setProvisioning] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProvisionedUser | null>(null);
  const canProvision = !brand.brand_admin_user_id && step === 'Provision its Brand Admin.';

  const provision = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const done = await onProvision(email);
    setBusy(false);
    if (done) {
      setResult(done);
      setEmail('');
      setProvisioning(false);
    }
  };

  return (
    <article className="pf-brand ui-card ui-card--padded" aria-label={brand.name} id={`brand-${brand.brand_id}`}>
      <header className="pf-brand__head">
        <div className="pf-brand__title">
          <h2>{brand.name}</h2>
          <StatusPill status={brand.status} />
          {brand.last_activity_at ? (
            <Tip text={formatDateTime(brand.last_activity_at)}>
              <span className="muted small">Last activity {ago(brand.last_activity_at)}</span>
            </Tip>
          ) : (
            <span className="muted small">No activity yet</span>
          )}
        </div>
        <Menu
          label={`More actions for ${brand.name}`}
          items={
            brand.status === 'ACTIVE'
              ? [{ label: 'Suspend', onSelect: onSuspend, tone: 'danger' }]
              : [{ label: 'Reactivate', onSelect: onReactivate }]
          }
        />
      </header>

      {brand.onboarding ? (
        <Stepper o={brand.onboarding} />
      ) : (
        <p className="muted small">
          {brand.brand_admin_user_id ? 'Brand Admin provisioned' : 'Brand Admin not provisioned'}
        </p>
      )}

      <div className="pf-brand__stats">
        <span className="pf-brand__stats-label">Last 7 days</span>
        {row ? (
          <>
            <span>
              <strong>{row.stores_live}</strong> of {row.stores_total} stores live
            </span>
            <span>
              <strong>{row.holds}</strong> holds
            </span>
            <span>
              <strong>{row.pickups}</strong> pickups
            </span>
            <span>
              <strong>{row.online_orders}</strong> online orders
            </span>
            <span>
              Completion <strong>{pctText(row.completion_pct)}</strong>
            </span>
            {row.stores_flagged > 0 && (
              <Link className="pf-brand__flagged" to={`/platform/network?brand=${encodeURIComponent(row.brand_id)}`}>
                {plural(row.stores_flagged, 'store')} flagged →
              </Link>
            )}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </div>

      <div
        className={`pf-next pf-next--${step === 'Live.' ? 'live' : canProvision || brand.status === 'SUSPENDED' ? 'act' : 'wait'}`}
      >
        <span className="pf-next__label">Next step</span>
        {step === 'Live.' ? (
          <span className="pf-next__text">
            <CheckCircle2 size={16} aria-hidden="true" /> Live — nothing to do.
          </span>
        ) : canProvision ? (
          <>
            <span className="pf-next__text">{step}</span>
            {!provisioning && (
              <Button size="sm" variant="secondary" onClick={() => setProvisioning(true)}>
                Provision Brand Admin
              </Button>
            )}
          </>
        ) : brand.status === 'SUSPENDED' ? (
          <>
            <span className="pf-next__text">{step}</span>
            <Button size="sm" variant="secondary" onClick={onReactivate}>
              Reactivate
            </Button>
          </>
        ) : (
          <span className="pf-next__text">
            <Clock size={16} aria-hidden="true" /> {personal(step, brand.name)}
          </span>
        )}
      </div>

      {provisioning && (
        <form
          className="pf-provision"
          onSubmit={(e) => void provision(e)}
          aria-label={`Provision ${brand.name}'s Brand Admin`}
        >
          <label>
            Brand Admin email for {brand.name}
            <input
              type="email"
              required
              placeholder="admin@brand.example"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </label>
          <div className="pf-provision__actions">
            <Button type="submit" size="sm" loading={busy}>
              Provision
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProvisioning(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ProvisionedNotice result={result} />
    </article>
  );
}

/**
 * Platform Console → Brands (docs/11 §3; Change 16, UI-5; UI-P1 cards): each brand's
 * onboarding as a stepper, its next step in words (with the button when the platform can act),
 * its last 7 days as counts; create a brand from the "New brand" drawer, provision the single
 * Brand Admin in the brand's card, suspend / reactivate from its "⋯" menu. Never customer data.
 */
export function PlatformBrands() {
  const api = useApi();
  const toast = useToast();
  const brands = useLoad(useCallback(() => api.get<{ brands: Brand[] }>('/api/platform/brands'), [api]));
  const network = useLoad(
    useCallback(() => api.get<NetworkResponse>('/api/platform/network?days=7&include_history=true'), [api]),
  );
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    brands.reload();
    network.reload();
  };

  // New brand: a drawer with the name.
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const createBrand = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/platform/brands', { name });
      toast.show(`Brand "${name}" created. Next: provision its Brand Admin.`);
      setName('');
      setCreating(false);
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const provision = async (brand: Brand, email: string): Promise<ProvisionedUser | null> => {
    setError(null);
    try {
      const user = await api.post<ProvisionedUser>(`/api/platform/brands/${brand.brand_id}/admins`, { email });
      toast.show('Brand Admin provisioned. Hand over the setup link.');
      refresh();
      return user;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  };

  // Suspending asks for a reason (kept in the audit trail); reactivating does not.
  const [suspending, setSuspending] = useState<Brand | null>(null);
  const [reason, setReason] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const setStatus = async (brand: Brand, status: 'ACTIVE' | 'SUSPENDED', why?: string) => {
    setError(null);
    setStatusBusy(true);
    try {
      await api.patch(`/api/platform/brands/${brand.brand_id}`, why ? { status, reason: why } : { status });
      toast.show(status === 'SUSPENDED' ? `${brand.name} suspended.` : `${brand.name} reactivated.`);
      setSuspending(null);
      setReason('');
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStatusBusy(false);
    }
  };

  // "Open brand →" from the Overview lands on the brand's card.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash && brands.data)
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView?.({ block: 'start' });
  }, [hash, brands.data]);

  return (
    <ConsoleShell>
      <PageHeader
        title="Brands"
        purpose="Onboard brands and see how each one is doing — counts only, the platform never sees customers."
        action={
          <Button icon={<Plus size={16} aria-hidden="true" />} onClick={() => setCreating(true)}>
            New brand
          </Button>
        }
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {brands.error && <ErrorState message={brands.error} onRetry={brands.reload} />}
      {!brands.data && !brands.error && <Skeleton lines={4} label="Loading brands" />}
      {brands.data && brands.data.brands.length === 0 && (
        <EmptyState
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              New brand
            </Button>
          }
        >
          No brands yet. Create the first one.
        </EmptyState>
      )}
      <div className="pf-brand-list">
        {brands.data?.brands.map((brand) => (
          <BrandCard
            key={brand.brand_id}
            brand={brand}
            row={network.data?.brands.find((b) => b.brand_id === brand.brand_id) ?? null}
            onSuspend={() => setSuspending(brand)}
            onReactivate={() => void setStatus(brand, 'ACTIVE')}
            onProvision={(email) => provision(brand, email)}
          />
        ))}
      </div>

      <ConfirmDialog
        open={suspending !== null}
        title={`Suspend ${suspending?.name ?? ''}?`}
        confirmLabel="Suspend brand"
        tone="danger"
        busy={statusBusy}
        confirmDisabled={reason.trim().length === 0}
        onConfirm={() => suspending && void setStatus(suspending, 'SUSPENDED', reason.trim())}
        onCancel={() => {
          setSuspending(null);
          setReason('');
        }}
      >
        <p>
          Its users lose access to every console and see "Your brand is suspended. Contact Qwikspot support." Customers
          are not messaged. You can reactivate at any time.
        </p>
        <label className="pf-dialog-field">
          Reason (kept in the audit log)
          <input required maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </ConfirmDialog>

      <Drawer open={creating} title="New brand" onClose={() => setCreating(false)}>
        <form className="pf-drawer-form" onSubmit={(e) => void createBrand(e)}>
          <p className="muted small">
            Creates the brand. Next you provision its Brand Admin, who then syncs the catalogue and adds stores.
          </p>
          <label>
            Brand name
            <input
              aria-label="New brand name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <Button type="submit" loading={busy} disabled={name.trim().length === 0}>
            Create brand <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </form>
      </Drawer>
    </ConsoleShell>
  );
}
