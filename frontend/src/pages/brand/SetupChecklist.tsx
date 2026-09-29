import type { ReactNode } from 'react';
import { Section } from '../../components/ConsoleShell';
import { formatDateTime, type BrandStore, type CatalogResponse, type Connection } from './types';

interface Step {
  title: string;
  done: boolean;
  detail: ReactNode;
  /** Shown only while the step is not done (the step's empty state). */
  action: ReactNode;
}

/**
 * The brand's setup at a glance (docs/11_INTERFACE_CONTRACT.md §4): catalogue synced →
 * stores & stock imported → SKU mapping clean → Retail Admins provisioned.
 */
export function SetupChecklist(props: {
  connection: Connection | null;
  catalog: CatalogResponse | null;
  stores: BrandStore[] | null;
  syncing: boolean;
  onSync: () => void;
}) {
  const { connection, catalog, stores } = props;
  const stocked = stores?.filter((s) => s.sku_count > 0) ?? [];
  const stockAsOf =
    stocked
      .map((s) => s.stock_updated_at ?? '')
      .sort()
      .at(-1) || null;
  const owned = stores?.filter((s) => s.retailer_id) ?? [];
  const withAdmin = owned.filter((s) => s.retail_admin_user_id);
  const summary = catalog?.mapping_summary;

  const steps: Step[] = [
    {
      title: 'Catalog synced',
      done: connection?.status === 'CONNECTED' && !!connection.last_sync_at,
      detail: connection?.last_sync_at
        ? `${connection.product_count} products · ${connection.variant_count} variants · last sync ${formatDateTime(connection.last_sync_at)}`
        : connection?.last_error
          ? connection.last_error.message
          : 'Not synced yet.',
      action: (
        <button type="button" onClick={props.onSync} disabled={props.syncing}>
          {props.syncing ? 'Syncing…' : 'Sync catalog'}
        </button>
      ),
    },
    {
      title: 'Stores & stock imported',
      done: stocked.length > 0,
      detail: stocked.length
        ? `${stocked.length} of ${stores?.length ?? 0} stores with stock · stock as of ${formatDateTime(stockAsOf)}`
        : 'No store stock imported yet.',
      action: <a href="#retail-import">Import a retail CSV</a>,
    },
    {
      title: 'SKU mapping',
      done: !!summary && summary.auto_matched > 0 && summary.needs_attention === 0,
      detail:
        summary && summary.auto_matched + summary.needs_attention > 0
          ? `${summary.auto_matched} auto-matched · ${summary.needs_attention} need attention`
          : 'Nothing mapped yet.',
      action: <a href="#catalog">Review mapping</a>,
    },
    {
      title: 'Retail Admins provisioned',
      done: owned.length > 0 && withAdmin.length === owned.length,
      detail: owned.length ? `${withAdmin.length} of ${owned.length} stores have their Retail Admin` : 'No stores yet.',
      action: <a href="#retailers">Provision per store</a>,
    },
  ];

  return (
    <Section title="Setup checklist">
      <ol className="checklist">
        {steps.map((step) => (
          <li key={step.title} className={step.done ? 'done' : 'todo'}>
            <span className="check" aria-hidden="true">
              {step.done ? '✓' : '○'}
            </span>
            <div>
              <strong>{step.title}</strong> <span className="small">{step.done ? 'done' : 'to do'}</span>
              <div className="muted small">{step.detail}</div>
              {!step.done && <div className="step-action">{step.action}</div>}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
