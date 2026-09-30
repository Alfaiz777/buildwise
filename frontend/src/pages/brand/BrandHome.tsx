import { useCallback, useState, type FormEvent } from 'react';
import { useApi, type ProvisionedUser, type Role } from '../../api/apiContext';
import { ConsoleShell, errorMessage, Section, SetupLink, useLoad } from '../../components/ConsoleShell';
import { BrandNav } from './BrandNav';
import { CatalogSection } from './CatalogSection';
import { RetailImportSection } from './RetailImportSection';
import { SetupChecklist } from './SetupChecklist';
import { formatDateTime, type BrandStore, type CatalogResponse, type Connection, type RetailImport } from './types';

interface BrandUser {
  user_id: string;
  email: string | null;
  role: Role;
  retailer_id: string | null;
  store_id: string | null;
  status: string;
}
interface Retailer {
  retailer_id: string;
  name: string;
  status: string;
}

/**
 * Brand Console shell (M2) for the brand's single BRAND_ADMIN: manage the brand's
 * retailer network and store-level Retail Admin provisioning
 * (docs/11_INTERFACE_CONTRACT.md).
 *
 * Hierarchy: Retailer → its Stores → each Store's Retail Admin. A retailer may own many
 * stores; each store has at most one Retail Admin, provisioned from that store's row.
 * The Brand Admin is provisioned by the Platform Admin (there is no "add brand admin"
 * here). Stores come from the retail CSV import (M3): there is no store-ID entry and no
 * store-assignment UI. M3 adds the setup checklist, catalogue & mapping, and retail import.
 */
export function BrandHome() {
  const api = useApi();
  const users = useLoad(useCallback(() => api.get<{ users: BrandUser[] }>('/api/brand/users'), [api]));
  const retailers = useLoad(useCallback(() => api.get<{ retailers: Retailer[] }>('/api/brand/retailers'), [api]));
  const stores = useLoad(useCallback(() => api.get<{ stores: BrandStore[] }>('/api/brand/stores'), [api]));
  const connections = useLoad(
    useCallback(() => api.get<{ connections: Connection[] }>('/api/brand/connections'), [api]),
  );
  const catalog = useLoad(useCallback(() => api.get<CatalogResponse>('/api/products'), [api]));
  const imports = useLoad(useCallback(() => api.get<{ imports: RetailImport[] }>('/api/brand/retail-imports'), [api]));
  const [syncing, setSyncing] = useState(false);
  const [provisioned, setProvisioned] = useState<ProvisionedUser | null>(null);
  const [provisioningStore, setProvisioningStore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
      users.reload();
      retailers.reload();
      stores.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const submit = (handler: (form: FormData) => Promise<void>) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    void run(async () => {
      await handler(new FormData(form));
      form.reset();
    });
  };

  const syncCatalog = () => {
    setSyncing(true);
    void run(async () => {
      try {
        await api.post('/api/integrations/shopify/sync', {});
      } finally {
        setSyncing(false);
        connections.reload();
        catalog.reload();
      }
    });
  };
  const afterImport = () => {
    imports.reload();
    stores.reload();
    catalog.reload();
  };

  const addRetailer = submit(async (f) => {
    await api.post('/api/brand/retailers', { name: f.get('name') });
  });
  const addRetailAdmin = (storeId: string) =>
    submit(async (f) => {
      setProvisioned(
        await api.post<ProvisionedUser>(`/api/brand/stores/${encodeURIComponent(storeId)}/admins`, {
          email: f.get('email'),
        }),
      );
      setProvisioningStore(null);
    });

  const emailOf = (userId: string) => users.data?.users.find((u) => u.user_id === userId)?.email ?? userId;
  const brandAdmin = users.data?.users.find((u) => u.role === 'BRAND_ADMIN');
  const storesOf = (retailerId: string) => stores.data?.stores.filter((s) => s.retailer_id === retailerId) ?? [];
  const unassigned = stores.data?.stores.filter((s) => !s.retailer_id).length ?? 0;

  return (
    <ConsoleShell>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <BrandNav />
      <SetupLink result={provisioned} />

      <SetupChecklist
        connection={connections.data?.connections.find((c) => c.provider === 'SHOPIFY') ?? null}
        catalog={catalog.data}
        stores={stores.data?.stores ?? null}
        syncing={syncing}
        onSync={syncCatalog}
      />

      <Section title="Brand administrator">
        {users.error && <p className="error">{users.error}</p>}
        <p>
          {brandAdmin?.email ?? '—'} <span className="badge">BRAND_ADMIN</span>
        </p>
        <p className="muted small">One Brand Admin per brand, provisioned by the Buildwise platform admin.</p>
      </Section>

      <CatalogSection catalog={catalog.data} error={catalog.error} syncing={syncing} onSync={syncCatalog} />

      <RetailImportSection imports={imports.data?.imports ?? null} error={imports.error} onImported={afterImport} />

      <Section title="Retailers and stores" id="retailers">
        {retailers.error && <p className="error">{retailers.error}</p>}
        {stores.error && <p className="error">{stores.error}</p>}
        {retailers.data?.retailers.length === 0 && <p className="muted">No retailers yet.</p>}
        {retailers.data?.retailers.map((r) => (
          <div key={r.retailer_id} className="retailer">
            <h3>
              Retailer: {r.name} <span className="muted small mono">{r.retailer_id}</span>{' '}
              {r.status !== 'ACTIVE' && <span className="badge">{r.status}</span>}
            </h3>
            {storesOf(r.retailer_id).length === 0 ? (
              <p className="muted small">No stores yet. Stores arrive through the retail CSV import.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Store</th>
                    <th>City</th>
                    <th>Status</th>
                    <th>SKUs</th>
                    <th>Stock updated</th>
                    <th>Retail Admin</th>
                  </tr>
                </thead>
                <tbody>
                  {storesOf(r.retailer_id).map((s) => (
                    <tr key={s.store_id}>
                      <td>
                        {s.store_name} <span className="muted small mono">{s.store_id}</span>
                      </td>
                      <td>{s.city}</td>
                      <td>{s.store_status}</td>
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
            )}
          </div>
        ))}
        <form className="inline" onSubmit={addRetailer}>
          <input name="name" aria-label="Retailer name" placeholder="Retailer name" required />
          <button type="submit">Create retailer</button>
        </form>
        <p className="muted small">
          A retailer may own several stores. Each store has one Retail Admin, who operates only that store. Stores and
          their retailer come from the retail CSV import
          {unassigned > 0 && `; ${unassigned} store(s) are not yet associated with a retailer`}.
        </p>
      </Section>
    </ConsoleShell>
  );
}
