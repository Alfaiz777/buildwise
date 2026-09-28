import { Navigate } from 'react-router-dom';
import { useMe } from '../../account/meContext';
import type { Store } from '../../api/apiContext';
import { ConsoleShell, Section } from '../../components/ConsoleShell';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function hoursText(hours: Store['store_hours']): string | null {
  if (!hours) return null;
  const days = WEEKDAYS.filter((d) => hours[d]).map((d) => `${d.slice(0, 3)} ${hours[d]}`);
  if (days.length === 0) return null;
  return `${days.join(' · ')}${hours.timezone ? ` (${hours.timezone})` : ''}`;
}

/**
 * Retailer Console shell (M2) for RETAIL_ADMIN: exactly ONE physical store, the one the
 * backend verified at sign-in (docs/11_INTERFACE_CONTRACT.md). There is no store picker
 * and no list of the retailer's other stores: a Retail Admin never operates another store.
 * Inventory and reservations for this store arrive in later milestones.
 */
export function RetailerHome() {
  const me = useMe();
  if (me.scope !== 'RETAIL') return <Navigate to="/" replace />;
  const { store } = me;

  return (
    <ConsoleShell>
      <Section title="Your store">
        <dl>
          <dt>Retailer</dt>
          <dd>{me.retailer_name}</dd>
          <dt>Store</dt>
          <dd>{store.store_name}</dd>
          <dt>Store ID</dt>
          <dd className="mono">{store.store_id}</dd>
          <dt>City</dt>
          <dd>{store.city}</dd>
          <dt>Address</dt>
          <dd>{store.address ?? <span className="muted">not provided</span>}</dd>
          <dt>Status</dt>
          <dd>{store.store_status}</dd>
          <dt>Hours</dt>
          <dd>{hoursText(store.store_hours) ?? <span className="muted">not provided</span>}</dd>
        </dl>
      </Section>
      <Section title="Inventory and reservations">
        <p className="muted">
          Nothing to show yet. This store’s inventory and customer reservations appear here in a later milestone.
        </p>
      </Section>
    </ConsoleShell>
  );
}
