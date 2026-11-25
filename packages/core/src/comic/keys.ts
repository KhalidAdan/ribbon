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

/** One line of the list: the keys, each as it is printed on the keyboard, and what they do. */
export interface KeyLine {
  keys: string[];
  does: string;
}

/** The keys, in the order the list shows them, with the arrows the way the open comic reads. */
export function keyList(rightToLeft: boolean): KeyLine[] {
  const [onward, back] = rightToLeft ? ["←", "→"] : ["→", "←"];
  return [
    { keys: [onward, "Space", "Page Down"], does: "The next page" },
    { keys: [back, "Shift Space", "Page Up"], does: "The page before" },
    { keys: ["Home", "End"], does: "The first page, the last" },
    { keys: ["G"], does: "Go to a page" },
    { keys: ["T"], does: "Show or hide the small pages" },
    { keys: ["D"], does: "One page, or two side by side" },
    { keys: ["R"], does: "Read left to right, or right to left" },
    { keys: ["S"], does: "One long scroll, or pages" },
    { keys: ["P"], does: "Panels, or whole pages, where a comic's panels are marked" },
    { keys: ["1", "2", "3"], does: "Fit the page, the width, the height" },
    { keys: ["B"], does: "The next ground behind the page" },
    { keys: ["+", "-", "0"], does: "Zoom in, out, and back to the whole page; in one long scroll, a wider column, a narrower, and as wide as the window" },
    { keys: ["?"], does: "This list" },
    { keys: ["Esc"], does: "Close the comic" },
  ];
}
