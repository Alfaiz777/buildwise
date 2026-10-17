import { ArrowRight } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useApi } from '../../api/apiContext';
import { ConsoleShell, useLoad } from '../../components/ConsoleShell';
import { Badge, Card, ErrorState, Skeleton } from '../../components/ui';
import { label } from '../../lib/labels';
import { PageHeader } from '../platform/PlatformChrome';
import { StatusDot } from './StatusDot';
import './brand.css';
import './settings.css';
import { ShopifyCard } from './ShopifyCard';
import { StorefrontOrigins } from './StorefrontOrigins';
import { WhatsAppCard } from './WhatsAppCard';

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
  /** Per brand (L2-WhatsApp): WhatsApp only with the brand's own connected number. */
  channel: {
    mode: 'SIMULATOR' | 'WHATSAPP';
    whatsapp?: { display_phone_number: string | null; verified_name: string | null; status: string } | null;
  };
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

const SECTIONS = [
  { id: 'channels', label: 'Channels' },
  { id: 'follow-ups', label: 'Follow-ups' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'stores', label: 'Stores and outcomes' },
];

/**
 * Brand Console → Settings (docs/11 §4; Change 16, UI-3; audit P1-5; UI-P3 layout): how
 * Qwikspot works for this brand, exactly as the backend resolves it (GET /api/brand/settings),
 * in four sections with a sub-nav: channels (WhatsApp, Shopify, storefronts) with a status dot
 * each, the follow-up policy as readable cards, conversations, and stores and outcomes.
 */
export function SettingsPage() {
  const api = useApi();
  const settings = useLoad(useCallback(() => api.get<BrandSettings>('/api/brand/settings'), [api]));
  const [policyTable, setPolicyTable] = useState(false);
  const s = settings.data;
  return (
    <ConsoleShell>
      <PageHeader
        title="Settings"
        purpose="How Qwikspot works for your brand: your channels, follow-ups, conversations and stores."
      />
      {settings.error && <ErrorState message={settings.error} onRetry={settings.reload} />}
      {!s && !settings.error && <Skeleton lines={6} />}
      {s && (
        <div className="set-layout">
          <nav className="set-nav" aria-label="Settings sections">
            {SECTIONS.map((x) => (
              <a key={x.id} href={`#${x.id}`}>
                {x.label}
              </a>
            ))}
          </nav>
          <div className="set-sections">
            <section id="channels" className="set-section" aria-labelledby="set-channels">
              <h2 id="set-channels" className="set-section__title">
                Channels
              </h2>
              <WhatsAppCard />
              <ShopifyCard provider={s.commerce?.provider ?? 'MOCK'} />
              <Card
                title="Storefront and channel"
                description="Where shopper events may come from, and how customers reach you."
                actions={
                  <StatusDot
                    state={s.allowed_storefront_origins.length ? 'connected' : 'off'}
                    text={
                      s.allowed_storefront_origins.length
                        ? `${s.allowed_storefront_origins.length} storefront${s.allowed_storefront_origins.length === 1 ? '' : 's'}`
                        : undefined
                    }
                  />
                }
              >
                <dl className="settings-list">
                  <dt>Storefronts allowed to send shopper events</dt>
                  <dd>
                    <StorefrontOrigins origins={s.allowed_storefront_origins} onSaved={settings.reload} />
                  </dd>
                  <dt>Customer channel</dt>
                  <dd>
                    <StatusDot
                      state={s.channel.mode === 'WHATSAPP' && s.channel.whatsapp ? 'connected' : 'simulator'}
                    />{' '}
                    {s.channel.mode === 'WHATSAPP' && s.channel.whatsapp
                      ? `WhatsApp: ${s.channel.whatsapp.display_phone_number ?? ''}${s.channel.whatsapp.verified_name ? ` (${s.channel.whatsapp.verified_name})` : ''}`
                      : 'Simulator — WhatsApp once your number is connected'}
                  </dd>
                </dl>
              </Card>
            </section>

            <section id="follow-ups" className="set-section" aria-labelledby="set-follow-ups">
              <h2 id="set-follow-ups" className="set-section__title">
                Follow-ups
              </h2>
              <Card
                title="How Qwikspot follows up for you"
                description="Shoppers who leave are followed up on WhatsApp only when they opted in and the type is on."
              >
                {policyTable ? (
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
                ) : (
                  <ul className="set-policy" aria-label="Follow-up rules">
                    {s.follow_up.types.map((t) => (
                      <li key={t.type} className={`set-rule${t.enabled ? '' : ' is-off'}`}>
                        <span className="set-rule__when">{INTENT_WORDS[t.type] ?? label(t.type)}</span>
                        <ArrowRight size={14} aria-hidden="true" className="set-rule__arrow" />
                        <span className="set-rule__what">
                          {t.enabled ? 'A WhatsApp follow-up' : 'No follow-up'}{' '}
                          {t.priority === 'HIGH' && t.enabled && <Badge tone="warning">High priority</Badge>}
                        </span>
                        <ArrowRight size={14} aria-hidden="true" className="set-rule__arrow" />
                        <span className="set-rule__when-sent">
                          {t.enabled ? `after ${duration(t.delay_minutes)}` : <OnOff on={false} />}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" className="ui-link-button small" onClick={() => setPolicyTable(!policyTable)}>
                  {policyTable ? 'Show as cards' : 'Show as table'}
                </button>
                <p className="small">
                  Qwikspot waits for {duration(s.follow_up.inactivity_minutes)} without activity before a session counts
                  as left, and sends at most one follow-up per customer every{' '}
                  {duration(s.follow_up.frequency_hours * 60)}. Browsing only (a visit or a product glance) is never
                  followed up.
                </p>
              </Card>
            </section>

            <section id="conversations" className="set-section" aria-labelledby="set-conversations">
              <h2 id="set-conversations" className="set-section__title">
                Conversations
              </h2>
              <Card>
                <dl className="settings-list">
                  <dt>Sender name customers see</dt>
                  <dd>{s.messaging.display_name}</dd>
                  <dt>Logo</dt>
                  <dd>
                    {s.messaging.logo_url ? (
                      <img
                        className="settings-logo"
                        src={s.messaging.logo_url}
                        alt={`${s.messaging.display_name} logo`}
                      />
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
            </section>

            <section id="stores" className="set-section" aria-labelledby="set-stores">
              <h2 id="set-stores" className="set-section__title">
                Stores and outcomes
              </h2>
              <Card>
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
              <p className="muted small">Apart from the storefronts above, settings are read-only in this prototype.</p>
            </section>
          </div>
        </div>
      )}
    </ConsoleShell>
  );
}
