import type { KeyGroup } from "./comic/keys";

/**
 * The desktop's keys, as the list `?` shows them: every key Ribbon answers
 * outside the comic reader, which has a list of its own
 * (comic/keys.ts). The keys themselves are handled where they act
 * (ui/useKeys.tsx for the player, reader/ReadingView.tsx, ui/ReaderPage.tsx,
 * ui/BookcasePage.tsx, ui/SearchField.tsx): this is what they are, in words,
 * and a key added there is added here.
 *
 * `mac` names the search's chord as a Mac's keyboard prints it.
 */
export function appKeyGroups(mac: boolean): KeyGroup[] {
  return [
    {
      title: "Anywhere",
      lines: [
        { keys: ["/", mac ? "⌘+F" : "Ctrl+F"], does: "Search your books" },
        { keys: ["?"], does: "These keys" },
        { keys: ["Esc"], does: "Back, or close what's open" },
      ],
    },
    {
      title: "Listening",
      lines: [
        { keys: ["Space", "K"], does: "Play or pause" },
        { keys: ["←", "→"], does: "Back or on 30 seconds" },
        { keys: ["Shift+←", "Shift+→"], does: "Back or on 10 seconds" },
        { keys: ["[", "]"], does: "Previous or next chapter" },
        { keys: ["-", "+"], does: "Slower or faster" },
      ],
      note: "While a book is loaded, on any page but the bookcase and the readers.",
    },
    {
      title: "Reading",
      lines: [
        { keys: ["→", "Space", "Page Down"], does: "Next page" },
        { keys: ["←", "Shift+Space", "Page Up"], does: "Previous page" },
        { keys: ["K"], does: "Play or pause the narration" },
        { keys: ["Esc"], does: "Close the book" },
      ],
      note: "A comic has keys of its own: press ? while reading one.",
    },
    {
      title: "The bookcase",
      lines: [
        { keys: ["←", "→"], does: "Along the shelf, and on to the next" },
        { keys: ["↑", "↓"], does: "The shelf above or below" },
        { keys: ["Enter"], does: "Open the book in hand" },
      ],
    },
    {
      title: "A book's page",
      lines: [{ keys: ["↑", "↓"], does: "Previous or next book in its series" }],
    },
  ];
}
