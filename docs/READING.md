# Reading

Ribbon reads the EPUB that sits beside an audiobook, and keeps one place
across reading and listening. This is the plan and the reasoning behind it.
The North Star says why; this says how.

## 1. The shape

**Rust understands the book. TypeScript draws it.**

- **Rust** opens the EPUB where it sits, reads its package, its table of
  contents and every chapter, and reduces each chapter to a small block model
  (section 4): paragraphs, headings, images and breaks, each a list of styled
  text runs. Later it also finds the sentences, reads Media Overlays, and
  aligns the narration to the text.
- **TypeScript** lays the blocks out with
  [pretext](https://github.com/chenglou/pretext), which measures and breaks
  lines with the browser's own font engine but without asking the browser to
  lay anything out. Every line of the book has a known position. Pages are
  that list of lines cut at the page height; scrolling is the same list,
  uncut. Each line is painted as its own element.

Ribbon sets the book in its own type (Newsreader, at the reader's size and
spacing), not the publisher's. The publisher's CSS is read only for what
the text means: which paragraphs are indented, centred or set apart, which
words are italic, bold or small capitals, what is a heading. That
sidesteps most of what makes ebook rendering hard (fighting publisher
stylesheets, embedded and obfuscated fonts, scripts) and gives one look
across every book.

### Why not a library

Considered and set aside, October 2026:

- **foliate-js** renders with CSS multi-column in iframes. Capable, but it
  calls itself unstable, and the place it reports is wherever the browser
  put the text.
- **Readium's navigator** (TypeScript) is well kept and speaks Readium
  Locators, which the position format uses. It has no EPUB parser: it
  expects a Readium manifest served over HTTP. Its read-aloud is speech
  synthesis, not a recorded narrator, so read-along would be ours anyway.
- **Our own, in the browser's layout** (iframes and CSS columns) puts the
  hardest part, pagination, in the browser's hands.

### The evidence

A spike laid out Voidscarred (Black Library, 97,778 words, 2,046
paragraphs) with pretext, in Newsreader at 19 px on 30 px lines, 560 px
wide:

- The whole book became 377 pages in 0.56 s: 0.50 s preparing the text,
  once, and 0.055 s breaking it into lines. A new window width or text size
  costs only the second part.
- 2,043 of 2,046 paragraphs broke into exactly the lines the browser
  chose. The other three came out one line longer. None of the 9,251
  painted lines ran past its column.
- Painting all 377 pages took 0.7 s, about 2 ms a page.

## 2. Which EPUB goes with which book

Version 1 pairs by folder. The audiobook and its EPUB are one book when:

- the EPUB is in the book's folder (for an anthology, the anthology's
  folder), or
- the audio is a loose file and the EPUB beside it has the same name
  (`Voidscarred.m4b` and `Voidscarred.epub`).

When a folder holds several EPUBs, the first by name is taken. An EPUB
with no audio beside it is not a book yet; reader-only books come later.
The EPUB's identifiers (ISBN, its own `urn:uuid`) become claims on the
text edition (section 5); a later version can pair by those.

The scan only notices the file. The EPUB is opened when it is read, never
during a scan.

## 3. What is refused

- **EPUBs with DRM.** A file whose `META-INF/encryption.xml` encrypts
  anything but fonts is refused with a plain message, the way AAX is.
  Font obfuscation is not DRM, and Ribbon does not use the publisher's
  fonts anyway.
- **Fixed-layout EPUBs** (comics, picture books) say so and do not open, in
  version 1.
- **Scripts** in an EPUB are never run. The block model has no place for
  them.

## 4. The block model

What Rust hands TypeScript for one book. JSON, versioned as
`ribbon-ebook/1`. Text offsets are UTF-16 code units, the way JavaScript
counts, so the drawing side indexes text without converting.

```jsonc
{
  "format": "ribbon-ebook/1",
  "meta": {
    "title": "Voidscarred",
    "authors": ["Mike Brooks"],
    "language": "en-GB",
    "publisher": "Black Library",
    "date": "2025-08-05",
    "description": "…",
    "identifiers": [
      { "scheme": "uuid", "value": "9c3e2701-97e8-4a84-8845-fac671bbf378" },
      { "scheme": "isbn", "value": "9781836093152" }
    ]
  },
  "layout": "reflowable",          // or "pre-paginated", which v1 refuses
  "sections": [                    // the spine, in reading order
    {
      "href": "OEBPS/08-40k-Content-3.xhtml",
      "linear": true,
      "overlay": null,             // the SMIL file, when the book has read-along
      "chars": 28412,              // text length, for progress through the book
      "blocks": [
        { "k": "img", "src": "OEBPS/image/Aeldari-Icon.jpg", "w": 120, "h": 120, "alt": "" },
        { "k": "h", "level": 1, "runs": [{ "t": "TWO" }], "ids": [{ "id": "_idParaDest-7", "at": 0 }] },
        { "k": "p", "runs": [{ "t": "Eluadhri was one of only three planets…" }] },
        { "k": "p", "indent": true, "runs": [
          { "t": "It was a giant circle of wraithbone, … " },
          { "t": "Light of Heaven", "i": true },
          { "t": ", Myrin’s flagship, …" }
        ] },
        { "k": "hr" }
      ]
    }
  ],
  "toc": [ { "label": "Two", "section": 7, "block": 1, "depth": 0 } ]
}
```

Blocks:

| `k`   | What                     | Fields                                                     |
| ----- | ------------------------ | ---------------------------------------------------------- |
| `p`   | A paragraph              | `runs`, and the style flags below                          |
| `h`   | A heading                | `level` 1–6, `runs`, style flags                           |
| `img` | An image on its own line | `src` (path in the EPUB), `w`, `h` in pixels, `alt`        |
| `hr`  | A break between scenes   | none                                                       |
| `pre` | Text set as it is        | `runs`, whitespace kept                                    |

Style flags, all optional: `indent` (first line indented), `align`
(`center` or `end`; justifying is the reader's setting, not the
publisher's), `space` (set apart from the paragraph before it, by a margin
or an empty paragraph), `quote` (inset), `list` (a list item; its marker is the
first run), `table` (a table row, cells joined by tabs, until tables are
drawn properly). `ids` lists the element ids inside a block with their text
offsets, so links, the table of contents and Media Overlays can point into
it.

Runs: `t` (the text, whitespace already collapsed the way CSS collapses it,
non-breaking spaces and soft hyphens kept), and optional `i` (italic), `b`
(bold), `sc` (small capitals), `sup`, `sub`, `href` (a link, resolved to a
path in the EPUB plus `#fragment`). A line break inside a paragraph (a
`<br>`, usual in verse) is a `\n` in the text.

How the publisher's CSS becomes flags: Rust reads every stylesheet the
chapter links and its `style` attributes, keeps rules whose selector is a
tag, a class, or a tag with classes, and reads only `text-indent`,
`text-align`, `margin-top`, `margin-left`, `font-style`, `font-weight`,
`font-variant` and `display: none`. Class rules beat tag rules; anything
more complicated is ignored.

## 5. Places

The text is its own edition in the position log
([POSITION-FORMAT.md](POSITION-FORMAT.md)): its claims are its own
(`urn:isbn:` of the EPUB, its `urn:uuid:`, and `urn:ribbon:<book>-text`),
never the audiobook's, because a claim names an edition. A reading place is
a `pos` record whose `loc` is a Readium Locator:

```jsonc
"loc": {
  "href": "OEBPS/08-40k-Content-3.xhtml",
  "type": "application/xhtml+xml",
  "locations": { "progression": 0.412, "totalProgression": 0.061, "fragments": ["_idParaDest-7"] },
  "text": { "before": "…the waygate hung. ", "highlight": "It was a giant circle of wraithbone", "after": ", and at fully…" }
}
```

Ribbon finds a place again by its words first, then by its progression
through the chapter, so a place survives a new text size, a new window and
a slightly different edition. A text edition's `pos` records carry no
`ms`, a change to the format (version 1.1) made in the same PR as the
reader.

Switching: when the book is opened to read and the listening place is
newer, it is mapped into the text; when play is pressed and the reading
place is newer, it is mapped into the audio. Each mapping says how it was
made (`chapter`, `overlay`, `aligned`), and a mapping never overwrites an
exact place with an approximate one.

## 6. The three levels

**Level 1: chapter and how far through it.** Pair the EPUB's chapters
with the audio's: by title first (Ribbon's real chapter names help),
then by order, skipping matter only one side has (a dramatis personae,
end credits). Within a chapter, the fraction of its characters read is
the fraction of its time listened. Voidscarred pairs every chapter one to
one, and its narrator holds 160 words a minute within ±5% across most
chapters, so a switch should land within about a minute.

**Level 3: Media Overlays.** An EPUB 3 with Media Overlays (Storyteller
makes them) carries, for each sentence, the audio file and the time it is
spoken. Rust reads the SMIL files into a list of (block, text range) and
(audio file, start, end); when that audio is the audiobook beside it,
switching is exact, and the reader highlights the sentence being
narrated, turning pages with the narrator.

**Level 2: Ribbon's own alignment.** For a book without Media Overlays,
Rust transcribes the narration on the machine (whisper.cpp) and matches
the transcript to the text, the way Storyteller does, writing the result
beside the book as a Media Overlay–shaped file Ribbon reads like level 3.
Nothing leaves the machine. Slow, so it runs in the background, once per
book.

## 7. The order of the work

1. **The book model.** Rust opens an EPUB into the block model; the scan
   pairs EPUBs with books by folder; the book page shows the pairing.
2. **The reader.** pretext layout, pages and scrolling, Ribbon's
   typography, contents, progress, keyboard; reading places in the log.
3. **Level 1.** Switching by chapter and proportion.
4. **Level 3.** Media Overlays: exact switching and read-along.
5. **Level 2.** On-device alignment.

## 8. Not in the first version

Reader-only books; pairing by ISBN; fixed layout; vertical writing;
drawn tables; footnotes as pop-ups; search inside the book; highlights and
notes (the Lexical or Tiptap work, much later). Right-to-left text is laid
out, but each line is painted as one element so the browser orders it.

Hyphenation. Only the publisher's soft hyphens break words today, so a
column narrower than 24 ems (a phone) is set ragged-right even with
Justify on: justified lines that cannot hyphenate open wide gaps. Adding
hyphenation means putting soft hyphens into the text before pretext
prepares it, by language, which pretext supports.
