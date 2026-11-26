import type { ComicShape } from "./comic-name";
import type { ComicVineLayer } from "./comicvine";
import { bytesToRows, rowsToBytes, type Row } from "./csv";
import { EDIT_FIELDS, EDIT_HEADERS, editColumn, editFieldOf, type EditValues } from "./edits";

/**
 * What ComicVine said of a comic in a folder, kept beside the books in
 * `.ribbon/matched/<id>.csv` (docs/BOOK-DETAILS.md, sections 4 and 7), so
 * it's never asked again unless a person asks. It is a layer of its own,
 * between what the comic's files say and a person's edits (comicvine.ts,
 * `withMatch`), and kept apart from the edits so a look-up never changes
 * one and forgetting the match takes the layer away whole.
 *
 * The file is in the edits' shape, one row a field (`field`, `value`,
 * `updated_at`), each field by its column in the edits' CSV, with two rows
 * more: `address`, the issue's page on ComicVine, which the comic links back
 * to; and `as`, how its number was read (an issue's, a collection's
 * volume, or neither). `updated_at` is when ComicVine was asked.
 *
 * A comic can also be noted as asked with nothing kept, in a row `none`:
 * "not found", when the address its file gives is one ComicVine has no
 * issue at; or "forgotten", when a person forgot its match. Either way it
 * is never looked up by itself again, though a person can always look it
 * up. That is kept beside the books too, so another computer sharing the
 * folder doesn't match a comic again that a person here let go of.
 */

/** A comic's ComicVine match: the layer, and how its number was read. */
export interface KeptMatch extends ComicVineLayer {
  as: ComicShape;
}

/** Why a comic was asked about and nothing is kept. */
export type NoMatch = "not found" | "forgotten";

/** A comic's ComicVine record: its match, or a note that it was asked and why there is none; and when. */
export type MatchRecord = { bookId: string; askedAt: string } & ({ match: KeptMatch } | { match: null; none: NoMatch });

const SHAPES: readonly ComicShape[] = ["issue", "collection", "alone"];
const NONE: readonly NoMatch[] = ["not found", "forgotten"];

/** A record as the file keeps it. */
export function matchToBytes(record: MatchRecord): Promise<Uint8Array> {
  const at = record.askedAt;
  const rows: Row[] = [];
  if (record.match) {
    const { address, as, values } = record.match;
    rows.push({ field: "address", value: address, updated_at: at }, { field: "as", value: as, updated_at: at });
    for (const f of EDIT_FIELDS) if (values[f] !== undefined) rows.push({ field: editColumn(f), value: values[f]!, updated_at: at });
  } else rows.push({ field: "none", value: record.none, updated_at: at });
  return rowsToBytes(rows, EDIT_HEADERS);
}

/**
 * A record from its file, or null for one that says neither a match nor
 * why there's none. A field this version doesn't know is left out: the
 * next look-up writes the record whole again.
 */
export async function bytesToMatch(bookId: string, bytes: Uint8Array): Promise<MatchRecord | null> {
  const { rows } = await bytesToRows(bytes);
  const values: EditValues = {};
  let address = "";
  let as: ComicShape = "issue";
  let none: NoMatch | null = null;
  let askedAt = "";
  for (const r of rows) {
    const column = (r.field ?? "").trim();
    const value = r.value ?? "";
    if ((r.updated_at ?? "") > askedAt) askedAt = r.updated_at ?? "";
    if (column === "address") address = value.trim();
    else if (column === "as") as = SHAPES.find((s) => s === value.trim()) ?? "issue";
    else if (column === "none") none = NONE.find((n) => n === value.trim()) ?? "forgotten";
    else {
      const f = editFieldOf(column);
      if (f) values[f] = value;
    }
  }
  if (address) return { bookId, askedAt, match: { address, as, values } };
  return none ? { bookId, askedAt, match: null, none } : null;
}
