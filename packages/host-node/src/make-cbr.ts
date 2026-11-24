import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { crc32 } from "node:zlib";
import { madePageName, pagePng, type MadeComic } from "./make-comic";

/**
 * A CBR made for the tests: the comic `makeComic` would write, in a RAR
 * (docs/COMICS.md, section 12). Nothing free writes RAR from Node, so the
 * archive is written here, from the published format (RARLAB's technical
 * note, https://www.rarlab.com/technote.htm): RAR 5.0, or the older
 * format most CBRs still are.
 *
 * Every file is stored, never squeezed: squeezing is RAR's own, and this
 * is no archiver. So a made CBR proves the listing, the order, the limits
 * and the refusals, and not the unpacking. The Rust tests of the reader
 * itself (packages/desktop/src-tauri/cbr) make squeezed ones.
 */
export interface MadeRar {
  /** "rar5" (RAR 5.0 and later), or "rar4" (RAR 1.5 to 4.x). */
  format?: "rar5" | "rar4";
  /** Mark every file as locked with a password. Nothing is encrypted: the mark is what a reader refuses. */
  locked?: boolean;
  /** Mark the archive as the first part of one split across several files. */
  split?: boolean;
  /**
   * Bytes to bring each page's file up to, for measuring: a scanned page
   * is a megabyte or two, and a flat colour is a kilobyte. The weight
   * goes after the picture's end, where a decoder has stopped reading.
   */
  weight?: number;
}

/** One file of an archive. */
export interface MadeFile {
  name: string;
  bytes: Uint8Array;
}

/** Write a CBR at `file`. */
export async function makeComicRar(file: string, comic: MadeComic, how: MadeRar = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, storedRar(madeFiles(comic, how.weight), how));
}

/** Every file a made comic's archive holds, in the order `makeComic` writes them: what it says of itself, litter, then its pages. */
function madeFiles(comic: MadeComic, weight: number | undefined): MadeFile[] {
  const width = comic.width ?? 200;
  const height = comic.height ?? 300;
  const wide = new Set(comic.wide ?? []);
  const text = (s: string) => new TextEncoder().encode(s);
  return [
    ...(comic.comicInfo !== undefined ? [{ name: "ComicInfo.xml", bytes: text(comic.comicInfo) }] : []),
    ...Object.entries(comic.extra ?? {}).map(([name, body]) => ({ name, bytes: text(body) })),
    ...Array.from({ length: comic.pages }, (_, i) => ({ name: madePageName(comic, i), bytes: weighted(pagePng(i + 1, wide.has(i) ? width * 2 : width, height), weight, i) })),
  ];
}

/** A page's file brought up to `weight` bytes with noise that is the same every time. */
function weighted(page: Uint8Array, weight: number | undefined, seed: number): Uint8Array {
  if (weight === undefined || weight <= page.length) return page;
  const out = new Uint8Array(weight);
  out.set(page);
  let x = (seed + 1) * 2654435761;
  for (let i = page.length; i < weight; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** A RAR archive of the given files, each stored as it is. */
export function storedRar(files: readonly MadeFile[], how: MadeRar = {}): Uint8Array {
  return join(how.format === "rar4" ? rar4Blocks(files, how) : rar5Blocks(files, how));
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

/** RAR 5's number of any size: seven bits to a byte, the lowest first, the top bit saying another byte follows. */
function vint(n: number): Uint8Array {
  const out: number[] = [];
  do {
    const low = n % 128;
    n = Math.floor(n / 128);
    out.push(n > 0 ? low | 0x80 : low);
  } while (n > 0);
  return new Uint8Array(out);
}

/** When a made file says it was written: one fixed moment, so the same comic is the same bytes. */
const MADE_AT = Date.UTC(2026, 10, 23, 12, 0, 0);

// RAR 5.0: a signature, then blocks. A block is the CRC32 of the rest of its header, the header's
// size, its type and its flags, then whatever its type says; a file's bytes follow its block.
const RAR5_SIGNATURE = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const RAR5 = { main: 1, file: 2, end: 5, hasExtra: 0x01, hasData: 0x02, continues: 0x10, isVolume: 0x01, hasTime: 0x02, hasCrc: 0x04, unix: 1, plainFile: 0o100644, lockRecord: 1 };

function rar5Block(type: number, flags: number, fields: readonly Uint8Array[], extra?: Uint8Array, dataSize?: number): Uint8Array {
  const body = join([vint(type), vint(flags), ...(extra ? [vint(extra.length)] : []), ...(dataSize !== undefined ? [vint(dataSize)] : []), ...fields, ...(extra ? [extra] : [])]);
  const sized = join([vint(body.length), body]);
  return join([u32(crc32(sized)), sized]);
}

function rar5Blocks(files: readonly MadeFile[], how: MadeRar): Uint8Array[] {
  // What a locked file carries: the record of how its key is made. All zeros, since no reader here gets as far as using it.
  const lock = join([vint(RAR5.lockRecord), vint(0), vint(0), new Uint8Array([15]), new Uint8Array(16), new Uint8Array(16)]);
  const lockRecord = join([vint(lock.length), lock]);
  const blocks = [RAR5_SIGNATURE, rar5Block(RAR5.main, 0, [vint(how.split ? RAR5.isVolume : 0)])];
  for (const { name, bytes } of files) {
    const called = new TextEncoder().encode(name);
    const fields = [vint(RAR5.hasTime | RAR5.hasCrc), vint(bytes.length), vint(RAR5.plainFile), u32(MADE_AT / 1000), u32(crc32(bytes)), vint(0), vint(RAR5.unix), vint(called.length), called];
    const flags = RAR5.hasData | (how.locked ? RAR5.hasExtra : 0) | (how.split ? RAR5.continues : 0);
    blocks.push(rar5Block(RAR5.file, flags, fields, how.locked ? lockRecord : undefined, bytes.length), bytes);
  }
  blocks.push(rar5Block(RAR5.end, 0, [vint(how.split ? 1 : 0)]));
  return blocks;
}

// RAR 1.5 to 4.x: a marker, then blocks. A block is two bytes of the CRC32 of the rest of its
// header, then its type, its flags and its size, in fields of fixed width. Folders in a name are
// parted by a backslash, as on Windows.
const RAR4_MARKER = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR4 = { main: 0x73, file: 0x74, end: 0x7b, isVolume: 0x0001, firstVolume: 0x0100, continues: 0x02, locked: 0x04, utf8Name: 0x0200, hasSize: 0x8000, skippable: 0x4000, windows: 2, stored: 0x30, version: 20, archiveAttribute: 0x20 };

function rar4Block(type: number, flags: number, fields: readonly Uint8Array[]): Uint8Array {
  const rest = join(fields);
  const header = join([new Uint8Array([type]), u16(flags), u16(7 + rest.length), rest]);
  return join([u16(crc32(header) & 0xffff), header]);
}

/** A moment as MS-DOS kept it: two seconds to a tick, years counted from 1980. */
function dosTime(ms: number): number {
  const d = new Date(ms);
  return (((d.getUTCFullYear() - 1980) << 25) | ((d.getUTCMonth() + 1) << 21) | (d.getUTCDate() << 16) | (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)) >>> 0;
}

function rar4Blocks(files: readonly MadeFile[], how: MadeRar): Uint8Array[] {
  const blocks = [RAR4_MARKER, rar4Block(RAR4.main, how.split ? RAR4.isVolume | RAR4.firstVolume : 0, [u16(0), u32(0)])];
  for (const { name, bytes } of files) {
    const called = new TextEncoder().encode(name.split("/").join("\\"));
    // A name that isn't plain ASCII is marked as Unicode, and written as UTF-8.
    const flags = RAR4.hasSize | (called.some((b) => b > 127) ? RAR4.utf8Name : 0) | (how.locked ? RAR4.locked : 0) | (how.split ? RAR4.continues : 0);
    const fields = [u32(bytes.length), u32(bytes.length), new Uint8Array([RAR4.windows]), u32(crc32(bytes)), u32(dosTime(MADE_AT)), new Uint8Array([RAR4.version, RAR4.stored]), u16(called.length), u32(RAR4.archiveAttribute), called];
    blocks.push(rar4Block(RAR4.file, flags, fields), bytes);
  }
  blocks.push(rar4Block(RAR4.end, RAR4.skippable, []));
  return blocks;
}
