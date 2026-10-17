/**
 * A small QR Code encoder (byte mode, error correction L/M/Q/H, versions 1–40), after the QR
 * Code spec (ISO/IEC 18004) and Project Nayuki's reference design. No dependency, nothing sent
 * anywhere: the QR is drawn in the browser. The same encoder runs in the Shopify snippet
 * (integrations/shopify/qwikspot-shopify.js); a test keeps the two identical, and both were
 * checked module for module against the reference Python `qrcode` package (every mask, ECC
 * level and version choice).
 */
export type QrLevel = 'L' | 'M' | 'Q' | 'H';
export interface QrMatrix {
  size: number;
  version: number;
  mask: number;
  modules: boolean[][];
}

/** [row in the tables, format bits] per level. */
const LEVEL: Record<QrLevel, [number, number]> = { L: [0, 1], M: [1, 0], Q: [2, 3], H: [3, 2] };
const ECC_PER_BLOCK = [
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
];
const BLOCKS = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19,
    19, 20, 21, 22, 24, 25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
    33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43,
    45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48,
    51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
];

const rawModules = (ver: number) => {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
};

/** Multiplication in GF(2^8) with the polynomial 0x11D. */
function mul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const r: number[] = new Array<number>(degree - 1).fill(0);
  r.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = mul(r[j]!, root);
      if (j + 1 < r.length) r[j] = r[j]! ^ r[j + 1]!;
    }
    root = mul(root, 0x02);
  }
  return r;
}

function rsRemainder(msg: number[], div: number[]): number[] {
  const r = div.map(() => 0);
  for (const b of msg) {
    const factor = b ^ r.shift()!;
    r.push(0);
    div.forEach((coef, i) => {
      r[i] = r[i]! ^ mul(coef, factor);
    });
  }
  return r;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

export function qrMatrix(text: string, level: QrLevel = 'M', forcedMask?: number): QrMatrix {
  const [row, levelBits] = LEVEL[level];
  const bytes = Array.from(new TextEncoder().encode(text));
  const dataCodewords = (ver: number) =>
    Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[row]![ver]! * BLOCKS[row]![ver]!;

  // The smallest version that holds the data (byte mode: 4 mode bits + 8/16 count bits).
  let ver = 1;
  for (; ; ver++) {
    if (ver > 40) throw new Error('QR: data too long');
    if (4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  const bits: number[] = [];
  const put = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let k = 0; k < bits.length; k += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[k + j]!;
    data.push(v);
  }

  // Blocks with their error correction, interleaved.
  const numBlocks = BLOCKS[row]![ver]!;
  const eccLen = ECC_PER_BLOCK[row]![ver]!;
  const rawCodewords = Math.floor(rawModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const div = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let b = 0, at = 0; b < numBlocks; b++) {
    const dat = data.slice(at, at + shortLen - eccLen + (b < numShort ? 0 : 1));
    at += dat.length;
    const ecc = rsRemainder(dat, div);
    if (b < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLen - eccLen || j >= numShort) codewords.push(blocks[j]![i]!);
    }
  }

  // The grid and its function patterns.
  const size = ver * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    isFn[y]![x] = true;
  };
  for (let t = 0; t < size; t++) {
    setFn(6, t, t % 2 === 0);
    setFn(t, 6, t % 2 === 0);
  }
  const finder = (x: number, y: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  let align: number[] = [];
  if (ver > 1) {
    const na = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + na * 3 + 5) / (na * 4 - 4)) * 2;
    align = [6];
    for (let pos = size - 7; align.length < na; pos -= step) align.splice(1, 0, pos);
  }
  for (let ai = 0; ai < align.length; ai++) {
    for (let aj = 0; aj < align.length; aj++) {
      const last = align.length - 1;
      if ((ai === 0 && aj === 0) || (ai === 0 && aj === last) || (ai === last && aj === 0)) continue;
      for (let ay = -2; ay <= 2; ay++) {
        for (let ax = -2; ax <= 2; ax++) {
          setFn(align[ai]! + ax, align[aj]! + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
        }
      }
    }
  }
  const drawFormat = (mask: number) => {
    const d = (levelBits << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(f, i));
    setFn(8, 7, bit(f, 6));
    setFn(8, 8, bit(f, 7));
    setFn(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(f, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(f, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0); // reserves the area; redrawn with the chosen mask
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, bit(vbits, i));
      setFn(b, a, bit(vbits, i));
    }
  }

  // The data, in the zig-zag order.
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y]![x] && n < codewords.length * 8) {
          modules[y]![x] = bit(codewords[n >>> 3]!, 7 - (n & 7));
          n++;
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFn[y]![x]) continue;
        const inv = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][mask];
        if (inv) modules[y]![x] = !modules[y]![x];
      }
    }
  };

  // The mask with the lowest penalty (the spec's four rules).
  const addHistory = (len: number, h: number[]) => {
    if (h[0] === 0) len += size;
    h.pop();
    h.unshift(len);
  };
  const countPatterns = (h: number[]) => {
    const m = h[1]!;
    const core = m > 0 && h[2] === m && h[3] === m * 3 && h[4] === m && h[5] === m;
    return (core && h[0]! >= m * 4 && h[6]! >= m ? 1 : 0) + (core && h[6]! >= m * 4 && h[0]! >= m ? 1 : 0);
  };
  const terminate = (color: boolean, len: number, h: number[]) => {
    if (color) {
      addHistory(len, h);
      len = 0;
    }
    addHistory(len + size, h);
    return countPatterns(h);
  };
  const penalty = () => {
    let score = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let color = false;
        let run = 0;
        const h = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const cell = pass === 0 ? modules[a]![b]! : modules[b]![a]!;
          if (cell === color) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score++;
          } else {
            addHistory(run, h);
            if (!color) score += countPatterns(h) * 40;
            color = cell;
            run = 1;
          }
        }
        score += terminate(color, run, h) * 40;
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y]![x];
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3;
      }
    }
    const dark = modules.reduce((s, r) => s + r.filter(Boolean).length, 0);
    const total = size * size;
    return score + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  };

  let best = forcedMask ?? -1;
  if (best < 0) {
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      const p = penalty();
      if (p < bestScore) {
        best = m;
        bestScore = p;
      }
      applyMask(m);
    }
  }
  applyMask(best);
  drawFormat(best);
  return { size, version: ver, mask: best, modules };
}

/** The matrix as one SVG path (dark modules), with the spec's 4-module quiet zone. */
export function qrPath(m: QrMatrix, quiet = 4): { path: string; viewBox: number } {
  let path = '';
  m.modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }),
  );
  return { path, viewBox: m.size + quiet * 2 };
}
