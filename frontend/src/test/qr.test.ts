import { describe, expect, it } from 'vitest';
import { qrMatrix, qrPath } from '../lib/qr';

/**
 * The QR encoder (lib/qr.ts). Checked module for module against the reference Python `qrcode`
 * package when written; these tests pin the structure every reader relies on.
 */
const url =
  'https://app.qwikspot.urbanlyfe.in/api/wa?brand=brd_demo&entry=STORE_NEED&variant=45678901234567&session=ws_k3j2h4g5f6d7&visitor=vis_m9n8b7v6&via=qr';

describe('QR encoder', () => {
  it('picks the smallest version that holds the data', () => {
    expect(qrMatrix('hi', 'M').version).toBe(1);
    expect(qrMatrix('https://m6ccxz-wk.myshopify.com', 'M').version).toBe(3);
    const m = qrMatrix(url, 'M');
    expect(m.size).toBe(m.version * 4 + 17);
    expect(() => qrMatrix('x'.repeat(3000), 'H')).toThrow(/too long/);
  });

  it('draws the three finder patterns, the timing lines and the dark module', () => {
    const { modules, size } = qrMatrix(url, 'M');
    const finderOk = (x0: number, y0: number) => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          if (modules[y0 + y]![x0 + x] !== (ring !== 2)) return false;
        }
      }
      return true;
    };
    expect(finderOk(0, 0)).toBe(true);
    expect(finderOk(size - 7, 0)).toBe(true);
    expect(finderOk(0, size - 7)).toBe(true);
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6]![i]).toBe(i % 2 === 0);
      expect(modules[i]![6]).toBe(i % 2 === 0);
    }
    expect(modules[size - 8]![8]).toBe(true);
  });

  it('is deterministic, and its SVG path has one square per dark module', () => {
    const a = qrMatrix(url);
    const b = qrMatrix(url);
    expect(a.modules).toEqual(b.modules);
    const dark = a.modules.flat().filter(Boolean).length;
    const { path, viewBox } = qrPath(a);
    expect(viewBox).toBe(a.size + 8);
    expect(path.match(/h1v1h-1z/g)).toHaveLength(dark);
  });
});
