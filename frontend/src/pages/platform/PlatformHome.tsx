import { useCallback, useState, type FormEvent } from 'react';
import { useApi, type ProvisionedUser } from '../../api/apiContext';
import { ConsoleShell, errorMessage, Section, SetupLink, useLoad } from '../../components/ConsoleShell';

interface Brand {
  brand_id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  created_at: string | null;
  brand_admin_user_id: string | null;
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

  const setStatus = (brand: Brand) =>
    run(() =>
      api.patch(`/api/platform/brands/${brand.brand_id}`, {
        status: brand.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
      }),
    );

  return (
    <ConsoleShell>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <Section title="Brands">
        {brands.error && <p className="error">{brands.error}</p>}
        <table>
          <thead>
            <tr>
              <th>Brand</th>
              <th>ID</th>
              <th>Status</th>
              <th>Brand Admin</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {brands.data?.brands.map((brand) => (
              <tr key={brand.brand_id}>
                <td>{brand.name}</td>
                <td className="mono">{brand.brand_id}</td>
                <td>{brand.status}</td>
                <td>{brand.brand_admin_user_id ? 'provisioned' : <span className="muted">not provisioned</span>}</td>
                <td>
                  <button type="button" className="secondary" onClick={() => void setStatus(brand)}>
                    {brand.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
        {audit.error && <p className="error">{audit.error}</p>}
        <ul className="list">
          {audit.data?.events.map((e) => (
            <li key={e.audit_id}>
              <span className="mono">{e.action}</span> · brand {e.target_brand_id ?? '—'} ·{' '}
              <span className="muted">{e.timestamp ?? 'just now'}</span>
            </li>
          ))}
        </ul>
      </Section>
    </ConsoleShell>
  );
}
