import type { ScannedBook } from "../core/scan/scan";

export interface MediaSessionHandlers {
  play: () => void;
  pause: () => void;
  seekBackward: () => void;
  seekForward: () => void;
  previousChapter: () => void;
  nextChapter: () => void;
  seekTo: (positionMs: number) => void;
}

/** Lock-screen and hardware-key plumbing. No-op where unsupported. */
export function installMediaSession(h: MediaSessionHandlers): () => void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return () => undefined;
  const ms = navigator.mediaSession;
  const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* unsupported action */
    }
  };
  set("play", () => h.play());
  set("pause", () => h.pause());
  set("seekbackward", () => h.seekBackward());
  set("seekforward", () => h.seekForward());
  set("previoustrack", () => h.previousChapter());
  set("nexttrack", () => h.nextChapter());
  set("seekto", (d) => {
    if (d.seekTime !== undefined && d.seekTime !== null) h.seekTo(d.seekTime * 1000);
  });
  return () => {
    for (const a of ["play", "pause", "seekbackward", "seekforward", "previoustrack", "nexttrack", "seekto"] as const) set(a, null);
  };
}

export function updateMediaMetadata(book: ScannedBook | null, chapterTitle: string, coverUrl: string | null): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  if (!book) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const artwork: MediaImage[] = coverUrl ? [{ src: coverUrl, sizes: "512x512", type: "image/jpeg" }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: chapterTitle ? `${book.book.title}: ${chapterTitle}` : book.book.title,
    artist: book.book.author || "",
    album: book.book.series || book.book.title,
    artwork,
  });
}

export function updateMediaPlayback(playing: boolean, positionMs: number, durationMs: number, speed: number): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  try {
    if (durationMs > 0 && positionMs <= durationMs) {
      navigator.mediaSession.setPositionState({ duration: durationMs / 1000, position: positionMs / 1000, playbackRate: speed });
    }
  } catch {
    /* some builds throw on odd values */
  }
}
