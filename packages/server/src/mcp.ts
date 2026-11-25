import type { FastifyInstance } from "fastify";
import { panelsFrom, type Panel } from "@ribbon/core/comic/panels";
import { pagePicture } from "@ribbon/host-node/page-picture";
import { signedIn, type Auth, type Person } from "./auth.ts";
import { bookDir, type BookIndex } from "./library/books.ts";
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

export function mcpRoutes(app: FastifyInstance, deps: { auth: Auth; books: BookIndex; panels: ComicPanels; dataDir: string }): void {
  const text = (words: string): Content => ({ type: "text", text: words });

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
      description: "The comics on this Ribbon server: each one's id, title, series, how many pages it has and how many of them have their panels set. Give `query` to list only those whose title or series holds those words.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Words in the title or the series." } } },
      async run(args) {
        const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
        const divided = deps.panels.counts();
        const comics = deps.books
          .list()
          .filter((b) => b.comic && (!query || `${b.title} ${b.series ?? ""}`.toLowerCase().includes(query)))
          .map((b) => ({ id: b.id, title: b.title, series: b.series ?? null, number: b.seriesIndex ?? null, pages: b.pages ?? 0, pagesWithPanels: divided.get(b.id) ?? 0 }));
        return [text(JSON.stringify({ comics }, null, 1))];
      },
    },
    {
      name: "comic_pages",
      description: "One comic's pages: which way it reads, each page's number (from 1) and size in pixels, and the pages whose panels are set. Use it to see what is left to do in a comic.",
      inputSchema: { type: "object", properties: { book: { type: "string", description: "The comic's id, from list_comics." } }, required: ["book"] },
      async run(args) {
        const comic = await comicAsked(args);
        const divided = dividedPages(comic.pages, deps.panels.of(comic.id));
        return [
          text(
            JSON.stringify(
              {
                title: comic.stored.book.title,
                reads: comic.stored.book.rightToLeft ? "right to left" : "left to right",
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
        return [...(await picture(comic, panels)), text(JSON.stringify({ page: comic.number, of: comic.pages.length, reads: comic.stored.book.rightToLeft ? "right to left" : "left to right", panels }))];
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
          instructions: "A Ribbon server's comics and their panels. To set a comic's panels: list_comics to find it, comic_pages to see what is left, then for each page look_at_page and set_panels, checking the picture set_panels sends back.",
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
