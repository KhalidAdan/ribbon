// The cloths the lamp-lit bookcase binds its books in, the same on every device: the Apple app's are in
// packages/apple/Ribbon/Bookcase/Cloth.swift, and a change to one is a change to both.

/**
 * A number from a book's id, the same on every device (FNV-1a over UTF-16, as the Apple app's `stableHash`): what a
 * book's height, its binding and its quiet cloth are chosen by, so it stands the same everywhere.
 */
export function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A colour as bytes. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function rgb(hex: number): RGB {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

export function hexOf(c: RGB): string {
  return "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Hue, saturation and lightness, each 0 to 1. */
export function hslOf(c: RGB): { h: number; s: number; l: number } {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), l = (hi + lo) / 2, d = hi - lo;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  if (h < 0) h += 1;
  return { h, s: Math.min(1, s), l };
}

export function fromHsl(h: number, s: number, l: number): RGB {
  const light = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * light - 1)) * s, x = c * (1 - Math.abs(((h * 6) % 2) - 1)), m = light - c / 2;
  const sixths: [number, number, number][] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  const v = sixths[Math.floor(h * 6) % 6]!;
  const byte = (u: number) => Math.round((u + m) * 255);
  return { r: byte(v[0]), g: byte(v[1]), b: byte(v[2]) };
}

/**
 * A book cloth, as a binder's swatch book has one: its colour, the lettering that reads on it, and the foil for the
 * rules and the number. `alternatives` are the next-nearest cloths, for when a neighbour already wears this one.
 */
export interface Cloth {
  ground: RGB;
  ink: RGB;
  foil: RGB;
  alternatives: Cloth[];
}

export const CREAM = rgb(0xf2ebdd);
export const DARK_INK = rgb(0x1d1b18);
const GOLD = rgb(0xcdb27a), SILVER = rgb(0xc9ccd1), COPPER = rgb(0xc48d62);

const cloth = (ground: number, ink: RGB, foil: RGB): Cloth => ({ ground: rgb(ground), ink, foil, alternatives: [] });

/** Eighteen cloths, deep and matte. Every cover is bound in the cloth nearest its own colour, so the shelf stays in tune however wild the covers are. */
export const SWATCHES: readonly Cloth[] = [
  cloth(0x6b1f24, CREAM, GOLD), // oxblood
  cloth(0x8c3b2a, CREAM, GOLD), // brick
  cloth(0xa65a2c, CREAM, rgb(0xeedcb6)), // burnt orange
  cloth(0x9c7428, DARK_INK, DARK_INK), // mustard
  cloth(0x5f6234, CREAM, GOLD), // olive
  cloth(0x2f4b36, CREAM, GOLD), // forest
  cloth(0x1e3f39, CREAM, COPPER), // bottle green
  cloth(0x22595d, CREAM, SILVER), // teal
  cloth(0x1f4a60, CREAM, SILVER), // petrol
  cloth(0x1d2c4c, CREAM, GOLD), // navy
  cloth(0x31437a, CREAM, SILVER), // ink blue
  cloth(0x3d2a52, CREAM, GOLD), // aubergine
  cloth(0x5e2944, CREAM, GOLD), // plum
  cloth(0x8a4a4a, CREAM, rgb(0xf0dccb)), // dusty rose
  cloth(0x4b5b67, CREAM, SILVER), // slate
  cloth(0x2c2a27, CREAM, GOLD), // charcoal
  cloth(0xcfc1a0, DARK_INK, rgb(0x7a2c26)), // stone, with red
  cloth(0xe7ddc8, DARK_INK, rgb(0x1f2f4f)), // cream, with navy
];

/** The cloth nearest a colour, with the next four behind it: hue counts most where both are coloured, lightness and strength after. */
export function nearestCloth(c: RGB): Cloth {
  const a = hslOf(c);
  const distance = (other: Cloth) => {
    const b = hslOf(other.ground);
    const hue = Math.min(Math.abs(a.h - b.h), 1 - Math.abs(a.h - b.h)) * 2 * Math.min(a.s, b.s) * 3;
    return hue * hue + (a.s - b.s) * (a.s - b.s) * 0.6 + (a.l - b.l) * (a.l - b.l) * 1.2;
  };
  // Ranked by distance, ties in the swatch book's order.
  const ranked = SWATCHES.map((s, i) => ({ s, i, d: distance(s) })).sort((p, q) => p.d - q.d || p.i - q.i).map((p) => p.s);
  return { ...ranked[0]!, alternatives: ranked.slice(1, 5) };
}

/** The cloth for a book with no cover to read: a quiet colour of its own, the same on every device. */
export function clothForBook(id: string): Cloth {
  const h = hashOf(id + "hue");
  return h % 11 === 0 ? nearestCloth(rgb(0x2b2926)) : nearestCloth(fromHsl((h % 1000) / 1000, 0.5, 0.35));
}

/**
 * The colour a cover is bound in, from its pixels (RGBA, a small sample of the picture): its most characteristic
 * colour, not its commonest, which is the strongest hue that covers real area. Set a little deeper than print, as
 * cloth is, unless the cover itself is pale. Its cloth is the swatch nearest this colour.
 */
export function coverColour(px: ArrayLike<number>): RGB {
  const buckets = 24, n = Math.floor(px.length / 4);
  const weight = new Array<number>(buckets).fill(0);
  const sums = Array.from({ length: buckets }, () => [0, 0, 0] as [number, number, number]);
  let lightness = 0, coloured = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const c = { r: px[i]!, g: px[i + 1]!, b: px[i + 2]! };
    const { h, s, l } = hslOf(c);
    lightness += l;
    if (!(s > 0.22 && l > 0.1 && l < 0.9)) continue;
    coloured += 1;
    const bucket = Math.floor(h * buckets) % buckets;
    const w = Math.pow(s, 1.5) * (1 - Math.abs(l - 0.5));
    weight[bucket]! += w;
    sums[bucket]![0] += c.r * w;
    sums[bucket]![1] += c.g * w;
    sums[bucket]![2] += c.b * w;
  }
  const averageLightness = lightness / Math.max(1, n);
  // A cover with hardly any colour: the neutral cloth nearest its lightness.
  if (coloured < Math.floor(n / 12)) return fromHsl(0.08, 0.06, averageLightness < 0.5 ? 0.2 : 0.82);
  const around = (b: number) => weight[(b + buckets - 1) % buckets]! + weight[b]! + weight[(b + 1) % buckets]!;
  let best = 0;
  for (let b = 1; b < buckets; b++) if (around(b) > around(best)) best = b;
  const total = [0, 0, 0];
  let w = 0;
  for (const j of [best - 1, best, best + 1]) {
    const k = (j + buckets) % buckets;
    total[0]! += sums[k]![0];
    total[1]! += sums[k]![1];
    total[2]! += sums[k]![2];
    w += weight[k]!;
  }
  const { h, s, l } = hslOf({ r: Math.trunc(total[0]! / w), g: Math.trunc(total[1]! / w), b: Math.trunc(total[2]! / w) });
  return fromHsl(h, s, l * (averageLightness > 0.55 ? 1 : 0.8));
}
