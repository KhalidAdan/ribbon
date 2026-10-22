# Ribbon design rules

Ribbon should look like a careful designer made it and then got out of
the way. The reference is the OpenCode console: a near-black canvas,
hairlines instead of boxes, small confident type, hierarchy by shades of
grey, colour only where it means something, and sentences that say what
is true. These rules are what that looks like here. Every screen
follows them; a change that breaks one says why in its PR.

## 1. Ground and surfaces

Four tokens, defined once in `src/index.css` and switched for light and
dark by the operating system. Components use the tokens, never raw
greys.

| Token        | Dark      | Light     | Use                                                |
| ------------ | --------- | --------- | -------------------------------------------------- |
| `canvas`     | `#0a0a0a` | `#fafaf9` | The page. Everything sits on it.                   |
| `surface`    | `#141414` | `#ffffff` | Cards, the player bar, dialogs, menus.             |
| `raised`     | `#1c1c1c` | `#f4f4f3` | Rows inside a card, inputs, hovered rows.          |
| `line`       | white 8%  | black 8%  | Every border and divider. Never a solid grey.      |

- The lightest separation that works: whitespace, then a hairline, then
  a card. A card is for something you can act on as a whole.
- Nested surfaces step one level at a time (canvas, surface, raised)
  and their radii are concentric: an outer radius is the inner radius
  plus the padding between them.
- Radii: 6px for rows, inputs and buttons; 10px for cards and dialogs;
  covers 4px. Never pills except play buttons, toggles and badges.
- No shadows in dark mode. In light mode only floating things (menus,
  dialogs) get one, paired with a `line` ring, never a border.

## 2. Ink

| Token   | Dark      | Light     | Use                                         |
| ------- | --------- | --------- | ------------------------------------------- |
| `ink`   | `#ededed` | `#0a0a0a` | Titles, values, anything you read first.    |
| `ink-2` | `#a1a1a1` | `#5f5f5f` | Descriptions, meta, secondary values.       |
| `ink-3` | `#6e6e6e` | `#8f8f8f` | Labels, hints, timestamps, disabled.        |

- Hierarchy is made with these three greys and weight, not size.
- One heading weight: `font-semibold`. Body is regular; a row title is
  `font-medium`.

## 3. Type

- Inter everywhere (`cv02 cv03 cv04 cv11`). Newsreader only for a book's
  title on its own page, where it is the book speaking, not the app.
- Sizes are small and few: 13px for meta, 14px for body and rows, 15px
  for section titles, 20px for page titles, 28px for a book's title.
  On narrow screens body text is 16px.
- Every number that changes is `tabular-nums`. Times are right-aligned
  in lists so the colons line up.
- Sentence case everywhere, including buttons and headings. No
  uppercase eyebrows.

## 4. Colour means something

- **Amber is your place.** The ribbon in a hardback marks where you are;
  amber does the same: the played part of a scrubber, a progress
  hairline, the current chapter's tick, the focus ring. Nothing else is
  amber.
- **The primary action is inverted ink**: white on black in dark, black
  on white in light. One per screen (play, Save, Continue).
- Red only for something destructive that is about to happen.
- A book's page may take a faint wash of its cover's colour behind the
  header. That is the only decoration in the app.

## 5. Layout

- A top bar carries the app mark, where you are (a breadcrumb), search
  and the few global actions. Pages are tabs under it, plain text, the
  current one in `ink` with a 1px underline.
- Content sits in a centred column. Lists and settings at 48rem, grids
  at 80rem, the full player at 28rem.
- Section header pattern: a 15px title and one muted line under it on
  the left, the section's actions on the right.
- Rows: title in `ink` `font-medium`, meta in `ink-2` beneath or to the
  right. Actions that are not the row's own click appear on hover and
  focus.
- The full player is a canvas of its own, like a focused editor: a
  breadcrumb top left, the book centred, grouped settings as inset
  cards below.

## 6. Sentences

- Titles that state the situation in words beat labels: "Book 4 of 29,
  37% in, 7h 43m left" rather than three separate badges.
- Descriptions that stand alone end with a period. Lists do not.
- Empty states are one quiet icon, one bold line, one muted line, and at
  most one action.
- Say what Ribbon did, not what it is: "Kept on this machine; the
  share will get it when it is back."

## 7. Controls

- Buttons are 32px tall (28px for compact rows). Primary is inverted
  ink; secondary is `raised` with a `line` ring; ghost is text in
  `ink-2` that turns `ink` on hover.
- Icon buttons have a 48px touch target on coarse pointers.
- Icons are Heroicons micro (16px) in the app; never in a coloured
  container.
- Toggles, checkboxes and radios are native inputs styled by state, in
  ink, never amber.
- Menus are compact: a muted group label, items with an ellipsis when
  they open something else, destructive items last.
- Hover changes colour without a transition; only things that move
  animate, and quickly (150 to 200ms).

## 8. Checking

`npm run shots` (with `npm run dev -- --mode demo` running) captures
every scene in light and dark, wide and narrow, into `shots/`. Look at
them before calling a change done. `npm run demo-library -- <dir>`
builds a realistic library from the records already mirrored on this
machine, so the shelf is full of real covers without touching the
share.
