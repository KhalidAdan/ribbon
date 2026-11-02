import type { Position } from "./types";
import { bytesToRows, rowsToBytes, int, type ParseReport } from "./csv";

export const POSITION_HEADERS = ["book_id", "offset_ms", "updated_at", "device"];

export function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

export function serializePosition(p: Position): Promise<Uint8Array> {
  return serializePositions([p]);
}

/** Several positions as one file, in the same shape as a single one. */
export function serializePositions(list: readonly Position[]): Promise<Uint8Array> {
  return rowsToBytes(
    list.map((p) => ({
      book_id: p.bookId,
      offset_ms: String(Math.max(0, Math.round(p.offsetMs))),
      updated_at: p.updatedAt,
      device: p.device,
    })),
    POSITION_HEADERS,
  );
}

export interface PositionReport {
  positions: Position[];
  problems: ParseReport["problems"];
}

/** Every well-formed row in the file. Bad rows are reported, not fatal. */
export async function parsePositions(bytes: Uint8Array): Promise<PositionReport> {
  const { rows, problems } = await bytesToRows(bytes);
  const positions: Position[] = [];
  for (const row of rows) {
    const bookId = row.book_id ?? "";
    const updatedAt = row.updated_at ?? "";
    if (!bookId || Number.isNaN(Date.parse(updatedAt))) {
      problems.push({ line: JSON.stringify(row), message: "missing book_id or bad updated_at" });
      continue;
    }
    positions.push({
      bookId,
      offsetMs: Math.max(0, int(row.offset_ms)),
      updatedAt,
      device: row.device ?? "",
    });
  }
  return { positions, problems };
}

/**
 * Last write wins. Ties on updated_at go to the lexically greater
 * device so two machines merging the same files agree on the answer.
 */
export function mergePositions(candidates: readonly Position[], bookId: string): Position | null {
  let best: Position | null = null;
  for (const p of candidates) {
    if (p.bookId !== bookId) continue;
    if (best === null || comparePositions(p, best) > 0) best = p;
  }
  return best;
}

export function comparePositions(a: Position, b: Position): number {
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  return 0;
}
