/**
 * The comic reader's keys on the desktop (docs/COMICS.md, section 15):
 * which key does what, and the list `?` shows. The keys a comic already
 * had (the arrows, Space, Page Up and Down, Home, End, Escape) turn pages
 * and are the reader's own; these are the view's. None clash with the
 * player's keys, which are off while a comic is open.
 */
export type ComicKey = "jump" | "strip" | "two-up" | "direction" | "scroll" | "panels" | "fit-page" | "fit-width" | "fit-height" | "ground" | "zoom-in" | "zoom-out" | "zoom-whole" | "keys";

/** What a key does, by the `key` a keyboard event names; null for a key that isn't the view's. */
export function comicKey(key: string): ComicKey | null {
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case "g":
      return "jump";
    case "t":
      return "strip";
    case "d":
      return "two-up";
    case "r":
      return "direction";
    case "s":
      return "scroll";
    case "p":
      return "panels";
    case "1":
      return "fit-page";
    case "2":
      return "fit-width";
    case "3":
      return "fit-height";
    case "b":
      return "ground";
    // `+` is Shift and `=` on most keyboards: the key itself, unshifted, zooms too.
    case "+":
    case "=":
      return "zoom-in";
    case "-":
    case "_":
      return "zoom-out";
    case "0":
      return "zoom-whole";
    case "?":
      return "keys";
    default:
      return null;
  }
}

/**
 * One line of the list: the keys that do it, each as it is printed on the
 * keyboard, and what they do. Keys held together are written with a `+`
 * between them ("Shift+Space"); the `+` key alone is just "+".
 */
export interface KeyLine {
  keys: string[];
  does: string;
}

/** A group of the list's lines, under a heading, with a line said of them all where one is needed. */
export interface KeyGroup {
  title: string;
  lines: KeyLine[];
  note?: string;
}

/** The keys, grouped as the list shows them, with the arrows the way the open comic reads. */
export function keyGroups(rightToLeft: boolean): KeyGroup[] {
  const [onward, back] = rightToLeft ? ["←", "→"] : ["→", "←"];
  return [
    {
      title: "Turning the pages",
      lines: [
        { keys: [onward, "Space", "Page Down"], does: "Next page" },
        { keys: [back, "Shift+Space", "Page Up"], does: "Previous page" },
        { keys: ["Home", "End"], does: "First or last page" },
        { keys: ["G"], does: "Go to a page" },
      ],
    },
    {
      title: "How the pages show",
      lines: [
        { keys: ["D"], does: "One page or two side by side" },
        { keys: ["S"], does: "One long scroll or pages" },
        { keys: ["P"], does: "Panels or whole pages, where marked" },
        { keys: ["1", "2", "3"], does: "Fit the page, width or height" },
        { keys: ["R"], does: "Left to right or right to left" },
        { keys: ["B"], does: "Next ground behind the page" },
      ],
    },
    {
      title: "Zoom",
      lines: [
        { keys: ["+", "-"], does: "Closer or further" },
        { keys: ["0"], does: "The whole page again" },
      ],
      note: "In one long scroll, they make the column wider or narrower.",
    },
    {
      title: "The reader",
      lines: [
        { keys: ["T"], does: "Show or hide the small pages" },
        { keys: ["?"], does: "These keys" },
        { keys: ["Esc"], does: "Close the comic" },
      ],
    },
  ];
}

/** Every line of the list, in its order, without its groups. */
export function keyList(rightToLeft: boolean): KeyLine[] {
  return keyGroups(rightToLeft).flatMap((g) => g.lines);
}

/** A key as its caps are drawn: the keys held together for a chord ("Shift+Space"), else the one key, "+" included. */
export function keyCaps(key: string): string[] {
  return key.length > 1 && key.includes("+") ? key.split("+") : [key];
}
