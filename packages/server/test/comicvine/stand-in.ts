import { existsSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

/**
 * A stand-in for ComicVine's API, so no test ever asks the real one. It
 * answers from answers written by hand in the shape ComicVine's
 * documentation gives (the JSON files beside this one): an issue, a run
 * (ComicVine's volume), a search of runs by name, and a run's issues by
 * number. Every comic, person and address in them is made up. What it
 * doesn't have it answers as ComicVine says it does: status 101 for one
 * thing, an empty list for a search.
 *
 * It takes one made-up key, and answers any other with status 100. It can
 * be told to answer the next requests as a ComicVine that is blocking
 * (420, 429, status 107) or failing, or to fail everything. Each request
 * it was asked is noted, without the key, so a test can say what was
 * asked and how often. The covers it is asked for are pictures it serves
 * itself, at the addresses in its answers.
 */

/** The only key the stand-in takes: made up, as a key in this repository must be. */
export const STAND_IN_KEY = "a-made-up-key-for-the-stand-in";

const ANSWERS = import.meta.dirname;

/** The searches it has answers for, by their filter. */
const SEARCHES: Record<string, string> = {
  "name:Made Up Saga": "volumes-made-up-saga.json",
  "name:Made Up Saga,start_year:2018": "volumes-made-up-saga-2018.json",
};

/** The start of a JPEG: enough to be served as one, which is all the server does with it. */
const PICTURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

/** How the stand-in answers a request it's told to answer otherwise: as blocked (420, 429, status 107), or as failing (a 502). */
export type Trouble = "420" | "429" | "107" | "502";

export interface StandIn {
  /** Its API's address, for the server's settings. */
  api: string;
  /** Each request to the API, as its path and its question without the key or the format: "issue/4000-123456/?field_list=…". */
  asked: string[];
  /** Answer the next requests so, one each, before answering as usual again. */
  next: Trouble[];
  /** Fail every request while set: ComicVine out of reach. */
  failing: boolean;
  /** The pictures it was asked for. */
  pictures: string[];
  close(): Promise<void>;
}

/** A stand-in ComicVine, listening on this machine. */
export async function standIn(): Promise<StandIn> {
  const stand: StandIn = { api: "", asked: [], next: [], failing: false, pictures: [], close: async () => undefined };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stand-in");
    if (url.pathname.startsWith("/a/uploads/")) {
      stand.pictures.push(url.pathname);
      response.writeHead(200, { "content-type": "image/jpeg" }).end(PICTURE);
      return;
    }
    const resource = url.pathname.replace(/^\/api\//, "");
    const question = new URLSearchParams([...url.searchParams].filter(([name]) => name !== "api_key" && name !== "format"));
    stand.asked.push(`${resource}?${question.toString()}`);
    if (url.searchParams.get("api_key") !== STAND_IN_KEY) return json(response, 401, { error: "Invalid API Key", limit: 0, offset: 0, number_of_page_results: 0, number_of_total_results: 0, status_code: 100, results: [] });
    const trouble = stand.failing ? "502" : stand.next.shift();
    if (trouble === "420" || trouble === "429") return response.writeHead(Number(trouble), { "content-type": "text/plain" }).end("Slow down.");
    if (trouble === "107") return json(response, 200, { error: "Rate limit exceeded.  Slow down cowboy.", limit: 0, offset: 0, number_of_page_results: 0, number_of_total_results: 0, status_code: 107, results: [] });
    if (trouble === "502") return response.writeHead(502, { "content-type": "text/html" }).end("<html>Bad gateway</html>");
    const filter = url.searchParams.get("filter") ?? "";
    let file: string | undefined;
    const detail = resource.match(/^(issue|volume)\/(\d{4}-\d+)\/$/);
    if (detail) file = `${detail[1]}-${detail[2]}.json`;
    else if (resource === "volumes/") file = SEARCHES[filter] ?? "";
    else if (resource === "issues/") {
      const by = filter.match(/^volume:(\d+),issue_number:(.+)$/);
      file = by ? `issues-${by[1]}-${by[2]}.json` : "";
    }
    if (file === undefined) return json(response, 404, { error: "Object Not Found", status_code: 101, results: [] });
    if (file && existsSync(path.join(ANSWERS, file))) {
      // Its pictures are its own: served here, at the address its answers give.
      const text = readFileSync(path.join(ANSWERS, file), "utf8").replaceAll("https://comicvine.gamespot.com/a/uploads/", `${origin}/a/uploads/`);
      return response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(text);
    }
    if (detail) return json(response, 404, { error: "Object Not Found", limit: 0, offset: 0, number_of_page_results: 0, number_of_total_results: 0, status_code: 101, results: [] });
    return json(response, 200, { error: "OK", limit: 100, offset: 0, number_of_page_results: 0, number_of_total_results: 0, status_code: 1, results: [] });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stand.api = `${origin}/api`;
  stand.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return stand;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}
