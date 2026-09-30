/**
 * Forward dispatch (docs/00 §11.8 Change 12, E3): after GUARDRAIL and TOOLS, commerce
 * replies are (re)built from verified tool results of THIS run, so a runtime's own text can
 * never state a store fact, stock level or reservation detail that no tool returned.
 */
import type { NearbyStoresOutput, ProductContextOutput, ReservationToolOutput } from '../../domain/agentTools.js';
import {
  blockedPrefix,
  cancelNotFoundReply,
  cancelledReply,
  confirmationReply,
  discoveryReply,
  noEligibleStoreReply,
  noPendingHoldReply,
  onlinePurchaseReply,
  refusalReply,
  type Reply,
} from '../../domain/agentReplies.js';
import type { AgentDecision } from '../../ports/agent.js';
import type { AgentToolExecutor } from './toolExecutor.js';

export interface GuardrailOutcome {
  status: 'ALLOWED' | 'BLOCKED';
  reason: string | null;
  /** What was checked: CREATE_RESERVATION, CANCEL_RESERVATION or OFFERED_STORES. */
  checked: string | null;
  storeId: string | null;
  storeName: string | null;
  variantId: string | null;
}

export async function composeReply(input: {
  decision: AgentDecision;
  guardrail: GuardrailOutcome;
  tools: AgentToolExecutor;
  canHold: boolean;
  now: Date;
}): Promise<Reply> {
  const { decision, guardrail, tools } = input;
  const executed = tools.calls.filter((c) => c.phase === 'EXECUTE');
  const create = executed.find((c) => c.tool === 'create_reservation');
  const cancel = executed.find((c) => c.tool === 'cancel_reservation');

  // 1. The outcome of an executed write.
  if (create) {
    const out = create.output as ReservationToolOutput | null;
    if (create.status === 'EXECUTED' && out?.reservation) return confirmationReply(out, input.now);
    // Lost race / rejected in the transaction: verified reason + a safe alternative.
    return safeAlternative(
      input,
      out?.reason ?? create.reasonCode ?? 'NOT_ELIGIBLE',
      out?.store?.store_name ?? guardrail.storeName,
    );
  }
  if (cancel) {
    const out = cancel.output as ReservationToolOutput | null;
    return cancel.status === 'EXECUTED' && out ? cancelledReply(out) : cancelNotFoundReply();
  }

  // 2. A guardrail block: nothing executed; explain with the verified reason, offer a safe alternative.
  if (guardrail.status === 'BLOCKED') {
    if (guardrail.checked === 'CANCEL_RESERVATION') return cancelNotFoundReply();
    if (guardrail.reason === 'SCOPE_VIOLATION') return refusalReply();
    if (guardrail.reason === 'AMBIGUOUS') return noPendingHoldReply();
    return safeAlternative(input, guardrail.reason ?? 'NOT_ELIGIBLE', guardrail.storeName);
  }

  // 3. Read-only commerce actions: rebuilt from this run's tool results.
  const action = decision.next_best_action.action;
  const finds = tools.outputsOf<NearbyStoresOutput>('find_nearby_stores');
  if (action === 'STORE_DISCOVERY') {
    const find = [...finds]
      .reverse()
      .find((f) => f.output.variant?.variant_id === decision.next_best_action.variant_id);
    const rebuilt = find ? discoveryReply(find.output, { canHold: input.canHold }) : null;
    if (rebuilt) return rebuilt;
  }
  if (action === 'ALTERNATIVE_PRODUCT' || action === 'ONLINE_PURCHASE') {
    const primary = finds.find((f) => f.output.status === 'OK' && f.output.eligible.length === 0)?.output;
    const alt = finds.find(
      (f) => f.output.variant?.variant_id === decision.next_best_action.variant_id && f.output.eligible.length > 0,
    )?.output;
    if (primary?.variant) {
      return noEligibleStoreReply({
        variant: primary.variant,
        alternative:
          action === 'ALTERNATIVE_PRODUCT' && alt?.variant && alt.eligible[0]
            ? { variant: alt.variant, store: alt.eligible[0] }
            : null,
        canHold: input.canHold,
      });
    }
    if (action === 'ONLINE_PURCHASE') {
      const product = tools.outputsOf<ProductContextOutput>('get_product_context').at(-1)?.output.product;
      if (product) return onlinePurchaseReply({ title: product.title, url: product.online_url });
    }
  }
  return decision.reply;
}

/** A fresh store search excluding the blocked store: another eligible store, else online. */
async function safeAlternative(
  input: { decision: AgentDecision; guardrail: GuardrailOutcome; tools: AgentToolExecutor; canHold: boolean },
  reason: string,
  storeName: string | null,
): Promise<Reply> {
  const prefix = blockedPrefix(storeName, reason);
  const variantId = input.guardrail.variantId ?? input.decision.next_best_action.variant_id;
  if (!variantId) return { message_type: 'TEXT', text: `${prefix} Tell me your area and I'll check other stores.` };
  const exclude = input.guardrail.storeId ? [input.guardrail.storeId] : [];
  const result = await input.tools.execute({
    tool: 'find_nearby_stores',
    input: { variant_id: variantId, ...(exclude.length ? { skip_stores: exclude } : {}) },
  });
  const find = result.status === 'EXECUTED' ? (result.output as NearbyStoresOutput) : null;
  if (find) {
    const reply = discoveryReply(
      { ...find, skipped_stores: [] },
      { canHold: input.canHold, prefix: `${prefix} Good news:` },
    );
    if (reply) return reply;
    if (find.variant) return noEligibleStoreReply({ variant: find.variant, alternative: null, prefix });
  }
  return { message_type: 'TEXT', text: `${prefix} Tell me your area and I'll check other stores.` };
}
