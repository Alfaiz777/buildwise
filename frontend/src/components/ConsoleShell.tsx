import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useMe } from '../account/meContext';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/authContext';
import { label } from '../lib/labels';

const AREA_TITLE = { PLATFORM: 'Platform Admin', BRAND: 'Brand Console', RETAIL: 'Retailer Console' } as const;

/** Header + frame shared by the three console areas. */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const { signOut } = useAuth();
  const context =
    me.scope === 'RETAIL'
      ? `${me.retailer_name} · ${me.brand_name}`
      : me.scope === 'BRAND'
        ? me.brand_name
        : 'Qwikspot platform';

  return (
    <div className="shell">
      <header className="shell-header">
        <div>
          <strong>Qwikspot</strong> <span className="muted">· {AREA_TITLE[me.scope]}</span>
          <div className="muted small">{context}</div>
        </div>
        <div className="shell-user">
          <span className="small">
            {me.user.email ?? me.user.user_id} <span className="badge">{label(me.role)}</span>
          </span>
          <button type="button" className="secondary" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="shell-main">{children}</main>
    </div>
  );
}

export function Section({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section className="panel" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? `${err.message} (${err.code})` : 'Something went wrong.';
}

/** Loads data on mount and on reload(); errors are shown, never thrown. */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    load()
      .then((value) => {
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [load]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

/** Shows the result of a provisioning action, including the hand-over link. */
export function SetupLink({ result }: { result: { email: string; role: string; password_setup_link: string } | null }) {
  if (!result) return null;
  return (
    <div className="notice" role="status">
      Provisioned <strong>{result.email}</strong> as {label(result.role)}. Hand over this password-setup link:
      <code className="link">{result.password_setup_link}</code>
    </div>
  );
}
