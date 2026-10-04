import { Navigate, useLocation } from 'react-router-dom';

/**
 * Redirects to `to`, keeping the query string and fragment — old links such as
 * `/demo-store?qs_ref=…#product=…` (sent in chats before UI-0) still land correctly.
 */
export function RedirectKeepingUrl({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}
