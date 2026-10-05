import { Copy } from 'lucide-react';
import { useCallback, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApi, type ProvisionedUser } from '../../api/apiContext';
import { ConsoleShell, errorMessage, Section, useLoad } from '../../components/ConsoleShell';
import { Empty, ErrorState, Loading } from '../../components/States';
import { useToast } from '../../components/ui';
import { label } from '../../lib/labels';
import { formatDateTime } from '../brand/types';
import { nextStep, pctText, type Brand, type NetworkResponse, type Onboarding } from './platformTypes';

/** The onboarding checklist as short, readable facts (counts only, never customer data). */
function OnboardingList({ o }: { o: Onboarding }) {
  const r = o.retail_admins;
  const items: [string, boolean, string][] = [
    ['Brand Admin', o.brand_admin_provisioned, o.brand_admin_provisioned ? 'provisioned' : 'not provisioned'],
    [
      'Catalog',
      o.catalog.synced,
      o.catalog.failed ? 'last sync failed' : o.catalog.synced ? `${o.catalog.product_count} products` : 'not synced',
    ],
    ['Stores', o.stores.with_stock > 0, `${o.stores.with_stock} of ${o.stores.total} with stock`],
    [
      'SKU mapping',
      o.sku_mapping.auto_matched > 0 && o.sku_mapping.needs_attention === 0,
      `${o.sku_mapping.auto_matched} matched, ${o.sku_mapping.needs_attention} need attention`,
    ],
    [
      'Retail Admins',
      r.stores_with_retailer > 0 && r.provisioned === r.stores_with_retailer,
      `${r.provisioned} of ${r.stores_with_retailer} stores`,
    ],
    [
      'Channel',
      o.channel.whatsapp_number_configured || o.channel.simulator,
      o.channel.whatsapp_number_configured ? 'WhatsApp number set, simulator' : 'simulator only',
    ],
  ];
  return (
    <ul className="onboarding small">
      {items.map(([name, done, detail]) => (
        <li key={name} className={done ? 'done' : 'todo'}>
          <span aria-hidden="true">{done ? '✓' : '○'}</span> {name}: <span className="muted">{detail}</span>
          <span className="sr-only">{done ? ' (done)' : ' (to do)'}</span>
        </li>
      ))}
    </ul>
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

/**
 * Platform Console → Brands (docs/11 §3; Change 16, UI-5): each brand's onboarding, its
 * next step in words and its results as counts (stores live, holds, pickups, online
 * orders, completion, flagged stores); create, provision the single Brand Admin,
 * suspend / reactivate with a reason. Never customer data.
 */
export function PlatformBrands() {
  const api = useApi();
  const toast = useToast();
  const brands = useLoad(useCallback(() => api.get<{ brands: Brand[] }>('/api/platform/brands'), [api]));
  const network = useLoad(
    useCallback(() => api.get<NetworkResponse>('/api/platform/network?days=7&include_history=true'), [api]),
  );
  const [name, setName] = useState('');
  const [adminBrand, setAdminBrand] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [provisioned, setProvisioned] = useState<ProvisionedUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    brands.reload();
    network.reload();
  };

  async function run(action: () => Promise<unknown>, success?: string) {
    setError(null);
    try {
      await action();
      if (success) toast.show(success);
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const createBrand = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.post('/api/platform/brands', { name });
      setName('');
    }, `Brand "${name}" created. Next: provision its Brand Admin.`);
  };

  const provisionAdmin = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setProvisioned(
        await api.post<ProvisionedUser>(`/api/platform/brands/${adminBrand}/admins`, { email: adminEmail }),
      );
      setAdminEmail('');
    }, 'Brand Admin provisioned. Hand over the setup link.');
  };

  const needingAdmin = brands.data?.brands.filter((b) => !b.brand_admin_user_id) ?? [];

  // Suspending asks for a reason (kept in the audit trail); reactivating does not.
  const [suspending, setSuspending] = useState<Brand | null>(null);
  const [reason, setReason] = useState('');
  const setStatus = (brand: Brand, status: 'ACTIVE' | 'SUSPENDED', why?: string) =>
    run(
      async () => {
        await api.patch(`/api/platform/brands/${brand.brand_id}`, why ? { status, reason: why } : { status });
        setSuspending(null);
        setReason('');
      },
      status === 'SUSPENDED' ? `${brand.name} suspended.` : `${brand.name} reactivated.`,
    );
  const confirmSuspend = (event: FormEvent) => {
    event.preventDefault();
    if (suspending) void setStatus(suspending, 'SUSPENDED', reason.trim());
  };

  return (
    <ConsoleShell>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <Section title="Brands">
        <p className="muted small">
          Onboarding, next step and the last 7 days per brand (counts only, including synthetic history). The platform
          never sees customers or conversations.
        </p>
        {brands.error && <ErrorState message={brands.error} onRetry={brands.reload} />}
        {!brands.data && !brands.error && <Loading what="Loading brands" />}
        {brands.data && brands.data.brands.length === 0 && <Empty>No brands yet. Create the first one below.</Empty>}
        {brands.data && brands.data.brands.length > 0 && (
          <div className="ui-table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Brand</th>
                  <th scope="col">Status</th>
                  <th scope="col">Next step</th>
                  <th scope="col">Last 7 days</th>
                  <th scope="col">Onboarding</th>
                  <th scope="col">Last activity</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {brands.data.brands.map((brand) => (
                  <tr key={brand.brand_id}>
                    <td>
                      {brand.name}
                      <div className="mono small muted">{brand.brand_id}</div>
                    </td>
                    <td>
                      <span className={brand.status === 'ACTIVE' ? 'badge ok' : 'badge warn'}>
                        {label(brand.status)}
                      </span>
                    </td>
                    <td className="small">{nextStep(brand)}</td>
                    <td className="small">
                      <BrandResults row={network.data?.brands.find((b) => b.brand_id === brand.brand_id) ?? null} />
                    </td>
                    <td>
                      {brand.onboarding ? (
                        <OnboardingList o={brand.onboarding} />
                      ) : brand.brand_admin_user_id ? (
                        'Brand Admin provisioned'
                      ) : (
                        <span className="muted">Brand Admin not provisioned</span>
                      )}
                    </td>
                    <td className="small">
                      {brand.last_activity_at ? (
                        formatDateTime(brand.last_activity_at)
                      ) : (
                        <span className="muted">none yet</span>
                      )}
                    </td>
                    <td>
                      {brand.status === 'ACTIVE' ? (
                        <button type="button" className="secondary" onClick={() => setSuspending(brand)}>
                          Suspend
                        </button>
                      ) : (
                        <button type="button" className="secondary" onClick={() => void setStatus(brand, 'ACTIVE')}>
                          Reactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {suspending && (
          <form className="notice" onSubmit={confirmSuspend} aria-label={`Suspend ${suspending.name}`}>
            <p>
              Suspend <strong>{suspending.name}</strong>? Its users lose access to every console and see "Your brand is
              suspended. Contact Qwikspot support." Customers are not messaged. You can reactivate at any time.
            </p>
            <label>
              Reason (kept in the audit log)
              <input required maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="inline">
              <button type="submit">Suspend brand</button>
              <button type="button" className="secondary" onClick={() => setSuspending(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <form className="inline" onSubmit={createBrand}>
          <input
            aria-label="New brand name"
            placeholder="New brand name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit">Create brand</button>
        </form>
      </Section>

      <Section title="Provision a brand's Brand Admin">
        <p className="muted small">Exactly one Brand Admin per brand. Brands that already have one are not listed.</p>
        <form className="inline" onSubmit={provisionAdmin}>
          <select aria-label="Brand" required value={adminBrand} onChange={(e) => setAdminBrand(e.target.value)}>
            <option value="">Select brand…</option>
            {needingAdmin.map((b) => (
              <option key={b.brand_id} value={b.brand_id}>
                {b.name}
              </option>
            ))}
          </select>
          <input
            aria-label="Admin email"
            type="email"
            placeholder="admin@brand.example"
            required
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
          />
          <button type="submit">Provision Brand Admin</button>
        </form>
        <ProvisionedNotice result={provisioned} />
      </Section>
    </ConsoleShell>
  );
}

function BrandResults({ row }: { row: NetworkResponse['brands'][number] | null }) {
  if (!row) return <span className="muted">—</span>;
  return (
    <ul className="plain">
      <li>
        {row.stores_live} of {row.stores_total} stores live
      </li>
      <li>
        {row.holds} holds · {row.pickups} pickups · {row.online_orders} online orders
      </li>
      <li>Completion {pctText(row.completion_pct)}</li>
      {row.stores_flagged > 0 && (
        <li>
          <Link to={`/platform/network?brand=${encodeURIComponent(row.brand_id)}`}>
            {row.stores_flagged} store{row.stores_flagged === 1 ? '' : 's'} flagged →
          </Link>
        </li>
      )}
    </ul>
  );
}
