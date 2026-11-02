import { clsx } from "clsx";
import { useLayoutEffect, useRef, useState } from "react";

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
        <CoverImage url={url} />
      ) : (
        <div className="@container flex size-full items-center justify-center text-ink-3">
          <p className="text-[min(1.5rem,22cqw)] font-medium tracking-tight opacity-70">{initials || "?"}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The cover's picture. One already decoded when it's drawn, as most are, from
 * the cache, shows at once; one still on its way (a first scan, a server's
 * books) fades in over the blank square when it lands, rather than popping.
 */
function CoverImage({ url }: { url: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [coming, setComing] = useState(false);
  // Before the first paint, so a picture already here is never faded.
  useLayoutEffect(() => setComing(!ref.current?.complete), [url]);
  return (
    <img
      ref={ref}
      src={url}
      alt=""
      draggable={false}
      onLoad={() => setComing(false)}
      onError={() => setComing(false)}
      className={clsx("size-full object-cover transition-opacity duration-150 ease-out", coming && "opacity-0")}
    />
  );
}

/** A series' cover: the next book's, on a small stack of the others when there are any. */
export function CoverStack({ url, title, count, className }: Props & { count: number }) {
  return (
    <div className={clsx("pointer-events-none relative shrink-0 self-start pr-2", className)}>
      {count > 2 && <span className="absolute inset-y-[10%] right-0 left-2 rounded-[4px] bg-raised ring-1 ring-line" aria-hidden="true" />}
      {count > 1 && <span className="absolute inset-y-[5%] right-1 left-1 rounded-[4px] bg-raised ring-1 ring-line" aria-hidden="true" />}
      <Cover url={url} title={title} className="relative w-full" />
    </div>
  );
}
