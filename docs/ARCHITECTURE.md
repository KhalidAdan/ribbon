# Architecture

How Ribbon is put together, in pictures. For why it is this way, see
[NORTHSTAR.md](NORTHSTAR.md); for reading and read-along in detail,
[READING.md](READING.md); for the position log, [POSITION-FORMAT.md](POSITION-FORMAT.md).

## 1. The big picture

A Tauri app: a web page (React, TypeScript) in a native window, and Rust
behind it for the work on files. Your library folder is the database:
everything Ribbon learns is a small file in `.ribbon/` beside the books.

```mermaid
flowchart LR
  subgraph Web["Web side (TypeScript, React)"]
    UI["ui/ and reader/<br/>what you see"]
    C["app/controller.ts<br/>AppController: the app's state and every action"]
    Core["core/<br/>pure logic: no files, no IPC"]
    Eng["player/engine.ts<br/>PlayerEngine: two audio elements"]
    Lib["app/library.ts<br/>LibraryService: one per library folder"]
    Host["host/host.ts<br/>Host: every file and process operation"]
  end
  subgraph Rust["Rust side (src-tauri)"]
    Scan["scan.rs<br/>walk and probe a library"]
    Ebook["ebook/<br/>EPUB → block model, the export"]
    Speech["speech.rs<br/>whisper.cpp on the GPU"]
    Frames["frames.rs<br/>exact MP3 frames, ribbonmp3://"]
    Home["home.rs<br/>the Ribbon folder"]
  end
  subgraph Disk["Files"]
    Books["Library folder<br/>audio · EPUB · .ribbon/"]
    App["%LOCALAPPDATA%\\Ribbon<br/>settings · mirror · logs"]
  end
  UI -- "useAppState / useController" --> C
  C --> Core
  C --> Eng
  C --> Lib
  Lib --> Host
  Host -- "tauri.ts: invoke() over IPC" --> Scan & Ebook & Speech & Home
  Eng -- "asset:// and ribbonmp3://" --> Frames
  Scan & Ebook & Speech & Frames --> Books
  Home & Ebook & Frames --> App
```

**The rules the layers keep:**

| Layer | May | May not |
| --- | --- | --- |
| `core/` | compute: pairing, mapping, parsing records, search | touch files, the network, React or the controller |
| `app/` | own the state, run actions, read and write records through `Host` | draw |
| `host/` | do IO: `tauri.ts` in the app, `browser.ts` for the web build, `node.ts` for tests and tools | decide anything |
| `ui/`, `reader/` | draw the state, call controller actions | change state directly |
| Rust | the per-file heavy work: walking, probing, parsing EPUBs, speech, frames, exports | hold the app's state |

So most of Ribbon's logic is in `core/` and runs in the tests with no app at all.

## 2. Six ways of naming a spot in a book

Most of the reading code converts between these. Knowing which is which is
most of knowing how it works.

```mermaid
flowchart LR
  P["TextPlace<br/>{section, block, offset}<br/>the reader's own"]
  N["chars<br/>a character of the reading order<br/>(the whole book's text, end to end)"]
  T["ms<br/>a moment of the recording<br/>(all its files, end to end)"]
  F["file + ms<br/>a moment in one audio file"]
  B["byte<br/>where an MP3 frame starts"]
  L["Locator<br/>Readium's: href, progression, quote<br/>(the position log)"]
  H["href#id<br/>an element of the EPUB<br/>(links, Media Overlays)"]
  X["XHTML bytes<br/>where the text sits in the chapter file"]

  P <-- "BookText.chars / .place" --> N
  N <-- "Alignment: textToMs / msToText" --> T
  T <-- "timeline.locate" --> F
  F -- "frames.rs: FrameIndex.at" --> B
  P <-- "BookText.locator / .fromLocator" --> L
  H -- "BookText.fromHref / .idAt" --> P
  P -- "ChapterSource.bytes (Rust)" --> X
```

- **`BookText`** (`core/reading/booktext.ts`) owns everything about the
  text side: made once per opened book.
- **`Alignment`** (`core/reading/align.ts`) is the only bridge between text
  and time. Everything read-along does is about making it precise.
- **`ChapterSource`** (`src-tauri/src/ebook/source.rs`) is how a place
  becomes bytes of the book's own files, for the export.

## 3. The reading model

```mermaid
classDiagram
  direction LR
  class Ebook {
    meta: title, authors, language, identifiers
    sections: EbookSection[]
    toc: EbookTocEntry[]
  }
  class EbookSection {
    href
    linear
    chars
    blocks: EbookBlock[]
    narration?: Narrated[]
  }
  class EbookBlock {
    k: p | h | img | hr | pre
    runs: EbookRun[]
    ids: id, at
  }
  class EbookRun {
    t: text
    i, b, sc, sup, sub, href
  }
  class Narrated {
    id
    audio
    begin, end ms
  }
  class BookText {
    ebook
    total
    chars(place) number
    place(chars) TextPlace
    text(range) string
    sentenceAt(place)
    progress(place)
    tocEntryAt(place)
    locator(place) Locator
    fromLocator(loc) TextPlace
    fromHref(href) TextPlace
  }
  class TextPlace {
    section
    block
    offset
  }
  class Alignment {
    how: chapter | overlay | proportion
    pairs: Pair[]
  }
  class Pair {
    text: start, end chars
    audio: startMs, endMs
    points: ms, chars[]
    confidence
  }
  Ebook *-- EbookSection
  EbookSection *-- EbookBlock
  EbookBlock *-- EbookRun
  EbookSection *-- Narrated : Media Overlay
  BookText --> Ebook
  BookText ..> TextPlace : speaks
  Alignment *-- Pair
```

The `Ebook` comes from Rust (`ebook/mod.rs` parses the EPUB once and caches
the model in the Ribbon folder). Offsets are UTF-16 code units, as
JavaScript strings count them, so a `TextPlace` indexes a block's text
directly.

A **`Pair`** is one text chapter matched with one audio chapter (or a few
of either). Its `points` are where text and time are known to meet: its two
ends at least, and every checkpoint inside. Between two points, a place
maps by proportion. More points, more precision.

## 4. Where read-along's precision comes from

Each level adds points to the pairs. The reader marks a sentence only
where points are under 20 s apart (`precise()` in `align.ts`).

```mermaid
flowchart TB
  A["Chapters of the audio<br/>(file markers, Audible's names)"] --> L1
  E["Chapters of the EPUB<br/>(its contents)"] --> L1
  L1["Level 1: alignBook<br/>pair chapters by pace, names and kind<br/>points: each pair's two ends"]
  L1 --> O
  O{"Does the EPUB<br/>have Media Overlays<br/>for this recording?"}
  O -- "yes: level 3" --> OV["overlay.ts → byOverlay<br/>every sentence is a point<br/>nothing to hear"]
  O -- "no" --> G{"Fast machine?<br/>(a clip in under 1.2 s)"}
  G -- "yes: level 2" --> TR["Transcribe the whole narration<br/>speech_transcribe, a minute at a time<br/>transcript.ts matches each phrase<br/>a point every ~6 s"]
  G -- "no" --> CP["Hear a clip every 90 s<br/>around the reader<br/>anchors.ts finds it in the text<br/>a point every 90 s"]
  H["Heard chapter openings<br/>(speech_openings)"] -.-> L1
  OV --> M
  TR --> M
  CP --> M
  M["Alignment<br/>textToMs / msToText"]
```

## 5. Opening a book to read

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant V as ReadingView
  participant C as AppController
  participant L as LibraryService
  participant R as Rust
  You->>C: openReading(book)
  C->>V: state.reading = opening
  par everything at once
    C->>R: ebook_open (model, cached)
    C->>L: chapters, pairing fixes, heard, transcript, shared place
  end
  C->>C: text = new BookText(ebook)
  C->>C: pairUp: alignBook (+ byOverlay)
  C->>C: openingPlace: newest of this machine's, the log's, the narrator's
  C->>V: state.reading = ready {text, place, alignment}
  C-)C: hearPlaces() in the background
  Note over C: the minutes around you are transcribed first,<br/>behind "getting ready" while they are
  C-)R: speech_transcribe (8 stretches of 60 s)
  R--)C: phrases with times
  C->>C: matchTranscript → points → re-pair
  C->>L: aligned/book.csv, merged with what is there
```

A book opened again in the same session reuses its `ReadingData` (the
heard places, transcript and fixes kept in memory) and reads none of it again.

### Laying out the pages

The reader's lines are broken by pretext, which measures text on a canvas.
That work runs in a worker, so a long chapter never holds up a tap, a turn
or a scroll:

```mermaid
flowchart LR
  V["ReadingView<br/>useLayout"] -- "want(here, either side)<br/>later(the rest, outward)" --> E["LayoutEngine<br/>layout-engine.ts"]
  E -- "one chapter at a time" --> W["layout.worker.ts<br/>Typesetter + OffscreenCanvas"]
  W -- "blocks · pages · flow" --> E
  E -- "version bumps when a watched<br/>chapter arrives" --> V
```

The worker loads the reader's own faces (`reader/faces.ts`), the same ones the
page draws with, so its lines break exactly as the page would draw them.
Where no worker can measure (no `OffscreenCanvas`: Safari before 16.4), the
engine lays out on the page instead, one chapter per task. A change of text
size, column or justification starts the whole book again.

Scrolling shows the whole book as one column: chapters not laid out yet hold
a height guessed from their length until they arrive. Only the lines within
half a screen of the view are drawn, and a scroll draws again only when it
crosses a half-screen band; where you are reaches the app a few times a
second, not on every scroll event.

A book opens to the page you left at once (`reader/snapshot.ts`): the
chapter's layout and your place in it are kept in the window's storage, and
drawn while the book's text is read and paired with the narration. The same
layout seeds the engine, so the real page needs no layout and replaces the
snapshot without moving. A snapshot made for another window size, other
settings or another version of Ribbon is not used.

## 6. Following the narrator

Five times a second, while the book plays:

```mermaid
sequenceDiagram
  participant E as PlayerEngine
  participant C as AppController
  participant T as Text (ReadingView)
  participant B as BookText
  E->>C: positionMs (every 200 ms)
  C->>T: state.player
  T->>T: chars = msToText(alignment, ms)
  T->>B: place(chars), sentenceAt(place)
  alt points around it are close (precise)
    T->>T: mark the sentence (marks.ts cuts the line's fragments)
  end
  alt following, and the narrator has left the page
    T->>C: moveReading(place, "follow")
  end
```

A turn or scroll by hand stops following; turning back to the narrator
while it plays starts it again.

## 7. Playing an MP3 from the exact place

```mermaid
sequenceDiagram
  participant E as PlayerEngine
  participant W as Webview audio
  participant F as frames.rs
  E->>E: seek(ms) → file + ms (timeline.locate)
  alt an MP3
    E->>W: src = ribbonmp3://?path=…&ms=…
    W->>F: GET, Range: bytes=0-
    F->>F: FrameIndex (kept in the Ribbon folder)<br/>byte where that frame starts
    F-->>W: the file from that frame, 512 KB first
    Note over E: the element's 0 is that moment:<br/>position = base + currentTime
  else anything else
    E->>W: currentTime = ms
  end
```

The webview's own seek in an MP3 with no seek table guesses by bitrate and
was measured up to two minutes off; this lands within a frame.

## 8. The read-along export

```mermaid
sequenceDiagram
  participant C as AppController
  participant P as export.ts (plan)
  participant R as export.rs
  participant S as ChapterSource
  participant FF as ffmpeg
  C->>P: exportPlan(text, alignment, files)
  P-->>C: per chapter: sentences (block, start, end, times), audio pieces
  C->>R: ebook_export(plan)
  loop each chapter
    R->>S: read(xhtml): where each character came from
    R->>S: wrap(sentences as span ids)
    S-->>R: the chapter, tags spliced in at their bytes
    R->>R: SMIL: each sentence id → audio clip
  end
  par four at once
    R->>FF: cut and encode each chapter's audio (AAC)
  end
  R->>R: zip: original files, changed chapters, package, SMIL, audio
  R-->>C: Name (read-along).epub, beside the original
```

## 9. Files

```text
Your library folder/                 the database: sync it, back it up
  Some Book/
    Some Book.mp3 (or many files)
    Some Book.epub
    Some Book (read-along).epub      an export, if you made one
  .ribbon/
    library.csv, files.csv           the scan's cache
    positions/<device>.ndjson        where you are, per device (POSITION-FORMAT.md)
    bookmarks/, clips/               bookmarks and highlights, with their audio
    chapters/, corrections/          chapters, and your edits to them
    pairing/<book>.csv               text chapters paired with audio by hand
    heard/<book>.csv                 what the narrator was heard saying, and where
    aligned/<book>.csv               the narration transcribed, phrase by phrase
    loudness/, silence/, settings/, edits/, covers/, ebooks.csv

%LOCALAPPDATA%\Ribbon\               this machine only
  settings.json                      app settings, reading places, the speech model
  mirror/                            a local copy of each library's records, for a fast start
  mirror/ebooks/<hash>/              each EPUB's parsed model and images
  mirror/frames/<hash>.bin           each MP3's frame index
  logs/ribbon.log
  models/                            a downloaded speech model
```

Anything in `.ribbon/` is either rebuilt on demand or yours (positions,
bookmarks, corrections, pairing); README.md lists which is which.

## 10. Where to start reading code

| To understand | Read |
| --- | --- |
| How the app holds together | `app/controller.ts` (state at the top, then actions by area) |
| What a book is | `core/types.ts`, `core/scan/group.ts` |
| Places in a book | `core/reading/booktext.ts` |
| Text ↔ time | `core/reading/align.ts` (`alignBook`, `textToMs`, `msToText`) |
| Read-along's transcript | `core/reading/transcript.ts`, `src-tauri/src/speech.rs` |
| The reader on screen | `reader/ReadingView.tsx`, `core/reading/pages.ts`, `reader/typeset.ts`, `reader/layout-engine.ts` |
| Playback | `player/engine.ts`, `src-tauri/src/frames.rs` |
| The EPUB parser | `src-tauri/src/ebook/content.rs` |
| The export | `core/reading/export.ts`, `src-tauri/src/ebook/export.rs`, `source.rs` |
