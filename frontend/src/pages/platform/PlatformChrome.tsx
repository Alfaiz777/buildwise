import type { ReactNode } from 'react';
import { AiButton, Badge, Segmented, Tip } from '../../components/ui';
import { useAskQwikspot } from '../brand/askQwikspot';
import './platform.css';

/**
 * The Platform Console's page frame (UI-P1): every page opens with the same header — its
 * title, one line on what it is for, and its one primary action on the right.
 */
export function PageHeader({ title, purpose, action }: { title: string; purpose: string; action?: ReactNode }) {
  return (
    <header className="pf-page-head">
      <div>
        <h1 className="pf-page-head__title">{title}</h1>
        <p className="pf-page-head__purpose">{purpose}</p>
      </div>
      {action && <div className="pf-page-head__action">{action}</div>}
    </header>
  );
}

/**
 * Period and synthetic-history controls shared by the platform's aggregate pages: two compact
 * segmented controls ("7 days | 28 days", "Live only | Live + demo history") and, when the
 * numbers include generated demo records, one page-level badge saying so.
 */
export function PeriodControls(props: {
  days: 7 | 28;
  onDays: (d: 7 | 28) => void;
  includeHistory: boolean;
  onHistory: (v: boolean) => void;
  /** Generated demo records counted in the numbers on screen (shows the badge when > 0). */
  demoRecords?: number;
  /** UI-P3: the badge's tooltip for a console other than the Platform's. */
  demoTip?: string;
  children?: ReactNode;
}) {
  return (
    <div className="pf-filters">
      {props.children}
      <Segmented
        label="Period"
        value={props.days}
        options={[
          { value: 7, label: '7 days' },
          { value: 28, label: '28 days' },
        ]}
        onChange={props.onDays}
      />
      <Segmented
        label="History"
        value={props.includeHistory ? 'all' : 'live'}
        options={[
          { value: 'live', label: 'Live only' },
          { value: 'all', label: 'Live + demo history' },
        ]}
        onChange={(v) => props.onHistory(v === 'all')}
      />
      {props.includeHistory && (props.demoRecords ?? 0) > 0 && (
        <Tip
          text={
            props.demoTip ??
            `Includes synthetic demo history (${props.demoRecords} generated records). Choose "Live only" to see real activity. Counts only — the platform never sees customers.`
          }
        >
          <Badge tone="neutral">Includes demo history</Badge>
        </Tip>
      )}
    </div>
  );
}

/**
 * A page's AI action ("Ask about this network", "What changed today?"): opens Ask Qwikspot, with
 * the question asked when there is one. A component of its own so it renders inside the console
 * shell, where the drawer lives — a hook called by the page itself would sit outside it.
 */
export function AskAction({ label, question }: { label: string; question?: string }) {
  const { ask } = useAskQwikspot();
  return <AiButton onClick={() => ask(question)}>{label}</AiButton>;
}

/** "2h ago", "6 days ago" (the full date goes in a tooltip). */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.round(d / 30);
  return `${mo} month${mo === 1 ? '' : 's'} ago`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
