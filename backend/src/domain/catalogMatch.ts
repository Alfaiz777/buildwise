/**
 * Finding the product a customer names in free text (docs/05_AI_AGENT_SPEC.md §6, §9.2).
 * Pure: the catalogue comes from the caller. A product's own words ("mineral", "niacinamide")
 * win; a generic word ("sunscreen", "serum") lists every product of that kind instead.
 */
export interface NamedProduct {
  title: string;
  category: string | null;
}

export const normalizeSize = (s: string) => s.toLowerCase().replace(/(\d)\s+(ml|g)\b/g, '$1$2');

const tokens = (s: string) =>
  normalizeSize(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Words that never name a product, even when a title happens to contain them. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'near',
  'nearby',
  'today',
  'tonight',
  'now',
  'need',
  'want',
  'have',
  'has',
  'get',
  'buy',
  'order',
  'online',
  'store',
  'stores',
  'shop',
  'available',
  'stock',
  'this',
  'that',
  'one',
  'which',
  'what',
  'any',
  'some',
  'good',
  'best',
  'better',
  'please',
  'you',
  'your',
  'can',
  'does',
  'are',
  'product',
  'products',
  'size',
]);

/** "sunscreens" also matches "sunscreen". */
const forms = (word: string) => (word.length > 4 && word.endsWith('s') ? [word, word.slice(0, -1)] : [word]);

/**
 * The products a text names. A distinctive word (in the title, not in the category) wins:
 * the products with the most such hits. Without one, the products whose category or title
 * contains a query word. One result = a unique match; several = candidates to ask about.
 */
export function matchProducts<P extends NamedProduct>(query: string, products: P[]): P[] {
  const words = new Set(
    tokens(query)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
      .flatMap(forms),
  );
  if (!words.size) return [];
  const best = (from: P[], score: (p: P) => number) => {
    const scored = from.map((p) => ({ product: p, hits: score(p) })).filter((s) => s.hits > 0);
    const top = Math.max(0, ...scored.map((s) => s.hits));
    return scored.filter((s) => s.hits === top).map((s) => s.product);
  };
  const anyWord = (p: P) =>
    new Set([...tokens(p.category ?? ''), ...tokens(p.title)].filter((t) => t.length >= 3 && words.has(t))).size;
  const distinctive = best(products, (p) => {
    const generic = new Set(tokens(p.category ?? ''));
    return tokens(p.title).filter((t) => t.length >= 3 && !generic.has(t) && words.has(t)).length;
  });
  // "the gel sunscreen": "gel" is in two titles, and the kind of product settles it.
  if (distinctive.length) return distinctive.length > 1 ? best(distinctive, anyWord) : distinctive;
  return best(products, anyWord);
}

/** The size ("50 g", "30ml") of `sizes` that the text names, if any. */
export function matchSize<S extends { title: string }>(query: string, sizes: S[]): S | null {
  const q = ` ${normalizeSize(query).replace(/[^a-z0-9]+/g, ' ')} `;
  return (
    sizes.find((s) =>
      q.includes(
        ` ${normalizeSize(s.title)
          .replace(/[^a-z0-9]+/g, ' ')
          .trim()} `,
      ),
    ) ?? null
  );
}
