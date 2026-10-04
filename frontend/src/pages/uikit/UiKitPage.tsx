import { MapPin, Moon, PackageCheck, ShoppingBag, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Wordmark } from '../../components/shell/Wordmark';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  KpiTile,
  ProductThumb,
  Skeleton,
  StatusPill,
  Table,
  Tabs,
  Timeline,
  useToast,
} from '../../components/ui';

interface Row {
  id: string;
  product: string;
  store: string;
  status: string;
  qty: number;
}
const ROWS: Row[] = [
  { id: 'r1', product: 'Vitamin C Glow Serum 30 ml', store: 'Andheri Store', status: 'PENDING', qty: 1 },
  { id: 'r2', product: 'Niacinamide Serum 50 ml', store: 'Bandra Store', status: 'READY', qty: 2 },
  { id: 'r3', product: 'Ceramide Cream 50 ml', store: 'Andheri Store', status: 'COMPLETED', qty: 1 },
  { id: 'r4', product: 'Mineral Sunscreen 50 ml', store: 'Powai Store', status: 'CANCELLED', qty: 1 },
];

/**
 * LOCAL PROFILE ONLY: every UI kit component in every state (UI-0). Example content only;
 * nothing here calls the API.
 */
export function UiKitPage() {
  const toast = useToast();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [tab, setTab] = useState('active');
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);

  return (
    <div className="uikit">
      <header className="uikit__header">
        <Wordmark />
        <span className="ui-pill ui-pill--neutral">UI kit · local only · example content</span>
        <Button
          variant="secondary"
          size="sm"
          icon={theme === 'light' ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          {theme === 'light' ? 'Dark' : 'Light'} theme
        </Button>
      </header>

      <main className="uikit__grid">
        <Card title="Buttons" description="Primary, accent, secondary, ghost, danger, small, loading, disabled.">
          <div className="uikit__row">
            <Button>Primary</Button>
            <Button variant="accent">Accent</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button size="sm">Small</Button>
            <Button
              loading={loading}
              onClick={() => {
                setLoading(true);
                setTimeout(() => setLoading(false), 1500);
              }}
            >
              {loading ? 'Saving…' : 'Click to load'}
            </Button>
            <Button disabled>Disabled</Button>
          </div>
        </Card>

        <Card title="Pills" description="Status in words, coloured by meaning.">
          <div className="uikit__row">
            {['PENDING', 'CONFIRMED', 'READY', 'CUSTOMER_ARRIVED', 'COMPLETED', 'CANCELLED', 'SUSPENDED'].map((s) => (
              <StatusPill key={s} status={s} />
            ))}
            <Badge tone="primary">New</Badge>
            <Badge>Synthetic</Badge>
          </div>
        </Card>

        <Card title="KPI tiles" description="Example numbers.">
          <div className="ui-kpi-grid">
            <KpiTile label="Holds" value="42" sub="last 7 days" icon={<MapPin size={16} />} />
            <KpiTile label="Pickups" value="31" sub="74% of holds" icon={<PackageCheck size={16} />} synthetic />
            <KpiTile label="Store sales" value="₹24,650" estimated sub="quantity × store price" />
            <KpiTile label="Online orders" value="9" icon={<ShoppingBag size={16} />} />
          </div>
        </Card>

        <Card
          title="Table"
          description="Sticky header, scrolls inside the card, rows open with click or Enter."
          padded={false}
          className="uikit__table"
        >
          <Table
            caption="Example reservations"
            rows={ROWS}
            rowKey={(r) => r.id}
            onRowClick={(r) => toast.show(`Opened ${r.product}`, 'info')}
            columns={[
              {
                key: 'product',
                header: 'Product',
                render: (r) => (
                  <span className="uikit__product">
                    <ProductThumb name={r.product} size={32} />
                    {r.product}
                  </span>
                ),
              },
              { key: 'store', header: 'Store', render: (r) => r.store },
              { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
              { key: 'qty', header: 'Qty', numeric: true, render: (r) => r.qty },
            ]}
          />
        </Card>

        <Card title="Tabs">
          <Tabs
            label="Example tabs"
            value={tab}
            onChange={setTab}
            items={[
              { id: 'active', label: 'Active', count: 3 },
              { id: 'history', label: 'History' },
              { id: 'stock', label: 'Stock' },
            ]}
          />
          <p className="uikit__note">Selected: {tab}. Use ← → Home End on the tabs.</p>
        </Card>

        <Card title="States" description="Loading, empty, error.">
          <Skeleton lines={3} />
          <EmptyState action={<Button variant="secondary">Import a retail CSV</Button>}>
            No stock has been imported for this store yet.
          </EmptyState>
          <ErrorState
            message="Qwikspot can't reach its database right now. Please try again in a minute."
            reference="req_example_123"
            onRetry={() => toast.show('Retried', 'info')}
          />
        </Card>

        <Card title="Feedback" description="Toast, confirm dialog, drawer.">
          <div className="uikit__row">
            <Button variant="secondary" onClick={() => toast.show('Reservation confirmed. Customer notified.')}>
              Show toast
            </Button>
            <Button variant="danger" onClick={() => setDialog(true)}>
              Reset demo…
            </Button>
            <Button variant="secondary" onClick={() => setDrawer(true)}>
              Open drawer
            </Button>
          </div>
        </Card>

        <Card title="Timeline" description="Example journey.">
          <Timeline
            label="Example journey"
            items={[
              { id: '1', title: 'Viewed Serum 30 ml on the website', time: '6:40 pm', tone: 'neutral' },
              { id: '2', title: 'Asked on WhatsApp: "Need it today"', time: '6:41 pm', tone: 'info' },
              {
                id: '3',
                title: 'Held at Andheri Store',
                time: '6:42 pm',
                tone: 'primary',
                detail: 'Powai was out of stock; Andheri is 2.1 km away.',
              },
              { id: '4', title: 'Picked up — in-store purchase', time: '8:05 pm', tone: 'success' },
            ]}
          />
        </Card>
      </main>

      <ConfirmDialog
        open={dialog}
        title="This resets the shared demo for everyone."
        confirmLabel="Yes, reset the demo"
        tone="danger"
        onCancel={() => setDialog(false)}
        onConfirm={() => {
          setDialog(false);
          toast.show('Demo reset (example).');
        }}
      >
        All conversations, reservations and outcomes of the demo brand are deleted and rebuilt.
      </ConfirmDialog>
      <Drawer open={drawer} title="Demo controls" onClose={() => setDrawer(false)}>
        <p>Drawers hold secondary tools, such as the shopper demo controls.</p>
      </Drawer>
    </div>
  );
}
