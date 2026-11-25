# A book's details, by kind

**A design, read and accepted by the owner** (2026-11-25: "pretty low
stakes. We can always fix later"). It is step 7 of [COMICS.md](COMICS.md),
section 15: each kind of book with details of its own, a comic's above
all, and then ComicVine filling a comic's in. Nothing here is built yet.
Section 10's questions are decided as recommended, and the defaults
marked **proposed** stand as written until he changes one.

Reading it, in order: section 1 says why; section 2 is what each kind
keeps, from what its files carry; section 3 how a comic is named on the
shelf from those details; section 4 where it all lives on every device;
section 5 the edit form and the MCP; section 6 how today's edits move
over; section 7 ComicVine; section 8 the north star; section 9 the order
of the work; section 10 the questions.

## 1. Why

Every book keeps the same details today, the ones an audiobook needs:
title and subtitle, author and narrator, series and its number, year,
genres, publisher, language, ISBN, ASIN and description
(`EDIT_FIELDS`, `packages/core/src/edits.ts`). Since 0.49.0 the edit form
asks each kind only the ones that fit it (`packages/core/src/edit-form.ts`),
but underneath they are still an audiobook's, and a comic doesn't fit in
them:

- **Its people share one line.** "Writers and artists" is the author
  field, names apart by semicolons, with nothing to say who wrote and who
  drew.
- **Its number is an issue's or a volume's**, in one field, so a
  collection and the issues it holds can't both be said.
- **Its other details have nowhere to go.** The Transformers comics on
  the owner's server show it best. An assistant filled them in through
  the MCP (`set_details`), and the colourist, the letterer and the day
  each went on sale went into the description, because no field could
  hold them:

  > Writer: Daniel Warren Johnson. Artist: Jorge Corona. Colours: Mike
  > Spicer. Letters: Rus Wooton. In stores July 10, 2024.

  The collection is "Transformers Vol. 1 (#1–#6)", number 1 in the same
  series as issues #7 to #24, and "Collects Transformers #1–6" is in its
  description too.

ComicVine knows all of these apart. Filled into today's fields, they'd be
run together again. So the owner asked, on 2026-11-25, for the details to
be rethought first: "it should be a different form per type of book".

## 2. What each kind keeps

Some details belong to every book and some are a kind's own. The kinds
are the edit form's three (`BookKind`, `packages/core/src/kind.ts`): an
audiobook (heard, with or without its EPUB), a text (an EPUB read alone)
and a book of pages (a comic, or a PDF read as pages). **New** marks what
no book keeps today.

| | Audiobook | Text | Comic or PDF |
| --- | --- | --- | --- |
| Title | Yes | Yes | Yes: the story's own name (section 3) |
| Series, and a place in it | Yes | Yes | Yes: the run, the place from its issue (section 3) |
| Year, publisher, language, genres, description | Yes | Yes | Yes |
| ISBN | Yes | Yes | Yes: a collection's |
| A cover chosen by hand | Yes | Yes | Yes: any of its pages |
| Subtitle | Yes | Yes | No |
| Author | Yes | Yes | No: its credits make its byline |
| Narrator, ASIN | Yes | No | No |
| Read-along switch | Yes, with its EPUB | No | No |
| Translators | No | **New** | **New**, among its credits |
| Credits by role | No | No | **New** |
| Issue; or volume and the issues it collects | No | No | **New** |
| Imprint, cover date, day on sale, story arcs | No | No | **New** |
| ComicVine address | No | No | **New** |
| Reads right to left | No | No | Yes: an edit from section 15, step 4 |

The rest of this section grounds each kind's in what its files actually
carry, and says what Ribbon reads of them today.

### An audiobook

Nothing new: today's details were made for it, and they stay as they
are. For the record, where each comes from (`scan.rs`, `KEEP_TAGS`;
`core/src/scan/metadata.ts`; `sidefiles.ts`):

| Detail | From the files |
| --- | --- |
| Title, subtitle | The `album` tag (or a lone file's `title`), a numbered folder's name, the folder, the file; `subtitle` |
| Author | `artist`, `album_artist`, `author` |
| Narrator | `composer`, `narrator`, `performer`; a folder's "{Scott Brick}"; `reader.txt` |
| Series and number | `series`, `mvnm`, `grouping`, `show`; `series-part`, `mvin`, `part`; numbered folders |
| Year | `date`, `year`, `originaldate`; a folder's leading year |
| Publisher, language, genres | `publisher`, `label`; `language`; `genre` |
| ISBN, ASIN | `isbn`; `asin`, a folder's "[B002V1OF70]" |
| Description | `ldes`, `description`, `desc`, `synopsis`, a comment that reads like prose; `desc.txt` |
| Over all of these | A `metadata.opf` beside the book (Audiobookshelf's or Calibre's), which someone wrote on purpose |

### A text

An EPUB's package (its OPF) says more than Ribbon reads of it. The Rust
side reads its `dc:title`, its `dc:creator`s with no role or the role
`aut`, `dc:language`, `dc:publisher`, `dc:date`, `dc:description` and
`dc:identifier` (`ebook/src/lib.rs`, `read_meta`), kept in
`.ribbon/ebooks.csv`.

What it leaves out, though core already reads the first two from a
`metadata.opf` beside an audiobook (`parseOpf`, `sidefiles.ts`):

| Detail | In the package | Proposed |
| --- | --- | --- |
| Series and number | Calibre's `calibre:series` and `calibre:series_index`; EPUB 3's `belongs-to-collection` and `group-position` | Read, as from a `metadata.opf` |
| Genres | `dc:subject` | Read |
| Translators | `dc:creator` with the role `trl` | Read, and asked in the form |

So an EPUB alone has no series today unless a person gives it one
(`buildReaderOnly`, `core/src/scan/scan.ts`). Proposed: the Rust side
hands the package's metadata over as text, as it does a comic's
ComicInfo.xml, and core reads it with the same `parseOpf` a side file
goes through, taught translators too, so there is one reader of an OPF.

### A comic

A comic's details come from three places: its ComicInfo.xml, if it has
one (the file comic managers write into the archive; its fields are the
Anansi Project's schema, 2.0 and the 2.1 draft); its file's name; and,
later, ComicVine (section 7). Ribbon reads eleven of ComicInfo's elements
today (`parseComicInfo`, `core/src/comic/comicinfo.ts`) and keeps ten of
them in `.ribbon/comics.csv`.

| Detail | ComicInfo.xml | File name | Read today? |
| --- | --- | --- | --- |
| Series (the run) | `Series`; `Volume` when it is a year (section 3) | "Saga 014" is Saga; a number alone takes its folder's name | Yes, but `Volume` is read and dropped: `ComicRecord` has no column for it |
| Issue | `Number`, as text ("14", "0", "½", "1.MU") | "Saga 014", "Saga #14" | As a number only: "1.MU" is lost |
| Volume, of a collection | `Number`, when `Format` says it is one (TPB, HC, Omnibus) | "Saga v2", "Saga Vol. 2" | Yes, into the series number, where an issue goes |
| The issues it collects | None | None | No: a person says them, or an assistant |
| Title | `Title`: the story's name | What's left once the brackets go | Yes, but it becomes the comic's whole name (section 3) |
| Writers | `Writer` | None | Yes, into the author field |
| Pencils, inks, colours, letters, cover | `Penciller`, `Inker`, `Colorist`, `Letterer`, `CoverArtist` | None | No |
| Editors, translators | `Editor`; `Translator` (2.1) | None | No |
| Publisher, imprint | `Publisher`, `Imprint` | None | Publisher only |
| Cover date | `Year`, `Month`, `Day` | "(2013)": a year | Year only |
| Story arcs | `StoryArc` (2.1 adds `StoryArcNumber`) | None | No |
| Genres, language, description | `Genre`, `LanguageISO`, `Summary` | None | Yes |
| Reads right to left | `Manga` is `YesAndRightToLeft` | None | Yes |
| ComicVine address | `Web`, when it holds one (Panels looked for it there) | None | No |

And from the file name, one more thing is lost: in "Batman v2 014" the
"v2" is read and dropped (`parseComicName`, `core/src/comic/filename.ts`).

**"Volume" means three things**, and the design keeps them apart:

1. **A run of a series**: Transformers (2023) is not Transformers (2019).
   ComicVine calls a run a volume; ComicInfo's `Volume` may hold the
   run's first year (its documentation says a volume goes by a number or
   by a year); a file name's "v2" before an issue number is the second
   run. Here a run is the series (section 3).
2. **A collection's number**: "Saga Vol. 2", a book that holds issues.
   This is the comic's **volume**.
3. **A manga's book**: "One Piece v03" is a collection of chapters, the
   same as 2.

So a comic is one of three things, and the form asks which (section 5):
**an issue**, with an issue number; **a collection**, with a volume
number and the issues it collects; or **a comic on its own** (a graphic
novel, a one-shot), with neither. Which one is never kept as a field of
its own: an issue number makes it an issue, a volume or the issues it
collects make it a collection.

**The people who made it**, each a list of names (a lone "Artist" credit,
as the Transformers descriptions have it, is pencils and inks both):

| Role | Form label | ComicInfo | ComicVine (section 7) |
| --- | --- | --- | --- |
| `writers` | Writers | `Writer` | writer |
| `pencils` | Art | `Penciller` | penciler, artist |
| `inks` | Inks | `Inker` | inker, artist |
| `colours` | Colours | `Colorist` | colorist |
| `letters` | Letters | `Letterer` | letterer |
| `coverArtists` | Cover | `CoverArtist` | cover |
| `editors` | Editors | `Editor` | editor |
| `translators` | Translators | `Translator` | None |

ComicVine's credits carry their roles as words, several to a person
("penciler, inker, cover"); its documentation doesn't list them, so the
words above are checked against real answers when it's built.

**Dates.** The cover date is the month on the cover ("July 2024"), kept
as `2024-07`, or `2024` when only the year is known; the comic's year,
the detail every book has, is the cover date's year. ComicInfo's `Year`,
`Month` and `Day` are read as the cover date (its documentation calls
them "usually" the release date; proposed).
The day on sale ("In stores July 10, 2024") is ComicVine's `store_date`,
kept as `onSale` and shown under More.

### A PDF read as pages

A PDF can be anything: a comic, a graphic novel, or a magazine (the
owner's server has a White Dwarf). Today Ribbon learns only how many
pages it has (the scan sends `pages` and nothing else, in the web view's
`pdf-host.ts` and on Node alike), and names it by its file.

**Proposed: a PDF keeps a comic's details** and is edited in the same
form, under "The book" rather than "The comic". A magazine fits it as it
is: the magazine is the series, the number on the cover is the issue,
and the month on the cover is its cover date. Where its Info dictionary
has a `Title` or an `Author`, they are read as a comic's ComicInfo is,
by pdf.js where it counts the pages, since the document is open then
anyway. ComicVine is offered for a PDF too; for a magazine it will
simply find nothing.

## 3. How a comic is named on the shelf

Today a comic's title is its whole name: ComicInfo's `Title` if it has
one, else "Saga #14" from its series and number, else its file's name
(`nameComic`, `core/src/scan/comics.ts`). So a Saga issue whose
ComicInfo says `Title` "Chapter Fourteen" is on the shelf as "Chapter
Fourteen", and the form's hint asks people to type "Saga Vol. 1 (#1–#6)"
into the title by hand.

**Proposed: the name is made from the details**, in core, so every
device names a comic the same way, and the title is only the story's own
name:

| It is | Its name on the shelf | For example |
| --- | --- | --- |
| An issue | Series #issue, then the title after a colon | "Transformers #7"; "Saga #14: Chapter Fourteen" |
| A collection | Series Vol. volume, then the title | "Transformers Vol. 1: Robots in Disguise" |
| A collection with no volume number | Series, then the title, then the issues | "Saga: Compendium One"; "Saga (#1–#54)" |
| On its own | Its title | "The Sculptor" |

- **A run's first year**, in brackets at the end of the series' name
  ("Transformers (2023)"), is left out of the comic's name: the series
  says it, the issue doesn't need to.
- **Its byline**, where an audiobook says its author, is its writers and
  then its art, each name once: "Daniel Warren Johnson; Jorge Corona".
  The listing's `author` is that line, so every device that shows an
  author shows it without knowing about credits.
- **Its place in the series** is its issue number, when that is a
  number. A collection's is the first issue it collects, else its volume
  number. That is how the owner's Transformers series reads now: Vol. 1
  (#1–#6) first, then #7 onwards. A person who numbers a series by hand
  (its own order, `series_book` on the server, `.ribbon/series/` beside
  the books) still has the last word.
- **Its label in a series** is "#7" or "Vol. 1", where an audiobook's is
  "Book 2": "Transformers (2023) · #7 of 19" on the book's page, on every
  device.

A run's year stays in the series' name (proposed, question 3) because
that is what keeps two runs apart: series are grouped by name
(`detectSeries`, `core/src/series.ts`), so two runs both called
"Transformers" would be taken for one. ComicVine's pages show its runs
the same way, and the owner's server already has "Transformers (2023)".

## 4. Where they're kept

### In core

`Book` (`core/src/types.ts`) gains a comic's own details, and the people
of a book beyond its author and narrator. Plain data, as every value in
core is:

```ts
/** People by what they did: a comic's, and a text's translators. Not "cover": that is the cover picture's edit already. */
type Role = "writers" | "pencils" | "inks" | "colours" | "letters" | "coverArtists" | "editors" | "translators";
type Credits = Partial<Record<Role, string[]>>;

interface Book {
  // ...every book's details, as today
  credits?: Credits;
  /** A comic's own (docs/BOOK-DETAILS.md). */
  issue?: string;        // as printed: "14", "½", "1.MU"
  volume?: string;       // a collection's: "1"
  collects?: string;     // "1–6, Annual 1"
  imprint?: string;
  coverDate?: string;    // "2024-07", or "2024"
  onSale?: string;       // "2024-07-10"
  storyArcs?: string[];
  comicvine?: string;    // "4000-1234567"
  rightToLeft?: boolean; // as today, and an edit (section 15, step 4)
}
```

Each is an edit like any field (`EDIT_FIELDS`), one row each: `issue`,
`volume`, `collects`, one per role (`writers`, `pencils` and so on),
`imprint`, `coverDate`, `onSale`, `storyArcs`; all but `comicvine`,
which comes from the file or from a match (section 7). The name, the
byline, the place and the label of section 3 are worked out from them
by one module in core, `comic-name.ts` (proposed), with tests, which the
desktop and the server both call. `rightToLeft` became an edit in step 4 of
section 15 (#289, in 0.50.0): a switch kept as `yes` or `no`
(`right_to_left` beside the books), which stands over ComicInfo's `Manga`. It is one of a comic's own details here,
and nothing about it changes.

### On the desktop alone

| What | Today | After |
| --- | --- | --- |
| What a comic's file says | `.ribbon/comics.csv`: path, size, time, pages, title, series, number, year, writers, publisher, summary, language, genres, right to left | The same file, with `issue` (text) in place of `number`, and `volume`, `format`, `pencils`, `inks`, `colours`, `letters`, `cover_artists`, `editors`, `translators`, `imprint`, `month`, `day`, `story_arc` and `web` |
| What an EPUB's package says | `.ribbon/ebooks.csv` | With `series`, `series_index`, `subjects` and `translators` |
| A person's edits | `.ribbon/edits/<id>.csv`: field, value, when | The same file, with the new fields; old ones read as new (section 6) |
| What ComicVine said, for a comic matched | None | `.ribbon/matched/<id>.csv`, in the edits' shape, with the address and when it was asked (section 7) |
| A ComicVine key | None | Ribbon's own settings, never beside the books, which may be a share others read |

**Reading the files again, once.** The records are kept so an unchanged
comic is never opened twice, and a record from before this change has
no column for what's new. A `comics.csv` whose columns are the old ones
is read as if it weren't there, so each comic's archive list and its
ComicInfo.xml are read once more, as on its first scan: after the shelf
has painted from the folder walk, streamed in as tags are, so the first
paint costs what it did. The same for `ebooks.csv`. Measured before and
after (section 9).

**Fields a version doesn't know.** Reading edits skips a field it
doesn't know (`bytesToEdits`), and saving writes only the fields it knows
(`editsToBytes`, `diffEdits`). So an older Ribbon on another computer,
sharing the folder, would drop a comic's new fields the next time it
saved that book. That can't be fixed in the versions already out, but
from this change on, saving keeps every row it doesn't know as it found
it, so it never happens between two newer versions.

### On a server

| What | Today | After |
| --- | --- | --- |
| `book` table | Title, author, narrator, series and number as the files say, for the listing | A `details` column: the kind's own details as the files say, as JSON, so the listing can name a comic without opening its `book.json` |
| `books/<id>/book.json` | The scanner's record, `StoredBook` | With the new fields. Each comic's ComicInfo.xml is read again once from its `book.cbz`, the way `hydrate.ts` works a book out again when what it came from changes |
| `book_edit` | The edits as JSON | The same, with the new fields; moved once (section 6), the edits as they were kept beside them |
| `book_match` | None | A comic's ComicVine match: its address, an issue or a collection, what it said for each field, its whole answer, when and by whom (section 7) |
| `comicvine_cache` | None | ComicVine's answers to searches, for a day (section 7) |

And what devices are given:

| Request | After |
| --- | --- |
| `GET /api/books` | Each comic's `title` and `author` are its name and byline (section 3), made from its files, its match and its edits. Nothing else is new, so the listing stays the size it is. |
| `GET /api/series` | Each book gains `label`: "#7", "Vol. 1", or null for a book, which shows "Book 2" as today. |
| `GET /api/books/:id` | `book` gains the new fields, edits laid over them as today; `matched`, beside `edited`, says what ComicVine said for each field and its address. |
| `PUT /api/books/:id/edits` | Takes the new fields. Today it refuses a field it doesn't know (`editsAsked`, `library/routes.ts`), so the server must know them before a desktop sends them: the server says it does, and a desktop on an older server shows a comic's form as it is today. |

**A folder's edits don't come with it** to a server today: adding a
folder carries its chapters, hand corrections and pairing
(`CARRIED`, `server/src/library/records.ts`), not its edits. That stays as
it is here; it is noted because section 6 moves edits in two places.

### The Apple apps

They draw what the server gives them, so most of this reaches them with
no change:

- **The name and the byline** come composed in the listing's `title` and
  `author`. An iPad, iPhone or TV that isn't updated shows "Transformers
  Vol. 1: Robots in Disguise" by "Daniel Warren Johnson" the day the
  server is.
- **The series line** ("Transformers (2023) · Book 7 of 19" today,
  `BookView.swift`) uses the series' `label`: "#7 of 19".
- **A comic's page** lists its credits by role, its cover date, the
  issues it collects, its story arcs and its imprint beside its
  publisher, read from `GET /api/books/:id` (`ServerBookDetail.About`
  decodes `description`, `year`, `publisher` and `rightToLeft` today).
  A matched comic says "Details from ComicVine", as ComicVine asks
  (section 7). The TV's other screens are compared pixel for pixel,
  unchanged.
- **Reading direction** is step 4's, and the apps follow it there.

### The position log

**Nothing changes.** The log names books by ids, never by names
(POSITION-FORMAT.md, section 4): a comic's place is a page, under
`urn:ribbon:<id>-text`, and its id is its path and its size, which no
detail touches.

A ComicVine address is kept as a detail, not a claim (proposed). A claim
is also how a server knows a book is already there when another copy
arrives (`book_claim`), and a comic is matched after it arrives, so the
address couldn't do that job; and two scans of one issue are two files a
person may want to keep apart.

## 5. The edit form, and the MCP

### The form, per kind

The audiobook's and the text's forms are today's, with one field more
for a text. The comic's is new. Shown in groups, as now (`editForm`):

**An audiobook:** as today. The book (title, subtitle); people (author,
narrator); series (series, number in the series); more (year, language,
genres, publisher, ISBN, ASIN, description); read-along, for a book with
its EPUB.

**A text:** as today, with **Translators** beside the author.

**A comic** (and a PDF, under "The book"):

| Group | Fields |
| --- | --- |
| The comic | **It is**: an issue, a collection, or a comic on its own. **Series**. **Issue**, for an issue; **Volume** and **Collects** ("1–6, Annual 1"), for a collection. **Title**: "The story's own name, if it has one. The shelf adds the series and the number." |
| People | **Writers**, **Art**, **Inks** ("Leave it empty when the artist inked their own pages"), **Colours**, **Letters**, **Cover**. Several names apart by semicolons, as today. **By**, only while a byline kept from before is there (section 6). |
| When | **Cover date**: a month and a year, or a year. |
| More | Publisher, **imprint**, **story arcs**, language, genres, ISBN (a collection's), **editors**, **translators**, **day on sale**, description. |
| Reading | **Reads right to left** (step 4's switch). |
| ComicVine | "Look it up…", where a key is set (section 7); once matched, "Details from ComicVine" with its address, and "Forget the match". |

- **Switching what it is** empties what no longer fits: an issue made a
  collection has its issue number emptied by an edit, so the file's
  `Number` doesn't come back as an issue.
- **The title's hint** today ("Say which issue or issues it holds") goes:
  the shelf says that now.
- **Each field** still says what the files say and offers "Use the
  files'". For a matched comic it says what ComicVine says, and offers
  "Use ComicVine's" (section 7).
- **A field the form leaves out is never changed by it**, as today.

### The MCP

The MCP's comic tools take their fields from the form (`DETAILS`, made
from `formFields("comic")` in `packages/server/src/mcp.ts`), so they
follow it:

- **`comic_details`** answers with the name the shelf shows, what it is
  (an issue, a collection, on its own), and every field above by name
  (`series`, `issue`, `volume`, `collects`, `title`, `writers`, `pencils`,
  `inks`, `colours`, `letters`, `cover_artists`, `editors`, `translators`,
  `publisher`, `imprint`, `cover_date`, `on_sale`, `year`, `story_arcs`,
  `language`, `genres`, `isbn`, `description`, and which way it reads),
  which were corrected by hand, which came from ComicVine, and its cover.
- **`set_details`** takes the same names. `number` goes, for `issue` and
  `volume`; `author` goes, for the credits (and `by`, to take back a
  byline kept from before, section 6). An assistant reads the list of
  tools when it connects, so nothing needs to understand the old names.
  Its description says what the title now is, how a collection's issues
  are written, and that a date is `2024-07`.
- **Which way it reads** is step 4's to add to `set_details`, under the
  name it gives it.
- **With ComicVine on** (section 7), `set_details` also takes
  `comicvine`, an address: the server asks ComicVine itself and keeps the
  match as the form's "Use these" does (proposed). An assistant that
  finds the right page on ComicVine then hands over the address instead
  of copying out every detail.

## 6. Moving what exists

**Only a comic's edits move.** An audiobook's and a text's are already
in the fields they keep. The rules, in core (proposed: `movedComicEdits`,
with a test for each row):

| A comic's edit today | After |
| --- | --- |
| Title, equal to the name the shelf would now make ("Transformers #10") | Dropped: the shelf shows the same |
| Title in the shape the form's hint asked for, "Series Vol. 1 (#1–#6)" | Volume 1, collects "1–6"; its subtitle, if it has one, becomes its title |
| Title, anything else | Kept: it is the story's name |
| Subtitle, beside a title kept | Joined to it: "Title: Subtitle" |
| Number in the series | The volume, if the comic is a collection by the rule above or by its file's name; else its issue |
| Author ("Writers and artists") | Kept as the comic's byline, and shown in the form as **By** while it's there: "Kept from before writers and artists had fields of their own. Take it back to show the credits." |
| Everything else | Unchanged |

The title's shape is Ribbon's own, from its own hint, so reading it back
is not a guess at what someone meant. A byline can't be moved: "Daniel
Warren Johnson; Jorge Corona" doesn't say who drew, and putting both
under writers would be wrong for one of them. Kept as it is, nothing is
lost, nothing is mislabelled, and it goes when someone takes it back.

**Where the move happens:**

- **On a server**, once, when it starts, in one transaction, as the
  upgrade that let books into many series did (`letBooksIntoManySeries`,
  `server/src/db.ts`). Each comic's edits as they were are kept in a
  column beside them for a release, so the move can be undone by hand.
- **On the desktop alone**, as edits are read: a file with the old
  fields is read as the new ones, and written in the new shape only when
  the person next saves that book. Nothing is written to a library on
  opening it, and an older Ribbon sharing the folder keeps reading the
  file it knows until then.

**The owner's Transformers**, from the four read for this design (#7,
#10, #24 and Vol. 1):

- **#7 to #24:** "Transformers #10" is the name the shelf makes, so the
  title edit goes; number 10 becomes issue 10; the byline stays until the
  credits are filled; the description is untouched.
- **Vol. 1:** volume 1, collects "1–6", title "Robots in Disguise" (its
  subtitle); "Transformers Vol. 1: Robots in Disguise" on the shelf, first
  in the series.
- **The credits and dates in the descriptions** are an assistant's
  prose, not a format, so Ribbon doesn't parse them (proposed, question
  8). Once the new fields are in, the assistant is asked once, through
  `set_details`, to move them into writers, art, colours, letters, cover
  date and day on sale, take the "Writer: …" lines out of the
  descriptions, and take the old bylines back. Every one of those is an
  edit a person can see and undo.

Before the server's move runs on the owner's data, it runs on a copy of
it, and its pull request shows every comic's details before and after.

## 7. ComicVine

**ComicVine** (comicvine.gamespot.com) is the comic database most comic
managers look things up in, Panels among them, through its API. What its
terms of use say (on its API page, read on 2026-11-25):

- A key comes with an account, and a site needs a key of its own.
- The API is "strictly for non-commercial use only".
- 200 requests per resource an hour are supported, and too many in a
  second may block a key for a while.
- Answers should be cached, so the same thing isn't asked twice.
- Wherever its data is used, link back to ComicVine. Don't build a
  competing product, don't use its name to promote your own, and don't
  edit or reproduce its data on another medium.

So Ribbon keeps ComicVine's answers as a cache for one server's people,
shows its words as they came (its HTML made plain text, nothing
rewritten), and links back wherever they show.

### Off unless a server's owner turns it on

As Audible's descriptions are (`RIBBON_DESCRIPTIONS`,
`server/src/library/describe.ts`): **`RIBBON_COMICVINE_KEY`**, the
server owner's own key. Unset, the server asks no one and the form shows
no "Look it up". Ribbon ships no key of its own: a key is one site's,
and Ribbon is many people's servers.

### "Look it up"

In the edit form, for a book of pages, for whoever may edit it (on a
server, its admin). Every request is the server's: a device never talks
to ComicVine, so the key and the answers stay on the server.

1. **By its address.** A comic whose file names its ComicVine page
   (ComicInfo's `Web`), or that was matched before, goes straight to it.
   Otherwise a person can paste one: an issue's (`…/4000-1234567/`), or a
   run's (`…/4050-123456/`) with the comic's issue number.
2. **Or by searching**, with the comic's series (its run's year taken
   out of the name and given as the year), and its issue number: the
   runs ComicVine has by that name, each with its first year, its
   publisher, how many issues it has and a small picture of its first
   cover, fetched by the server. A person picks the run, and the issue
   is asked for by its number.
3. **Then side by side:** each field as the comic has it, and as
   ComicVine has it. "Use these" keeps the match; nothing is kept before
   that.

A look-up is two requests to the API either way: the issue (with its
credits) and its run (for its publisher and first year), besides the
small pictures of the runs offered. The form's choice of issue
or collection says how ComicVine's number is read: a collection's
"issue" on ComicVine is its volume.

### What is filled

| Ribbon | ComicVine |
| --- | --- |
| Series | The run's name, with its first year in brackets |
| Issue, or volume | The issue's `issue_number` |
| Title | The issue's `name` |
| Credits | The issue's `person_credits`, by role (section 2) |
| Cover date, year | The issue's `cover_date` |
| Day on sale | The issue's `store_date` |
| Story arcs | The issue's `story_arc_credits` |
| Publisher | The run's `publisher` |
| Description | The issue's `description`, its HTML made plain paragraphs as Audible's are (`summaryText`); else its `deck`. Never the run's: that is about the run, not this comic. |
| ComicVine address | The issue's `site_detail_url` |
| Never | Imprint (ComicVine has no such field), language, genres, reading direction, the issues a collection holds (ComicVine has them only in prose), and the cover: a comic's cover is one of its own pages |

### A person's edit always beats it

ComicVine's answer is a layer of its own, between the files and a
person's edits (proposed, question 5). Each field shows the person's
edit if there is one; else what ComicVine said, if it said anything;
else what the files say. So:

- **A look-up never changes an edit.** Taking an edit back goes to
  ComicVine's value, where today it goes to the files'.
- **Looking it up again** replaces ComicVine's layer and nothing else.
- **"Forget the match"** takes the layer away whole, and the comic is
  what its files and its edits say again.
- **The assistant's details stand.** The Transformers comics keep what
  the assistant set; once matched, each field where ComicVine says
  something else shows it, and "Use ComicVine's" is one press.

### By itself, only by an exact address

Panels looked every comic up as it arrived: it searched ComicVine's runs
by the series' name, scored them, took the best and its issue by number,
and wrote the answer over the comic's fields. Ribbon doesn't guess, so
**it never searches without a person**. The one look-up it makes by
itself (proposed, question 6) is the exact one: a comic whose
ComicInfo's `Web` is a ComicVine issue's address is matched to that
issue, in the background on the server, as Audible's descriptions are
fetched after a folder is added, one comic at a time. A person's "Look
it up" always goes before it.

### Rate limits and caching

- **One request at a time, a second and a half apart** (Panels' gap),
  and no more than 180 to a resource in an hour, so a person's look-up
  always has room. A batch waits rather than coming near the limit.
- **Blocked** (an answer of 420 or 429, or ComicVine's status 107, as
  Panels handled them): wait and try again, twice more, waiting twice as
  long each time. Three in a row unreachable, and the background job
  stops until the next run, as `describeBooks` does.
- **Kept:** a match is kept with its comic, its whole answer included,
  so it's never asked again unless a person asks. Searches are kept for a
  day (`comicvine_cache`), as Panels kept them.

### Where it runs

**On the server first.** It is where the key is set once for everyone,
where the cache and the limit are shared, and where the owner's comics
are. Proposed after that (question 7): **the desktop alone too**, with a
key in Settings → Online, beside "Descriptions and chapter names", which
already asks Open Library, Audible's catalog and Audnexus when it is
turned on. The look-up's rules (what is matched, what is filled) are in
core, so the server and the desktop can't come to disagree; on the
desktop the requests go through a Rust command that builds only
ComicVine's addresses, as `online.rs` builds only Audible's, and the
match is kept in `.ribbon/matched/`.

### Panels, and what is different

| Panels | Ribbon |
| --- | --- |
| Matched every comic as it arrived: by the address in its `Web`, else by searching runs by name and taking the best | Only by an exact address the file gives; never a search without a person |
| ComicVine's answer replaced the comic's fields (`buildFieldUpdates`) | A layer under a person's edits, forgotten in one press |
| Kept the writers only, joined by commas | Every role Ribbon keeps |
| The year from the cover date, else the run's first year | The cover date's; the run's first year goes in the series' name |
| The description from the issue, else the run's | The issue's only |
| `COMICVINE_API_KEY` | `RIBBON_COMICVINE_KEY` |

## 8. The north star

"Nothing in anyone else's cloud" holds:

- **What goes out** is what names a comic: a series' name, an issue's
  number, a year, or a ComicVine address, with the owner's key. Never a
  page, a file, a person or a place.
- **What comes back stays home**, on the server or beside the books, and
  is shown with a link back to ComicVine.
- **Nothing depends on it.** It is off until the owner turns it on. With
  the key taken away, or ComicVine gone, every comic keeps every detail
  it has.

It is the same door as Audible's descriptions. But the north star says
today: "The one door out is the one you open yourself: an assistant
given a key to your server's comics". Added (question 9, decided), in
"Not someone else's service": *Looking a book's details up, Audible's
descriptions or ComicVine's comics, is another you open yourself: off
until you turn it on, it sends only what names the book.*

## 9. The order of the work

One pull request each, as ever. Step 1 here is section 15's step 7, and
the rest are its step 8 taken apart. Steps 2 to 4 go out in one release:
the name the shelf makes and the move of today's edits have to reach
every device together.

| Step | What it is | Checked by |
| --- | --- | --- |
| 1 | This design | Read by the owner |
| 2 | Core: a comic's own details and credits; ComicInfo.xml read in full and the file name's volume kept; the new edits; the name, byline, place and label made from them (`comic-name.ts`); today's edits moved as they are read; edits keep rows they don't know | Unit tests, one for each row of section 6's table and section 3's |
| 3 | The desktop alone: `comics.csv`'s new columns and the one read again; the comic's form; credits, dates and the series label on a book's page | Unit tests; the end-to-end checks at 1x and 6x, with comics in `.e2e/library` carrying a full ComicInfo.xml; the first paint measured before and after |
| 4 | The server: `book.details`, the listing's names and the series' labels, the new fields in and out, the one-time move of `book_edit`, the MCP's tools | Server tests, on a database made in today's shape; `desktop-on-server.test.ts`; the move run on a copy of the owner's data, every comic shown before and after; the image swapped only on his word |
| 5 | The Transformers' credits and dates out of their descriptions, by the assistant through `set_details` | On the owner's word, after step 4 is on his server; looked at in the form |
| 6 | The Apple apps: the series label, and a comic's credits, dates and "Details from ComicVine" on its page | The Apple tests; the TV's other screens compared pixel for pixel, unchanged |
| 7 | An EPUB's own: its series, genres and translators from its package, read by `parseOpf`; translators in the form | Rust and unit tests; the scan benchmark, before and after |
| 8 | ComicVine on the server: the key, the gate, the cache, `book_match`, "Look it up" and its routes, the match by the file's address, `set_details`'s `comicvine` | Server tests against a stand-in ComicVine answering from recorded answers (CI never asks the real one); then by hand with the owner's key, on his Transformers |
| 9 | ComicVine on the desktop alone, if he wants it | Unit tests; the end-to-end checks, with the stand-in |

## 10. Questions for the owner

**Decided on 2026-11-25: every recommendation below, as written.** The
north star's line (question 9) is made in [NORTHSTAR.md](NORTHSTAR.md).

1. **Should the shelf name a comic from its details** ("Transformers
   #7", "Transformers Vol. 1: Robots in Disguise"), with the title only
   the story's own name? Or keep the title as a person types it, whole?
   *Recommended: from its details.* Every device then names it the same,
   and the form stops asking people to type the series and the number
   twice.
2. **Should a run's issues and its collections share one series**, a
   collection placed at the first issue it collects? Or the collections a
   series of their own? *Recommended: one series*, as yours reads now:
   Vol. 1 (#1–#6), then #7 on.
3. **Should a run's first year stay in the series' name**
   ("Transformers (2023)"), left out of each comic's name? Or be a detail
   of its own? *Recommended: in the name.* Series are told apart by
   name, so two runs called "Transformers" would otherwise be one series,
   and ComicVine's pages show runs this way too.
4. **Which people should a comic keep?** Writers, art, inks, colours,
   letters and cover, as you listed, plus editors and translators under
   More. *Recommended: all eight.* ComicInfo and ComicVine have them
   all, and manga needs its translators.
5. **Should ComicVine's answer be a layer under a person's edits**, so
   a look-up never changes an edit and is forgotten in one press? Or be
   written as edits, as the assistant's are? *Recommended: a layer.*
6. **Should the server look a comic up by itself**, but only by the
   exact ComicVine address in its ComicInfo's `Web`, in the background?
   Or only ever when a person presses "Look it up"? *Recommended: by the
   file's address.* It is the comic saying which issue it is, so nothing
   is guessed; anything less certain waits for a person.
7. **Should ComicVine come to the desktop alone too**, with a key in
   Settings → Online, after the server's? *Recommended: yes, after.*
   The desktop alone is all of Ribbon, and it already looks things up
   behind a switch.
8. **The Transformers' credits and dates, written into their
   descriptions:** moved by the assistant, once, through `set_details`?
   Or by a one-time move in Ribbon's code that reads "Writer: …"
   lines? *Recommended: the assistant.* It is one assistant's way of
   writing, on nineteen comics, and code that reads it would stay in
   Ribbon for good.
9. **Should the north star name looking details up** as a door you
   open yourself, in the words of section 8? *Recommended: yes*, since
   Audible's descriptions are one already and ComicVine would be
   another.
10. **Should an EPUB's own series, genres and translators be part of
    this work** (step 7), or wait? *Recommended: part of it, last.* It is
    small, the same reader as a side file's, and "each kind its own"
    covers texts too.
