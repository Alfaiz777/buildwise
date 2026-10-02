import { useCallback, useState, type FormEvent } from 'react';
import { useApi, type ProvisionedUser } from '../../api/apiContext';
import { ConsoleShell, errorMessage, Section, SetupLink, useLoad } from '../../components/ConsoleShell';
import { Empty, ErrorState, Loading } from '../../components/States';
import { label } from '../../lib/labels';
import { formatDateTime } from '../brand/types';

interface Onboarding {
  brand_admin_provisioned: boolean;
  catalog: { synced: boolean; failed: boolean; last_sync_at: string | null; product_count: number };
  stores: { total: number; with_stock: number };
  sku_mapping: { auto_matched: number; needs_attention: number };
  retail_admins: { provisioned: number; stores_with_retailer: number };
  channel: { simulator: boolean; whatsapp_number_configured: boolean };
}
interface Brand {
  brand_id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  created_at: string | null;
  brand_admin_user_id: string | null;
  last_activity_at?: string | null;
  onboarding?: Onboarding;
}

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
interface AuditEvent {
  audit_id: string;
  action: string;
  target_brand_id: string | null;
  target_id: string;
  timestamp: string | null;
}

/**
 * Platform Admin minimum (M2): brands, suspend/reactivate, each brand's single
 * Brand Admin (only the Platform Admin provisions it), platform audit.
 * Platform scope never shows customer data.
 */
export function PlatformHome() {
  const api = useApi();
  const brands = useLoad(useCallback(() => api.get<{ brands: Brand[] }>('/api/platform/brands'), [api]));
  const audit = useLoad(useCallback(() => api.get<{ events: AuditEvent[] }>('/api/platform/audit?limit=10'), [api]));
  const [name, setName] = useState('');
  const [adminBrand, setAdminBrand] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [provisioned, setProvisioned] = useState<ProvisionedUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    brands.reload();
    audit.reload();
  };

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
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
    });
  };

  const provisionAdmin = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setProvisioned(
        await api.post<ProvisionedUser>(`/api/platform/brands/${adminBrand}/admins`, { email: adminEmail }),
      );
      setAdminEmail('');
    });
  };

  const needingAdmin = brands.data?.brands.filter((b) => !b.brand_admin_user_id) ?? [];

  // Suspending asks for a reason (kept in the audit trail); reactivating does not.
  const [suspending, setSuspending] = useState<Brand | null>(null);
  const [reason, setReason] = useState('');
  const setStatus = (brand: Brand, status: 'ACTIVE' | 'SUSPENDED', why?: string) =>
    run(async () => {
      await api.patch(`/api/platform/brands/${brand.brand_id}`, why ? { status, reason: why } : { status });
      setSuspending(null);
      setReason('');
    });
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
          Onboarding and last activity per brand. The platform never sees customers or conversations.
        </p>
        {brands.error && <ErrorState message={brands.error} onRetry={brands.reload} />}
        {!brands.data && !brands.error && <Loading what="Loading brands" />}
        {brands.data && brands.data.brands.length === 0 && <Empty>No brands yet. Create the first one below.</Empty>}
        {brands.data && brands.data.brands.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Brand</th>
                  <th scope="col">Status</th>
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
              suspended. Contact Buildwise support." Customers are not messaged. You can reactivate at any time.
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
        <SetupLink result={provisioned} />
      </Section>

      <Section title="Platform audit (latest)">
        {audit.error && <ErrorState message={audit.error} onRetry={audit.reload} />}
        {audit.data && audit.data.events.length === 0 && <Empty>No platform actions yet.</Empty>}
        <ul className="list">
          {audit.data?.events.map((e) => (
            <li key={e.audit_id}>
              {label(e.action)} · brand <span className="mono">{e.target_brand_id ?? '—'}</span> ·{' '}
              <span className="muted">{e.timestamp ? formatDateTime(e.timestamp) : 'just now'}</span>
            </li>
          ))}
        </ul>
      </Section>
    </ConsoleShell>
  );
}
