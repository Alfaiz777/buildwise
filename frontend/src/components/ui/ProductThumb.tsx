import { useState } from 'react';

/** A product image, or the product's initials when there is none (or it fails to load). */
export function ProductThumb({ src, name, size = 40 }: { src?: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <span className="ui-thumb" style={{ width: size, height: size }}>
      {src && !failed ? (
        <img src={src} alt={name} width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span role="img" aria-label={name}>
          {initials || '?'}
        </span>
      )}
    </span>
  );
}
