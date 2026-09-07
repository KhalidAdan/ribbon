import { bytesToRows, rowsToBytes } from "./csv";

/** A file the last scan could not read, kept so it is visible later. */
export interface Problem {
  /** Library-relative path of the file. */
  path: string;
  message: string;
  /** ISO 8601, when the scan reported it. */
  at: string;
}

export const PROBLEM_HEADERS = ["path", "message", "at"];

export function problemsToBytes(list: readonly Problem[]): Promise<Uint8Array> {
  return rowsToBytes(
    list.map((p) => ({ path: p.path, message: p.message, at: p.at })),
    PROBLEM_HEADERS,
  );
}

export async function bytesToProblems(bytes: Uint8Array): Promise<Problem[]> {
  const { rows } = await bytesToRows(bytes);
  return rows.filter((r) => r.path).map((r) => ({ path: r.path!, message: r.message ?? "", at: r.at ?? "" }));
}

/** The folder a problem file sits in: the book it belongs to, usually. */
export function problemFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export interface ProblemGroup {
  folder: string;
  problems: Problem[];
}

/** Problems grouped by folder, in first-seen order. */
export function groupProblems(list: readonly Problem[]): ProblemGroup[] {
  const groups = new Map<string, Problem[]>();
  for (const p of list) {
    const folder = problemFolder(p.path);
    const g = groups.get(folder) ?? [];
    g.push(p);
    groups.set(folder, g);
  }
  return [...groups].map(([folder, problems]) => ({ folder, problems }));
}
