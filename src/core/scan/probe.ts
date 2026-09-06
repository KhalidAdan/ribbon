import type { Host } from "../../host/host";
import type { Chapter } from "../types";

export interface ProbeResult {
  durationMs: number;
  /** Lower-cased tag names from the format block, then the audio stream. */
  tags: Record<string, string>;
  hasCover: boolean;
  chapters: Chapter[];
  codec: string;
  sampleRate: number;
  channels: number;
}

export class ProbeError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ProbeError";
  }
}

export function probeArgs(path: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", path];
}

export async function probe(host: Host, absPath: string, signal?: AbortSignal): Promise<ProbeResult> {
  const r = await host.run("ffprobe", probeArgs(absPath), signal);
  if (r.code !== 0) throw new ProbeError(absPath, r.stderr.trim() || `ffprobe exited ${r.code}`);
  return parseProbe(r.stdout, absPath);
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
}
interface RawChapter {
  start_time?: string;
  end_time?: string;
  tags?: Record<string, string>;
}
interface RawProbe {
  format?: { duration?: string; tags?: Record<string, string> };
  streams?: RawStream[];
  chapters?: RawChapter[];
}

export function parseProbe(json: string, path = ""): ProbeResult {
  let raw: RawProbe;
  try {
    raw = JSON.parse(json) as RawProbe;
  } catch (e) {
    throw new ProbeError(path, `unreadable ffprobe output: ${(e as Error).message}`);
  }
  const streams = raw.streams ?? [];
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!audio) throw new ProbeError(path, "no audio stream");

  const durationSec = num(raw.format?.duration) ?? num(audio.duration) ?? 0;
  const tags: Record<string, string> = {};
  for (const src of [audio.tags ?? {}, raw.format?.tags ?? {}]) {
    for (const [k, v] of Object.entries(src)) tags[k.toLowerCase()] = String(v);
  }
  const hasCover = streams.some((s) => s.codec_type === "video" && s.disposition?.attached_pic === 1);
  const chapters: Chapter[] = (raw.chapters ?? [])
    .map((c) => ({
      startMs: toMs(num(c.start_time) ?? 0),
      endMs: toMs(num(c.end_time) ?? 0),
      title: c.tags?.title ?? c.tags?.TITLE ?? "",
    }))
    .filter((c) => c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  return {
    durationMs: toMs(durationSec),
    tags,
    hasCover,
    chapters,
    codec: audio.codec_name ?? "",
    sampleRate: Math.round(num(audio.sample_rate) ?? 0),
    channels: audio.channels ?? 0,
  };
}

function num(v: string | number | undefined): number | null {
  if (v === undefined || v === "" || v === "N/A") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toMs(sec: number): number {
  return Math.round(sec * 1000);
}
