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

### Hyphenation

Justified paragraphs are hyphenated. Before pretext prepares a paragraph,
Ribbon puts soft hyphens into its text where Liang's patterns for the
book's language allow a break (the `hyphen` package, English when the book
names no language). Each language's patterns are a separate chunk, loaded
when a book in it is opened; a language without patterns is not
hyphenated. Headings, preformatted text, centred and right-aligned
paragraphs and addresses (URLs, emails, paths) are left alone, and so are words under six letters, words in capitals,
words with digits, and words the publisher already hyphenated. A break
keeps two letters before it and three after.

The added hyphens are never part of the text. Each run keeps the list of
offsets where they went, and every line and fragment pretext gives back is
mapped to offsets in the model's text before anything else sees it:
places, links, copying and page starts never see them. A line that ends at
one shows a hyphen, as at the publisher's own.

With hyphens, a column as narrow as 16 ems (a phone) can be justified.
Without patterns for the book's language, columns narrower than 24 ems are
set ragged-right even with Justify on, since lines that cannot hyphenate
open wide gaps.

## 2. Which EPUB goes with which book

Folder first. The audiobook and its EPUB are one book when:

- the EPUB is in the book's folder (for an anthology, the anthology's
  folder), or
- the audio is a loose file and the EPUB beside it has the same name
  (`Voidscarred.m4b` and `Voidscarred.epub`), or, since store downloads
  are rarely named alike, the name whose start is most like the audio
  file's, at least six letters or digits alike, when no other file or
  EPUB beside them is as close (`VoidscarredWarhammer40000_ep7.mp3` and
  `Voidscarred -- Mike Brooks -- 2025 -- Black Library.epub`).

When a folder holds several EPUBs, the first by name is taken; the others
stay with the book.

Then metadata. An EPUB the folder left alone pairs with an audiobook
elsewhere in the library that has no EPUB yet:

- by ISBN: an ISBN in the audiobook's tags or side files is one of the
  EPUB's identifiers (the ten- and thirteen-digit forms of a number
  agree), or else
- by title and author: the titles agree with brackets, a leading article
  and case set aside, either side of a colon counting ("The Horus Heresy:
  Horus Rising" is "Horus Rising"), and one author is the same ("Abnett,
  Dan" is "Dan Abnett").

A pair is made only when it is the only one both ways. An EPUB that agrees
with two audiobooks, or an audiobook two EPUBs agree with, pairs with
nothing.

An EPUB that pairs with nothing is a book of its own, to read. It has no
audio: its page offers Read and not Play, and its progress is how far
through the text this machine has read. Its title, author, year,
publisher, language, description and cover come from its package.

The EPUB's identifiers (ISBN, its own `urn:uuid`) are claims on the text
edition, never on the book (section 5).

The scan reads only an EPUB's package: the zip's directory, the
container and the package file, a few small reads wherever it is, and
nothing for any other file. What it read is kept in
`.ribbon/ebooks.csv`, so an unchanged EPUB is not opened again. The
chapters are read when the book is read.

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
        { "k": "img", "src": "OEBPS/image/Aeldari-Icon.jpg", "w": 120, "h": 120, "alt": "", "tone": "ink" },
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

| `k`   | What                     | Fields                                                       |
| ----- | ------------------------ | ------------------------------------------------------------ |
| `p`   | A paragraph              | `runs`, and the style flags below                            |
| `h`   | A heading                | `level` 1–6, `runs`, style flags                             |
| `img` | An image on its own line | `src` (path in the EPUB), `w`, `h` in pixels, `alt`, `tone`  |
| `hr`  | A break between scenes   | none                                                         |
| `pre` | Text set as it is        | `runs`, whitespace kept                                      |

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

Images in the dark. Built: when the cache keeps a book's images, Rust
looks at each one (the `image` crate, PNG, JPEG, GIF and WebP only, at
most 64 by 64 points of it) and sets its `tone`. `ink` is line art,
ornaments, diagrams and pictures of text: little colour, few greys, and
a light or clear ground. Anything else is a `picture`, and so is an image
that will not decode. In dark mode the reader inverts ink and turns its
hue back (`invert(1) hue-rotate(180deg)`), so black marks become light and
a red rule stays red; pictures are dimmed to 85% so a white page does not
glare. In light mode both are drawn as they are. The model is version 3
in the cache, so books cached before are read again.

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

Built (#55, #63): pairing is one search for the best-scoring pairing in
order. Pace is the backbone: a pair's narratable characters per minute
against the book's own. A name that matches adds confidence (names
compare as numbers: "Twenty-one", "Chapter 21", "XXI"). What the
publisher says a section is (`epub:type`: chapter, epilogue, credits…)
sets how much skipping it costs, and text in sections never narrated (a
contents page) does not count toward pace. One audio chapter may cover up
to three of the text's, and the other way round. Audio named credits never
pairs; with generated titles, a short first or last track is taken for
credits. With no pairs, the whole text maps to the whole recording.
Voidscarred pairs the same 35 chapters with Audible's names or with only
"Chapter 1" to "Chapter 37": the journal extract with the epigraph, One
to Thirty-three, the epilogue.

The contents show each entry's audio chapter, a guess marked with a
question mark. **Fix pairing** puts a choice on each entry (automatic,
not in the audio, or a chapter of the recording), kept beside the book in
`.ribbon/pairing/<book>.csv`; the rest re-pairs around it.

The listening bar sits under the text, which shortens to make room. It
shows itself while the book's audio is loaded; a header button shows or
hides it either way. It has back, play and forward, where the narrator
is, and, when the narrator is not on the page, **Go to the narrator** and
**Listen from here**, which starts at the top of the page. Tapping the
text marks the sentence tapped and offers **Listen from here** for it,
so the narrator starts where the eyes are. Another book playing shows
under its own title.
Opening the book to read starts where the narrator is when listening was
more recent; pressing play outside the reader starts where the reading
stopped when pages were turned after the audio last paused. Opening and
closing the reader without turning a page changes nothing.

**Level 3: Media Overlays.** An EPUB 3 with Media Overlays (Storyteller
makes them) carries, for each sentence, the audio file and the time it is
spoken. Rust reads the SMIL files into a list of (block, text range) and
(audio file, start, end); when that audio is the audiobook beside it,
switching is exact, and the reader highlights the sentence being
narrated, turning pages with the narrator.

Built (#56): Rust reads each chapter's SMIL file into the model as its
`narration`: the id of each passage's element, its audio file in the
book, and when it is read. A passage's element id is a place in the
text, since the model keeps every id with its offset. When the overlay's
audio files have the audiobook's file names, each passage lands in that
file; otherwise the files are taken in order, when together they are as
long as the audiobook (within 1.5% or 30 s), each as long as its last
passage, stretched to fit. Every passage is then a point mapping text to
audio, and the chapters are not paired at all; nothing is heard.

**Level 2: Ribbon's own alignment.** For a book without Media Overlays,
Rust transcribes the narration on the machine (whisper.cpp) and matches
the transcript to the text, the way Storyteller does, writing the result
beside the book as a Media Overlay–shaped file Ribbon reads like level 3.
Nothing leaves the machine. Slow, so it runs in the background, once per
book.

Built first (#65): the narrator's opening words. whisper.cpp is built into
Ribbon (whisper-rs); ffmpeg decodes the first 8 seconds of each audio
chapter, and whisper hears them, encoding only the clip's own frames. The words
are matched against each contents entry's opening, loosely (whisper spells
"Eluadhri" as "Eloadri" and says "2" for "Two"; the commonest words are
left out), and a match is the strongest evidence in the pairing score.
It runs only when the pairing has doubts, the doubtful chapters first,
while the book is open to read, and keeps what it heard beside the book
in `heard/<book>.csv`, so each book is heard once. The model is any
whisper.cpp `ggml` file (Settings → Read-along), or Ribbon's download of
whisper base (about 57 MB, from Hugging Face). On Voidscarred with
SayIt's small model: 34 of 35 pairs confirmed by their words; with only
generated titles, mean confidence rose from 0.53 to 0.99.

whisper.cpp is compiled with AVX2 and FMA (`.cargo/config.toml`);
without them MSVC builds it unoptimised and a clip takes a minute.

**Checkpoints inside chapters.** Chapter and proportion, measured on
Voidscarred by hearing 27 places a quarter, half and three quarters into
nine chapters and finding the words in the text: a median of 15 s off,
52 s at worst. A page is about two minutes. So after the doubts, Ribbon
hears a clip every 90 s of audio, nearest the reader first, finds each in
the text near where the pairing puts it (the matching window's latest
start, where the heard words begin), and maps between those checkpoints.
Held out, checkpoints at a quarter and three quarters alone took the
error at the half from a median of 15 s to 6 s; at 90 s apart no place is
more than 45 s from one. A machine that hears a clip in under 1.2 s (a
GPU) checks the whole book; a slower one, the chapters around the reader.
"Listen from here" and "Go to the narrator" hear the place itself first
when no checkpoint is within 45 s.

**The whole narration, on a GPU (#57).** A machine that hears a clip in
under 1.2 s transcribes the whole recording instead of hearing
checkpoints: minutes of audio, three at once (an RTX 2070 does 8
minutes in 7.5 s; a 10-hour book in about ten minutes), from just
before the narrator or the reader onward first. whisper gives each
phrase with its time. The phrases of a minute are matched word by word
to the text around where the pairing puts them, the best local
alignment of the two (whisper hears "Eloadri" for "Eluadhri" and "2"
for "Two"); each phrase whose first words are found is a checkpoint.
On Voidscarred's first 20 minutes, 96% of heard words were found and
a checkpoint fell every 6 s. The transcript is kept beside the book in
`aligned/<book>.csv`, with which minutes were done, so it is made once
for every device.

**Read-along.** Where the points around the narrator are less than 20 s
apart (an overlay, or a transcribed stretch), the mapping places it to
the sentence. Following the narrator, the reader marks the sentence
being read and turns the page (or scrolls) when the narrator reads past
it. Opening the reader while the book plays, **Listen from here**, and
**Go to the narrator** start following; **Follow along** in the
listening bar toggles it; turning a page or scrolling by hand stops it.
The mark can be turned off in the text settings. Sentences come from
the browser's sentence breaking, with dialogue kept whole (a sentence
that starts lowercase, as in “Who made it?” asked Jurilan., joins the
one before).

**On the GPU.** whisper.cpp runs on Vulkan (`whisper-rs` feature
`vulkan`), which every current graphics driver supports. vulkan-1.dll is
loaded only when speech is first used, so Ribbon starts on a machine with
no graphics driver, and speech says it cannot run there.

## 7. The order of the work

1. **The book model.** Rust opens an EPUB into the block model; the scan
   pairs EPUBs with books by folder; the book page shows the pairing.
2. **The reader.** pretext layout, pages and scrolling, Ribbon's
   typography, contents, progress, keyboard; reading places in the log.
3. **Level 1.** Switching by chapter and proportion.
4. **Level 3.** Media Overlays: exact switching and read-along.
5. **Level 2.** On-device alignment.

## 8. Not in the first version

Pairing an EPUB with its audiobook by hand; fixed layout; vertical
writing; drawn tables; footnotes as pop-ups; search inside the book;
highlights and notes (the Lexical or Tiptap work, much later). A book
that is only its EPUB keeps its reading progress on each machine; only
its place goes in the position log. Right-to-left text is laid
out, but each line is painted as one element so the browser orders it.
