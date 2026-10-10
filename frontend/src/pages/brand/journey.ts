import { formatPrice } from './types';
import { EVENT_TEXT, humanize, REFUSAL_TEXT, type ConversationDetail } from './conversationTypes';
import { whySentence } from './whySentence';

/**
 * The journey of one conversation as a single timeline (Change 16, UI-3; audit P0-2):
 * website events → chat → AI decisions → hold → store steps → outcome. Built only from
 * the conversation detail; the transcript itself stays in the Messages card.
 */
export type JourneyTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
export interface JourneyStep {
  id: string;
  at: string;
  title: string;
  detail?: string;
  tone: JourneyTone;
  /** The outcome always closes the journey. */
  final?: boolean;
}

const money = (value: number, currency: string | null) => formatPrice(value, currency ?? 'INR');

export function buildJourney(d: ConversationDetail): JourneyStep[] {
  const steps: JourneyStep[] = [];
  const product = d.intent?.product_title ?? null;

  // 1. The website.
  (d.web_events ?? []).forEach((e, i) => {
    const id = `web-${i}`;
    switch (e.event_type) {
      case 'PRODUCT_VIEW':
      case 'PRODUCT_DETAIL_VIEW':
        steps.push({
          id,
          at: e.at,
          title: product ? `Opened ${product}` : (EVENT_TEXT[e.event_type] ?? ''),
          tone: 'neutral',
        });
        break;
      case 'WHATSAPP_CLICK':
        steps.push({
          id,
          at: e.at,
          title: e.details.entry === 'STORE_NEED' ? 'Tapped "Need it today?"' : 'Tapped "Chat on WhatsApp"',
          tone: 'primary',
        });
        break;
      case 'FOLLOW_UP_SENT':
        steps.push({
          id,
          at: e.at,
          title: 'Follow-up sent',
          detail: e.details.message_kind === 'TEMPLATE' ? 'As an approved template message' : 'As a session message',
          tone: 'info',
        });
        break;
      case 'FOLLOW_UP_SUPPRESSED':
        steps.push({
          id,
          at: e.at,
          title: 'Follow-up not sent',
          detail: humanize(String(e.details.reason ?? '')),
          tone: 'neutral',
        });
        break;
      case 'ORDER_CREATED':
        steps.push({ id, at: e.at, title: 'Placed an order online', tone: 'success' });
        break;
      default:
        steps.push({ id, at: e.at, title: EVENT_TEXT[e.event_type] ?? humanize(e.event_type), tone: 'neutral' });
    }
  });

  // 2. The chat: how it started, locations shared, a person taking over.
  const messages = d.messages ?? [];
  const inbound = messages.filter((m) => m.direction === 'INBOUND');
  const first = inbound[0];
  if (first) {
    steps.push({
      id: `msg-${first.message_id}`,
      at: first.timestamp,
      title: 'Started a WhatsApp chat',
      detail: first.text ? `"${first.text.slice(0, 80)}"` : undefined,
      tone: 'primary',
    });
  }
  for (const m of inbound) {
    if (m.location) {
      steps.push({ id: `loc-${m.message_id}`, at: m.timestamp, title: 'Shared a location', tone: 'neutral' });
    }
  }
  if (d.handoff_at) steps.push({ id: 'handoff', at: d.handoff_at, title: 'Asked for a person', tone: 'warning' });
  const firstHuman = messages.find((m) => m.origin === 'HUMAN_AGENT');
  if (firstHuman) {
    steps.push({
      id: `human-${firstHuman.message_id}`,
      at: firstHuman.timestamp,
      title: 'Your team replied',
      tone: 'info',
    });
  }

  // 3. Decisions, holds and the store's steps.
  const outcomes = d.outcomes ?? [];
  for (const r of d.recommendations ?? []) {
    if (r.action === 'NO_ACTION') continue;
    const blocked = r.guardrail_status === 'BLOCKED';
    const res = r.reservation;
    const title = blocked
      ? 'Hold not placed'
      : res
        ? `Hold placed at ${res.store_name}`
        : r.action === 'STORE_DISCOVERY'
          ? 'Qwikspot looked for a store'
          : r.action === 'ONLINE_PURCHASE'
            ? 'Sent the online store link'
            : r.action === 'HUMAN_HANDOFF'
              ? 'Handed to your team'
              : `Qwikspot: ${humanize(r.action)}`;
    const held = res
      ? `${res.quantity ?? 1} × ${[res.product_title, res.variant_title].filter(Boolean).join(' ') || 'item'}. `
      : '';
    steps.push({
      id: `rec-${r.recommendation_id}`,
      at: r.proposed_at,
      title,
      detail: `${held}${whySentence(r)}`,
      tone: blocked ? 'warning' : res ? 'success' : 'info',
    });
    if (!res) continue;
    const pickedUp = outcomes.some((o) => o.reservation_id === res.reservation_id && o.purchase_type !== 'NONE');
    for (const s of res.status_history ?? []) {
      const id = `res-${res.reservation_id}-${s.status}`;
      switch (s.status) {
        case 'CONFIRMED':
          steps.push({ id, at: s.at, title: `${res.store_name} confirmed the hold`, tone: 'info' });
          break;
        case 'READY':
          steps.push({ id, at: s.at, title: `Ready for pickup at ${res.store_name}`, tone: 'info' });
          break;
        case 'CUSTOMER_ARRIVED':
          steps.push({ id, at: s.at, title: `Customer arrived at ${res.store_name}`, tone: 'info' });
          break;
        case 'COMPLETED':
          if (!pickedUp) steps.push({ id, at: s.at, title: `Picked up at ${res.store_name}`, tone: 'success' });
          break;
        case 'CANCELLED':
          steps.push({
            id,
            at: s.at,
            title:
              s.by === 'RETAILER'
                ? `${res.store_name} refused: ${REFUSAL_TEXT[s.reason ?? ''] ?? 'no reason given'}`
                : s.by === 'CUSTOMER'
                  ? 'Customer cancelled the hold'
                  : 'Hold cancelled',
            tone: s.by === 'RETAILER' ? 'danger' : 'neutral',
          });
          break;
        case 'EXPIRED':
          steps.push({ id, at: s.at, title: 'Hold expired — not collected', tone: 'neutral' });
          break;
      }
    }
  }

  steps.sort((a, b) => a.at.localeCompare(b.at));

  // 4. The outcome closes the journey.
  for (const o of outcomes) {
    steps.push({ id: `out-${o.timestamp}-${o.purchase_type}`, at: o.timestamp, final: true, ...outcomeText(o) });
  }
  return steps;
}

export function outcomeText(o: NonNullable<ConversationDetail['outcomes']>[number]): {
  title: string;
  detail?: string;
  tone: JourneyTone;
} {
  const value = o.value > 0 ? ` · ${money(o.value, o.currency)} est.` : '';
  if (o.cancelled_at) {
    return {
      title: o.purchase_type === 'OFFLINE' ? 'Purchase cancelled' : 'Ordered online — order cancelled',
      detail: 'The order was cancelled, so it no longer counts as a sale.',
      tone: 'neutral',
    };
  }
  switch (o.purchase_type) {
    case 'OFFLINE':
      return { title: `Picked up at ${o.store_name ?? 'the store'} — in-store purchase${value}`, tone: 'success' };
    case 'ONLINE':
      return { title: `Ordered online${value}`, tone: 'success' };
    case 'ALTERNATIVE':
      return { title: `Bought an alternative product${value}`, tone: 'success' };
    default:
      return {
        title: 'No purchase recorded',
        detail: 'Nothing was bought within the attribution window.',
        tone: 'neutral',
      };
  }
}
