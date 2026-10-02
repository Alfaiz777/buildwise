import type { ReactNode } from 'react';

/** One look for loading, empty and error states on every screen (M7 polish). */
export function Loading({ what = 'Loading' }: { what?: string }) {
  return (
    <p className="muted state" role="status" aria-live="polite">
      {what}…
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted state empty">{children}</p>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error state" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
