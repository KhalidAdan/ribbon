import type { FastifyInstance } from "fastify";
import { comicShape, type ComicShape } from "@ribbon/core/comic-name";
import { panelsFrom, type Panel } from "@ribbon/core/comic/panels";
import { formFields, shapeEmpties, type FormField } from "@ribbon/core/edit-form";
import { applyEdits, coverDateFrom, editColumn, fieldText, isRoleField, sharedEdits, switchText, type EditValues } from "@ribbon/core/edits";
import type { Book } from "@ribbon/core/types";
import { nodeHost } from "@ribbon/host-node/node";
import { pagePicture } from "@ribbon/host-node/page-picture";
import { signedIn, type Auth, type Person } from "./auth.ts";
import type { Events } from "./events.ts";
import { asEdited, bookDir, type BookIndex, type StoredBook } from "./library/books.ts";
import { coverFrom } from "./library/chosen-cover.ts";
import type { LibrarySeries } from "./library/series.ts";
import { pageBytes } from "./library/comic.ts";
import type { ComicPanels } from "./library/panels.ts";
import { comicOn, dividedPages } from "./panels-routes.ts";

/**
 * The server's MCP (docs/COMICS.md, section 14): the library's comics and
 * their panels as tools an assistant can call, so a person can ask one to
 * look at a comic's pages and say what its panels are, and in what order.
 *
 * It is one address, `POST /mcp`, speaking the Model Context Protocol the
 * plain way: a JSON-RPC message in, its answer out as JSON, and nothing
 * remembered between two messages. An assistant is pointed at it with a
 * key the admin makes (`npm run key`, key.ts), which is a session like a
 * device's. Only the admin's key works: the tools change the library.
 *
 * The tools do nothing of their own. They read and keep panels through
 * the store the devices' routes use (panels-routes.ts), and what a panel
 * may be is core's to say (packages/core/src/comic/panels.ts): so a
 * person's editor and an assistant keep to the same rules.
 *
 * A comic's details go the same way (docs/COMICS.md, section 4): an
 * assistant asked to fill them in from somewhere a person trusts sets
 * the fields the desktop's edit form shows for a comic
 * (packages/core/src/edit-form.ts), kept as that form's edits are, and
 * can make any page of a comic its cover, as "Choose a page…" does there.
 * They are a comic's own (docs/BOOK-DETAILS.md, section 5): its issue, or
 * its volume and the issues it collects; its title, the story's own name;
 * its people by what they did; its cover date and the day it went on sale.
 * Each goes by its name in the edits' CSV (`cover_artists`, `cover_date`).
 * Which way a comic reads is one of them, the form's switch, said here in
 * words: "right to left" or "left to right"; and a byline kept from before
 * comics had people of their own is `by`, which can only be taken back.
 */

/** The versions of the protocol this speaks, newest first. Asked for another, it answers with the newest. */
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** How large a page is sent to be looked at: enough to see every panel's edge, small enough to look at hundreds in a night. */
const LOOK_LONGEST = 1200;

/** What a tool sends back: words, and pictures of pages. */
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, me: Person): Promise<Content[]>;
}

/** What went wrong with what a tool was asked, to be said back in a sentence. */
class Refused extends Error {}

const HOW_PANELS_ARE_MEASURED =
  "A panel is a rectangle: x and y are its top left corner and w and h its size, each a fraction of the page from 0 to 1 (x 0 is the page's left edge, y 0 its top, w 1 its whole width). List panels in the order they are read. Take each panel's box to the outside of its border, and include a caption or a balloon that belongs to it even where it breaks the border. A page with one picture across it is one panel: x 0, y 0, w 1, h 1.";

/**
 * What a detail is called for an assistant: its name in the edits' CSV
 * (`editColumn`: `cover_artists`, `cover_date`, `on_sale`, `story_arcs`),
 * except the switch for which way a comic reads, and a byline kept from
 * before writers and artists had fields of their own (docs/BOOK-DETAILS.md,
 * section 6), which is `by`, as the form calls it.
 */
const NAMED: Partial<Record<FormField, string>> = { rightToLeft: "reads", author: "by" };

/**
 * The details an assistant gives a comic: the ones the edit form asks a
 * comic for (docs/BOOK-DETAILS.md, section 5), and its year, which follows
 * its cover date unless a person said otherwise, so one said before can be
 * taken back.
 */
const COMIC_FIELDS: FormField[] = formFields("comic").flatMap((f) => (f === "coverDate" ? [f, "year" as const] : [f]));

/** A comic's details by the names an assistant gives them. */
const DETAILS: Record<string, FormField> = Object.fromEntries(COMIC_FIELDS.map((f) => [NAMED[f] ?? editColumn(f), f]));

/** Which way a comic reads, in the words an assistant reads and gives. */
const READS = { rightToLeft: "right to left", leftToRight: "left to right" } as const;

/** What a comic is (comic-name.ts), in the words an assistant reads. */
const IS: Record<ComicShape, string> = { issue: "an issue", collection: "a collection", alone: "a comic on its own" };

const HOW_DETAILS_ARE_GIVEN = [
  `Details are given by name: ${Object.keys(DETAILS).join(", ")}. Each is text; issue, volume and year may be numbers, and a list of names may be a list.`,
  `The title is the story's own name, if it has one ("Chapter Fourteen"), and nothing else: the shelf names the comic from its series, its number and its title ("Saga #14: Chapter Fourteen", "Transformers Vol. 1: Robots in Disguise"), so never put the series or the number in the title.`,
  `A comic is an issue, with an issue number (issue: "14", or "½" or "1.MU" as printed); or a collection, with a volume number and the issues it collects, written as numbers and ranges apart by commas (volume: "1", collects: "1–6, Annual 1"); or a comic on its own, with neither. Giving an issue makes it an issue and empties its volume and collects; giving a volume or collects makes it a collection and empties its issue.`,
  `The people who made it are given by what they did: writers, pencils (its art; an artist credited alone drew and inked it, so give them as pencils and leave inks empty), inks, colours, letters, cover_artists, editors and translators, several names apart by semicolons ("Daniel Warren Johnson; Jorge Corona").`,
  `A date is written as numbers: cover_date is the month on its cover, 2024-07, or the year alone, 2024; on_sale is the day it went on sale, 2024-07-10. Its year follows its cover date: give year only to say otherwise, or as null to take back one said before.`,
  `story_arcs are apart by semicolons and genres by commas; reads is which way its pages turn, "${READS.rightToLeft}" (as manga reads) or "${READS.leftToRight}". by is a byline kept from before writers and artists had fields of their own: once its names are in writers and pencils, give by as null to take it back.`,
  `An empty text empties a detail; null takes a correction back, to what the comic's file says.`,
].join(" ");

/** A comic's detail as an assistant reads it: the edit form's text, and which way it reads in words. */
function detailText(book: Book, field: FormField): string {
  if (field === "rightToLeft") return book.rightToLeft ? READS.rightToLeft : READS.leftToRight;
  return fieldText(book, field);
}

/** A day on sale as a comic keeps it: 2024-07-10. */
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The details that may be given as a number: they are kept as its text. */
const NUMBERS: ReadonlySet<FormField> = new Set(["issue", "volume", "year"]);

/** Whether a detail is a list: its names (a role), its story arcs, its genres. */
function isList(field: FormField): boolean {
  return isRoleField(field) || field === "storyArcs" || field === "genres";
}

/** What an assistant is told a detail is, where its name doesn't say enough. */
const SAID: Partial<Record<FormField, string>> = {
  title: "The story's own name, without the series or the number.",
  collects: "The issues a collection holds: 1–6, Annual 1.",
  coverDate: "The month on its cover, 2024-07, or its year alone, 2024.",
  onSale: "The day it went on sale, 2024-07-10.",
  year: "Follows the cover date: give it only to say otherwise, or as null to take back a year said before.",
  author: "A byline kept from before: null takes it back, once its names are in writers and pencils.",
};

/** What a detail may be given as, for an assistant's tool list. */
function detailSchema(field: FormField): Record<string, unknown> {
  const said = SAID[field] ? { description: SAID[field] } : {};
  if (field === "rightToLeft") return { type: ["string", "null"], enum: [READS.rightToLeft, READS.leftToRight, null] };
  if (field === "author") return { type: "null", ...said };
  if (NUMBERS.has(field)) return { type: ["string", "number", "null"], ...said };
  if (isList(field)) return { type: ["string", "array", "null"], items: { type: "string" }, ...said };
  return { type: ["string", "null"], ...said };
}

/**
 * A detail as an assistant gave it, made the edit the form would keep:
 * which way it reads as the form's switch, a list as names apart by
 * semicolons, a cover date as 2024-07. Refused, in a sentence it can act
 * on, when it can't be one.
 */
function detailValue(name: string, field: FormField, value: unknown): string {
  if (field === "rightToLeft") {
    // One way or the other: kept as the edit form's switch keeps it.
    const said = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (said !== READS.rightToLeft && said !== READS.leftToRight) throw new Refused(`Give reads as "${READS.rightToLeft}" or "${READS.leftToRight}", or null for what the comic's file says.`);
    return switchText(said === READS.rightToLeft);
  }
  // A byline is only ever one kept from before: a new one would say nothing of who wrote and who drew.
  if (field === "author") throw new Refused("by is a byline kept from before writers and artists had fields of their own, and it can only be taken back, with null. Give the comic's people as writers, pencils and the rest.");
  let text: string | null = null;
  if (typeof value === "string") text = value.trim();
  else if (typeof value === "number" && Number.isFinite(value) && NUMBERS.has(field)) text = String(value);
  else if (Array.isArray(value) && isList(field) && value.every((v) => typeof v === "string")) text = value.map((v) => v.trim()).join(field === "genres" ? ", " : "; ");
  if (text === null || text.length > DETAIL_LETTERS) throw new Refused(`Give ${name} as text. ${HOW_DETAILS_ARE_GIVEN}`);
  if (!text) return text;
  if (field === "coverDate") {
    const date = coverDateFrom(text);
    if (!date) throw new Refused(`Give cover_date as the month on the comic's cover, 2024-07, or its year alone, 2024: "${text}" isn't one.`);
    return date;
  }
  if (field === "onSale" && !DAY.test(text)) throw new Refused(`Give on_sale as the day the comic went on sale, 2024-07-10: "${text}" isn't one.`);
  if (field === "year" && !/^\d{4}$/.test(text)) throw new Refused(`Give year as a year, 2024: "${text}" isn't one.`);
  return text;
}

/** The longest a detail may be, as the edit form's route has it. */
const DETAIL_LETTERS = 20_000;

export function mcpRoutes(app: FastifyInstance, deps: { auth: Auth; books: BookIndex; panels: ComicPanels; series: LibrarySeries; events: Events; dataDir: string }): void {
  const host = nodeHost();
  const text = (words: string): Content => ({ type: "text", text: words });

  /** A comic as it stands, as every device shows it: its file's details with the corrections laid over them, named from them. */
  const asCorrected = (comic: { id: string; stored: StoredBook }) => asEdited(comic.stored.book, deps.books.edits(comic.id)?.values ?? {}, deps.books.hasDetails(comic.id));

  /** Which way a comic reads, as every device reads it. */
  const readsOf = (comic: { id: string; stored: StoredBook }) => detailText(asCorrected(comic), "rightToLeft");

  /**
   * A comic's details as they stand: the name the shelf shows, what it is,
   * each detail by name, which of them were corrected by hand, and what its
   * cover is. A byline kept from before (`by`) is there only while it is,
   * as the form shows it.
   */
  const detailsOf = (comic: { id: string; stored: StoredBook }) => {
    const corrected = deps.books.edits(comic.id)?.values ?? {};
    const book = asCorrected(comic);
    const shown = Object.entries(DETAILS).filter(([, field]) => field !== "author" || corrected.author !== undefined);
    return {
      id: comic.id,
      name: book.title,
      is: IS[comicShape(book)],
      ...Object.fromEntries(shown.map(([name, field]) => [name, detailText(book, field)])),
      pages: comic.stored.pages?.length ?? 0,
      corrected: shown.flatMap(([name, field]) => (corrected[field] !== undefined ? [name] : [])),
      cover: deps.books.chosenCover(comic.id) ? "chosen by hand" : "its first page",
    };
  };

  const comicAsked = async (args: Record<string, unknown>) => {
    const id = typeof args.book === "string" ? args.book : "";
    const comic = await comicOn(deps, id);
    if (!comic) throw new Refused(`There is no comic with the id "${id}" on this server. list_comics gives each comic's id.`);
    return { id, ...comic };
  };

  const pageAsked = async (args: Record<string, unknown>) => {
    const comic = await comicAsked(args);
    const number = typeof args.page === "number" && Number.isInteger(args.page) ? args.page : 0;
    const page = comic.pages[number - 1];
    if (!page) throw new Refused(`This comic has ${comic.pages.length} pages, counted from 1.`);
    return { ...comic, number, page };
  };

  /** The page as a picture to look at, with panels drawn over it and numbered when given. */
  const picture = async (comic: Awaited<ReturnType<typeof pageAsked>>, panels: readonly Panel[]): Promise<Content[]> => {
    const bytes = await pageBytes(bookDir(deps.dataDir, comic.id), comic.file, comic.pages, comic.number - 1);
    try {
      const drawn = await pagePicture(bytes, { longest: LOOK_LONGEST, panels });
      return [{ type: "image", data: Buffer.from(drawn.jpeg).toString("base64"), mimeType: "image/jpeg" }];
    } catch {
      return [text("This server can't draw a page to be looked at: the canvas it draws on (@napi-rs/canvas) isn't installed (packages/server/README.md).")];
    }
  };

  const tools: Tool[] = [
    {
      name: "list_comics",
      description: "The comics on this Ribbon server: each one's id, the name the shelf shows it by (\"Saga #14: Chapter Fourteen\"), its series, how many pages it has and how many of them have their panels set. Give `query` to list only those whose name or series holds those words.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Words in the name or the series." } } },
      async run(args) {
        const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
        const divided = deps.panels.counts();
        const comics = deps.books
          .list()
          .filter((b) => b.comic && (!query || `${b.title} ${b.series ?? ""}`.toLowerCase().includes(query)))
          .map((b) => ({ id: b.id, name: b.title, series: b.series ?? null, pages: b.pages ?? 0, pagesWithPanels: divided.get(b.id) ?? 0 }));
        return [text(JSON.stringify({ comics }, null, 1))];
      },
    },
    {
      name: "comic_pages",
      description: "One comic's pages: the name the shelf shows it by, which way it reads, each page's number (from 1) and size in pixels, and the pages whose panels are set. Use it to see what is left to do in a comic.",
      inputSchema: { type: "object", properties: { book: { type: "string", description: "The comic's id, from list_comics." } }, required: ["book"] },
      async run(args) {
        const comic = await comicAsked(args);
        const divided = dividedPages(comic.pages, deps.panels.of(comic.id));
        return [
          text(
            JSON.stringify(
              {
                name: asCorrected(comic).title,
                reads: readsOf(comic),
                pages: comic.pages.map((page, at) => ({ page: at + 1, width: page.width, height: page.height, panels: divided.find((d) => d.page === at + 1)?.panels.length ?? 0 })),
              },
              null,
              1,
            ),
          ),
        ];
      },
    },
    {
      name: "look_at_page",
      description: "One page of a comic as a picture, with the panels it has now drawn over it, each outlined and numbered in reading order, and listed. Look at a page before setting its panels.",
      inputSchema: { type: "object", properties: { book: { type: "string" }, page: { type: "integer", description: "The page's number, from 1." } }, required: ["book", "page"] },
      async run(args) {
        const comic = await pageAsked(args);
        const panels = deps.panels.ofPage(comic.id, comic.page.name);
        return [...(await picture(comic, panels)), text(JSON.stringify({ page: comic.number, of: comic.pages.length, reads: readsOf(comic), panels }))];
      },
    },
    {
      name: "set_panels",
      description: `Set one page's panels, in place of any it had. ${HOW_PANELS_ARE_MEASURED} The answer is the page with the new panels drawn over it and numbered: check each box holds its whole panel and that the numbers follow the reading order, and set them again if not. An empty list takes the page's panels away.`,
      inputSchema: {
        type: "object",
        properties: {
          book: { type: "string" },
          page: { type: "integer", description: "The page's number, from 1." },
          panels: {
            type: "array",
            description: "The page's panels in reading order.",
            items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } }, required: ["x", "y", "w", "h"] },
          },
          show: { type: "boolean", description: "False to leave the picture out of the answer. It is sent unless this says not to." },
        },
        required: ["book", "page", "panels"],
      },
      async run(args, me) {
        const comic = await pageAsked(args);
        const panels = panelsFrom(args.panels);
        if (!panels) throw new Refused(`Give the page's panels as a list. ${HOW_PANELS_ARE_MEASURED}`);
        const problem = deps.panels.keep(comic.id, comic.page.name, panels, me.id);
        if (problem) throw new Refused(problem);
        const said = text(panels.length > 0 ? `Page ${comic.number} has ${panels.length} ${panels.length === 1 ? "panel" : "panels"} now.` : `Page ${comic.number} has no panels now, and is read whole.`);
        return args.show === false ? [said] : [...(await picture(comic, panels)), said];
      },
    },
    {
      name: "comic_details",
      description:
        "One comic's details as every device shows them: the name the shelf shows it by, made from its series, its number and its title; what it is (an issue, a collection, or a comic on its own); its series, issue, volume and the issues it collects; its title, the story's own name; the people who made it, by what they did; its cover date, its year, the day it went on sale; its publisher, imprint, story arcs, language, genres, ISBN and description; which way it reads; a byline kept from before its people had fields of their own (by), while it has one. And which of them were corrected by hand, and whether its cover is its first page or one chosen by hand.",
      inputSchema: { type: "object", properties: { book: { type: "string", description: "The comic's id, from list_comics." } }, required: ["book"] },
      async run(args) {
        return [text(JSON.stringify(detailsOf(await comicAsked(args)), null, 1))];
      },
    },
    {
      name: "set_details",
      description: `Correct a comic's details, for every device. Only the details given change; the rest stay as they are. ${HOW_DETAILS_ARE_GIVEN} The comic's file is never touched. Comics that name the same series are put in it together, in the order of their issues (a collection where the first issue it collects would be), once three of them do. The answer is the comic's details as they then stand.`,
      inputSchema: {
        type: "object",
        properties: {
          book: { type: "string" },
          details: {
            type: "object",
            description: "The details to change, by name.",
            properties: Object.fromEntries(Object.entries(DETAILS).map(([name, field]) => [name, detailSchema(field)])),
          },
        },
        required: ["book", "details"],
      },
      async run(args, me) {
        const comic = await comicAsked(args);
        const given = args.details && typeof args.details === "object" && !Array.isArray(args.details) ? Object.entries(args.details as Record<string, unknown>) : null;
        if (!given || given.length === 0) throw new Refused(`Give the details to change. ${HOW_DETAILS_ARE_GIVEN}`);
        // Laid over the corrections it has, as the edit form's are: the last one stands.
        const values: EditValues = { ...(deps.books.edits(comic.id)?.values ?? {}) };
        const named = new Set<FormField>();
        for (const [name, value] of given) {
          const field = DETAILS[name];
          if (!field) throw new Refused(`A comic has no detail called "${name}". ${HOW_DETAILS_ARE_GIVEN}`);
          named.add(field);
          if (value === null) delete values[field];
          else values[field] = detailValue(name, field, value);
        }
        // Said to be an issue, or a collection: what the other shape has is emptied, as the form's "It is" does, so a
        // number the comic's file gives doesn't keep it what it was. Never both at once.
        const saidIssue = !!values.issue?.trim() && named.has("issue");
        const saidCollection = (!!values.volume?.trim() && named.has("volume")) || (!!values.collects?.trim() && named.has("collects"));
        if (saidIssue && saidCollection) throw new Refused(`A comic is an issue or a collection, not both: give an issue, or a volume and collects. ${HOW_DETAILS_ARE_GIVEN}`);
        const shape = saidIssue ? "issue" : saidCollection ? "collection" : null;
        if (shape) {
          const now = applyEdits(comic.stored.book, values);
          for (const field of shapeEmpties(shape)) if (!named.has(field) && fieldText(now, field)) values[field] = "";
        }
        deps.books.saveEdits(comic.id, { values: sharedEdits(values), updatedAt: new Date().toISOString() }, me.id);
        deps.events.toEveryone({ type: "books", data: { edited: comic.id } });
        // A series it names now is one it belongs to, as a book that arrives naming one does.
        if (deps.series.find(deps.books.list(), Date.now()) > 0) deps.events.toEveryone({ type: "series", data: {} });
        return [text(JSON.stringify(detailsOf(comic), null, 1))];
      },
    },
    {
      name: "set_cover",
      description: "Make one page of a comic its cover, on every device: a collection's files give it its first page, and a better one is often inside. Look at the page first (look_at_page). Give page 0 to go back to the cover its file gives it. The answer is the page that is now the cover.",
      inputSchema: { type: "object", properties: { book: { type: "string" }, page: { type: "integer", description: "The page's number, from 1; 0 for the cover the comic's file gives it." } }, required: ["book", "page"] },
      async run(args, me) {
        const at = new Date().toISOString();
        if (args.page === 0) {
          const comic = await comicAsked(args);
          deps.books.chooseCover(comic.id, null, me.id, at);
          deps.events.toEveryone({ type: "books", data: { edited: comic.id } });
          return [text("Its cover is the one its file gives it again.")];
        }
        const comic = await pageAsked(args);
        const cover = await coverFrom(host, deps.dataDir, comic.id, await pageBytes(bookDir(deps.dataDir, comic.id), comic.file, comic.pages, comic.number - 1));
        if (cover === "gone") throw new Refused("That comic was deleted just now.");
        if (!cover) throw new Refused(`Page ${comic.number} couldn't be made into a cover: it isn't a picture this server can read.`);
        deps.books.chooseCover(comic.id, cover, me.id, at);
        deps.events.toEveryone({ type: "books", data: { edited: comic.id } });
        return [...(await picture(comic, [])), text(`Page ${comic.number} is its cover now.`)];
      },
    },
  ];

  /** One message answered: its result, or the error to send back; undefined for a note that wants no answer. */
  const answer = async (message: { id?: unknown; method?: unknown; params?: unknown }, me: Person): Promise<unknown> => {
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
    const done = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
    const failed = (code: number, words: string) => ({ jsonrpc: "2.0", id: message.id ?? null, error: { code, message: words } });
    if (typeof message.method !== "string") return failed(-32600, "Not a request.");
    // A note (no id) is heard and not answered.
    if (message.id === undefined || message.id === null) return undefined;
    switch (message.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return done({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "ribbon", version: "1" },
          instructions:
            "A Ribbon server's comics: their panels, their details and their covers. To set a comic's panels: list_comics to find it, comic_pages to see what is left, then for each page look_at_page and set_panels, checking the picture set_panels sends back. To fill in a comic's details: comic_details to see what it has, then set_details with what should change; set_cover makes a page its cover.",
        });
      }
      case "ping":
        return done({});
      case "tools/list":
        return done({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) return failed(-32602, `There is no tool called ${String(params.name)}.`);
        try {
          return done({ content: await tool.run((params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>, me) });
        } catch (e) {
          // What was asked couldn't be done: said in the answer, where the assistant reads it and can ask again.
          if (e instanceof Refused) return done({ content: [text(e.message)], isError: true });
          app.log.warn({ err: e }, `the MCP's ${tool.name} failed`);
          return done({ content: [text("The server couldn't do that just now.")], isError: true });
        }
      }
      default:
        return failed(-32601, `This server doesn't do ${message.method}.`);
    }
  };

  app.post<{ Body: unknown }>("/mcp", async (request, reply) => {
    const me = await signedIn(deps.auth, request);
    if (!me) return reply.code(401).header("www-authenticate", "Bearer").send({ error: "Send the key the server's admin made for this (npm run key), as a bearer token." });
    if (me.role !== "admin") return reply.code(403).send({ error: "Only the admin's key works here: these tools change the library." });
    const body = request.body;
    const messages = (Array.isArray(body) ? body : [body]).filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
    if (messages.length === 0) return reply.code(400).send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Send a JSON-RPC message." } });
    const answers = (await Promise.all(messages.map((m) => answer(m, me)))).filter((a) => a !== undefined);
    // Nothing but notes: taken, with nothing to say back.
    if (answers.length === 0) return reply.code(202).send();
    return reply.type("application/json").send(Array.isArray(body) ? answers : answers[0]);
  });

  // It keeps no stream open and no session to end.
  const notHere = async (_request: unknown, reply: { code(n: number): { header(k: string, v: string): { send(b: unknown): unknown } } }) => reply.code(405).header("allow", "POST").send({ error: "This address takes POST only." });
  app.get("/mcp", notHere as never);
  app.delete("/mcp", notHere as never);
}
