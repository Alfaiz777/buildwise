import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useApi, type MeResponse, type Scope } from '../api/apiContext';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/authContext';

const MeContext = createContext<MeResponse | null>(null);

export function useMe(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe must be used inside MeGate');
  return me;
}

export const HOME_BY_SCOPE: Record<Scope, string> = {
  PLATFORM: '/platform',
  BRAND: '/brand',
  RETAIL: '/retailer',
};

type State = { kind: 'loading' } | { kind: 'ready'; me: MeResponse } | { kind: 'error'; error: ApiError | null };

/**
 * Loads GET /api/me once for the signed-in user and provides it to the console.
 * The backend decides the scope; the frontend only routes by it.
 */
export function MeGate() {
  const api = useApi();
  const { signOut } = useAuth();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .get<MeResponse>('/api/me')
      .then((me) => !cancelled && setState({ kind: 'ready', me }))
      .catch((err: unknown) => !cancelled && setState({ kind: 'error', error: err instanceof ApiError ? err : null }));
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (state.kind === 'loading') return <p className="status page">Loading your account…</p>;
  if (state.kind === 'error') {
    return (
      <main className="card">
        <h1>Qwikspot</h1>
        <div role="alert" className="error">
          <p>{state.error?.message ?? 'Could not reach the Qwikspot API.'}</p>
          {state.error?.requestId && <p className="muted">Reference: {state.error.requestId}</p>}
        </div>
        <button type="button" className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </main>
    );
  }
  return (
    <MeContext.Provider value={state.me}>
      <Outlet />
    </MeContext.Provider>
  );
}

/** "/" → the signed-in user's own console area. */
export function ScopeHome() {
  return <Navigate to={HOME_BY_SCOPE[useMe().scope]} replace />;
}

/**
 * Only renders its area for the matching scope; anyone else is sent to their own area.
 * A UX convenience: the backend enforces scope on every request.
 */
export function ScopeRoute({ scope }: { scope: Scope }) {
  const me = useMe();
  if (me.scope !== scope) return <Navigate to={HOME_BY_SCOPE[me.scope]} replace />;
  return <Outlet />;
}
