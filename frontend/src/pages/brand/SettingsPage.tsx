import { useCallback } from 'react';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { Badge, Card, ErrorState, Skeleton } from '../../components/ui';
import { label } from '../../lib/labels';
import { ShopifyCard } from './ShopifyCard';

export interface BrandSettings {
  brand_id: string;
  messaging: { display_name: string; logo_url: string | null; powered_by_footer: boolean; handoff_enabled: boolean };
  follow_up: {
    inactivity_minutes: number;
    frequency_hours: number;
    types: { type: string; enabled: boolean; delay_minutes: number; priority: 'NORMAL' | 'HIGH' }[];
  };
  fulfilment: { home_delivery: boolean; delivery_days: string; radius_km: number; extended_radius_km: number };
  retail_freshness_hours: number;
  attribution_window_minutes: number;
  allowed_storefront_origins: string[];
  channel: { mode: 'SIMULATOR' | 'WHATSAPP' };
  /** L2-Shopify: where this server's catalogue comes from. */
  commerce?: { provider: 'MOCK' | 'SHOPIFY' };
}

/** "after 2 min", "after 1 h", "after 2 days". */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.round((minutes / 60) * 10) / 10} h`;
  const days = Math.round((minutes / 60 / 24) * 10) / 10;
  return `${days} day${days === 1 ? '' : 's'}`;
}

const INTENT_WORDS: Record<string, string> = {
  SEARCH_EXPLORATION: 'Searched, then left',
  PRODUCT_CONSIDERATION: 'Looked at a product, then left',
  CART_ABANDONMENT: 'Added to cart, then left',
  CHECKOUT_ABANDONMENT: 'Started checkout, then left',
  STORE_ORIENTED: 'Asked for a store, then left',
};

const OnOff = ({ on }: { on: boolean }) => <Badge tone={on ? 'success' : 'neutral'}>{on ? 'On' : 'Off'}</Badge>;

/**
 * Brand Console → Settings (docs/11 §4; Change 16, UI-3; audit P1-5): how Qwikspot works
 * for this brand, read-only, exactly as the backend resolves it (GET /api/brand/settings).
 */
export function SettingsPage() {
  const api = useApi();
  const settings = useLoad(useCallback(() => api.get<BrandSettings>('/api/brand/settings'), [api]));
  const s = settings.data;
  return (
    <ConsoleShell>
      {settings.error && <ErrorState message={settings.error} onRetry={settings.reload} />}
      {!s && !settings.error && <Skeleton lines={6} />}
      {s && (
        <>
          <ShopifyCard provider={s.commerce?.provider ?? 'MOCK'} />

          <Card
            title="How Qwikspot follows up for you"
            description="Shoppers who leave are followed up on WhatsApp only when they opted in and the type is on."
          >
            <div className="ui-table-wrap">
              <table aria-label="Follow-up policy">
                <thead>
                  <tr>
                    <th>When a shopper…</th>
                    <th>Follow-up</th>
                    <th>Sent after</th>
                    <th>Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {s.follow_up.types.map((t) => (
                    <tr key={t.type}>
                      <td>{INTENT_WORDS[t.type] ?? label(t.type)}</td>
                      <td>
                        <OnOff on={t.enabled} />
                      </td>
                      <td>{t.enabled ? duration(t.delay_minutes) : '—'}</td>
                      <td>{t.priority === 'HIGH' ? 'High' : 'Normal'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small">
              Qwikspot waits for {duration(s.follow_up.inactivity_minutes)} without activity before a session counts as
              left, and sends at most one follow-up per customer every {duration(s.follow_up.frequency_hours * 60)}.
              Browsing only (a visit or a product glance) is never followed up.
            </p>
          </Card>

          <Card title="Conversations">
            <dl className="settings-list">
              <dt>Sender name customers see</dt>
              <dd>{s.messaging.display_name}</dd>
              <dt>Logo</dt>
              <dd>
                {s.messaging.logo_url ? (
                  <img className="settings-logo" src={s.messaging.logo_url} alt={`${s.messaging.display_name} logo`} />
                ) : (
                  'None'
                )}
              </dd>
              <dt>A customer can ask for a person</dt>
              <dd>
                <OnOff on={s.messaging.handoff_enabled} />
              </dd>
              <dt>"Powered by Qwikspot" footer</dt>
              <dd>
                <OnOff on={s.messaging.powered_by_footer} />{' '}
                <span className="muted small">Only under automated messages with buttons, lists or images.</span>
              </dd>
            </dl>
          </Card>

          <Card title="Stores and outcomes">
            <dl className="settings-list">
              <dt>Stores offered for pickup today</dt>
              <dd>
                Within {s.fulfilment.radius_km} km. If a store can&apos;t fulfil a hold and none is that close, the
                nearest one within {s.fulfilment.extended_radius_km} km is still offered, with its distance.
              </dd>
              <dt>Home delivery shown next to pickup</dt>
              <dd>
                {s.fulfilment.home_delivery
                  ? `In ${s.fulfilment.delivery_days} ${s.fulfilment.delivery_days === '1' ? 'day' : 'days'}`
                  : 'Off (no online store link)'}
              </dd>
              <dt>Store stock counts as stale after</dt>
              <dd>{duration(s.retail_freshness_hours * 60)} (customers are told when it was last updated)</dd>
              <dt>A purchase counts for a conversation for</dt>
              <dd>{duration(s.attribution_window_minutes)} after the last message</dd>
            </dl>
          </Card>

          <Card title="Storefront and channel">
            <dl className="settings-list">
              <dt>Storefronts allowed to send shopper events</dt>
              <dd>
                {s.allowed_storefront_origins.length ? (
                  <ul className="plain">
                    {s.allowed_storefront_origins.map((o) => (
                      <li key={o} className="mono small">
                        {o}
                      </li>
                    ))}
                  </ul>
                ) : (
                  'None yet'
                )}
              </dd>
              <dt>Customer channel</dt>
              <dd>
                {s.channel.mode === 'WHATSAPP'
                  ? 'WhatsApp'
                  : 'Simulator now; WhatsApp when the live channel is connected'}
              </dd>
            </dl>
          </Card>
          <p className="muted small">Settings are read-only in this prototype.</p>
        </>
      )}
    </ConsoleShell>
  );
}
