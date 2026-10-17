import { Copy } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useApi, type ProvisionedUser, type Role } from '../../api/apiContext';
import { ConsoleShell, errorMessage, useLoad } from '../../components/ConsoleShell';
import { Badge, Button, Card, Drawer, EmptyState, Skeleton, Tabs, Tip, useToast } from '../../components/ui';
import { label } from '../../lib/labels';
import { ago, AskAction, PageHeader } from '../platform/PlatformChrome';
import { FLAG_TEXT } from '../platform/platformTypes';
import { CatalogSection } from './CatalogSection';
import type { InsightsResponse } from './InsightsPage';
import { RetailImportSection } from './RetailImportSection';
import { formatDateTime, type BrandStore, type CatalogResponse, type RetailImport } from './types';
import { storeLabel } from '../../lib/storeLabel';
import { AskAboutThis } from './AiCards';
import './brand.css';
import './network.css';

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

type Flag = keyof typeof FLAG_TEXT;
type NetworkTab = 'stores' | 'catalog' | 'import' | 'retailers';
const TAB_NAME: Record<NetworkTab, string> = {
  stores: 'Stores',
  catalog: 'Catalogue',
  import: 'Stock import',
  retailers: 'Retailers',
};
const TAB_OF_HASH = (hash: string): NetworkTab =>
  hash === 'catalog' ? 'catalog' : hash === 'retail-import' ? 'import' : hash === 'retailers' ? 'retailers' : 'stores';

/** "Fresh · 2h ago" / "Stale · 3 days ago" / "No stock yet". */
function freshness(
  s: BrandStore,
  freshnessHours: number,
  now: number,
): { text: string; tone: 'success' | 'warning' | 'neutral' } {
  if (s.sku_count === 0 || !s.stock_updated_at) return { text: 'No stock yet', tone: 'neutral' };
  const stale = now - Date.parse(s.stock_updated_at) > freshnessHours * 3_600_000;
  return {
    text: `${stale ? 'Stale' : 'Fresh'} · ${ago(s.stock_updated_at, now)}`,
    tone: stale ? 'warning' : 'success',
  };
}

/**
 * The store health flags the Platform Console shows (same words and tooltips), from what this
 * console already loads: stock upload and freshness, the Store Admin, and the fill rate.
 */
function flagsOf(
  s: BrandStore,
  input: { freshnessHours: number; now: number; fill: Map<string, { nearest: number; had: number }> },
): Flag[] {
  const flags: Flag[] = [];
  if (s.sku_count === 0) flags.push('NO_STOCK_UPLOAD');
  else if (s.stock_updated_at && input.now - Date.parse(s.stock_updated_at) > input.freshnessHours * 3_600_000)
    flags.push('STALE_STOCK');
  if (s.retailer_id && !s.retail_admin_user_id) flags.push('NO_STORE_ADMIN');
  const f = input.fill.get(s.store_id);
  if (f && f.nearest >= 3 && f.had / f.nearest < 0.5) flags.push('LOW_FILL_RATE');
  return flags;
}

function FlagPill({ flag }: { flag: Flag }) {
  return (
    <Tip text={FLAG_TEXT[flag].explain}>
      <Badge tone="warning">{FLAG_TEXT[flag].label}</Badge>
    </Tip>
  );
}

/**
 * Brand Console → Network (docs/11 §4; UI-3; UI-P3 tabs): the brand's stores and their health,
 * its catalogue & mapping, the retail stock import and its retailers — the same actions as
 * before, one tab each. Links like /brand/network#store-st_north_2 open Stores and mark the row;
 * #catalog, #retail-import and #retailers open their tab.
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
  // For the health flags: the freshness window and the stores' fill rate (both already used elsewhere).
  const settings = useLoad(
    useCallback(() => api.get<{ retail_freshness_hours: number }>('/api/brand/settings'), [api]),
  );
  const insights = useLoad(
    useCallback(() => api.get<InsightsResponse>('/api/brand/insights?days=7&include_history=true'), [api]),
  );
  const [syncing, setSyncing] = useState(false);
  const [provisioned, setProvisioned] = useState<ProvisionedUser | null>(null);
  const [provisioningStore, setProvisioningStore] = useState<string | null>(null);
  const [addingRetailer, setAddingRetailer] = useState(false);
  const [flagFilter, setFlagFilter] = useState<Flag | 'ATTENTION' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = location.hash.replace(/^#/, '');
  const [tab, setTab] = useState<NetworkTab>(() => TAB_OF_HASH(target));
  useEffect(() => setTab(TAB_OF_HASH(target)), [target]);
  // Links like /brand/network#store-st_north_2 (from Insights) scroll to and mark the row.
  useEffect(() => {
    if (!target || !stores.data) return;
    document.getElementById(target)?.scrollIntoView?.({ block: 'center' });
  }, [target, stores.data, tab]);

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
    setAddingRetailer(false);
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

  const now = Date.now();
  const freshnessHours = settings.data?.retail_freshness_hours ?? 24;
  const fill = new Map<string, { nearest: number; had: number }>();
  for (const f of insights.data?.fill_rate ?? []) {
    const g = fill.get(f.store_id) ?? { nearest: 0, had: 0 };
    g.nearest += f.nearest;
    g.had += f.had_stock;
    fill.set(f.store_id, g);
  }
  const all = stores.data?.stores ?? [];
  const flagged = all.map((s) => ({ s, flags: flagsOf(s, { freshnessHours, now, fill }) }));
  const flagCounts = new Map<Flag, number>();
  for (const { flags } of flagged) for (const f of flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  const attention = flagged.filter((x) => x.flags.length > 0).length;
  const shownStores = flagged
    .filter((x) => !flagFilter || (flagFilter === 'ATTENTION' ? x.flags.length > 0 : x.flags.includes(flagFilter)))
    .sort((a, b) => b.flags.length - a.flags.length || a.s.store_name.localeCompare(b.s.store_name));
  const emailOf = (userId: string) => users.data?.users.find((u) => u.user_id === userId)?.email ?? userId;
  const storesOf = (retailerId: string) => all.filter((s) => s.retailer_id === retailerId);
  const retailerName = (id: string | null) => retailers.data?.retailers.find((r) => r.retailer_id === id)?.name ?? null;
  const unassigned = all.filter((s) => !s.retailer_id).length;
  const lastImport = imports.data?.imports[0];

  return (
    <ConsoleShell>
      <PageHeader
        title="Network"
        purpose="Your stores and their health, your catalogue, the stock file and your retailers."
        action={<AskAction label="Ask which store needs attention" question="Which store needs attention, and why?" />}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ProvisionedNotice result={provisioned} />

      <Tabs
        label="Network"
        value={tab}
        onChange={(id) => setTab(id as NetworkTab)}
        items={[
          { id: 'stores', label: 'Stores', count: all.length || undefined },
          { id: 'catalog', label: 'Catalogue' },
          { id: 'import', label: 'Stock import' },
          { id: 'retailers', label: 'Retailers', count: retailers.data?.retailers.length || undefined },
        ]}
      />

      <div role="tabpanel" aria-label={TAB_NAME[tab]} className="nw-panel">
        {tab === 'stores' && (
          <Card
            id="stores"
            title="Stores"
            description={`Needs attention first. Stock counts as stale after ${freshnessHours} h.`}
          >
            {stores.error && <p className="error">{stores.error}</p>}
            {!stores.data && !stores.error && <Skeleton lines={3} />}
            {stores.data && all.length === 0 && (
              <EmptyState>No stores yet. Stores arrive through the retail CSV import.</EmptyState>
            )}
            {all.length > 0 && (
              <>
                <div className="pf-chips" role="group" aria-label="Filter stores by health">
                  <button
                    type="button"
                    className="pf-chip pf-chip--warning"
                    aria-pressed={flagFilter === 'ATTENTION'}
                    disabled={attention === 0}
                    onClick={() => setFlagFilter((f) => (f === 'ATTENTION' ? null : 'ATTENTION'))}
                  >
                    <span className="pf-chip__count">{attention}</span> Need attention
                  </button>
                  <button type="button" className="pf-chip pf-chip--success" aria-pressed={false} disabled>
                    <span className="pf-chip__count">{all.length - attention}</span> Healthy
                  </button>
                  {[...flagCounts.entries()].map(([f, n]) => (
                    <button
                      key={f}
                      type="button"
                      className="pf-chip"
                      aria-pressed={flagFilter === f}
                      onClick={() => setFlagFilter((x) => (x === f ? null : f))}
                    >
                      <span className="pf-chip__count">{n}</span> {FLAG_TEXT[f].label}
                    </button>
                  ))}
                </div>
                <div className="ui-table-wrap nw-stores">
                  <table>
                    <thead>
                      <tr>
                        <th>Store</th>
                        <th>Health</th>
                        <th>Stock</th>
                        <th>Store Admin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownStores.map(({ s, flags }) => {
                        const fresh = freshness(s, freshnessHours, now);
                        return (
                          <tr
                            key={s.store_id}
                            id={`store-${s.store_id}`}
                            className={target === `store-${s.store_id}` ? 'is-target' : undefined}
                          >
                            <td data-label="Store">
                              <span className="nw-store">
                                <strong>{storeLabel(s)}</strong>
                                <span className="small muted">
                                  {[s.city, retailerName(s.retailer_id)].filter(Boolean).join(' · ')}
                                  {s.store_status !== 'ACTIVE' && ` · ${label(s.store_status)}`}
                                </span>
                                <AskAboutThis
                                  label={`Ask Qwikspot about ${s.store_name}`}
                                  question={`How is ${s.store_name} doing, and does it need attention?`}
                                />
                              </span>
                            </td>
                            <td data-label="Health">
                              <span className="nw-flags">
                                {flags.length === 0 ? (
                                  <Badge tone="success">Healthy</Badge>
                                ) : (
                                  flags.map((f) => <FlagPill key={f} flag={f} />)
                                )}
                              </span>
                            </td>
                            <td data-label="Stock">
                              <span className="nw-stock">
                                <span>
                                  {s.sku_count} <span className="small muted">SKUs</span>
                                </span>
                                <Tip text={`Stock updated ${formatDateTime(s.stock_updated_at)}`}>
                                  <Badge tone={fresh.tone}>{fresh.text}</Badge>
                                </Tip>
                              </span>
                            </td>
                            <td data-label="Store Admin">
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
                                  <button
                                    type="button"
                                    className="secondary"
                                    onClick={() => setProvisioningStore(null)}
                                  >
                                    Cancel
                                  </button>
                                </form>
                              ) : (
                                <span className="nw-admin">
                                  <span className="muted">Not provisioned</span>
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    aria-label={`Provision Retail Admin for ${s.store_name}`}
                                    onClick={() => setProvisioningStore(s.store_id)}
                                  >
                                    Provision Retail Admin
                                  </Button>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        )}

        {tab === 'catalog' && (
          <CatalogSection catalog={catalog.data} error={catalog.error} syncing={syncing} onSync={syncCatalog} />
        )}

        {tab === 'import' && (
          <RetailImportSection imports={imports.data?.imports ?? null} error={imports.error} onImported={afterImport} />
        )}

        {tab === 'retailers' && (
          <Card
            title="Retailers and stores"
            id="retailers"
            actions={
              <Button variant="brand" size="sm" onClick={() => setAddingRetailer(true)}>
                + Add retailer
              </Button>
            }
          >
            {retailers.error && <p className="error">{retailers.error}</p>}
            {stores.error && <p className="error">{stores.error}</p>}
            {retailers.data?.retailers.length === 0 && <p className="muted">No retailers yet.</p>}
            <div className="nw-retailers">
              {retailers.data?.retailers.map((r) => (
                <section key={r.retailer_id} className="nw-retailer" aria-labelledby={`rt-${r.retailer_id}`}>
                  <h3 id={`rt-${r.retailer_id}`}>
                    {r.name} {r.status !== 'ACTIVE' && <span className="badge">{label(r.status)}</span>}
                  </h3>
                  {storesOf(r.retailer_id).length === 0 ? (
                    <p className="muted small">No stores yet. Stores arrive through the retail CSV import.</p>
                  ) : (
                    <ul className="nw-retailer__stores">
                      {storesOf(r.retailer_id).map((s) => (
                        <li key={s.store_id}>
                          <span>{storeLabel(s)}</span>
                          <span className="small muted">
                            {s.retail_admin_user_id ? 'Store Admin set' : 'No Store Admin'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
            <p className="muted small">
              A retailer may own several stores. Each store has one Store Admin (Retail Admin), who operates only that
              store. Stores and their retailer come from the retail CSV import
              {unassigned > 0 && `; ${unassigned} store(s) are not yet associated with a retailer`}.
            </p>
            <Drawer open={addingRetailer} title="Add a retailer" onClose={() => setAddingRetailer(false)}>
              <form className="nw-retailer-form" onSubmit={addRetailer}>
                <label>
                  <span>Retailer name</span>
                  <input name="name" aria-label="Retailer name" placeholder="e.g. Ahmedabad Retail Partners" required />
                </label>
                <p className="small muted">
                  Its stores arrive through the retail CSV import; then provision a Store Admin per store.
                </p>
                <Button type="submit" variant="brand">
                  Create retailer
                </Button>
              </form>
            </Drawer>
          </Card>
        )}
      </div>
      {tab !== 'import' && lastImport && (
        <p className="small muted">
          Last stock import: {lastImport.file_name} · {formatDateTime(lastImport.completed_at)}
        </p>
      )}
    </ConsoleShell>
  );
}
