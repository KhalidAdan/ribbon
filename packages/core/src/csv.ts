import { pipe, of, from, collect, collectBytes } from "@culvert/stream";
import { csvParse, csvStringify, type CsvSyntaxError } from "@culvert/csv";

export type Row = Record<string, string>;

export interface ParseReport {
  rows: Row[];
  /** One entry per skipped malformed line. Never fatal. */
  problems: { line: string; message: string }[];
}

/** Bytes in, records out. Malformed lines are skipped and reported. */
export async function bytesToRows(bytes: Uint8Array): Promise<ParseReport> {
  const problems: ParseReport["problems"] = [];
  const rows = await pipe(
    of(bytes),
    csvParse<Row>({
      headers: true,
      newline: "auto",
      skipEmptyLines: true,
      onMalformed: (err: CsvSyntaxError, rawLine: string) => {
        problems.push({ line: rawLine, message: err.message });
        return null;
      },
    }),
    collect(),
  );
  return { rows, problems };
}

/** Records in, bytes out. Header order is fixed by `headers`. */
export function rowsToBytes(rows: Iterable<Row>, headers: string[]): Promise<Uint8Array> {
  return pipe(from(rows), csvStringify({ headers, newline: "\n" }), collectBytes());
}

export function num(value: string | undefined, fallback = 0): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function int(value: string | undefined, fallback = 0): number {
  return Math.trunc(num(value, fallback));
}

export function bool(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
