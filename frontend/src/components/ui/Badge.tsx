import type { ReactNode } from 'react';
import { label } from '../../lib/labels';

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`ui-pill ui-pill--${tone}`}>{children}</span>;
}

/** Which tone a status reads as. Anything unknown is neutral. */
const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: 'success',
  CONNECTED: 'success',
  COMPLETED: 'success',
  READY: 'success',
  DELIVERED: 'success',
  SENT: 'success',
  IN_STOCK: 'success',
  PENDING: 'warning',
  CONFIRMED: 'info',
  CUSTOMER_ARRIVED: 'info',
  SCHEDULED: 'info',
  LOW_STOCK: 'warning',
  STALE: 'warning',
  SUSPENDED: 'danger',
  INACTIVE: 'danger',
  ERROR: 'danger',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  OUT_OF_STOCK: 'danger',
};

/** A status in words ("Customer arrived"), coloured by meaning. */
export function StatusPill({ status, tone }: { status: string; tone?: Tone }) {
  return <Badge tone={tone ?? STATUS_TONE[status] ?? 'neutral'}>{label(status)}</Badge>;
}
