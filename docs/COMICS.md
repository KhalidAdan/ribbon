# Comics in Ribbon

**The plan for comics, agreed on 2026-11-23.** A third kind of book, the
comic, and what it takes on the desktop, the server and the Apple apps.
Section 10 lists what was decided; the changes to the north star are in
section 9 and made in [NORTHSTAR.md](NORTHSTAR.md). Section 11 says what
is built so far.

## 1. Why

Ribbon is a home for your books, and a shelf of comics kept as files is a
shelf of books with no home in it. The owner already built that home once:
[Panels](https://github.com/KhalidAdan/panels), a comic reader for a server
of his own, with the same accounts, invites and SQLite that Ribbon's server
has. Two servers, two sign-ins and two places to look for "where was I?" is
the thing Ribbon exists to end.

It is also a real change of mind. The north star says "Not a reader for
every format", and it says so because Ribbon lays out every line of an EPUB
itself. A comic has no lines to lay out: its pages are already drawn. So
this is not Ribbon's reader stretched over another format. It is a second,
much smaller reader beside it, and the rest of Ribbon (the library, the
server, the place, the people) carrying one more kind of book.

## 2. What a comic is, to Ribbon

**A comic is a book of pages already drawn.** One CBZ file is one book: a
zip of pictures, read in the order of their names.

- **It is read, never heard.** No narration, no transcript, no read-along,
  and Ribbon never pairs a comic with an audiobook or an EPUB.
- **Its place is a page.** One place per person, the newest wins, kept in
  the position log like every other place (section 6).
- **Its pages are shown as they are.** Whole, in the artist's order, turned
  the moment they are asked. Ribbon doesn't crop them, reflow them, or guess
  where the panels are.
- **Time with it counts as reading**, in Stats and towards the daily goal.

What is refused, each for a reason:

| Refused | Why |
| --- | --- |
| CBR, CB7 | RAR and 7z each need a decoder Ribbon would have to ship on every system, and RAR's comes with a licence of its own. A CBR converts to a CBZ with existing tools, outside Ribbon. |
| PDF | Not pictures in a zip: it needs a renderer on every system, and it brings every other kind of PDF with it. A separate decision, not this one. |
| Comics with DRM | The same line as AAX and locked EPUBs. |
| Guided view (panel by panel) | It means guessing where panels are. Ribbon offers only what is exact. |
| A comics catalogue or store | No catalogue, no recommendations (NORTHSTAR.md). Looking a comic's details up is a different thing (section 8). |

## 3. What Panels gives us, and what it doesn't

Panels is the proof that this is a small reader. Its ideas come across; its
code mostly gets rewritten in Ribbon's own shape, because Ribbon already has
a server, accounts and a design.

| From Panels | In Ribbon |
| --- | --- |
| Reading one page straight out of the zip, without unpacking it (`cbz.server.ts`, `@culvert/zip`) | The server reads pages this way, in process. The desktop alone is section 5. |
| Page order: pictures only, by natural order of their names | `packages/core/src/comic/pages.ts`, beside `natsort.ts`, so every host agrees. |
| Spreads: the cover alone, wide pages alone, the rest in pairs (`double-page.ts`) | `packages/core/src/comic/spreads.ts`, almost as it is, with tests. |
| ComicInfo.xml and the per-page record (width, height, wide) | Read at the scan, kept as a record beside the book (section 4). |
| Right-to-left for manga, fit to width or height, keys | The comic reader on the desktop (section 5). |
| Limits against a hostile zip (size, entry count, a zip bomb) | Kept, in core, checked wherever an archive is opened. |
| Windowed prefetch (2 pages behind, 8 ahead) | The page window (section 5), made a thing of its own and measured. |
| ComicVine lookup | Later, and only if asked for (section 8). |
| Its server, Prisma, React Router, shadcn, uploads | Not brought over. Ribbon has its own of each, and books come in from folders. |
| One page number per person per comic | A `pos` record in the position log (section 6). |

## 4. In the library

**The scan.** A `.cbz` is a new kind of file beside `audio` and `ebook`
(`packages/core/src/scan/walk.ts`). The rule that cost hours still holds:
nothing is opened per book on the way to the first paint.

1. **The folder walk paints the shelf**: a comic appears with the title its
   file name gives, as an audiobook appears before its tags are read.
2. **Details stream in after**, once per file, in Rust as tags are: the
   zip's list of entries (two small reads from the end of the file), then
   ComicInfo.xml if there is one. From them: the page count, the page list,
   title, series and number, writer, publisher, year, summary, and whether
   it reads right to left.
3. **They are kept** in `.ribbon/comics.csv`, as `.ribbon/ebooks.csv` keeps
   an EPUB's, so an unchanged comic is never opened again. Through Culvert:
   Source, Transform, Sink.

**On the shelf** (decided): comics share the shelf with every other book.
A comic is a `Book` with a `comic` path where an audiobook's EPUB has an
`ebook` path. Its cover is its first page, made into Ribbon's cover sizes
the way any cover is.

**The same details as any book** (decided), or as close as a comic gets.
A comic fills the fields a book already has, and is corrected in the same
edit form, with the same edits kept the same way (`edits.ts`, and on a
server `PUT /api/books/:id/edits`):

| A book's field | From a comic |
| --- | --- |
| Title | ComicInfo's `Title`, else the file name's |
| Author | `Writer` |
| Series and number | `Series` and `Number`, else the file name's |
| Year, publisher, description, language, genres | `Year`, `Publisher`, `Summary`, `LanguageISO`, `Genre` |
| Narrator, length in hours | None: the shelf shows pages where it shows time |

Only two things are a comic's own: its page count, and whether it reads
right to left.

**Series are how comics are found.** An issue alone is twenty pages; the
series is the thing a person follows. Ribbon's series already hold books in
order with a number each, and a book can be in many, so a run and a
crossover reading list both fit with no new machinery.

**A file name counts for the series** (decided). Many comics carry no
ComicInfo.xml, and their names are regular: "Saga 014 (2013).cbz" is Saga,
number 14, 2013. So for a comic, and only for a comic, the name is taken as
the file naming its series, when ComicInfo doesn't. What a person has
edited always stands: a series or a number set by hand is never overwritten
by a name, and a comic taken out of a series is never put back in it, the
rule series already have. Audiobooks and EPUBs keep theirs: a series is
never guessed from a title.

## 5. Reading a comic on the desktop

A new, small reader in `packages/desktop/src/comic/`, beside
`src/reader/` and sharing none of its layout engine. What it shares is
what is not about text: swipes (`reader/swipe.ts`), the dock, the keys.

**What it does, first version:** one page or a spread; fit to the height or
the width of the window; left to right or right to left; turn by key, click,
swipe or wheel; jump to a page; open at your page; keep your place and the
time spent.

**Where the pages come from** (decided: the `ribboncomic` address, with
the other way measured beside it). A page is a picture of a megabyte or
more, and a Tauri command reply over 8 KB takes the slow path on WebView2,
so pages can't come through a command. The plan is a `ribboncomic` address,
answered in Rust like `ribbonmp3` and `ribbonaudio`: the web view asks for
a book's page by its entry's name, and Rust reads that one entry out of the
zip with the `zip` crate the EPUB parser already uses. The order of pages
stays core's decision; Rust only fetches the entry it is asked for.

The other way is Culvert all the way: `@culvert/zip` in the web view,
reading byte ranges through the Tauri file plugin. It is one zip reader
instead of two, and it is what Panels does on its server. It is measured
beside the address (section 11), and the numbers go in the pull request: if
Culvert is as fast at 6x, that is worth knowing before a second zip reader
is kept for good.

**The page window, in Culvert.** Turning a page should never wait for one
to arrive or to decode. The window is the pages around yours, kept ready.

- `packages/core/src/comic/window.ts` decides, purely, which pages to hold
  for a page and a direction (`windowAround`), and which to let go.
  Unit-tested.
- A Culvert pipe carries it out (`PageWindow`): a Source of the pages the
  window wants, nearest first, and a Sink that fetches each and keeps it
  if it is still wanted when it lands. Turning the page moves the window;
  a page still on its way and no longer wanted is abandoned.
- It holds a bounded number of pages, so a 600-page omnibus costs what a
  24-page issue does.

**Two windows, because a page costs two different things.** Its file is a
megabyte or two, and fetching it is the wait over a network share. Its
picture, decoded, is its width times its height times four bytes, about
24 MB for a scanned page, and decoding takes a tenth of a second wherever
the file is. So the reader keeps a wide window of files (two pages behind,
eight ahead, as Panels has it) and a narrow one of decoded pictures (one
behind and two ahead; with two pages up, the spread on screen and the one
either side).

**Ribbon holds the decoded pictures itself.** Each page is drawn onto a
canvas the size it shows at, from a picture Ribbon decoded and frees the
moment it leaves the window. The first version left this to the web view,
as images, and measured badly: WebKit kept every decoded page in a cache
of its own, 1.3 GB after 177 turns of a comic of full-size scans, and
still there with the comic closed (section 11). A page's size is read
from the first bytes of its file (`comic/size.ts`), so a page's place on
screen and whether it is drawn across two are known without decoding it.

**Over a share.** A comic in a folder on a network share is read in
ranges: the list of entries once, then one read per page. Nothing is
copied and nothing is written beside it but the usual records.

## 6. The place, and time spent

A comic's place is a `pos` record without `ms`, as a text's is
(POSITION-FORMAT.md, section 3.6), with a locator that names a page:

```json
{"v":1,"k":"pos","dev":"urn:uuid:5f0c…","seq":1795000000000,"t":"2026-12-01T20:15:00.000Z",
 "book":{"ids":["urn:ribbon:3b1f09aa-text"]},
 "why":"close",
 "loc":{"href":"Saga 001/page-014.jpg","type":"image/jpeg",
        "locations":{"position":14,"totalProgression":0.5652}}}
```

- `href` is the page's entry in the archive, by name, so the place
  survives a reader that orders pages differently.
- `position` is the page, counted from 1, which is what Readium's
  `position` already means.
- `totalProgression` is 0 on the first page and 1 on the last, so a comic
  is finished on its last page.
- A spread's place is its first page.
- The claim is the one a text's place has, `-text`: the edition that is
  read rather than heard. A comic has no other, and every reader of the
  log that merges text places merges these with no change.

This is an addition to the format (POSITION-FORMAT.md, section 3.8,
version 1.4), not a change: a reader that doesn't know comics skips nothing
it understood before. Time spent is a `reading` record under the same
claim, thirty seconds or more, as the EPUB reader keeps one. Bookmarks, a
page with a note, are not built yet.

## 7. The server and the thin apps

**On the server.** A comic is copied in as `books/<book-id>/book.cbz`,
never changed, and never added twice (its fingerprint: its size and a hash
of its first and last megabyte, as an audiobook's files have). Preparing it
is quick: read the entries, read ComicInfo.xml, make the covers from the
first page.

| Request | What it does |
| --- | --- |
| `GET /api/books` | Each comic says it is one, and how many pages it has. |
| `GET /api/books/:id` | A comic's pages in order: each one's name, width and height. |
| `GET /api/books/:id/pages/:n` | One page, streamed out of the archive with `@culvert/zip`, as Panels does. It never changes, so it is cached for good. |
| `POST /api/books/:id/place` | Takes a `page`, for a device that keeps no log. |
| `GET /api/progress` | A comic is as far through as its page. |

**The desktop with a server** downloads a comic before reading it, like any
book: the `.cbz` is a file on the device from then on, read as a folder's
comic is.

**The iPad and the iPhone** read from the server, page by page, in a native
view of their own (`packages/apple/Ribbon/Comic/`): a page that zooms and
pans by touch, turns by swipe, and holds the same window of pages around
yours. The iPad is the device comics are best on, so it is where this is
judged. Nothing is kept on the device, as with every thin app.

**The Apple TV** (decided: it's in). A wide screen is the one place a
spread is shown at its full size, two pages side by side as they were
drawn. The TV streams pages from the server and keeps nothing, as it does
with everything, and the remote does all of it:

- **Left and right turn the page**, or the spread; for a comic that reads
  right to left, they swap.
- **A page fits the screen's height** to start with. Select brings it to
  the screen's width, and then up and down move along it; Select again
  goes back to the whole page.
- **Menu leaves the comic**, with the page kept.

How it sits on the screen (the ground behind a page, what shows while one
arrives, where the page number goes) wants a design round of its own before
it is built. Every screen the TV has today must come out of this unchanged,
compared pixel for pixel.

**Android**, when it comes, gets comics from the same requests.

## 8. Later, and only if wanted

- **A strip of small pages** to find your way through a long book. It needs
  small pictures made for every page, which is real work on a 600-page
  book: measured before it is promised.
- **One long scroll**, for comics drawn as a single column.
- **ComicVine**, for comics whose files say nothing about themselves. It
  would be off unless the server's owner turns it on with a key of their
  own, as Audible's descriptions are (`RIBBON_DESCRIPTIONS`).
- **Comics on the bookcase.** An issue's spine is thinner than its title.
  Collected editions would stand well; single issues want another answer.

**Panels retires** (decided) once Ribbon reads comics on a server and on
the iPad. Its comics are files, so they come over as any folder does: added
to Ribbon's server. Its places are one page per person per comic in its
database, brought over once, by a small tool, as `pos` records for the
people who have accounts on both. Then Panels is switched off.

## 9. The north star

Four edits, made in [NORTHSTAR.md](NORTHSTAR.md) on this branch:

1. **What this is** names the comic beside the EPUB and the audiobook, and
   says in one sentence what Ribbon does with one.
2. **Not two apps** keeps its refusal and moves the line: EPUBs and comics
   without DRM, and still no PDF, CBR or MOBI.
3. **A new principle, "A drawn page is shown as it was drawn"**, next to
   "The page is the product too", so the two readers each have their rule.
4. **What comes next** lists comics, pointing here.

The tagline stays: a comic is a book, and it is read.

## 10. What was decided

Asked of the owner and answered on 2026-11-23.

| Question | Decision |
| --- | --- |
| Do comics share the shelf with books, or have a section of their own? | **They share the shelf.** |
| Who opens the archive on the desktop? | **Rust, behind a `ribboncomic` address**, with Culvert in the web view measured beside it. |
| A comic with no ComicInfo.xml? | **Its file name counts for its series**, unless a person edited it first. Comics use the same details as any book, or as close as they get. |
| The Apple TV? | **In the plan.** |
| Panels? | **Retired** once Ribbon reads comics. |
| Before "easy to install", or after? | **Alongside it**, each in its own session, so neither waits on the other. |

## 11. The order of the work

One pull request per step, each usable on its own, each with its numbers.

| Step | What it is | Checked by |
| --- | --- | --- |
| 1 | This plan and the north star | Read by the owner |
| 2 | Core: the `.cbz` kind in the scan, page order, spreads, ComicInfo, the archive limits, the place (with section 3.8 of the position format). Comics on the desktop's shelf, with covers | Unit tests; fixture comics; the scan's speed over a share before and after |
| 3 | The desktop's comic reader, from folders: the page address, the window, the place, time spent | The end-to-end checks and the speed report at 1x and 6x |
| 4 | The server: copy in, prepare, the page requests; the desktop reading a server's comic | Server tests; the desktop against a real server |
| 5 | The iPad and the iPhone | The Apple tests and screens; the TV compared pixel for pixel, unchanged |
| 6 | The Apple TV, after its design round | The TV's tests by remote; its other screens compared pixel for pixel, unchanged |
| 7 | Panels' places brought over, and Panels switched off | Each person's page in Ribbon against their page in Panels |

Comics and "easy to install" go on side by side. They touch different
files except where a release is cut, so each step here is rebased on `main`
before it merges, and neither holds the other's release.

**Built so far** (November 2026): steps 2 and 3, in one pull request,
since a comic on the shelf that couldn't be opened was not worth merging
by itself. A comic's bookmarks are not built. Steps 4 to 7 are to come.

**What steps 2 and 3 measured**, on the Mac (a debug build of the app
under its own identity and folder, WebKit; the screen was locked, so no
frame times). The comic is sixty pages of 1988 by 3056 JPEGs, 1.85 MB
each, 114 MB in all, made for the purpose.

| What | Measured |
| --- | --- |
| The scan of six comics, from nothing | 25 ms |
| A comic's list of files, read at the scan (Rust) | 1.1 ms |
| One page out of the archive (Rust) | 3.5 ms, median of 19 |
| A cover, made from a full-size page | 96 ms, once per comic |
| Opening the comic, to its pages known | 27 to 60 ms |
| A page's bytes arriving in the web view, at the `ribboncomic` address | 15 to 19 ms |
| Decoding a page | 74 to 104 ms |
| A turn inside the window, to the page drawn | 5 ms at most, over 176 turns |

| The web view's memory | Pages as images | Pages as now |
| --- | --- | --- |
| The shelf, no comic open | 208 MB | 213 MB |
| The comic open, its windows full | 335 MB | 208 MB |
| After 177 turns, back and forth | 1,394 MB | 215 MB |
| Thirty seconds after closing it | 1,312 MB | 216 MB |

On Windows (GitHub's runner, WebView2, the end-to-end `comic` check, forty
pages of 1000 by 1500), a turn by key to the frame its page is drawn took
29 ms at the median at 1x and 239 ms with the CPU six times slower. Each
turn was drawing three spreads again: the one coming in, and both of its
neighbours. Now a spread waiting beside keeps its canvas when it moves to
the middle, so a turn draws nothing before the frame that shows it, and
the one new neighbour is drawn after. Measured in the browser: no draw
before the next frame, one after.

Not measured yet: anything over a network share. Reading a page with Culvert in the web view, beside the
`ribboncomic` address, was not tried: bytes of a page's size take the slow
path through a command on WebView2, and the address answers in 15 ms.

**Fixture comics are made, not found.** The repository is public, so the
test comics are drawn by a script in `tools/`: numbered pages, a wide one,
a ComicInfo.xml, one with no details, one that reads right to left. No page
of anyone's comic goes into the repository.

**What is measured**, in the built app, at 1x and at 6x, before and after:

| Number | Where |
| --- | --- |
| Opening a comic to your page, in a folder and over a share | Step 3 |
| Turning a page inside the window, and just outside it | Step 3 |
| Memory with a 24-page issue and with a 600-page book | Step 3 |
| The two ways of reading a page on the desktop, side by side | Step 3, before the choice |
| The scan of the existing library, with and without comics in it | Step 2 |
| A page from the server to the iPad's screen | Step 5 |
| A spread from the server to the TV's screen | Step 6 |

Culvert: Ribbon reads archives on Node with `@culvert/zip` 0.2.0, which is
made for the `@culvert/stream` 0.2.0 it was already on. Tried before step
2 on three made-up CBZs, stored and deflated: every page came out byte for
byte.
