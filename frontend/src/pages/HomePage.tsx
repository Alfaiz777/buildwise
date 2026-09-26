import { useEffect, useState } from 'react';
import { useApi, type MeResponse } from '../api/apiContext';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/authContext';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; me: MeResponse }
  | { kind: 'error'; message: string; requestId: string | null };

/**
 * M1 protected page: proves the authenticated round trip
 * React → Cloud Run → token verification → users/{uid} → response.
 */
export function HomePage() {
  const api = useApi();
  const { signOut } = useAuth();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .get<MeResponse>('/api/me')
      .then((me) => !cancelled && setState({ kind: 'ready', me }))
      .catch((err: unknown) => {
        if (cancelled) return;
        const apiError = err instanceof ApiError ? err : null;
        setState({
          kind: 'error',
          message: apiError?.message ?? 'Could not reach the Buildwise API.',
          requestId: apiError?.requestId ?? null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <main className="card">
      <header className="row">
        <h1>Buildwise</h1>
        <button type="button" className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      {state.kind === 'loading' && <p className="status">Loading your account…</p>}

      {state.kind === 'error' && (
        <div role="alert" className="error">
          <p>{state.message}</p>
          {state.requestId && <p className="muted">Reference: {state.requestId}</p>}
        </div>
      )}

      {state.kind === 'ready' && (
        <dl>
          <dt>Brand</dt>
          <dd>{state.me.brand?.name ?? '—'}</dd>
          <dt>Signed in as</dt>
          <dd>{state.me.user.email ?? state.me.user.user_id}</dd>
          <dt>Role</dt>
          <dd>{state.me.user.role}</dd>
          {state.me.user.store_ids.length > 0 && (
            <>
              <dt>Stores</dt>
              <dd>{state.me.user.store_ids.join(', ')}</dd>
            </>
          )}
        </dl>
      )}
    </main>
  );
}
