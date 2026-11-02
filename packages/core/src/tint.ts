/**
 * A page colour from a cover. The reader page takes each book's own
 * colour, the way a well-made book's endpapers do: the ground, the ink,
 * the hairlines and the accent all come from one hue, so the page reads
 * as that book's place and the type stays legible whatever the cover.
 */

export interface Tone {
  /** The page ground and a slightly lifted surface. */
  bg: string;
  bg2: string;
  /** Text, quieter text, hairlines, and the one bright accent. */
  ink: string;
  muted: string;
  line: string;
  accent: string;
}

/** Hue in turns (0 to 1) of the cover's most saturated colours, or null for a grey cover. */
export function dominantHue(rgb: Uint8ClampedArray | number[]): number | null {
  const samples: { h: number; s: number; l: number }[] = [];
  for (let i = 0; i + 2 < rgb.length; i += 4) {
    samples.push(hsl(rgb[i]! / 255, rgb[i + 1]! / 255, rgb[i + 2]! / 255));
  }
  const vivid = samples.filter((c) => c.s > 0.08 && c.l > 0.06 && c.l < 0.94).sort((a, b) => b.s - a.s);
  if (vivid.length === 0) return null;
  // Average the top sixth by saturation on the hue circle, so red at 0.98 and red at 0.02 agree.
  const top = vivid.slice(0, Math.max(6, Math.floor(vivid.length / 6)));
  let x = 0;
  let y = 0;
  for (const c of top) {
    x += Math.cos(c.h * 2 * Math.PI) * c.s;
    y += Math.sin(c.h * 2 * Math.PI) * c.s;
  }
  const h = Math.atan2(y, x) / (2 * Math.PI);
  return (h + 1) % 1;
}

/** The tone set for a hue; a grey cover gets a neutral tone. */
export function toneFor(hue: number | null): Tone {
  const h = hue ?? 0.7;
  const s = hue === null ? 0.04 : 1;
  return {
    bg: hex(h, 0.13, 0.42 * s),
    bg2: hex(h, 0.17, 0.38 * s),
    ink: hex(h, 0.9, 0.35 * s),
    muted: hex(h, 0.7, 0.22 * s),
    line: hex(h, 0.3, 0.3 * s),
    accent: hex(h, 0.66, 0.8 * s),
  };
}

export const NEUTRAL_TONE: Tone = toneFor(null);

function hsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}

function hex(h: number, l: number, s: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h * 6) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg]!;
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r!)}${to(g!)}${to(b!)}`;
}
