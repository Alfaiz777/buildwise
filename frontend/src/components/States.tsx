import type { ReactNode } from 'react';

/**
 * M7 state helpers, kept for the screens not yet redesigned. New screens use
 * components/ui (Skeleton, EmptyState, ErrorState); ErrorState is shared.
 */
export { ErrorState } from './ui/States';

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
