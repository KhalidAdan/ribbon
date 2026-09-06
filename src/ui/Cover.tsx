import { clsx } from "clsx";

interface Props {
  url: string | null;
  title: string;
  className?: string;
}

/** Cover art with a quiet fallback: the first letters of the title. */
export function Cover({ url, title, className }: Props) {
  // Words that start with a letter, so "07. Legion" reads L, not 0L.
  const words = title.split(/\s+/).filter(Boolean);
  const lettered = words.filter((w) => /^\p{L}/u.test(w));
  const initials = (lettered.length > 0 ? lettered : words)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className={clsx("relative aspect-square shrink-0 overflow-hidden rounded-[min(1vw,10px)] bg-neutral-950/5 outline-1 -outline-offset-1 outline-black/10 dark:bg-white/5 dark:outline-white/10", className)}>
      {url ? (
        <img src={url} alt="" className="size-full object-cover" draggable={false} />
      ) : (
        <div className="flex size-full items-center justify-center text-neutral-400 dark:text-neutral-600">
          <span className="text-2xl font-semibold tracking-tight">{initials || "?"}</span>
        </div>
      )}
    </div>
  );
}
