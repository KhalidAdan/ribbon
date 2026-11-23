# Comics in Ribbon

**A plan, not yet agreed.** Nothing here is built. It proposes a third kind
of book, the comic, and says what it would take on the desktop, the server
and the Apple apps. The questions that are the owner's to answer are in
section 10; the changes to the north star are in section 9 and made in
[NORTHSTAR.md](NORTHSTAR.md) on this branch, so the diff is the proposal.

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

**On the shelf.** A comic is a `Book` with a `comic` path where an
audiobook's EPUB has an `ebook` path. Its author is its writer; it has no
narrator and no length in hours, so the shelf shows pages where it shows
time. Its cover is its first page, made into Ribbon's cover sizes the way
any cover is.

**Series are how comics are found.** An issue alone is twenty pages; the
series is the thing a person follows. Ribbon's series already hold books in
order with a number each, and a book can be in many, so a run and a
crossover reading list both fit with no new machinery.

## 5. Reading a comic on the desktop

A new, small reader in `packages/desktop/src/comic/`, beside
`src/reader/` and sharing none of its layout engine. What it shares is
what is not about text: swipes (`reader/swipe.ts`), the dock, the keys.

**What it does, first version:** one page or a spread; fit to the height or
the width of the window; left to right or right to left; turn by key, click,
swipe or wheel; jump to a page; open at your page; keep your place and the
time spent.

**Where the pages come from.** A page is a picture of a megabyte or more,
and a Tauri command reply over 8 KB takes the slow path on WebView2, so
pages can't come through a command. The plan is a `ribboncomic` address,
answered in Rust like `ribbonmp3` and `ribbonaudio`: the web view asks for
a book's page by its entry's name, and Rust reads that one entry out of the
zip with the `zip` crate the EPUB parser already uses. The order of pages
stays core's decision; Rust only fetches the entry it is asked for.

The other way is Culvert all the way: `@culvert/zip` in the web view,
reading byte ranges through the Tauri file plugin. It is one zip reader
instead of two, and it is what Panels does on its server. Whether it is
fast enough is a question of numbers, not taste (section 7), so both are
measured before one is chosen.

**The page window, in Culvert.** Turning a page should never wait for one
to decode. The window is the pages around yours, held decoded: by default
two behind and eight ahead, as Panels has it.

- `packages/core/src/comic/window.ts` decides, purely, which pages to hold
  for a page and a direction, and which to let go. Unit-tested.
- A Culvert pipe carries it out: a Source of the pages the window names, a
  Transform that fetches and decodes each, a Sink that keeps them for the
  reader and drops what the window let go. Turning the page moves the
  window; pages no longer wanted are cancelled, not finished.
- It holds a bounded number of decoded pages, so a 600-page omnibus costs
  what a 24-page issue does.

**Over a share.** A comic in a folder on a network share is read in
ranges: the list of entries once, then one read per page. Nothing is
copied and nothing is written beside it but the usual records.

## 6. The place, and time spent

A comic's place is a `pos` record without `ms`, as a text's is
(POSITION-FORMAT.md, section 3.6), with a locator that names a page:

```json
{"v":1,"k":"pos","dev":"urn:uuid:5f0c…","seq":1795000000000,"t":"2026-12-01T20:15:00.000Z",
 "book":{"ids":["urn:ribbon:3b1f09aa"]},
 "why":"close",
 "loc":{"href":"Saga 001/page-014.jpg","type":"image/jpeg",
        "locations":{"position":14,"totalProgression":0.58}}}
```

- `href` is the page's entry in the archive, by name, so the place
  survives a reader that orders pages differently.
- `position` is the page, counted from 1, which is what Readium's
  `position` already means.
- A spread's place is its first page.

This is an addition to the format (a short section 3.8, "Places in a book
of pages"), not a change: a reader that doesn't know comics skips nothing
it understood before. Time spent is a `reading` record under the comic's
claims, thirty seconds or more, as the EPUB reader keeps one. Bookmarks are
a page with a note, the same `mark` with the same locator.

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

**The Apple TV** is left out of the first version. Reading a comic with a
remote from across a room is a different design, and the TV must stay
exactly as it is until that is wanted.

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
- **Bringing Panels' places over**, once, from its database.

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

## 10. For the owner to decide

1. **Do comics share the shelf with books, or have a section of their own?**
   The plan assumes one library, with comics found through their series.
2. **Who opens the archive on the desktop:** Rust behind a `ribboncomic`
   address, or Culvert in the web view? The plan measures both and takes
   the Rust address unless Culvert is as fast at 6x.
3. **A comic with no ComicInfo.xml:** Ribbon never guesses a series from a
   title. Does a comic's file name count ("Saga 014 (2013).cbz"), or is its
   series made by hand?
4. **The Apple TV:** left out, as proposed, or wanted?
5. **Panels itself:** retired once Ribbon reads comics, or kept?
6. **When.** Ribbon was heading for "easy to install" and then quiet. This
   is new work on the desktop, the server and two Apple apps. Before
   distribution is finished, or after?

## 11. The order of the work

One pull request per step, each usable on its own, each with its numbers.

| Step | What it is | Checked by |
| --- | --- | --- |
| 1 | This plan, the north star, and section 3.8 of the position format | Read by the owner |
| 2 | Core: the `.cbz` kind in the scan, page order, spreads, ComicInfo, the archive limits, the place. Comics on the desktop's shelf, with covers | Unit tests; fixture comics; the scan's speed over a share before and after |
| 3 | The desktop's comic reader, from folders: the page address, the window, the place, time spent | The end-to-end checks and the speed report at 1x and 6x |
| 4 | The server: copy in, prepare, the page requests; the desktop reading a server's comic | Server tests; the desktop against a real server |
| 5 | The iPad and the iPhone | The Apple tests and screens; the TV compared pixel for pixel, unchanged |

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

To check before step 2: Panels uses `@culvert/zip` 0.1.1 with
`@culvert/stream` 0.1.1, and Ribbon is on `@culvert/stream` 0.2.0. Whether
the two go together is the owner's to say; they are his packages.
