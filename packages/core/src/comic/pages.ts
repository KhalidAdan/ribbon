import { natcompare } from "../natsort";

/**
 * A comic's pages (docs/COMICS.md, section 2): the pictures in its
 * archive, in the natural order of their names. Every host lists an
 * archive's entries and nothing more; which are pages, and in what order,
 * is decided here, so the desktop, the server and the tests agree.
 */

/** The pictures a web view and the Apple apps both draw. */
export const PAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function baseName(entry: string): string {
  const i = entry.lastIndexOf("/");
  return i < 0 ? entry : entry.slice(i + 1);
}

/** Folders and files an archive carries that are not the comic: macOS's resource forks, hidden files. */
function isLitter(entry: string): boolean {
  return entry.split("/").some((part) => part === "__MACOSX" || part.startsWith("."));
}

/** True when an archive entry is a page: a picture, not a folder, not litter. */
export function isPage(entry: string): boolean {
  if (entry.endsWith("/") || isLitter(entry)) return false;
  return PAGE_EXTENSIONS.has(extension(entry));
}

/** The pages among an archive's entries, in reading order: "page-2" before "page-10". */
export function pageOrder(entries: readonly string[]): string[] {
  return entries.filter(isPage).sort(natcompare);
}

/** A page's media type, from its name. */
export function pageType(entry: string): string {
  return TYPES[extension(entry)] ?? "application/octet-stream";
}

/** The archive's ComicInfo.xml, if it has one: the one nearest the top. */
export function comicInfoEntry(entries: readonly string[]): string | undefined {
  return entries
    .filter((e) => !isLitter(e) && baseName(e).toLowerCase() === "comicinfo.xml")
    .sort((a, b) => a.split("/").length - b.split("/").length || natcompare(a, b))[0];
}

/** What is known of one archive entry before it is read. */
export interface ArchiveEntry {
  name: string;
  /** Its size once unpacked, in bytes. */
  size: number;
  /** Its size in the archive, when the host knows it. */
  packed?: number;
}

/**
 * The most an archive may hold and still be opened. A comic is a few
 * hundred pictures of a few megabytes; an archive far outside that is
 * broken or hostile (a zip bomb unpacks to gigabytes from kilobytes).
 */
export const ARCHIVE_LIMITS = {
  entries: 20_000,
  /** One page, unpacked. */
  pageBytes: 128 * 1024 * 1024,
  /** Every page, unpacked. */
  totalBytes: 16 * 1024 * 1024 * 1024,
  /** Unpacked over packed, for one entry of a megabyte or more. Pictures barely shrink. */
  ratio: 200,
};

/** Why an archive is refused, in a sentence, or null when it may be opened. */
export function archiveProblem(entries: readonly ArchiveEntry[]): string | null {
  if (entries.length > ARCHIVE_LIMITS.entries) return `It holds ${entries.length.toLocaleString("en")} files, more than a comic has.`;
  let total = 0;
  for (const e of entries) {
    if (!isPage(e.name)) continue;
    if (e.size > ARCHIVE_LIMITS.pageBytes) return `"${baseName(e.name)}" unpacks to more than a page could be.`;
    if (e.packed !== undefined && e.size >= 1024 * 1024 && e.size > e.packed * ARCHIVE_LIMITS.ratio) return `"${baseName(e.name)}" unpacks to far more than a picture would.`;
    total += e.size;
    if (total > ARCHIVE_LIMITS.totalBytes) return "Its pages unpack to more than a comic's would.";
  }
  return null;
}
