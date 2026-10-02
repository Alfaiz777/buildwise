import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './authContext';

/**
 * Client-side gate for signed-in pages. This is a UX convenience only:
 * the real enforcement is the backend verifying the ID token on every request.
 */
export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <p className="status">Loading…</p>;
  // Keep the query and fragment (e.g. the simulator's prefilled text) across sign-in.
  if (!user) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  }
  return <Outlet />;
}
