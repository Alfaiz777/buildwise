/**
 * L5 (natural replies): the short, conversational answers to a turn that needs no commerce
 * action — thanks, "later", "ok", bye, a greeting, a compliment, a complaint, an off-topic
 * message (docs/05 §16). Pure: no I/O.
 *
 * - The rules runtime (mock / backup) answers these with the fixed texts below.
 * - Gemini writes its own text for them; `checkConversationalText` keeps that text short and
 *   free of commerce facts (prices, stock, stores, distances, delivery times, promises). A text
 *   that fails falls back to the deterministic reply.
 * - `finishConversationalReply` applies the turn rules to either: no buttons after a closing
 *   (thanks / later / bye), the "Talk to a person" button after a complaint.
 */
import { OPTION, type Reply } from './agentReplies.js';

export const TURN_TYPES = [
  'GREETING',
  'THANKS',
  'LATER',
  'OK',
  'BYE',
  'COMPLIMENT',
  'COMPLAINT',
  'OFF_TOPIC',
  'CLARIFY',
] as const;
export type TurnType = (typeof TURN_TYPES)[number];

/** Turns that end the conversation for now: no sales question, no buttons. */
export const CLOSING_TURNS: readonly TurnType[] = ['THANKS', 'LATER', 'BYE'];
/** Turns answered with a short free text (the limits of `checkConversationalText` apply). */
export const SOCIAL_TURNS: readonly TurnType[] = [
  'GREETING',
  'THANKS',
  'LATER',
  'OK',
  'BYE',
  'COMPLIMENT',
  'COMPLAINT',
  'OFF_TOPIC',
];

export const CONVERSATIONAL_MAX_CHARS = 250;
export const CONVERSATIONAL_MAX_SENTENCES = 2;
export const CONVERSATIONAL_MAX_EMOJI = 1;

export type Language = 'ENGLISH' | 'HINDI' | 'HINGLISH';

const DEVANAGARI = /[ऀ-ॿ]/;
/** Common Hindi words written in Latin script. Two of them (or one in a short message) → Hinglish. */
const HINGLISH_WORDS =
  /\b(hai|hain|hoon|hun|nahi|nahin|nhi|kya|kab|kal|aaj|abhi|baad|mein|mujhe|mera|meri|aap|aapka|aapke|aapko|kitne|kitna|milega|milegi|chahiye|theek|thik|accha|achha|acha|haan|bhai|yaar|dekhta|dekhti|lunga|lungi|karunga|karungi|shukriya|dhanyavaad|dhanyawad|bas|bohot|bahut|kaise|kaisa|kaun|kahan|wala|wali|jaldi|bekaar|bakwas|koi|baat|jab|bhi|yahan|wahan|dena|phir|karna|karo|kar|ke|ki|ko|se|ho|bata|bataiye|sakta|sakti|chahenge|swagat|kuch|aur|liye|hamare|hamari|samajh|dhoond|paas)\b/gi;

/** The language a customer wrote in: Devanagari → Hindi; Hindi words in Latin script → Hinglish. */
export function detectLanguage(text: string): Language {
  if (DEVANAGARI.test(text)) return 'HINDI';
  const hits = text.match(HINGLISH_WORDS)?.length ?? 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return hits >= 2 || (hits === 1 && words <= 4) ? 'HINGLISH' : 'ENGLISH';
}

const EMOJI = /\p{Extended_Pictographic}/gu;
/** Emoji, punctuation and spaces only ("👍", "🙏🙏", "😊!") — a reaction, not a question. */
const REACTION_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s!.]+$/u;

const COMPLAINT =
  /\b(useless|not helpful|unhelpful|no help|why (so|is it so|are you so) slow|so slow|too slow|very slow|waste of (my )?time|not working|doesn'?t work|frustrat\w*|annoying|terrible|worst|stupid bot|bekaar|bakwas|bakvas)\b/i;
const OFF_TOPIC =
  /\b(weather|rain|cricket|ipl|match score|football|joke|movie|film|song|news|politics|election|who are you|what are you|are you (a |an )?(bot|human|robot|ai|real)|what'?s your name|your name|how are you|kaise ho|aap kaun)\b/i;
const BYE = /\b(bye+|goodbye|good night|gn|see you|see ya|cya|ttyl|tata|alvida|chalo bye|take care)\b/i;
const LATER =
  /\b(later|some ?time later|not now|another time|some other time|next time|maybe later|will (buy|order|get|check|think|come back)|i'?ll (buy|order|get|check|think|come back)|baad (me|mein|main)|abhi nahi|abhi nahin|sochke|soch ke|dekhta hu|dekhti hu|dekhte hai)\b/i;
const THANKS = /\b(thanks?|thank (you|u)|thx|thnx|tnx|ty|tysm|dhanyavaad|dhanyawad|shukriya)\b|🙏|धन्यवाद|शुक्रिया/i;
const COMPLIMENT =
  /\b(great|awesome|amazing|nice|lovely|love (it|this|you)|perfect|super|helpful|good job|well done|wonderful)\b/i;
// The whole message, then only punctuation or emoji (no \b: it does not work after Devanagari letters).
const GREETING =
  /^(hi+|hello+|hey+|helo|namaste|namaskar|hola|good (morning|afternoon|evening)|नमस्ते|नमस्कार)[\s\p{P}\p{Extended_Pictographic}]*$/iu;
const OK_ONLY =
  /^(ok+|okay|okie|k+|kk|alright|all right|fine|cool|got it|sure|noted|hmm+|theek hai|thik hai|thik h|accha|achha|acha|haan|ha|ji|ठीक है|अच्छा|हाँ|हां)[\s\p{P}\p{Extended_Pictographic}]*$/iu;

/** A question about a product, a store, a price or an order: never small talk. */
const COMMERCE_QUESTION =
  /\?|\b(price|cost|how much|kitne|kitna|mrp|stock|available|store|shop|near|deliver|order|buy now|reserve|hold|pick ?up|size|ml|skin|oily|dry|sensitive|ingredient|milega|milegi|chahiye)\b/i;

/**
 * The social turn a message is, or null when it asks for something. Strict on purpose: a
 * message that also asks a product, store or order question is not small talk ("thanks, is it
 * good for oily skin?" is a product question).
 */
export function classifyTurn(text: string | null | undefined): TurnType | null {
  const t = (text ?? '').trim();
  if (!t || t.length > 160) return null;
  if (REACTION_ONLY.test(t)) return /🙏|❤|♥|😍|🥰/u.test(t) ? 'THANKS' : 'OK';
  if (COMPLAINT.test(t)) return 'COMPLAINT';
  if (OFF_TOPIC.test(t) && !/\b(price|stock|store|order|skin|serum|cream|sunscreen|cleanser)\b/i.test(t))
    return 'OFF_TOPIC';
  const question = COMMERCE_QUESTION.test(t.replace(/\b(buy|order|check) it later\b/gi, ''));
  if (BYE.test(t) && !question) return 'BYE';
  if (LATER.test(t) && !/\?/.test(t)) return 'LATER';
  if (THANKS.test(t) && !question) return 'THANKS';
  if (GREETING.test(t)) return 'GREETING';
  if (OK_ONLY.test(t)) return 'OK';
  if (COMPLIMENT.test(t) && !question && t.split(/\s+/).length <= 8) return 'COMPLIMENT';
  return null;
}

type Texts = Record<Language, string>;
const product = (title: string | null, fallback: string) => (title ? `*${title}*` : fallback);

/**
 * The rules runtime's fixed answer to a social turn, in the customer's language. Only the
 * product's name may appear; no price, stock, store or promise.
 */
export function socialReply(input: {
  turn: TurnType;
  language: Language;
  productTitle: string | null;
  brandName: string;
  handoffEnabled: boolean;
}): Reply {
  const { turn, language, productTitle, handoffEnabled } = input;
  const pick = (texts: Texts) => texts[language];
  const text = (texts: Texts): Reply => ({ message_type: 'TEXT', text: pick(texts) });
  switch (turn) {
    case 'THANKS':
      return text({
        ENGLISH: "You're welcome! 😊 Message me here anytime you need anything.",
        HINGLISH: 'Aapka swagat hai! 😊 Kabhi bhi kuch chahiye ho, yahan message kar dena.',
        HINDI: 'आपका स्वागत है! 😊 कभी भी कुछ चाहिए हो, यहाँ मैसेज कर दीजिए।',
      });
    case 'LATER':
      return text({
        ENGLISH: "No problem! Whenever you're ready, just message me here and I'll check stock near you again. 😊",
        HINGLISH:
          'Koi baat nahi! Jab bhi ready ho, yahan message kar dena, main aapke paas stock phir se check kar dunga. 😊',
        HINDI: 'कोई बात नहीं! जब भी तैयार हों, यहाँ मैसेज कर दीजिए, मैं आपके पास स्टॉक फिर से देख लूँगा। 😊',
      });
    case 'BYE':
      return text({
        ENGLISH: "Bye for now! 👋 I'm here whenever you need help.",
        HINGLISH: 'Bye! 👋 Jab bhi help chahiye, main yahin hoon.',
        HINDI: 'अलविदा! 👋 जब भी मदद चाहिए, मैं यहीं हूँ।',
      });
    case 'OK':
      return text({
        ENGLISH: "Great! 👍 I'm here if you need anything else.",
        HINGLISH: 'Theek hai! 👍 Kuch aur chahiye ho to bata dena.',
        HINDI: 'ठीक है! 👍 कुछ और चाहिए हो तो बता दीजिए।',
      });
    case 'COMPLIMENT':
      return text({
        ENGLISH: "Thank you, glad I could help! 😊 I'm here if you need anything else.",
        HINGLISH: 'Shukriya, khushi hui ki help kar paya! 😊 Kuch aur chahiye ho to bata dena.',
        HINDI: 'धन्यवाद, खुशी हुई कि मदद कर पाया! 😊 कुछ और चाहिए हो तो बता दीजिए।',
      });
    case 'GREETING':
      return text({
        ENGLISH: productTitle
          ? `Hi again! 😊 How can I help with ${product(productTitle, '')}?`
          : 'Hi! 😊 How can I help you today?',
        HINGLISH: productTitle
          ? `Hi! 😊 ${product(productTitle, '')} ke baare mein kya help chahiye?`
          : 'Hi! 😊 Bataiye, main kya help kar sakta hoon?',
        HINDI: productTitle
          ? `नमस्ते! 😊 ${product(productTitle, '')} के बारे में क्या मदद चाहिए?`
          : 'नमस्ते! 😊 बताइए, मैं क्या मदद कर सकता हूँ?',
      });
    case 'COMPLAINT': {
      const reply = {
        ENGLISH: handoffEnabled
          ? "Sorry about that, I didn't get it right. Would you like to talk to a person from our team?"
          : "Sorry about that, I didn't get it right. Tell me what you need and I'll try again.",
        HINGLISH: handoffEnabled
          ? 'Sorry, main theek se help nahi kar paya. Kya aap hamari team ke kisi person se baat karna chahenge?'
          : 'Sorry, main theek se help nahi kar paya. Bataiye kya chahiye, main phir try karta hoon.',
        HINDI: handoffEnabled
          ? 'माफ़ कीजिए, मैं ठीक से मदद नहीं कर पाया। क्या आप हमारी टीम के किसी व्यक्ति से बात करना चाहेंगे?'
          : 'माफ़ कीजिए, मैं ठीक से मदद नहीं कर पाया। बताइए क्या चाहिए, मैं फिर कोशिश करता हूँ।',
      };
      return withHandoff({ message_type: 'TEXT', text: pick(reply) }, handoffEnabled);
    }
    case 'OFF_TOPIC':
      return text({
        ENGLISH: `I can't help with that, but I can tell you about ${product(productTitle, 'our products')}, find a store near you that has it, or help you order online.`,
        HINGLISH: `Is mein main help nahi kar sakta, par ${product(productTitle, 'hamare products')} ke baare mein bata sakta hoon, paas ka store dhoond sakta hoon, ya online order karwa sakta hoon.`,
        HINDI: `इसमें मैं मदद नहीं कर सकता, पर ${product(productTitle, 'हमारे प्रोडक्ट्स')} के बारे में बता सकता हूँ, पास का स्टोर ढूँढ सकता हूँ, या ऑनलाइन ऑर्डर करवा सकता हूँ।`,
      });
    case 'CLARIFY':
      return text({
        ENGLISH: 'Sorry, I did not get that. Could you tell me what you are looking for?',
        HINGLISH: 'Sorry, samajh nahi aaya. Aap kya dhoond rahe hain?',
        HINDI: 'माफ़ कीजिए, समझ नहीं आया। आप क्या ढूँढ रहे हैं?',
      });
  }
}

const withHandoff = (reply: Reply, handoffEnabled: boolean): Reply =>
  handoffEnabled
    ? {
        ...reply,
        message_type: 'INTERACTIVE',
        options: [
          ...(reply.options ?? []).filter((o) => o.option_id !== OPTION.handoff),
          { option_id: OPTION.handoff, label: 'Talk to a person' },
        ],
      }
    : reply;

/** Why a free text was rejected (logged as a reason code, never with the text). */
export type TextRejection =
  | 'TOO_LONG'
  | 'TOO_MANY_SENTENCES'
  | 'TOO_MANY_EMOJI'
  | 'PRICE'
  | 'STOCK'
  | 'DISTANCE'
  | 'DELIVERY_TIME'
  | 'PROMOTION'
  | 'STORE_NAME'
  | 'LANGUAGE';

const FORBIDDEN: { code: TextRejection; pattern: RegExp }[] = [
  { code: 'PRICE', pattern: /₹|\brs\.?\s?\d|\binr\b|\brupees?\b|\bprice(d)? (is|of|at)\b|\d[\d,]*\s?\/-/i },
  {
    code: 'STOCK',
    pattern: /\bin stock\b|\bout of stock\b|\b\d+\s*(left|units?|pcs|pieces|available)\b|\bonly \d+\b/i,
  },
  { code: 'DISTANCE', pattern: /\d+(\.\d+)?\s?(km|kms|kilomet\w*|metres?|meters?|mins? away|minutes? away)\b/i },
  {
    code: 'DELIVERY_TIME',
    pattern:
      /\b(deliver\w*|ship\w*|dispatch\w*|arriv\w*)\b[^.!?]{0,30}\b(\d+|one|two|three|four|five|today|tomorrow|kal)\b|\b\d+\s?(-|–|to)\s?\d+\s?(days?|hours?|hrs?)\b|\b\d+\s?(days?|hours?|hrs?)\b/i,
  },
  {
    code: 'PROMOTION',
    // "feel free to message me" is not a promotion; "free delivery" is.
    pattern:
      /\b(discount\w*|(?<!feel )free|offer|offers|sale|deal|cashback|coupon|promo\w*|guarantee\w*|promise\w*|percent off)\b|\d+\s?%/i,
  },
];

const countSentences = (text: string) =>
  text
    .replace(/\b(e\.g|i\.e|etc|mr|mrs|dr|no)\./gi, '$1')
    .replace(/\d\.\d/g, '0')
    .split(/[.!?।]+(?=\s|$)/)
    .map((s) => s.replace(EMOJI, '').trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s)).length;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Checks a model-written conversational text: at most 2 sentences and 250 characters, one
 * emoji, the customer's script, and no commerce facts — no price, stock, distance, delivery
 * time, promotion or promise, and no store name (`storeNames`). Null when it may be sent.
 */
export function checkConversationalText(
  text: string,
  opts: {
    storeNames: string[];
    customerText?: string | null;
    /** False for a clarifying question or a refusal: only the content rules apply, not the length ones. */
    limits?: boolean;
  },
): TextRejection | null {
  const t = text.trim();
  if (opts.limits !== false) {
    if (t.length > CONVERSATIONAL_MAX_CHARS) return 'TOO_LONG';
    if (countSentences(t) > CONVERSATIONAL_MAX_SENTENCES) return 'TOO_MANY_SENTENCES';
    if ((t.match(EMOJI)?.length ?? 0) > CONVERSATIONAL_MAX_EMOJI) return 'TOO_MANY_EMOJI';
  }
  for (const { code, pattern } of FORBIDDEN) if (pattern.test(t)) return code;
  for (const name of opts.storeNames) {
    const n = name.trim();
    if (n.length >= 3 && new RegExp(`(^|[^\\p{L}])${escape(n)}($|[^\\p{L}])`, 'iu').test(t)) return 'STORE_NAME';
  }
  if (opts.customerText) {
    // Devanagari in, Devanagari out (and Latin in, Latin out). Hinglish vs English is not policed.
    const theirs = DEVANAGARI.test(opts.customerText);
    if (theirs !== DEVANAGARI.test(t) && /[\p{L}\p{M}]{3,}/u.test(opts.customerText.replace(EMOJI, '')))
      return 'LANGUAGE';
  }
  return null;
}

/**
 * The turn rules on a NO_ACTION reply, whichever runtime wrote it: no buttons after thanks /
 * later / bye; after a complaint, the "Talk to a person" button (when handoff is on).
 */
export function finishConversationalReply(reply: Reply, turn: TurnType | null, handoffEnabled: boolean): Reply {
  if (turn && CLOSING_TURNS.includes(turn)) {
    const { options: _options, ...rest } = reply;
    return { ...rest, message_type: 'TEXT' };
  }
  if (turn === 'COMPLAINT') return withHandoff(reply, handoffEnabled);
  return reply;
}
