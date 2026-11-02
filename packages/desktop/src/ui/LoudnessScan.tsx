import type { JobStatus } from "../app/jobs";
import { ProgressLine } from "./kit";

/** The open book's loudness scan, while it's waiting or running. */
export function scanning(job: JobStatus | undefined): job is JobStatus {
  return !!job && (job.state === "queued" || job.state === "running");
}

/** The player bar's line while the open book's loudness scan runs. */
export function scanLine(job: JobStatus): string {
  return job.state === "queued" ? "Loudness scan starting · may crackle" : `Loudness scan ${Math.floor((job.progress ?? 0) * 100)}% · may crackle`;
}

/**
 * Said in the player while the open book is measured, once: what for, how
 * far it has got, and that playback may crackle until it's done. It goes
 * when the scan does.
 */
export function LoudnessScanNote({ job }: { job: JobStatus }) {
  return (
    <div role="status" className="rounded-[10px] bg-surface p-1 ring-1 ring-line">
      <div className="rounded-md bg-raised px-3 py-2.5">
        <p className="flex items-baseline justify-between gap-3 text-base/6 text-ink sm:text-sm/5">
          <span className="font-medium">Measuring this book, once</span>
          <span className="shrink-0 text-ink-3 tabular-nums">{job.state === "queued" ? "Starting" : `${Math.floor((job.progress ?? 0) * 100)}%`}</span>
        </p>
        <p className="mt-0.5 text-base/6 text-pretty text-ink-2 sm:text-sm/5">Its loudness, so every book plays at the same volume, and its pauses, for Trim silence. Until it’s done, playback may crackle.</p>
        <ProgressLine fraction={job.progress ?? 0} className="mt-2" />
      </div>
    </div>
  );
}
