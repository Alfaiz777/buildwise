import { AlertTriangle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';

/** What an empty list means and the one thing to do next. */
export function EmptyState({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-empty">
      <span className="ui-empty__icon" aria-hidden="true">
        {icon ?? <Inbox size={22} />}
      </span>
      <p>{children}</p>
      {action}
    </div>
  );
}

/** What went wrong, what to do, and the request reference for support. */
export function ErrorState({
  message,
  onRetry,
  reference,
}: {
  message: string;
  onRetry?: () => void;
  reference?: string | null;
}) {
  return (
    <div className="ui-error error state" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div className="ui-error__body">
        <span>{message}</span>
        {reference && <span className="ui-error__ref">Reference: {reference}</span>}
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Placeholder blocks while data loads. Announced once as "Loading…". */
export function Skeleton({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className="ui-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="ui-skeleton__line" style={{ width: `${92 - i * 14}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}
