// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteBook } from "@ribbon/core/server-books";
import type { Source } from "@ribbon/core/sources";
import { nodeHost } from "@ribbon/host-node/node";
import { AppController, type AppState, type FoundLine, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";
import { LibraryPane } from "../src/ui/LibraryPane";
import { ControllerContext } from "../src/ui/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LION = remoteBook({ id: "0123456789abcdef", title: "The Lion: Son of the Forest", author: "Mike Brooks", narrator: "Jonathan Keeble", series: "", seriesIndex: null, durationMs: 60 * 60_000, sizeBytes: 1000, audio: true, ebook: true, ebookBytes: 100, cover: null, addedAt: "2026-10-28T00:00:00.000Z" });
const SERVER: Source = { id: "server", root: "/ribbon/servers/server", name: "ribbon.example", addedAt: "2026-10-23T00:00:00.000Z", server: { url: "https://ribbon.example", person: "Khalid" } };
const FOLDER: Source = { id: "folder", root: "/books", name: "books", addedAt: "2026-10-23T00:00:00.000Z" };
const LINE: FoundLine = { book: "0123456789abcdef", bookId: LION.book.id, sentence: 1682, ms: 12_091_000, chapter: "IX", text: "‘There is no malady at work here, my lord.", matches: [[1, 41]] };

/**
 * The shelf searched with words from inside a book: the lines a server's
 * search found under the books whose details match, as the Apple app's
 * Find a line shows them.
 */
describe("lines found by a search", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  /** The library searched for `query`, matching no book, with these lines found (null: still being asked), from these sources. */
  const searched = (lines: FoundLine[] | null, sources: Source[]) => {
    const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources() };
    const app = new AppController(platform);
    const read = vi.spyOn(app, "readLine").mockResolvedValue();
    (app as unknown as { set(s: Partial<AppState>): void }).set({ phase: "ready", sources, books: [{ ...LION, source: sources[0]!.id }] });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <ControllerContext.Provider value={app}>
          <LibraryPane query="There is no malady at work here, my lord" onQuery={() => undefined} found={[]} lines={lines} count={null} onSubmit={() => undefined} />
        </ControllerContext.Provider>,
      ),
    );
    return { host, read };
  };

  it("shows each line with the words searched for lit, and where it is, and opens the reader on the one chosen", () => {
    const { host, read } = searched([LINE], [SERVER]);
    const text = host.textContent ?? "";
    expect(text).toContain("1 line in your books");
    expect(text).not.toContain("No matches");
    const row = host.querySelector("#lines-title")!.closest("section")!.querySelector("li button") as HTMLButtonElement;
    expect(row.textContent).toContain("The Lion: Son of the Forest · IX · 3:21:31");
    expect(row.querySelector(".text-ink")?.textContent).toBe("There is no malady at work here, my lord.");

    act(() => row.click());
    expect(read).toHaveBeenCalledWith(LINE);
  });

  it("says nothing matches only once the server has answered", () => {
    expect(searched(null, [SERVER]).host.textContent).not.toContain("No matches");
    expect(searched(null, [SERVER]).host.textContent).toContain("Searching your books…");
    expect(searched([], [SERVER]).host.textContent).toContain("No matches");
  });

  it("doesn't wait for lines without a server, which is what finds them", () => {
    expect(searched(null, [FOLDER]).host.textContent).toContain("No matches");
  });
});
