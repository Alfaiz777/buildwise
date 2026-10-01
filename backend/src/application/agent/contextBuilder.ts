/**
 * The controlled context package (docs/04_DATA_MODEL.md §20), built by the backend from
 * the customer the pipeline resolved. It holds only this customer's own conversation data
 * and verified catalogue data; store facts are fetched by tools. The recommendation keeps
 * its hash and a PII-free summary, never the package itself.
 */
import { resolveMessagingSettings, onlineProductUrl } from '../../domain/brandSettings.js';
import { isProposalLive } from '../../domain/guardrail.js';
import { resolveReservationPolicy } from '../../domain/reservationStatus.js';
import { sha256Hex } from '../../lib/ids.js';
import type { AgentContext } from '../../ports/agent.js';
import type {
  ConversationRecord,
  ConversationRepository,
  CustomerRecord,
  IntentRecord,
  JsonValue,
} from '../../ports/conversationRepositories.js';
import type { BrandRecord, ProductRepository } from '../../ports/repositories.js';
import { alternativesOf, sheetOf } from './tools.js';

export const HISTORY_LIMIT = 10;

export async function buildAgentContext(
  deps: { products: ProductRepository; conversations: ConversationRepository },
  input: {
    brand: BrandRecord;
    customer: CustomerRecord;
    conversation: ConversationRecord;
    intent: IntentRecord | null;
    now: Date;
  },
): Promise<{ context: AgentContext; hash: string; summary: { [key: string]: JsonValue } }> {
  const { brand, customer, conversation, intent, now } = input;
  const settings = brand.settings ?? {};
  const messaging = resolveMessagingSettings(settings, brand.name);
  const policy = resolveReservationPolicy(settings);
  const [products, variants, messages] = await Promise.all([
    deps.products.listProducts(brand.brandId),
    deps.products.listVariants(brand.brandId),
    deps.conversations.listMessages(brand.brandId, conversation.conversationId),
  ]);

  const bound = intent?.productId ? products.find((p) => p.productId === intent.productId) : undefined;
  const sheets = bound ? [bound, ...alternativesOf(bound, products)].map((p) => sheetOf(p, variants, settings)) : [];
  const pending = isProposalLive(conversation.pendingProposal, now) ? conversation.pendingProposal : null;

  const context: AgentContext = {
    brand: {
      display_name: messaging.displayName,
      policy_summary: policy.reservationsEnabled
        ? `Reservations: up to ${policy.maxQuantityPerReservation} units, held ${policy.holdMinutes} min, pay at the store.${messaging.handoffEnabled ? ' Human handoff available.' : ''}`
        : `Reservations are not available.${messaging.handoffEnabled ? ' Human handoff available.' : ''}`,
      reservation_policy: {
        reservations_enabled: policy.reservationsEnabled,
        hold_minutes: policy.holdMinutes,
        max_quantity_per_reservation: policy.maxQuantityPerReservation,
      },
      handoff_enabled: messaging.handoffEnabled,
      online_purchase_available: onlineProductUrl(settings, 'x') !== null,
    },
    customer: {
      channel: conversation.channel,
      customer_ref: customer.displayRef,
      consent_state: customer.consentState,
      last_location: customer.lastLocation ? { ...customer.lastLocation } : null,
    },
    intent: intent
      ? {
          intent_id: intent.intentId,
          intent_type: intent.type,
          intent_stage: intent.stage,
          intent_strength: intent.strength,
          product_id: intent.productId,
          variant_id: intent.variantId,
          follow_up: intent.followUp
            ? { status: intent.followUp.status, template_name: intent.followUp.templateName }
            : null,
        }
      : null,
    products: sheets,
    history: messages
      .filter((m) => m.text)
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ direction: m.direction, text: m.text! })),
    pending_proposal: pending
      ? {
          store_id: pending.storeId,
          variant_id: pending.variantId,
          quantity: pending.quantity,
          proposed_at: pending.proposedAt,
          expires_at: pending.expiresAt,
          offered_stores: pending.offeredStores,
        }
      : null,
  };

  const summary: { [key: string]: JsonValue } = {
    intent_type: intent?.type ?? null,
    intent_stage: intent?.stage ?? null,
    product_ids: sheets.map((s) => s.product_id),
    location: customer.lastLocation ? customer.lastLocation.source : 'NONE',
    messages: context.history.length,
    pending_proposal: pending !== null,
    reservations_enabled: policy.reservationsEnabled,
  };
  return { context, hash: sha256Hex(JSON.stringify(context)), summary };
}
