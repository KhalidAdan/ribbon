import { issueNumber, seriesWithoutRunYear, type ComicShape } from "./comic-name";
import { plainNumber } from "./comic/filename";
import { shapeEmpties } from "./edit-form";
import { applyEdits, coverDateFrom, type EditField, type EditValues } from "./edits";
import { summaryText } from "./summary-text";
import type { Book, Credits, Role } from "./types";

/**
 * Looking a comic up on ComicVine (docs/BOOK-DETAILS.md, section 7): the
 * rules, here and only here, so a server and the desktop can't come to
 * disagree on them. What is asked (`issueRequest` and the rest), what an
 * answer means (`outcomeOf`), which issue is the comic (`lookUpComic`), what
 * it fills in (`matchedValues`), and how what it said lies between a
 * comic's files and a person's edits (`withMatch`).
 *
 * Nothing here asks anyone anything. A host sends the requests, with its
 * owner's key, one at a time, and hands the answers back (`Ask`): the
 * server through its own door (packages/server/src/library/comicvine.ts).
 *
 * **What ComicVine said is a layer of its own**, between what a comic's
 * files say and a person's edits. Each field shows the person's edit if
 * there is one; else what ComicVine said, if it said anything; else what
 * the files say. Looking it up again replaces the layer; forgetting the
 * match takes it away whole. A host lays it so:
 *
 *     const shown = namedComic(applyEdits(withMatch(files, match), edits), edits);
 *
 * The answers' shapes are ComicVine's API documentation's
 * (comicvine.gamespot.com/api/documentation). Its words for what a person
 * did on an issue aren't listed there, so `ROLE_WORDS` is a reading of
 * them, to be checked against real answers.
 */

// ComicVine's answers -----------------------------------------------------

/** A cover at the sizes ComicVine keeps it, as addresses. */
export interface CvImage {
  icon_url?: string | null;
  thumb_url?: string | null;
  tiny_url?: string | null;
  small_url?: string | null;
  medium_url?: string | null;
  super_url?: string | null;
  original_url?: string | null;
}

/** Someone credited on an issue, with what they did in words: "penciler, inker, cover". */
export interface CvPerson {
  id: number;
  name: string;
  role: string;
  site_detail_url?: string | null;
}

/** A story arc an issue is part of. */
export interface CvArc {
  id: number;
  name: string;
  site_detail_url?: string | null;
}

/** An issue (ComicVine's `issue` resource): its number, its name, its dates, its people and arcs, its run and its words. */
export interface CvIssue {
  id: number;
  name?: string | null;
  issue_number?: string | null;
  /** The month on its cover, as a day: "2024-07-01". */
  cover_date?: string | null;
  /** The day it went on sale: "2024-07-10". */
  store_date?: string | null;
  volume?: { id: number; name: string; site_detail_url?: string | null } | null;
  person_credits?: CvPerson[] | null;
  story_arc_credits?: CvArc[] | null;
  image?: CvImage | null;
  site_detail_url?: string | null;
  /** A line about it, as text. */
  deck?: string | null;
  /** What it is about, as HTML. */
  description?: string | null;
}

/** A run of a series (ComicVine's `volume` resource): its name, its first year, its publisher and how many issues it has. */
export interface CvVolume {
  id: number;
  name: string;
  start_year?: string | null;
  count_of_issues?: number | null;
  publisher?: { id: number; name: string } | null;
  image?: CvImage | null;
  site_detail_url?: string | null;
}

/** Every answer ComicVine gives: a status, what it means in words, and the results, one thing or a list. */
export interface CvAnswer<T = unknown> {
  status_code: number;
  error: string;
  results: T;
  limit?: number;
  offset?: number;
  number_of_page_results?: number;
  number_of_total_results?: number;
  version?: string;
}

/** ComicVine's status codes, as its documentation lists them: the ones Ribbon acts on. */
export const CV_STATUS = { ok: 1, badKey: 100, notFound: 101, tooMany: 107 } as const;

/**
 * What an answer means to whoever asked: the results; no such thing;
 * too many requests, to be tried again after a wait; the key refused; or
 * anything else, which is ComicVine out of reach for now. ComicVine says
 * it as an HTTP status (420 or 429 for too many), or in the answer's own
 * `status_code` (107), or both.
 */
export type CvOutcome = "answered" | "not found" | "too many" | "refused" | "failed";

export function outcomeOf(httpStatus: number, body: unknown): CvOutcome {
  const status = typeof (body as CvAnswer | null)?.status_code === "number" ? (body as CvAnswer).status_code : null;
  if (httpStatus === 420 || httpStatus === 429 || status === CV_STATUS.tooMany) return "too many";
  if (status === CV_STATUS.badKey || httpStatus === 401) return "refused";
  if (status === CV_STATUS.notFound || httpStatus === 404) return "not found";
  if (httpStatus >= 200 && httpStatus < 300 && status === CV_STATUS.ok) return "answered";
  return "failed";
}

// Addresses ----------------------------------------------------------------

/** An issue or a run on ComicVine, by its id: the number in "4000-1234567" (an issue) or "4050-123456" (a run). */
export type CvAddress = { kind: "issue"; id: number } | { kind: "run"; id: number };

/**
 * An issue's or a run's address on ComicVine, from what a person pastes:
 * its page, "https://comicvine.gamespot.com/saga-14/4000-1234567/", or its
 * id alone, "4000-1234567". Null for anything else, a page elsewhere
 * among them.
 */
export function comicVineAddress(text: string): CvAddress | null {
  const t = text.trim();
  const bare = t.match(/^(4000|4050)-(\d+)$/);
  const page = t.match(/^(?:https?:\/\/)?(?:www\.)?comicvine\.(?:gamespot\.)?com\/(?:[^\s/?#]+\/)*?(4000|4050)-(\d+)(?:[/?#]\S*)?$/i);
  const found = bare ?? page;
  if (!found) return null;
  return { kind: found[1] === "4000" ? "issue" : "run", id: Number(found[2]) };
}

/** An issue's id as a comic keeps it (`Book.comicvine`): "4000-1234567". */
export function issueKey(id: number): string {
  return `4000-${id}`;
}

/** A run's id as Ribbon gives it: "4050-123456". */
export function runKey(id: number): string {
  return `4050-${id}`;
}

/** An address is a page on ComicVine's own site: what is linked back to. */
function isComicVinePage(url: string): boolean {
  return /^https:\/\/comicvine\.gamespot\.com\//i.test(url.trim());
}

/** An issue's page on ComicVine, linked back to wherever its details show: as its answer gives it, else made from its id. */
export function issuePage(issue: Pick<CvIssue, "id" | "site_detail_url">): string {
  const given = issue.site_detail_url?.trim();
  return given && isComicVinePage(given) ? given : `https://comicvine.gamespot.com/issue/${issueKey(issue.id)}/`;
}

/** A run's page on ComicVine, as its answer gives it, else made from its id. */
export function runPage(run: Pick<CvVolume, "id" | "site_detail_url">): string {
  const given = run.site_detail_url?.trim();
  return given && isComicVinePage(given) ? given : `https://comicvine.gamespot.com/volume/${runKey(run.id)}/`;
}

// What is asked ------------------------------------------------------------

/** ComicVine's resources Ribbon asks: its limit is counted for each (an hour's requests to `issue` apart from `volumes`). */
export type CvResource = "issue" | "issues" | "volume" | "volumes";

/** One request to ComicVine's API, without the key and the format, which the host adds. */
export interface CvRequest {
  resource: CvResource;
  /** The path under the API's address: "issue/4000-1234567/". */
  path: string;
  params: Record<string, string>;
}

/** A request as an answer to it is kept by: its path and what it asks, without the key, in one order. */
export function requestKey(request: CvRequest): string {
  const params = Object.entries(request.params).sort(([a], [b]) => a.localeCompare(b));
  return `${request.path}?${new URLSearchParams(params).toString()}`;
}

/** What is read of an issue: its number, name and dates; its people and arcs; its run; its words and its page. */
const ISSUE_FIELDS = "id,name,issue_number,cover_date,store_date,volume,person_credits,story_arc_credits,site_detail_url,deck,description";

/** What is read of a run, the same whether it is asked for alone or found by a search, so one answers for the other. */
const RUN_FIELDS = "id,name,start_year,count_of_issues,publisher,image,site_detail_url";

/** What is read of a run's issues when one is looked for by its number: enough to know it, and ask for it whole. */
const ISSUE_LIST_FIELDS = "id,name,issue_number,cover_date,volume,site_detail_url";

/** How many runs a search offers. */
const RUNS_OFFERED = 20;

/** An issue, whole: its people and its arcs come only with it alone. */
export function issueRequest(id: number): CvRequest {
  return { resource: "issue", path: `issue/${issueKey(id)}/`, params: { field_list: ISSUE_FIELDS } };
}

/** A run, for its name, first year and publisher. */
export function runRequest(id: number): CvRequest {
  return { resource: "volume", path: `volume/${runKey(id)}/`, params: { field_list: RUN_FIELDS } };
}

/** The runs ComicVine has by a name, of the year given when there is one. */
export function runsRequest(search: RunSearch): CvRequest {
  // A filter's parts are apart by commas and a name from its value by a colon, so neither can be in the name.
  const name = search.name.replace(/[,:|]+/g, " ").replace(/\s+/g, " ").trim();
  const filter = search.year ? `name:${name},start_year:${search.year}` : `name:${name}`;
  return { resource: "volumes", path: "volumes/", params: { filter, field_list: RUN_FIELDS, limit: String(RUNS_OFFERED) } };
}

/** A run's issues with this number: "014" is asked as 14, as ComicVine prints it. */
export function issuesRequest(runId: number, number: string): CvRequest {
  const n = plainNumber(number.trim().replace(/^#/, "")).replace(/[,:|]/g, "");
  return { resource: "issues", path: "issues/", params: { filter: `volume:${runId},issue_number:${n}`, field_list: ISSUE_LIST_FIELDS } };
}

// Searching for a run ------------------------------------------------------

/** What runs are searched for by: a series' name, and its first year when it says one. */
export interface RunSearch {
  name: string;
  year: number | null;
}

/** A comic's series as a search: its run's year taken out of the name and given as the year, "Transformers (2023)" is Transformers of 2023. */
export function runSearchOf(series: string): RunSearch {
  const year = series.trim().match(/\((\d{4})\)$/)?.[1];
  return { name: seriesWithoutRunYear(series), year: year ? Number(year) : null };
}

/** A run as a person is offered it to choose: its name, first year, publisher, how many issues, and its page. */
export interface Run {
  /** "4050-123456": the address to look an issue of it up by. */
  id: string;
  name: string;
  startYear: number | null;
  publisher: string;
  issues: number | null;
  /** Its page on ComicVine, linked back to. */
  address: string;
}

export function runOf(volume: CvVolume): Run {
  const year = Number(volume.start_year);
  return {
    id: runKey(volume.id),
    name: volume.name.trim(),
    startYear: Number.isInteger(year) && year > 0 ? year : null,
    publisher: volume.publisher?.name?.trim() ?? "",
    issues: typeof volume.count_of_issues === "number" ? volume.count_of_issues : null,
    address: runPage(volume),
  };
}

/** The small picture of a run's first cover, as ComicVine gives it, or null. A host fetches it: a device never asks ComicVine. */
export function runPicture(volume: CvVolume): string | null {
  const image = volume.image;
  return image?.thumb_url || image?.small_url || image?.icon_url || null;
}

/** A name compared loosely: letters and digits, lower case. */
const loosely = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The runs found, in the order a person is offered them: the ones named
 * just as asked first, then the ones of the year asked, then the longest.
 * Nothing is chosen for them.
 */
export function runsInOrder(runs: readonly CvVolume[], asked: RunSearch): CvVolume[] {
  const rank = (v: CvVolume) => [loosely(v.name) === loosely(asked.name) ? 0 : 1, asked.year !== null && Number(v.start_year) === asked.year ? 0 : 1, -(v.count_of_issues ?? 0)];
  return runs
    .map((v, at) => ({ v, at, rank: rank(v) }))
    .sort((a, b) => a.rank[0]! - b.rank[0]! || a.rank[1]! - b.rank[1]! || a.rank[2]! - b.rank[2]! || a.at - b.at)
    .map((r) => r.v);
}

// Which issue it is --------------------------------------------------------

/** Two issue numbers that are the same issue: "014" and "14", "#7" and "7", "½" and "0.5"; "1.MU" only as itself. */
export function sameIssueNumber(a: string, b: string): boolean {
  const plain = (n: string) => {
    const t = n.trim().replace(/^#/, "").toLowerCase();
    const number = issueNumber(t);
    return number !== null ? String(number) : t;
  };
  return plain(a) !== "" && plain(a) === plain(b);
}

/** The issue of a run with this number, among those ComicVine answered with, or null. */
export function issueByNumber(issues: readonly CvIssue[], number: string): CvIssue | null {
  return issues.find((i) => sameIssueNumber(i.issue_number ?? "", number)) ?? null;
}

/**
 * How a host asks ComicVine: a request's results, or null when it has no
 * such thing. It throws when ComicVine can't be asked just now (out of
 * reach, refusing the key, too many requests even after waiting).
 */
export type Ask = <T>(request: CvRequest) => Promise<T | null>;

/** What a look-up found: the issue, its run, and what they say of the comic, read as the comic is (an issue, a collection, or on its own). */
export interface LookedUp {
  /** The issue's page, linked back to: what the match is kept by. */
  address: string;
  as: ComicShape;
  /** What ComicVine says, as the edits' fields (`matchedValues`). */
  values: EditValues;
  /** Its whole answer: the issue, and its run when there is one. */
  issue: CvIssue;
  run: CvVolume | null;
}

/** What a comic is looked up by: an issue's address; or a run's, with the number of the issue in it. */
export interface LookUpAsked {
  address: CvAddress;
  /** The issue's number in the run, for a run's address: a collection's is its volume. */
  number?: string;
  /** How ComicVine's issue number is read: an issue's, or a collection's volume, or neither for a comic on its own. */
  as: ComicShape;
}

/**
 * Look a comic up (section 7, "Look it up"): by an issue's address, the
 * issue and then its run; by a run's, the run, its issue with that number,
 * and the issue whole. Null when ComicVine has no such issue, or a run's
 * address comes without a number.
 */
export async function lookUpComic(ask: Ask, asked: LookUpAsked): Promise<LookedUp | null> {
  let issue: CvIssue | null;
  let run: CvVolume | null;
  if (asked.address.kind === "issue") {
    issue = await ask<CvIssue>(issueRequest(asked.address.id));
    if (!issue) return null;
    run = issue.volume ? await ask<CvVolume>(runRequest(issue.volume.id)) : null;
  } else {
    const number = asked.number?.trim();
    if (!number) return null;
    run = await ask<CvVolume>(runRequest(asked.address.id));
    if (!run) return null;
    const found = issueByNumber((await ask<CvIssue[]>(issuesRequest(run.id, number))) ?? [], number);
    issue = found ? await ask<CvIssue>(issueRequest(found.id)) : null;
    if (!issue) return null;
  }
  return { address: issuePage(issue), as: asked.as, values: matchedValues(issue, run, asked.as), issue, run };
}

// What is filled -----------------------------------------------------------

/**
 * ComicVine's words for what someone did, and the roles Ribbon keeps them
 * as (section 2): several to a person, apart by commas. An artist credited
 * alone drew and inked. A word not here (ComicVine's "other", say) is
 * left out; nobody is put in a role on a guess.
 */
const ROLE_WORDS: Record<string, readonly Role[]> = {
  writer: ["writers"],
  penciler: ["pencils"],
  penciller: ["pencils"],
  artist: ["pencils", "inks"],
  inker: ["inks"],
  colorist: ["colours"],
  colourist: ["colours"],
  letterer: ["letters"],
  cover: ["coverArtists"],
  "cover artist": ["coverArtists"],
  editor: ["editors"],
};

/** The roles one of ComicVine's credits says: "penciler, inker, cover" is pencils, inks and cover. */
export function rolesOf(words: string): Role[] {
  const roles = words
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .flatMap((w) => ROLE_WORDS[w] ?? []);
  return [...new Set(roles)];
}

/** An issue's people by role, each name once in a role, in the order ComicVine lists them. */
export function creditsFrom(people: readonly CvPerson[]): Credits {
  const credits: Credits = {};
  for (const person of people) {
    const name = person.name.trim();
    if (!name) continue;
    for (const role of rolesOf(person.role)) {
      const names = (credits[role] ??= []);
      if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
  }
  return credits;
}

/** A run as a comic's series: its name, with its first year in brackets, "Transformers (2023)", unless the name has one there already. */
export function runSeries(run: Pick<CvVolume, "name" | "start_year">): string {
  const name = run.name.trim();
  const year = run.start_year?.trim() ?? "";
  return /^\d{4}$/.test(year) && !/\(\d{4}\)$/.test(name) ? `${name} (${year})` : name;
}

/** A day on sale as a comic keeps it: 2024-07-10. */
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * What ComicVine says of a comic, as the edits' fields (section 7, "What
 * is filled"). Only what it says: a field it is silent on is left out, and
 * shows what the files say.
 *
 * - **Series**: the run's name, with its first year in brackets.
 * - **Issue, or volume**: the issue's number, read as the comic is: a
 *   collection's "issue" on ComicVine is its volume. Read as one, the other
 *   is emptied, as the form's "It is" does, so a number its file gives
 *   doesn't keep it what it was. For a comic on its own, neither.
 * - **Title**: the issue's name. **Credits**: its people, by role. **Cover
 *   date**: its cover date's month (its year follows). **Day on sale**:
 *   its store date. **Story arcs**: its arcs. **Publisher**: the run's.
 * - **Description**: the issue's, its HTML made plain paragraphs as
 *   Audible's are, else its deck. Never the run's: that is about the run.
 * - **Never**: imprint, language, genres, reading direction, the issues a
 *   collection holds, and the cover.
 */
export function matchedValues(issue: CvIssue, run: CvVolume | null, as: ComicShape): EditValues {
  const out: EditValues = {};
  const say = (field: EditField, value: string | null | undefined) => {
    const t = value?.trim();
    if (t) out[field] = t;
  };
  const runName = run?.name ?? issue.volume?.name;
  if (runName?.trim()) say("series", runSeries({ name: runName, start_year: run?.start_year ?? null }));
  const number = issue.issue_number?.trim();
  if (number && as !== "alone") {
    for (const field of shapeEmpties(as)) out[field] = "";
    out[as === "collection" ? "volume" : "issue"] = number;
  }
  say("title", issue.name);
  for (const [role, names] of Object.entries(creditsFrom(issue.person_credits ?? []))) say(role as Role, names.join("; "));
  const coverDate = issue.cover_date ? coverDateFrom(issue.cover_date) : null;
  if (coverDate) out.coverDate = coverDate;
  const onSale = issue.store_date?.trim();
  if (onSale && DAY.test(onSale)) out.onSale = onSale;
  say(
    "storyArcs",
    (issue.story_arc_credits ?? [])
      .map((arc) => arc.name.trim())
      .filter(Boolean)
      .join("; "),
  );
  say("publisher", run?.publisher?.name);
  say("description", summaryText(issue.description ?? "") || summaryText(issue.deck ?? ""));
  return out;
}

// The layer ----------------------------------------------------------------

/** A comic's match as a host keeps it and lays it: what ComicVine said for each field, and the issue's page. */
export interface ComicVineLayer {
  values: EditValues;
  address: string;
}

/**
 * A comic's ComicVine match as a server gives it, beside its edits
 * (`GET /api/books/:id`, `matched`): what ComicVine said for each field,
 * already laid under the edits; its issue's page, which a device shows as
 * "Details from ComicVine" and links back to; how its number was read; and
 * when it was kept.
 */
export interface SharedMatch {
  address: string;
  as: ComicShape;
  values: EditValues;
  matchedAt: string;
}

/**
 * A book with what ComicVine said laid over what its files say: under a
 * person's edits, which go over it after (above). Its ComicVine address
 * is the issue matched. A book with no match is given back as it is.
 */
export function withMatch<B extends Partial<Book>>(book: B, match: ComicVineLayer | null | undefined): B {
  if (!match) return book;
  const address = comicVineAddress(match.address);
  return { ...applyEdits(book, match.values), ...(address?.kind === "issue" ? { comicvine: issueKey(address.id) } : {}) };
}

/** The number a run's issue is looked for by, for a comic read this way: an issue's issue number, a collection's volume. */
export function numberToLookUp(book: Pick<Book, "issue" | "volume">, as: ComicShape): string {
  return (as === "collection" ? book.volume : book.issue)?.trim() ?? "";
}
