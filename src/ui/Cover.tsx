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
    <div className={clsx("relative aspect-square shrink-0 overflow-hidden rounded-[4px] bg-raised outline-1 -outline-offset-1 outline-line", className)}>
      {url ? (
        <img src={url} alt="" className="size-full object-cover" draggable={false} />
      ) : (
        <div className="@container flex size-full items-center justify-center text-ink-3">
          <p className="text-[min(1.5rem,22cqw)] font-medium tracking-tight opacity-70">{initials || "?"}</p>
        </div>
      )}
    </div>
  );
}
