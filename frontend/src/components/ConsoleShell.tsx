import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { label } from '../lib/labels';
import { AppShell } from './shell/AppShell';

/**
 * Every console page renders inside ConsoleShell. Since UI-0 it is the new AppShell
 * (header, sidebar / bottom tabs, role banner); pages did not change.
 */
export function ConsoleShell({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
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
