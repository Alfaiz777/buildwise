import type { ReactNode } from 'react';

/**
 * WhatsApp text formatting → React elements (Change 16): *bold*, _italic_, ~strike~,
 * line breaks and http(s) links. Built as React nodes — never HTML strings — so message
 * text can never inject markup.
 */
const INLINE = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|https?:\/\/[^\s]+)/g;

function inline(line: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of line.matchAll(INLINE)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > last) out.push(line.slice(last, at));
    const key = `${keyBase}-${i++}`;
    if (token.startsWith('http')) {
      out.push(
        <a key={key} href={token} target="_blank" rel="noopener noreferrer">
          {token}
        </a>,
      );
    } else {
      const inner = token.slice(1, -1);
      if (token.startsWith('*')) out.push(<strong key={key}>{inner}</strong>);
      else if (token.startsWith('_')) out.push(<em key={key}>{inner}</em>);
      else out.push(<s key={key}>{inner}</s>);
    }
    last = at + token.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function WhatsAppText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <span key={i} className="wa-line">
          {inline(line, String(i))}
          {i < lines.length - 1 && <br />}
        </span>
      ))}
    </>
  );
}

/** "https://www.google.com/maps/search/?api=1&query=<lat>,<lng>" */
export const mapsUrl = (latitude: number, longitude: number) =>
  `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
