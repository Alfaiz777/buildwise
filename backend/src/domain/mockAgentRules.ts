/**
 * The MockAgentRuntime's deterministic message rules (docs/05_AI_AGENT_SPEC.md §9.2,
 * docs/00 §11.8 Change 12). Only the classification lives here; the runtime turns a
 * class into tool calls and an AgentDecision. Rules are checked in this order.
 */
import { isHumanRequest } from './conversationPolicy.js';
import { parseOption, type ParsedOption } from './agentReplies.js';

export type MockRule =
  | { rule: 'REFUSE' }
  | { rule: 'HUMAN' }
  | { rule: 'CANCEL'; reservationId: string | null }
  | { rule: 'HOLD'; storeId: string | null }
  | { rule: 'BUY_ONLINE' }
  | { rule: 'OTHER_STORES' }
  | { rule: 'STORE_SEARCH'; fromLocation: boolean; variantId?: string }
  | { rule: 'EDUCATE' }
  | { rule: 'COMPARE' }
  | { rule: 'CLARIFY' };

const INJECTION =
  /\b(ignore (all |your |previous |the )*(instructions|rules|prompt)|system prompt|developer mode|jailbreak|private data|personal data|api key|password|credentials?|admin access|all customers|other customers?|another customer'?s?|someone else'?s?|other people'?s?)\b/i;
const CANCEL = /\b(cancel|don'?t need (it|the (hold|reservation)) anymore)\b/i;
const HOLD = /\b(reserve|hold|book) (it|one|this|that|1|a unit)\b|^\s*(reserve|hold)( it)?\s*[.!]?\s*$/i;
const BUY_ONLINE = /\b(buy|order) (it )?online\b/i;
const OTHER_STORE = /\b(another|other|different) (store|shop|branch|location)s?\b/i;
const STORE_SEARCH =
  /\b(today|tonight|right now|asap|urgent(ly)?|nearby|near me|near by|close to me|closest|nearest|in store|pick ?up|store near|shop near|available near|get it near|need it)\b/i;
const EDUCATE =
  /\b(oily|dry|sensitive|combination|skin|ingredients?|contain|suitable|good for|texture|how (to|do i) use|when (to|should i) use|morning|night)\b/i;
const COMPARE = /\b(which (one|should)|compare|comparison|difference|differ|vs\.?|versus|better)\b/i;

export function classifyMessage(input: {
  text: string | null;
  optionId: string | null;
  isLocation: boolean;
  /** The text names an area that matches a store locality (resolved by the runtime's tool). */
  mentionsArea: boolean;
}): MockRule {
  if (input.isLocation) return { rule: 'STORE_SEARCH', fromLocation: true };
  if (input.optionId) {
    const option: ParsedOption = parseOption(input.optionId);
    if (option.kind === 'HOLD') return { rule: 'HOLD', storeId: option.storeId };
    if (option.kind === 'CANCEL') return { rule: 'CANCEL', reservationId: option.reservationId };
    if (option.kind === 'BUY_ONLINE') return { rule: 'BUY_ONLINE' };
    if (option.kind === 'OTHER_STORES') return { rule: 'OTHER_STORES' };
    if (option.kind === 'HANDOFF') return { rule: 'HUMAN' };
    // M6: "Check stores again" after an expired hold — a fresh search for that variant.
    if (option.kind === 'RECHECK') return { rule: 'STORE_SEARCH', fromLocation: true, variantId: option.variantId };
    return { rule: 'CLARIFY' };
  }
  const text = input.text ?? '';
  if (INJECTION.test(text)) return { rule: 'REFUSE' };
  if (isHumanRequest(text)) return { rule: 'HUMAN' };
  if (CANCEL.test(text)) return { rule: 'CANCEL', reservationId: null };
  if (HOLD.test(text)) return { rule: 'HOLD', storeId: null };
  if (BUY_ONLINE.test(text)) return { rule: 'BUY_ONLINE' };
  if (OTHER_STORE.test(text)) return { rule: 'OTHER_STORES' };
  if (COMPARE.test(text)) return { rule: 'COMPARE' };
  if (STORE_SEARCH.test(text) || input.mentionsArea) return { rule: 'STORE_SEARCH', fromLocation: false };
  if (EDUCATE.test(text)) return { rule: 'EDUCATE' };
  return { rule: 'CLARIFY' };
}
