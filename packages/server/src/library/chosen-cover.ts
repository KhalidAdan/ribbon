import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Host } from "@ribbon/core/host";
import { inTurn } from "./book-folder.ts";
import { makeCovers, type Cover } from "./covers.ts";

/**
 * A book's cover made from a picture a person chose for it (the edit
 * form's, or a page of a comic an assistant was asked to use, mcp.ts):
 * its sizes beside the book's own covers, in the book's turn
 * (book-folder.ts). Null when the picture can't be read, and "gone" when
 * the book was deleted meanwhile.
 */
export async function coverFrom(host: Host, dataDir: string, id: string, picture: Uint8Array): Promise<Cover | null | "gone"> {
  return inTurn(dataDir, id, async (book) => {
    if (!(await book.stored())) return "gone";
    const dir = path.join(book.dir, "covers");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `chosen-${randomBytes(4).toString("hex")}`);
    await writeFile(file, picture);
    try {
      return await makeCovers(host, { image: file }, dir);
    } finally {
      await rm(file, { force: true });
    }
  });
}
