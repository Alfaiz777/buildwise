import { Copy } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useApi, type ProvisionedUser, type Role } from '../../api/apiContext';
import { ConsoleShell, errorMessage, Section, useLoad } from '../../components/ConsoleShell';
import { useToast } from '../../components/ui';
import { label } from '../../lib/labels';
import { CatalogSection } from './CatalogSection';
import { RetailImportSection } from './RetailImportSection';
import { formatDateTime, type BrandStore, type CatalogResponse, type RetailImport } from './types';

export interface BrandUser {
  user_id: string;
  email: string | null;
  role: Role;
  retailer_id: string | null;
  store_id: string | null;
  status: string;
}
export interface Retailer {
  retailer_id: string;
  name: string;
  status: string;
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
 * Brand Console → Network (docs/11 §4; Change 16, UI-3): the brand's catalogue & mapping,
 * retail stock imports and its retailers & stores with Store Admin provisioning — moved
 * from the Overview, same behaviour.
 */
export function NetworkPage() {
  const api = useApi();
  const toast = useToast();
  const location = useLocation();
  const users = useLoad(useCallback(() => api.get<{ users: BrandUser[] }>('/api/brand/users'), [api]));
  const retailers = useLoad(useCallback(() => api.get<{ retailers: Retailer[] }>('/api/brand/retailers'), [api]));
  const stores = useLoad(useCallback(() => api.get<{ stores: BrandStore[] }>('/api/brand/stores'), [api]));
  const catalog = useLoad(useCallback(() => api.get<CatalogResponse>('/api/products'), [api]));
  const imports = useLoad(useCallback(() => api.get<{ imports: RetailImport[] }>('/api/brand/retail-imports'), [api]));
  const [syncing, setSyncing] = useState(false);
  const [provisioned, setProvisioned] = useState<ProvisionedUser | null>(null);
  const [provisioningStore, setProvisioningStore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Links like /brand/network#store-st_north_2 (from Insights) scroll to and mark the row.
  const target = location.hash.replace(/^#/, '');
  useEffect(() => {
    if (!target || !stores.data) return;
    document.getElementById(target)?.scrollIntoView?.({ block: 'center' });
  }, [target, stores.data]);

  async function run(action: () => Promise<void>, success?: string) {
    setError(null);
    try {
      await action();
      if (success) toast.show(success);
      users.reload();
      retailers.reload();
      stores.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const submit =
    (handler: (form: FormData) => Promise<void>, success?: string) => (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      void run(async () => {
        await handler(new FormData(form));
        form.reset();
      }, success);
    };

  const syncCatalog = () => {
    setSyncing(true);
    void run(async () => {
      try {
        await api.post('/api/integrations/shopify/sync', {});
      } finally {
        setSyncing(false);
        catalog.reload();
      }
    }, 'Catalog synced.');
  };
  const afterImport = () => {
    imports.reload();
    stores.reload();
    catalog.reload();
  };

  const addRetailer = submit(async (f) => {
    await api.post('/api/brand/retailers', { name: f.get('name') });
  }, 'Retailer created.');
  const addRetailAdmin = (storeId: string) =>
    submit(async (f) => {
      setProvisioned(
        await api.post<ProvisionedUser>(`/api/brand/stores/${encodeURIComponent(storeId)}/admins`, {
          email: f.get('email'),
        }),
      );
      setProvisioningStore(null);
    }, 'Store Admin provisioned. Hand over the setup link.');

  const emailOf = (userId: string) => users.data?.users.find((u) => u.user_id === userId)?.email ?? userId;
  const storesOf = (retailerId: string) => stores.data?.stores.filter((s) => s.retailer_id === retailerId) ?? [];
  const unassigned = stores.data?.stores.filter((s) => !s.retailer_id).length ?? 0;

  return (
    <ConsoleShell>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ProvisionedNotice result={provisioned} />

      <CatalogSection catalog={catalog.data} error={catalog.error} syncing={syncing} onSync={syncCatalog} />

      <RetailImportSection imports={imports.data?.imports ?? null} error={imports.error} onImported={afterImport} />

      <Section title="Retailers and stores" id="retailers">
        {retailers.error && <p className="error">{retailers.error}</p>}
        {stores.error && <p className="error">{stores.error}</p>}
        {retailers.data?.retailers.length === 0 && <p className="muted">No retailers yet.</p>}
        {retailers.data?.retailers.map((r) => (
          <div key={r.retailer_id} className="retailer">
            <h3>
              {r.name} {r.status !== 'ACTIVE' && <span className="badge">{label(r.status)}</span>}
            </h3>
            {storesOf(r.retailer_id).length === 0 ? (
              <p className="muted small">No stores yet. Stores arrive through the retail CSV import.</p>
            ) : (
              <div className="ui-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Store</th>
                      <th>City</th>
                      <th>Status</th>
                      <th>SKUs</th>
                      <th>Stock updated</th>
                      <th>Store Admin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {storesOf(r.retailer_id).map((s) => (
                      <tr
                        key={s.store_id}
                        id={`store-${s.store_id}`}
                        className={target === `store-${s.store_id}` ? 'is-target' : undefined}
                      >
                        <td>
                          {s.store_name} <span className="muted small mono">{s.store_id}</span>
                        </td>
                        <td>{s.city}</td>
                        <td>{label(s.store_status)}</td>
                        <td>{s.sku_count}</td>
                        <td className="small">{formatDateTime(s.stock_updated_at)}</td>
                        <td>
                          {s.retail_admin_user_id ? (
                            emailOf(s.retail_admin_user_id)
                          ) : provisioningStore === s.store_id ? (
                            <form className="inline" onSubmit={addRetailAdmin(s.store_id)}>
                              <input
                                name="email"
                                type="email"
                                aria-label={`Retail admin email for ${s.store_name}`}
                                placeholder="owner@store.example"
                                required
                              />
                              <button type="submit">Provision</button>
                              <button type="button" className="secondary" onClick={() => setProvisioningStore(null)}>
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <>
                              <span className="muted">Not provisioned</span>{' '}
                              <button
                                type="button"
                                className="secondary"
                                aria-label={`Provision Retail Admin for ${s.store_name}`}
                                onClick={() => setProvisioningStore(s.store_id)}
                              >
                                Provision Retail Admin
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        <form className="inline" onSubmit={addRetailer}>
          <input name="name" aria-label="Retailer name" placeholder="Retailer name" required />
          <button type="submit">Create retailer</button>
        </form>
        <p className="muted small">
          A retailer may own several stores. Each store has one Store Admin (Retail Admin), who operates only that
          store. Stores and their retailer come from the retail CSV import
          {unassigned > 0 && `; ${unassigned} store(s) are not yet associated with a retailer`}.
        </p>
      </Section>
    </ConsoleShell>
  );
}
