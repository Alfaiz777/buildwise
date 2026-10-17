import { useMemo } from 'react';
import { qrMatrix, qrPath } from '../../lib/qr';

/**
 * A QR code for `value`, drawn in the browser (no service is sent the link). Dark on white
 * with the spec's quiet zone, whatever the theme, so every phone camera reads it.
 */
export function QrCode({ value, size = 160, label }: { value: string; size?: number; label: string }) {
  const { path, viewBox } = useMemo(() => qrPath(qrMatrix(value, 'M')), [value]);
  return (
    <svg
      className="ui-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${viewBox} ${viewBox}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={viewBox} height={viewBox} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}
