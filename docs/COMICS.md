# Comics in Ribbon

**The plan for comics, agreed on 2026-11-23.** A third kind of book, the
comic, and what it takes on the desktop, the server and the Apple apps.
Section 10 lists what was decided; the changes to the north star are in
section 9 and made in [NORTHSTAR.md](NORTHSTAR.md). Section 11 says what
is built so far. PDFs came after, in section 12, and CBRs in section 13.
Section 15 is what Panels did that Ribbon doesn't yet, and how it comes
over.

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
zip of pictures, read in the order of their names. A CBR is the same book
in a RAR archive (section 13).

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
| CB7 | 7z needs a decoder Ribbon would have to ship on every system, and nobody has asked for it. CBR was refused here too, for the same reason and for RAR's licence, until section 13. |
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
| ComicVine lookup | After a comic's details are its own (section 15). |
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

**The edit form knows what kind of book it has** (`packages/core/src/edit-form.ts`,
asked for on 2026-11-25). The details are kept the same way for every
book; what the form asks is what the kind of book can answer. A comic is
asked for its writers and artists (the book's author field, several
names apart by semicolons), its issue or volume number, and a title that
says which issues it holds; never for a narrator or an ASIN. A text that
is only read is asked for no narrator either. A field the form leaves
out is never changed by it.

**A comic's cover can be any of its pages.** Its files give it the first
one; a collection has each issue's cover inside. "Choose a page…" in the
edit form shows the comic's pages small (`ui/CoverPages.tsx`), each
fetched and drawn only when it comes on screen and let go at once, and
the page chosen is made into a JPEG and kept as a cover chosen by hand
is: beside the books, or on the server for every device. A server's
comic that isn't downloaded shows the server's pages
(`GET /api/books/:id/pages/:n`); a PDF's are drawn by pdf.js.

**An assistant can fill the details in** through the server's MCP
(section 14), for comics whose files say nothing about themselves:
`comic_details` says what a comic has, `set_details` corrects the fields
the edit form shows for a comic, and `set_cover` makes a page its cover.
They are kept exactly as the form's edits are, so a person sees them in
the form and can take any of them back. Comics that then name the same
series are put in it together, by their numbers, as books that arrive
naming one are. Where the details come from is the person's to say
(ComicVine, the publisher's page): Ribbon itself still looks nothing up
(section 8).

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

- **Comics on the bookcase.** An issue's spine is thinner than its title.
  Collected editions would stand well; single issues want another answer.

The strip of small pages, one long scroll and ComicVine were here too. They
are wanted now, and section 15 plans them.

**Panels is retired** (decided on 2026-11-25). Nothing of it was running,
and its reading places are not brought over: the owner doesn't want them.
Its comics are files, so they come over as any folder does. What it did
that Ribbon doesn't yet is section 15.

## 9. The north star

Four edits, made in [NORTHSTAR.md](NORTHSTAR.md) on this branch:

1. **What this is** names the comic beside the EPUB and the audiobook, and
   says in one sentence what Ribbon does with one.
2. **Not two apps** keeps its refusal and moves the line: EPUBs and comics
   without DRM, and still no CBR or MOBI. (PDFs were refused here too, until
   section 12, and CBRs until section 13.)
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
| 7 | Panels retired | Its places are not brought over (section 8) |

Comics and "easy to install" go on side by side. They touch different
files except where a release is cut, so each step here is rebased on `main`
before it merges, and neither holds the other's release.

**Built so far** (November 2026): steps 2 and 3, in one pull request,
since a comic on the shelf that couldn't be opened was not worth merging
by itself; step 4, the server, with the desktop reading a server's comic;
and step 5, the iPad and the iPhone. A comic's bookmarks are not built.
Step 6, the Apple TV, is built in its first shape (below). Step 7 is
done: Panels is retired, and what it did that Ribbon doesn't yet is
section 15.

Step 5 as built: one page at a time, as large as the screen allows. A
swipe or a touch on either side turns it, two fingers zoom into it, a
double tap zooms in and out, and a touch in the middle hides what is
around the page. The few pages around yours are kept decoded, each no
larger than the screen can show at twice its size. The page is told to the
server once you settle on it, and time with a comic counts as reading. Two
pages side by side, and the pages ahead kept as files, are not built on
these devices yet.

Step 6 as built (`packages/apple/Ribbon/Comic/ComicViewTV.swift`): the same
session as the iPad's, with a screen of its own for the remote. One page at
a time, whole, as tall as the screen; left and right turn it, swapped in a
comic that reads right to left. Select brings the page to the screen's
width, and then up and down move along it, most of a screen at a press;
down past its foot goes on to the next page, from its head, and up past
its head goes back to the one before, at its foot, so a comic can be read
with one thumb. Select again shows the page whole. Menu leaves, with the
page kept. The title and the page's number sit beside a whole page, never
over it. The screen stays on for twenty minutes after the last press. Two
pages side by side, which is what section 7 wants of the TV, is not built:
it needs the spreads the desktop works out (which pages are drawn across
two) on the Apple side first.

Step 4 as built differs from section 7 in two small ways. A page is asked
for as `pages/:n` counted from 1, and its place comes back the same way.
And the server opens the archive for each page it sends, rather than
keeping archives open: correct first, and not yet measured to need more.
An Apple app from before step 5 doesn't list a comic (it shows only books
with audio or an EPUB), so a server may have comics before every device
can read them.

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

## 12. PDFs

**Decided by the owner on 2026-11-24: Ribbon reads PDFs.** His older comics
are PDFs, every one of them, and a home for his comics that can't open
them isn't one. The plan above refused PDF as "a separate decision"; this
is that decision, and the cost it named is real: a PDF's pages aren't
pictures in a zip, so every device needs something that can draw one.

**What a PDF is, to Ribbon.** A book of pages already drawn, exactly as a
CBZ is: read in the same reader, with the same place (a page), the same
spreads, the same shelf. Nothing in Ribbon treats a PDF as text: no
search inside it, no reflow, no read-along. A PDF of a novel opens as its
pages, and that is all.

**Which PDFs are books** (proposed). A folder of audio often has a PDF in
it: the booklet that came with the audiobook. So a PDF is a book when its
folder holds no audio and no EPUB, and otherwise it is left off the shelf
as it is today.

**Its details** (proposed). From its file's name, by the rule comics
have: "Tales 014 (1954).pdf" is Tales, number 14, 1954. A PDF's own title
and author are too often its scanner's ("Scan0001", the program that made
it) to believe; they are not read. Anything edited by hand stands, as
ever.

**What draws it, on each device.**

| Where | What draws a page | Why |
| --- | --- | --- |
| The desktop | [pdf.js](https://mozilla.github.io/pdf.js/) (Mozilla's, Apache 2.0), in the web view | The same code on Windows and the Mac, and on Android's and iOS's web views after them. It reads the file in ranges, so a 200 MB scan over a share is asked only for the pages being read. It draws a page at the size it is shown, into the pictures the comic reader already keeps and frees itself. |
| The server | pdf.js again, on Node | It counts and measures a PDF's pages when the PDF is added, draws its first page for a cover, and draws any page the first time a device asks for it, keeping the picture beside the book (`pages/`), so each is drawn once. It draws on `@napi-rs/canvas`, which pdf.js brings where it can; without it a PDF is still added and still downloaded, with no cover and no pages to send. |
| The iPad, the iPhone, the Apple TV | Nothing: the server's pictures | They ask for a page as they ask for a comic's, `GET /api/books/:id/pages/:n`, and are sent a JPEG. An app that reads comics reads PDFs with no change. |

This is not what was first written here. The first plan had Apple's
PDFKit draw pages on the device and the server only keep the file. Drawing
on the server is the north star's own rule ("what a thin app needs worked
out is worked out on the server, once"), it needs nothing new in the apps,
and Android gets it for nothing. What it costs is the server's time the
first time each page is read, and disk for the pictures: a page is drawn
at 2400 pixels wide unless a device asks for 1200 (`?width=`).

A device that keeps books (the desktop) downloads the PDF itself,
`files/book.pdf`, and draws it. The library says which books of pages are
PDFs (`pdf`), since the file a device keeps, and so its id there, is
`book.pdf` and not `book.cbz`.

**Its page count and its cover on the desktop.** Not read at the scan: a
PDF says how many pages it has only to something that parses it. The shelf
shows it at once, by its file's name, and the first time it is seen the
web view counts its pages and draws its first page small for a cover, once,
kept as a comic's are.

**Its place.** A `pos` record as a comic's (POSITION-FORMAT.md, section
3.8), with the file's name as `href` and the page in `fragments` as PDFs
name one (`page=14`), beside `position`.

**The order of the work.**

| Step | What it is | Checked by |
| --- | --- | --- |
| P1 | This section, and the north star | Read by the owner |
| P2 | The desktop: PDFs on the shelf, read in the comic reader, their place kept | Unit tests over PDFs made by a script; the end-to-end check at 1x and 6x; memory and turn times in a Mac build, as for comics |
| P3 | The server: the PDF kept, its pages counted, measured and drawn when asked for; the desktop reading a server's PDF | Server tests, one with a whole desktop |
| P4 | The iPad and the iPhone: nothing to build, since they are sent pictures | The simulator against a scratch server |

**Built so far:** P2 and P3. Measured in a Mac build, on a PDF made for it
(sixty 1988 by 3056 JPEG scans, 111 MB) and one of JPEG 2000 pages:

| What | Measured |
| --- | --- |
| Opening the PDF, to its pages known | 71 to 87 ms |
| Its first page drawn | about 360 ms; 1.5 s for a JPEG 2000 page |
| A turn at reading pace (one every 0.7 s) | 5 ms at the median |
| Turning as fast as the keys repeat (one every 0.12 s) | 146 ms at the median: each page waits to be drawn |
| A jump to the last page | 330 ms |
| The web view's memory: the shelf, then reading, then after 454 turns | 225 MB, 429 MB, 626 MB, level from the hundredth turn |

A PDF is dearer than a comic in memory (pdf.js keeps what it has decoded)
and slower when pages are flipped past faster than they can be drawn.
Neither has been worked on yet.

**What is refused still:** PDFs with a password or DRM; forms, links,
sound and video inside one.

## 13. CBRs

**Asked for by the owner on 2026-11-23:** "add CBR support (or take CBRs
and convert them to CBZ)". Section 2 refused CBR for two reasons: a decoder
to ship on every system, and RAR's licence. Both have an answer now.

**What a CBR is, to Ribbon.** A CBZ whose archive is a RAR: the same
pages, in the same order, with the same ComicInfo.xml, place, spreads and
shelf. Core decides all of that for both (`comic/pages.ts`); a host lists
the archive and fetches one entry by name, as it does a zip. A file is
what its first bytes say, not what it is called: comics named `.cbr` are
often zips, and some named `.cbz` are RARs, and both open.

**The decoder, and its licence.** [`rars`](https://crates.io/crates/rars),
version 0.12.3, pinned: a RAR reader written in Rust alone, under
Apache-2.0, which sits with Ribbon's MIT. It has none of RARLAB's UnRAR
source in it, so the UnRAR licence and its condition (the source may not
be used to build a RAR compressor) don't come into it. Ribbon builds only
its reading side: no compressor, no passwords, no threads, no unsafe code,
and two small crates beneath it. It reads RAR 1.5 to 4 and RAR 5 to 7.
The other candidates: the `unrar` crate is RARLAB's C++ under that
licence; libarchive is BSD but a C library to build for every system, the
phones among them. `rars` is young (2026), which is why it is pinned and
why "What is not checked" below is plain about it.

**On the desktop a CBR is read where it sits**, in Rust
(`src-tauri/cbr`, a crate of its own, and `src/comic_rar.rs`), through the
commands and the `ribboncomic` address a CBZ is read through. Nothing is
unpacked to disk and nothing is written beside the comic but the usual
records. It builds wherever Rust does: checked for the Mac and for iOS;
Windows is the checks', Android was not tried.

**On the server a CBR is written out as a CBZ** when its folder is added,
and kept as `book.cbz`. The server reads every byte of a book to copy it
in anyway, so this costs no more; and after it, a comic that came as a CBR
is a comic like any other to the page requests, to the desktop that
downloads it, and to the Apple apps, which needed no change. Its pages are
stored in the zip, not squeezed, as every CBZ's should be. The server and
Node run the same reader as a command, `ribbon-cbr`, the way they run
`ribbon-ebook`.

**What was measured, and what it decided.** On the Mac, over a comic made
for it: 300 pages of 1.2 MB, 360 MB, stored, as a CBZ and as a CBR in each
RAR format (the two formats came out alike).

| What | The CBZ | The CBR |
| --- | --- | --- |
| Listing it | 0.5 ms | 41 ms, in 301 requests for bytes: one for each file in it |
| Listing it, with every request made to wait 20 ms, as a share does | | 8.5 s |
| One page | 0.1 to 0.3 ms | 1.5 ms, in 3 requests |
| One page, the pages squeezed as RAR squeezes them | | 11 ms |
| Written out as a CBZ, by the command | | 0.4 s, with 4 MB of memory at its peak |
| Written out as a CBZ in Node, by the same reader as WebAssembly | | 2.2 s, with 1.9 GB at its peak |

Three things follow.

1. **A RAR has no list of its files at one end**, as a zip has: each
   file's header sits in front of that file. Listing one is a jump to
   every header, and over a share each jump is a round trip. Nothing gets
   that below one request a file, so the reader makes it exactly one
   (`reader.rs`), and a page two or three. A CBR's list is walked at the
   scan, once, and kept in `comics.csv` like any comic's; again for its
   cover, once; and again when it is opened to read, after which the
   archive is kept open and a page costs what a CBZ's does.
2. **Converting on the desktop too was considered and not done.** A copy
   in Ribbon's own folder would make listing instant, but making it means
   reading every byte of the comic first: 360 MB over the share before the
   first page, against 301 small requests; and it doubles every CBR on the
   disk, with a cache to keep and to clear. Where the comic is on a local
   disk, the walk is 41 ms and there is nothing to win.
3. **The server converts with the command, not in Node.** The WebAssembly
   build of the same reader takes the whole archive into memory, several
   times over: 1.9 GB for this comic. A small server can't spare that for
   an omnibus, and the command needs 4 MB. So Node has no RAR reader of
   its own; where the command isn't built, a CBR is a comic with no pages,
   and adding one to a server says why.

**What is refused**, each in a sentence, the same on every host
(`core/comic/cbr.ts`):

| Refused | Why |
| --- | --- |
| A CBR locked with a password | The same line as AAX and locked EPUBs. The reader is built with no way to unlock one. |
| One part of a CBR split across several files | Ribbon reads a book from one file. |
| An archive of more than 20,000 files, a page of more than 128 MB, a megabyte that unpacks to more than 200, 16 GB in all | The limits a zip is held to (`archiveProblem`). A RAR's list gives every size, so they are checked before a page is read, and the unpacker is stopped at them whatever the list says. |
| An archive that asks the unpacker to remember more than 256 MB | RAR's own default is 32 MB; one that claims gigabytes isn't a comic. |

**Read, but slowly: a "solid" CBR**, whose pages were squeezed each against
the ones before it. To read a page, every page before it is unpacked
first: measured at 10 ms for each page of 1.2 MB, so 0.6 s for page 60
and, by that, two seconds for page 200. They are rare among comics, since
squeezing pictures against each other gains nothing. On the server it
makes no difference: writing the CBZ is one pass (0.6 s for those 60).

**What is not checked.**

- **No CBR made by RAR or WinRAR is in the tests**, because none may be
  in the repository. The Rust tests read archives squeezed by the same
  crate's writer; Node's are written by hand and stored. Once, by hand,
  the reader was run over the 162 archives that crate's own tests carry,
  some of them made by WinRAR. It unpacked 84; the 58 of those that
  libarchive (a different RAR reader, the Mac's `bsdtar`) could also
  unpack came out byte for byte the same from both. It refused 69 as
  locked or split and 6 as no RAR it reads (older than RAR 1.5, or a
  header damaged on purpose), and 3 more, damaged on purpose, failed
  while unpacking. That is the evidence, and it is not a shelf of real
  comics: the first real CBRs Ribbon reads will be the owner's.
- **Nothing over a real share.** The 8.5 s is a made delay, not a network.
- **In the built app**, a CBR was not opened by hand or by the end-to-end
  checks: the Rust tests go through the functions the app's commands
  call, not through the web view.
- **Names in old code pages.** Before RAR 5 a name could be written in
  the code page of the PC that made it. Such a page still opens, under a
  name with marks where its accents were.
- **A CBR over 4 GB**, which the CBZ written from it needs the zip
  format's large form for.

## 14. Panels

Reading a comic a panel at a time: one panel enlarged to fill the screen,
the rest of the page out of the way, a press for the next. It is what
Kindle and ComiXology call Guided View, and on a television it is the
difference between reading a page and squinting at it.

**What was learned from the others** (November 2026). The version people
love was drawn by hand: ComiXology's editors marked every panel of every
book, because where a panel ends and which is read next is a judgement.
The automatic versions (Kindle cutting each page in four, Marvel's and
DC's smart panels) are the ones people complain of: cropped art, the wrong
order. So Ribbon never works panels out by itself (the north star says so).
Someone says them.

**What a panel is.** A rectangle on its page, and nothing else:

| | |
| --- | --- |
| Shape | A rectangle. Nearly every panel is one, and a slanted one fits in the rectangle around it. Polygons are for later, if they are missed. |
| Measured in | Fractions of the page, 0 to 1: `x`, `y` its top left corner, `w`, `h` its size. A page is drawn at many sizes, and its panels are the same on all of them. |
| Order | The order of the list is the order of reading. A comic that reads right to left has its panels listed that way. |
| A splash page | One panel the size of the page. |
| A page nobody has marked | No panels: it is read whole, as before. |
| Overlapping | Allowed. An inset is a panel inside another. |

**Where the rules live.** `packages/core/src/comic/panels.ts`: what a
panel may be (`panelsProblem`), reading them from outside (`panelsFrom`),
and editing a page's list (`added`, `removed`, `redrawn`, `moved`, `split`,
`merged`). No screen and no server in it, and all of it tested. Everything
that touches panels calls these, so a person's editor and an assistant
cannot come to disagree about what a page's panels are.

**Where they are kept.** On the server, one row for each marked page
(`comic_panels`, `library/panels.ts`), by the page's name in the archive,
as a comic's place is. They are the library's, like a book's edits: one
set for everyone, the admin's to change, the last change standing.

| | |
| --- | --- |
| `GET /api/books/:id/panels` | Every marked page of a comic, by its number from 1, each with its panels in order. |
| `PUT /api/books/:id/pages/:n/panels` | A page's panels in place of the ones it had; an empty list takes them away. The admin only. |

**An assistant marks them: the server's MCP.** `POST /mcp` on the server
speaks the Model Context Protocol (`packages/server/src/mcp.ts`), plainly:
a JSON-RPC message in, its answer out, nothing remembered between two.
Its tools:

| Tool | What it does |
| --- | --- |
| `list_comics` | The comics, each with how many of its pages are marked. |
| `comic_pages` | One comic's pages, which way it reads, and which are left to do. |
| `look_at_page` | A page as a picture, no longer than 1200 pixels, with the panels it has drawn over it and numbered. |
| `set_panels` | A page's panels, in order. It answers with the page and the new panels drawn over it, so whoever set them sees at once whether each box holds its panel and the numbers run in reading order. |

It is on the server only (decided): the desktop alone has no MCP, so
nothing on a computer that is only a client listens for an assistant. It
takes a key the admin makes by hand (`npm run key -- <admin's name>`,
`src/key.ts`), which is a session like a device's; without one it answers
nobody, and only an admin's works. Ribbon never calls an assistant itself.
The pages an assistant looks at go to whoever runs the assistant: that is
the one place Ribbon's pages leave your machines, and the north star says
it in those words.

The first pass is the assistant's, asked for when wanted (decided): no
gutter finder is built. The owner lines up the week's comics and asks for
them in a batch, overnight.

**Built so far:** the rules, the store, the two routes, the MCP and its
key. Tried by hand on a page drawn for it, with five panels: marked
through the MCP by eye from `look_at_page`, and the picture sent back
showed each box on its panel, numbered in order.

**The Apple TV reads by them** (`packages/apple/Ribbon/Comic/ComicViewTV.swift`).
A comic with panels opens on its first: the panel fills the screen, with a
little room about it, and nothing else of the page shows. Right and Down
go on to the next panel, Left and Up back to the one before (Left goes on
in a comic that reads right to left), and the page glides from one to the
next. Past a page's last panel is the next page's first; back past its
first is the page before, at its last. Select shows the page whole, and
Select again goes back to its panels. A page nobody has marked is brought
to the screen's width instead, as before, so a comic half marked is still
read with one thumb. A small panel is not enlarged past four times the
whole page's size. Tried in the Apple TV simulator on the drawn page
above, by the remote's keys.

**A person marks them: the desktop's editor**
(`packages/desktop/src/comic/PanelEditor.tsx`). In a server's comic, for
its admin, the reader's Pages menu has "Mark its panels…". It shows one
page with its panels drawn over it, numbered, and listed beside it in
reading order. A drag on the page draws a panel; a panel is moved by its
middle and made larger or smaller by an edge or a corner; the list puts
one earlier or later, or takes it away; one button makes the whole page a
panel. Every change is kept on the server as it is made, in place of what
the page had, so there is nothing to save. It edits a list with core's
functions, the ones an assistant's marks go through, and what a pointer
does to a panel is worked out with no screen (`panel-drag.ts`, tested).
What an assistant marked shows here to be corrected, and the other way
about. Tried in the browser against a scratch server.

**The iPad, the iPhone and the desktop read by them too.** On the iPad
and the iPhone (`ComicView.swift`) a comic with panels opens on its first:
a touch on either side or a swipe goes to the next panel or the one
before, two touches show the whole page, and a button beside the title
goes between panels and whole pages. On the desktop (`PanelReader.tsx`)
the arrows, Space and a click on either side do the same, and the Pages
menu has "Whole pages" and "Read by panels". All three place a panel by
one piece of arithmetic, written twice and held together by tests with the
same numbers (`closeOn` in core, `ComicPaging.close` in the Apple app): it
fills the screen with a little room about it, and is never enlarged past
four times the whole page. Tried in an iPhone simulator and in the
desktop's browser harness, on the drawn page above.

The desktop reads a comic's panels from the server it came from each time
the comic opens, so a comic downloaded and read with the server out of
reach is read by whole pages.

**Not built yet:**

- **The editor on the iPad**, by touch. The desktop's is above.
- **Panels in a folder**, for the desktop alone: a record beside the comic
  in `.ribbon/`. Today panels are a server's.
- **A wide panel as two stops**, as Kindle asks of publishers: today it is
  two panels, set that way.

## 15. Everything Panels did

**Asked for by the owner on 2026-11-25**, after Panels (his earlier comic
server, not section 14's panels) and Ribbon were compared side by side: "I
very much enjoy a lot of the stuff that is in Panels." What Panels does
and Ribbon doesn't yet comes over, and Panels is retired (section 8).

Each piece below says what he decided, then the defaults it is built
with. **Proposed** marks a default written here that he hasn't said
himself: it is his to change when he reads this, and it is written down
before the work starts, as he asked for zoom.

### What each device gets

| | Desktop | iPad and iPhone | Apple TV |
| --- | --- | --- | --- |
| Small pictures of every page | New | From the server | From the server |
| A strip of small pages | New, `T` | New | New, Play/Pause |
| Jump to a page | New, `G` | New, from the page number | By the strip |
| A page slider | Has it | New | No |
| Zoom | New, keys and a click | Has it: two fingers, a double tap | Has it: Select |
| One long scroll | New | New, after the desktop's | Has it, nearly (below) |
| The ground behind the page | New, `B` | New | New |
| Keys for the view, and their list | New | No | No |
| Two pages side by side | Has it; gets `D` | Not planned | Not planned |
| Reading direction as the comic's own detail | New: the edit form, `R` | Follows it | Follows it |
| Delete a book from the server | Has it, for the admin | New, for the admin | No |

### Small pictures of every page

**Decided: built, then measured, then fixed if they need it.** They come
first: the strip is made of them, and jumping and choosing a cover
(`ui/CoverPages.tsx`, which fetches whole pages today) want them too.

- **Their size** (proposed): 300 pixels tall, a JPEG. A strip shows them
  at about 100 points tall, so they stay sharp on a Retina screen.
- **Made once**, the first time each is asked for, and kept: on a server
  beside the book's files; on the desktop in Ribbon's own folder, never
  beside the comic, since the library is never written to. A PDF's are
  drawn small by pdf.js, not shrunk from a large drawing.
- **On a server** (proposed): `GET /api/books/:id/pages/:n?small`, kept
  for good like a page, so the iPad, the iPhone and the TV only ask for
  them.
- **Measured after**, in the built app at 1x and 6x: the strip's first
  fill on a 24-page issue and on a 600-page omnibus, the disk they take
  for each, and how long the server takes to make one.

### A strip of small pages

**Decided: built, then measured, then fixed.**

- **On the desktop**, `T` shows or hides a row of small pages along the
  foot, above the slider. The page being read is outlined and kept in the
  middle; a click goes to a page. The row runs right to left for a comic
  that reads that way. Whether it shows is remembered on that machine
  (proposed: hidden until asked for).
- **On the iPad and the iPhone**, it shows with the title and page number
  (a touch in the middle of the page), above the slider; a touch goes.
- **On the Apple TV** (proposed), Play/Pause shows it along the foot.
  Left and right move along it, Select goes to the page, Menu puts it away.
- Only the small pictures near what is on screen are fetched and drawn,
  so a 600-page book costs what an issue does.

### Jump to a page

**Decided.**

- **On the desktop**, `G`, or "Go to page…" in the Pages menu, opens a
  small box with the page number chosen. Type a number and press Enter; a
  number past either end goes to that end. Escape closes it.
- **On the iPad and the iPhone**, a touch on "Page 3 of 24" opens the same
  box, with the number pad.
- **On the Apple TV** the strip is the way to jump: typing with a remote
  isn't.
- A jump is kept in the position log as a seek, as the slider's turns are.

### A page slider on the iPad and the iPhone

**Decided.** In the bar at the foot, shown with the title (a touch in the
middle), running the way the comic reads. The page number follows the
finger, and the page itself is fetched when the finger lets go, not for
every page it passes (proposed).

### Zoom

**Decided: wanted, with defaults written down first.** Panels' zoom is
better than Ribbon's on the desktop; the iPad, the iPhone and the TV
already zoom in their own way and are left as they are.

- **On the desktop** (proposed), `+` and `-` step through four sizes:
  the whole page (as today), then one and a half, two and three times
  that. `0` goes back to the whole page. A click in the middle third goes
  between the whole page and twice its size; today a click there does
  nothing.
- **Zoomed**, the wheel, the trackpad and a drag move about the page, and
  a click on either side still turns it.
- **Turning keeps the zoom** (proposed): each new page comes in at the
  top corner the comic starts from, top left, or top right for a comic
  that reads right to left. A comic opens whole.
- With two pages up the zoom is the spread's. Read by panels, the zoom
  keys do nothing: a panel already fills the screen.
- **Fit to height** (proposed) joins "Fit the page" and "Fit the width",
  so the view keys `1`, `2` and `3` are Panels' three: the page as tall as
  the window, a wide page running past the sides and moved sideways.

### One long scroll

**Decided: a must on the desktop, and wanted everywhere.** The pages one
under another, for comics drawn as a single column and for reading a
chapter without turning.

- **On the desktop**, "One long scroll" in the Pages menu, or `S`
  (proposed). The pages are as wide as the window, never wider than they
  were drawn; `+` and `-` make the column wider or narrower.
- **The place** is the page that fills the window's top third: the page
  being read.
- **Only the pages near the window are decoded and drawn**, by the same
  windows as turning (section 5). The rest are spaces of their known size
  (`comic/size.ts`), so the scroll bar is right from the start and a
  600-page book costs what an issue does.
- Two pages up and reading by panels don't apply in the scroll. The
  slider, the strip, jumping and the keys all move it.
- **Kept per device** (proposed), as one page or two is, for every comic.
  If a person reads both long-scroll comics and printed ones, per comic is
  the next step.
- **On the iPad and the iPhone**, the same, after the desktop's.
- **On the Apple TV**, Select's close view already reads a page at the
  screen's width and runs on to the next page with Down, which is a long
  scroll read by the remote. Nothing new is planned there.

### The ground behind the page

**Decided.** Black, grey, white, or Ribbon's own ground (the light or dark
of the app, as today). Ribbon's own stays the default (proposed), so no
screen changes until someone chooses, and the TV's screens still compare
pixel for pixel. Kept per device, for every comic.

- **On the desktop**, `B` goes through them, and they are in the Pages
  menu.
- **On the iPad, the iPhone and the TV**, in Settings (proposed).

### Keys for the view, and their list

**Decided**, on the desktop. The keys a comic already has stay as they
are: the arrows, Space and Shift+Space, Page Up and Page Down, Home, End
and Escape.

| Key | What it does |
| --- | --- |
| `G` | Jump to a page |
| `T` | Show or hide the strip |
| `D` | One page, or two side by side |
| `R` | Read left to right, or right to left |
| `S` | One long scroll, or pages (proposed) |
| `P` | Panels, or whole pages, where a comic's panels are marked (proposed) |
| `1`, `2`, `3` | Fit the page, the width, the height |
| `B` | The next ground behind the page |
| `+`, `-`, `0` | Zoom in, out, and back to the whole page |
| `?` | This list |

`?` and "Keys…" in the Pages menu show the list, with the arrows the way
the open comic reads. None of these clash with the player's keys, which
are off while a comic is open (`ui/useKeys.tsx`).

### Two pages side by side

**Decided: on the desktop**, where it is already built ("Two pages, as
printed" in the Pages menu). It gets the `D` key. The iPad held sideways
and the TV aren't planned here: they need the desktop's spreads (which
pages are drawn across two) on the Apple side first (section 11).

### Reading direction as the comic's own detail

**Decided: a setting, and a person's choice stands over ComicInfo.xml.**

- **A switch in the edit form**, for a comic: "Reads right to left". It is
  kept with the book's edits as any field is (`.ribbon/` beside the books
  on the desktop, `book_edit` on a server), so every device reads the
  comic the same way, and it stands over what ComicInfo's `Manga` says.
  Taken back like any edit, the comic reads as its file says again.
- **`R` in the desktop's reader** sets the same thing, where the person
  may edit the book: their own folders, or a server's comic for its
  admin. Anyone else's `R` is for their machine only, as the Pages menu's
  choice is today (proposed).
- **The MCP's `set_details`** can set it too (proposed), since an
  assistant fills in a comic's details.

### Deleting a book from the server

**Decided: any book, comics too.** The desktop does this already, for the
server's admin: "Delete from the server…" in the More menu of a book's
page. The book goes from the server and from every device that downloaded
it; everyone's places in it are kept, and the folder it was added from is
never touched. **New** (proposed): the same on the iPad and the iPhone,
for the admin, since they are only ever a server's.

### A comic's details as its own, then ComicVine

**Decided: the details are rethought first.** Every book keeps the same
fields today (title and subtitle, author and narrator, series and number,
year, publisher, language, genres, ISBN, ASIN, description), and the edit
form shows a comic only those that fit it (section 4). What is wanted is
details that are each kind of book's own: a comic's issue number and its
volume apart, its writers apart from its artists (pencils, inks, colours,
letters, the cover), its cover date. That changes what every host and the
server keep, and the edits' format, so it starts as a design round of its
own, read by the owner before anything is built.

**ComicVine comes after it**, filling those fields: off unless a server's
owner gives it a key of their own, as Audible's descriptions are
(`RIBBON_DESCRIPTIONS`); "Look it up" in the edit form; and a comic
matched by its ComicVine address. Like the descriptions, it is a lookup
the owner turns on, not someone else's service the library depends on.
The design round is [BOOK-DETAILS.md](BOOK-DETAILS.md).

### Not brought over

| From Panels | Why |
| --- | --- |
| Full screen | The desktop's window goes full screen by itself (decided). |
| Uploading a CBZ in the browser | Books come from folders (section 3). |
| Its sign-in, database and reading places | Ribbon has its own, and the places aren't wanted (section 8). |

### The order of this work

One pull request each, as ever. They can go out in one release when they
are ready together.

| Step | What it is | Checked by |
| --- | --- | --- |
| 1 | This section | Read by the owner |
| 2 | Small pictures of every page, on the server and the desktop, and the strip on the desktop | Server and unit tests; the end-to-end checks; then the strip measured at 1x and 6x, on 24 pages and on 600 |
| 3 | The desktop's reader: the keys and their list, jump to a page, the ground, zoom, fit to height | The end-to-end checks at 1x and 6x |
| 4 | Reading direction as the comic's own detail: core, the edit form and `R`, the server and the MCP, the Apple apps following it | Unit and server tests; the Apple tests |
| 5 | One long scroll on the desktop | The end-to-end checks; memory and scroll frame times at 1x and 6x, on 24 pages and on 600 |
| 6 | The iPad and the iPhone: the slider, jump to a page, the strip, the ground, one long scroll, deleting from the server. The TV: the strip and the ground | The Apple tests and screens; the TV's other screens compared pixel for pixel, unchanged |
| 7 | A comic's details as its own: the design round | Read by the owner |
| 8 | The details built, then ComicVine | After step 7 |

**Built so far** (2026-11-25, in 0.50.0): steps 2 to 6, each built in a
session of its own at the same time and merged together. Step 7's design
is [BOOK-DETAILS.md](BOOK-DETAILS.md) (#288), waiting on the owner's
answers to its questions; step 8 waits on those.

**Step 2, small pictures and the strip** (#287 the server, #290 the
desktop). The desktop makes them in Rust, behind the `ribboncomic`
address (`src-tauri/src/comic_small.rs`), four at a time at most, and
keeps them in Ribbon's folder under `small-pages/`, one folder for each
comic file with a note of its size and date, so a comic that changes has
them made again. A PDF's are drawn small by pdf.js and handed to Rust to
keep. Rust was chosen by measuring: 52.9 ms for a page the size of a
scan, against 72.3 ms in the web view, which would also have fetched and
decoded the whole page first. The server makes them on
`@napi-rs/canvas` and keeps them in the book's `pages/` folder:

| Measured | |
| --- | --- |
| One small picture on the server, a CBZ's page / a PDF's | 61 ms / 298 ms (M2), about 22 KB |
| One on the desktop | about 4.8 KB |
| The strip's first fill by `T`, every small page made then (Windows runner) | 218 ms at 1x, 390 ms at 6x |
| 600 pages opened at page 300, to the strip filled | 220 ms at 1x, 474 ms at 6x; 19 small pictures made |
| The web view's memory, reading, then with the strip shown | 208 MB, then 216 MB |

The strip (`comic/ComicStrip.tsx`, the arithmetic in `core/comic/strip.ts`)
draws the slots in view and six either side, as `ImageBitmap`s closed when
they leave. Building it found a fault in `PageWindow`: a page that
couldn't be brought in was asked for again at once, without end (14,000
requests a minute); it is now asked for once. The strip follows a turn
after the frame that shows it (#295), which brought its cost to a turn
from 1.2 ms to 0.5 ms at 1x, and from 17.8 ms to 10.4 ms at 6x.

**Step 3, the desktop's controls** (#291): the keys and their list
(`core/comic/keys.ts`), Go to page, the ground behind the page, zoom
(`core/comic/zoom.ts`) and fit to the height, as written above. A click on
the page is now placed by which third of the view it lands in, rather than
by buttons over it, since the view now scrolls both ways. A turn by key
zoomed one and a half times takes 4.0 ms at 1x and 27.2 ms at 6x, against
3.6 ms and 24.1 ms whole.

Its end-to-end check found a race in every dialog. The browser sends a
dialog's close event a task after the dialog closes, so Go to page's box,
closed and opened again by `G` in between, was shut by the first box's
late event. The modal hook (`ui/modal.ts`) now counts the closes it makes,
and `closedOnItsOwn` passes their events over; `Dialog`, `PlayerSheet`
and `Drawer` use it. The check presses `G` in the very task the box
closes, every run. In the browser, the race run eight times: the new box
stayed open once before, eight times after.

**Step 4, reading direction** (#289). Kept as `right_to_left` (yes or
no) beside the books, and in a server's edits. The server's listing now
carries the direction too, in a new column that is filled once at start
for comics added before it, from their records. A server from before
0.50.0 refuses the new edit, so the desktop and the server go together.
The Apple apps follow with no change of their own.

**Step 5, one long scroll** (#292, `comic/ScrollPages.tsx`, the arithmetic
in `core/comic/scroll.ts`). The two page windows are now a hook both
readers share (`comic/page-windows.ts`). Measured with a real mouse wheel
on the Windows runner:

| | 1x | 6x |
| --- | --- | --- |
| 40 pages: frames at the median, p95 | 15.6 ms, 17.0 ms | 15.0 ms, 33.1 ms |
| 600 pages: frames at the median, p95 | 15.6 ms, 17.6 ms | 14.5 ms, 31.7 ms |
| Frames over 50 ms | none | 1 of 149, on the 40 pages |
| Pages drawn at any time | 6 at most | 6 at most |
| The web view's memory, 600 pages in the scroll | 217 MB | 217 MB |

**Step 6, the iPad, the iPhone and the TV** (#293): everything in the
table at the top of this section. The TV's screens came out unchanged
against `main`, pixel for pixel, but for the new "Comics" row in
Settings. A jump across a 600-page comic asks the server for the 7 small
pictures in view.

**Not checked yet:** the desktop's new reader in the Mac's WebKit in a
built app (all of it was looked at in Chrome and measured on Windows);
over a network share; a real comic drawn as one column; the iPad turned
sideways, its number pad, and the Apple apps on real devices; the long
scroll's memory on an iPad with a 600-page comic. Small pictures of
comics that are gone are not cleared from the desktop's folder (a few
kilobytes a page). The iPad and iPhone's long scroll has no two-finger
zoom.
