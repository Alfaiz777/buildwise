/**
 * Shopify product descriptions → plain text and product attributes (L2-Shopify). Pure.
 * A store writes product facts as lines such as "Skin type: oily, combination"; the known
 * labels become `attributes` (docs/04 §7) so answers stay grounded in the catalogue.
 */

/** Label (as written in the description, any case) → attribute key. */
export const DESCRIPTION_LABELS: Record<string, string> = {
  'best for': 'best_for',
  'skin type': 'skin_type',
  'key ingredients': 'key_ingredients',
  texture: 'texture',
  'when to use': 'when_to_use',
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  hellip: '…',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** HTML → plain text: block elements and <br> become line breaks; tags dropped; entities decoded. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

/**
 * Splits a description into its prose and the "Label: value" attribute lines. Lines with
 * an unknown label stay in the text; known labels are removed from it and kept as attributes.
 */
export function parseDescription(html: string): { text: string; attributes: Record<string, string> } {
  const attributes: Record<string, string> = {};
  const prose: string[] = [];
  for (const line of htmlToText(html).split('\n')) {
    const m = /^(?:•\s*)?([A-Za-z][A-Za-z ]{1,30}?)\s*:\s*(.+)$/.exec(line);
    const key = m ? DESCRIPTION_LABELS[m[1]!.trim().toLowerCase()] : undefined;
    if (key && m) attributes[key] = m[2]!.trim().slice(0, 300);
    else prose.push(line);
  }
  return { text: prose.join('\n').trim(), attributes };
}
