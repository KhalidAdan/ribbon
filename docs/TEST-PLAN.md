# Ribbon test plan

The North Star says the difference between "fine" and "I would never
switch" lives in a dozen small behaviours. Every one of those
behaviours is a pure function in `packages/core` with a table of cases
here. If a behaviour is not in this file, it is not done.

## Layers

| Layer          | Tool                    | Runs where          | What it proves                      |
| -------------- | ----------------------- | ------------------- | ----------------------------------- |
| Unit           | Vitest                  | `npm test`          | Every decision in `packages/core`.       |
| Fixture        | Vitest + ffmpeg         | `npm test`          | Scan and probe against real codecs. |
| Real library   | Vitest, opt-in          | `RIBBON_BOOKS=books npm test` | The user's actual files.    |
| Rust           | `cargo test`            | `npm run test:rust` | Tauri commands and path scoping.    |
| Manual         | Checklist below         | The app             | Audio, keys, lock screen.           |

Fixtures are generated into `packages/desktop/test/fixtures/generated/` by
`packages/desktop/tools/make-fixtures.ts` using ffmpeg's `sine` and `anullsrc` sources.
They are deterministic and tiny. They are never committed.

## Unit cases

### Book id (`core/bookid.ts`)

- Same relative path and size on two machines gives the same id.
- Backslash and forward slash paths give the same id.
- Different size gives a different id.
- Case of the path is preserved, so `Book` and `book` differ.
- Output is exactly eight lowercase hex characters.

### Natural sort (`core/natsort.ts`)

- `Chapter 2` before `Chapter 10` before `Chapter 100`.
- `01 - Intro` before `2 - Body` before `10 - End`.
- Leading zeros: `007` and `7` compare equal, then fall back to string.
- Case-insensitive: `chapter 1` and `Chapter 1` compare equal.
- Stable for identical names.
- Unicode digits are not treated as numbers.

### Grouping (`core/scan/group.ts`)

- Folder with audio files becomes one book with those files.
- Loose audio file at library root becomes a one-file book.
- Nested folders: `Series/Book/*.mp3` groups at `Book`, not `Series`.
- A folder with both loose audio and subfolders with audio: the loose
  files are one book and each subfolder is its own book.
- Non-audio files (jpg, nfo, cue, txt) are ignored for grouping but
  `cover.jpg` and `folder.jpg` are captured as cover candidates.
- Files ordered by disc tag, then track tag, then natural filename.
- Files with a disc tag of `0` or missing sort as disc 1.
- A track tag like `3/22` parses as 3.
- Hidden files and the `.ribbon` folder are skipped.
- A numbered folder holding only numbered subfolders is one book with
  parts: `20. The Primarchs/01 The Reflection Crackd/…` plays as book 20.
  The library root never folds; a numbered folder with audio of its own
  or an unnumbered child is left alone; nested anthologies fold at the
  outermost.

### Stories (`core/scan/parts.ts`)

- Every file of a story carries the story's name in `files.csv`; the
  stories on the book timeline fall out of the file list alone.
- A story is named by its album tag when every story has one and no two
  agree, else by its folder name without the number.
- The author of a story is its files' artist tag; a book by several
  hands is by "Various".
- `partAt` finds the story around a position; the last owns its end.
- `groupByPart` folds chapters under stories keeping each chapter's flat
  index, so corrections and the player still address chapters.
- Anthology files recorded before stories had names are read again once.

### Probe parsing (`core/scan/probe.ts`)

- Duration parsed from `format.duration` as milliseconds, rounded.
- Falls back to the audio stream duration when format has none.
- Tags are matched case-insensitively (`TRACKNUMBER` and `track`).
- Attached picture detected from `disposition.attached_pic`.
- Chapters parsed with `start_time` and `end_time` to milliseconds.
- Malformed JSON rejects with a `ProbeError` naming the file.
- ffprobe non-zero exit rejects with the stderr text.

### Metadata resolution (`core/scan/metadata.ts`)

- Title from `album`, else folder name, else file name without extension.
- Author from `artist`, else `album_artist`.
- Narrator from `composer`, else `narrator`, else empty.
- Series from `series` or `mvnm`; series index from `series-part` or
  `mvin`; index parsed as a number and may be fractional (`2.5`).
- With no tag and no numbered folder, no series: titles are never read
  for one, however a store words them ("Leviathan Wakes (The Expanse,
  Book 1)"). Ribbon guessed series from titles until 0.36.0.
- A series deleted stays deleted: on a server for every device, in a
  folder by a record beside the books, though the tags still name it.
- Year from the first four digits of `date`.
- `(Unabridged)` suffix stripped from the title for display, preserved in
  `raw_title`.
- When files disagree on album, the most common value wins.

### Chapters (`core/scan/chapters.ts`)

- Embedded chapters from a single file are used as-is.
- Multi-file book with no embedded chapters: one chapter per file,
  start offsets accumulate durations exactly.
- Multi-file book where some files have embedded chapters: embedded
  chapters are offset by the file's start in the book timeline.
- Chapter titles from `title` tag, else file name, else `Chapter N`.
- Corrections overlay: rename, move start, delete, insert, all by
  chapter index, applied in file order.
- A correction that references a missing index is ignored and reported.
- Chapter list is always sorted and never has two equal start offsets.

### Timeline (`core/timeline.ts`)

Given files of durations `[1000, 2000, 3000]`:

- Offset 0 is file 0 at 0.
- Offset 999 is file 0 at 999.
- Offset 1000 is file 1 at 0, not file 0 at 1000.
- Offset 2999 is file 1 at 1999.
- Offset 3000 is file 2 at 0.
- Offset 6000 (end) is file 2 at 3000 and flagged as end.
- Offset past the end clamps to end.
- Negative offset clamps to 0.
- Reverse mapping from (file, offset) is exact for every boundary.
- Total duration equals the sum.
- Zero-duration files are skipped in forward mapping.

### Resume rewind (`core/resume.ts`)

| Gap           | Expected rewind ms | Offer chapter restart |
| ------------- | ------------------ | --------------------- |
| 0             | 0                  | no                    |
| 9 999         | 0                  | no                    |
| 10 000        | 2 000              | no                    |
| 119 999       | 2 000              | no                    |
| 120 000       | 10 000             | no                    |
| 3 599 999     | 10 000             | no                    |
| 3 600 000     | 30 000             | no                    |
| 86 399 999    | 30 000             | no                    |
| 86 400 000    | 30 000             | yes                   |
| 604 800 000   | 60 000             | yes                   |
| negative      | 0                  | no                    |

- Rewind never lands before the current chapter start.
- Rewind never lands before 0.
- Applying rewind at exactly the chapter start yields the chapter start.

### Speed and time remaining (`core/speed.ts`)

- Remaining at 1.0x for 3 600 000 ms left is 3 600 000.
- Remaining at 2.0x is 1 800 000.
- Remaining at 1.25x is 2 880 000.
- Speed is clamped to the range 0.5 to 3.0.
- Speed steps are 0.05 and snapping rounds to the nearest step.
- Formatting: `1:00:00`, `59:59`, `0:05`, never negative.

### Sleep timer (`core/sleep.ts`)

- Duration mode: fires at start plus duration.
- End-of-chapter mode: fires at the chapter end offset, recomputed if
  the chapter changes because of a seek.
- Fade starts fifteen seconds before firing; gain goes from 1 to 0
  linearly and is exactly 0 at fire time.
- Extend adds the extension and cancels any fade in progress, gain
  returns to 1.
- Cancel resets to idle with gain 1.
- Pausing the player pauses the timer clock in duration mode.
- Minutes added while it's held add to what was left: the time held is
  never counted, however long it was, and it stays held until the book
  plays again.
- Speed changes do not change wall-clock duration mode but do change
  the wall-clock time an end-of-chapter timer fires.
- Before and after: the timer made explicit does what the old one did in
  every sequence of six events but that one (`sleep-before-after.test.ts`).

### Whether a book plays (`core/playback.ts`)

- Every event has an answer in every status.
- A pause, a load, a pause from outside, a refusal to play, a failure
  while paused, and the end all lead to paused, from anywhere.
- The audio sounding leads to playing, and a failure while wanted to
  reconnecting, from anywhere.
- Waiting for the file counts only while it's wanted: loading before the
  first sound, buffering after.
- The play button pauses from the press on, through loading and
  reconnecting; the bar and the full player say the same thing.
- Before and after: the engine with its status made explicit does to the
  audio, the log and the place what the old one did, in every sequence of
  three of sixteen events and 2,000 random ones of sixteen, and shows the
  same but for four words the old one left up after their cause had
  stopped (`engine-before-after.test.ts`).

### Asks where only the newest counts (`core/latest.ts`)

- An ask is current until a newer one begins, and never again after.
- The book asked for last opens, in the player and the reader, though one
  asked for before it finishes downloading after it; asked for again
  while it downloads, it waits for the same download and opens
  (`desktop-on-server.test.ts`).

### Run again (`core/rerun.ts`)

- Idle, an ask runs at once; running, every ask made meanwhile shares one
  more run after, with what each asked merged, and waits for it.
- A run that fails rejects for those who asked for it; the run after
  still runs.
- A book that finishes downloading while its folder is scanned plays
  (`desktop-on-server.test.ts`).

### The reader's session (`core/reading/session.ts`)

- Opening, then ready with a text and a place, or failed with why; a
  text or a failure lands only on the book opening, only while it opens.
- Another book, or the same one again, opens from anywhere; closing
  closes from anywhere.
- What comes for a book that isn't open, or is still opening (its
  pairing, its transcription, its export, a highlight), is dropped:
  work goes on after a book is closed.
- A turn by hand stops following the narrator; one the narrator made,
  or a scroll, doesn't. A line a search found is marked until the reader
  moves on, whichever way.
- The export is one status: running, made or failed, never two at once.
- Before and after: the controller with the session as one status does
  with the reader what the old one did, on a library in memory (a book
  with its EPUB, an EPUB alone, one that can't be read), in every
  sequence of three of fifteen events (opening each, texts slow to load
  and arriving, closing, turning, following, the export made or failing,
  playing, pausing, a pairing fixed, a highlight) and 1,000 random ones
  of ten, and reaches every status of each (`reading-before-after.test.ts`).

### What's on screen (`core/screen.ts`)

- Each page shows from any other, and every page but Settings closes the
  full player as it opens.
- A book's page leads back to the bookcase when it was opened from there,
  or from a book's page that was; from anywhere else it doesn't.
- The full player opens on the drawer asked for, changes drawer only
  while open, and closes.
- A book's page whose book is gone, or a series' page whose series is,
  goes back to the library; any other page stays.
- One series dialog at a time: a scan never offers a series' setup over
  the dialog for making one, and opening either closes the other
  (`on-screen.test.ts`).
- A book deleted from the server while it's open to read stays until
  it's closed and the library shows, as one in the player or whose page
  shows does (`desktop-on-server.test.ts`).
- Before and after: the controller with the screen as one status shows
  what the old one did, page, book, series, way back, full player and
  drawer, and the reader over them, in every sequence of three of
  eighteen events and 1,000 random ones of ten
  (`screen-before-after.test.ts`).

### The library's lifecycle (`core/lifecycle.ts`)

- The phase is boot until the folders are known; then ready while any
  folder is open, loading while one opens and none is, and the first
  screen when none is either: no folders, or none that would open.
- A folder that failed at boot, picked again, opens and says no more
  that it couldn't, on the library or beside it in Settings.
- Removing the one folder that opened, with another that didn't still
  listed, goes back to the first screen.
- Removing a folder closes the reader, a book's details, the end of a
  book and a series' page that showed its books; resetting Ribbon's own
  folder closes the reader and stops the sleep timer
  (`library-lifecycle.test.ts`).
- A server that wants signing in again says so until it's signed in,
  though its folder is scanned meanwhile (`desktop-on-server.test.ts`).
- Before and after: from no folders, the books, the books and another
  that's missing, and only the missing one, the controller shows what the
  old one did, phase, error, folders and what each says, shelf, page,
  reader and a book's details, in every sequence of three of twelve
  events and 250 random ones of ten, but for those three fixes, each
  reached (`lifecycle-before-after.test.ts`).

### Transcribing on this machine (`core/transcriber.ts`)

- The open book is heard once at a time; asked again while it's heard,
  it's heard once more after, and only once.
- A server's worker waits when it has to, once however many reasons: a
  minute, doubling to half an hour, and from a minute again after a book
  is whole. Beginning work ends a wait.
- The computer is kept awake while the open book is heard or a server's
  books are worked on, never while the worker only waits; a reset stops
  all of it.
- The worker downloading a book to transcribe it, on a full disk, asks
  the person nothing and leaves a question they have open about room for
  their own download as it was; it says in a note that there wasn't room
  (`desktop-on-server.test.ts`).
- Resetting Ribbon's own folder stops transcribing for the server: what
  was being heard isn't sent, nothing more is asked, and the computer may
  sleep again (`desktop-on-server.test.ts`).
- Before and after: with a speech model whose answers the test holds,
  the controller asks the model what the old one did (every call, its
  clips, gently while a book plays), keeps the computer awake alike, and
  shows the same reader, progress, read-along, notes and top bar, in
  every sequence of three of ten events and 500 random ones of ten
  (`transcribing-before-after.test.ts`).

### A listen-through, written (`core/listen-through.ts`)

- Where a book stands is its latest listen-through: none, going or
  finished.
- Every event has an answer in every status: playing opens one only when
  there's none; starting again always opens a new one; finishing closes
  the one going, or writes one begun when the book was first heard, and
  leaves a finished one as it is; unfinishing opens the latest again.
- Before and after: what the server's `/listened`, `/finished` and
  `/unfinished` wrote, line for line, and the function write the same
  record in every sequence of seven events
  (`server/test/listen-through-before-after.test.ts`).

### Loudness (`core/loudness.ts`)

- Parses `I: -23.4 LUFS` and `Peak: -1.2 dBFS` from ebur128 summary.
- Gain for measured minus 23.4 with target minus 18 is plus 5.4 dB.
- Gain is clamped to plus or minus 12 dB.
- Gain is reduced so true peak plus gain never exceeds minus 1 dBTP.
- Missing measurement yields gain 0, not an exception.
- Decibels to linear: 0 dB is 1.0, plus 6.02 dB is 2.0 within 0.001.

### Silence (`core/silence.ts`)

- Parses `silence_start` and `silence_end` pairs into ranges.
- An unterminated `silence_start` at end of file closes at file end.
- Ranges shorter than the threshold are dropped.
- Given a range and a target gap of 300 ms, the rate multiplier is
  `range_length / 300`, capped at 8.
- Position lookup: inside a range returns the range, outside returns
  none, boundaries are inclusive start and exclusive end.

### Position file (`core/position.ts`)

- Round-trips through CSV with all four fields.
- `updated_at` is ISO 8601 with milliseconds and a `Z`.
- Merge of two rows keeps the later `updated_at`.
- Merge tie on `updated_at` picks the lexically greater device name.
- Merge ignores rows for a different book id.
- Merge of zero rows yields offset 0.
- A malformed row is skipped and reported, never fatal.
- Writing is atomic: temp file then rename.

### Bookmarks (`core/bookmarks.ts`)

- Round-trips through CSV including a note with commas, quotes, and
  newlines.
- Clip range for offset 10 000 is 0 to 10 000, not negative.
- Clip range for offset 100 000 is 70 000 to 100 000.
- Clip filename is `<book>-<offset>.opus` and is unique per offset.
- Bookmarks are listed in offset order.

### Library records (`core/records.ts`)

- `library.csv` and `files.csv` round-trip every field.
- Numeric fields are written as integers and parsed back as numbers.
- A book whose files have changed size or mtime is marked stale.
- A book whose files are unchanged is not re-probed.

### A book's folder on the server (`server/library/book-folder.ts`)

Against a real server, with the work that would be under way held at a
gate (ffmpeg, the EPUB tool), so two things happen in a known order
(`book-folder.test.ts`):

- A transcript sent while the book is measured, or filled in from its
  EPUB, is kept: the book's record lists it and says how it was placed,
  and the book reads along by sentence.
- A book deleted while its transcript was placed gets nothing written into
  its folder: the transcript is refused (404), no folder is left, and
  adding its folder again brings it back.
- A book deleted while its read-along was made isn't found by its words.
- A book whose record lost its transcript from its list, as a job writing
  back an older copy left it, reads along again once the server starts.

### Invites (`server/invites.ts`)

- A code held by a sign-up isn't given to anyone else however long the
  sign-up takes, through the server too; it's spent once, by the sign-up
  that held it, and never without a hold (`invites.test.ts`).
- Given back, it's good again; a spent one stays spent; one held when the
  server stopped is good again when it starts; past its days it's
  expired, but a sign-up that held it in time still spends it.
- Before and after: the new invites answer as the old did in every
  sequence of six events, but for three differences, each reached: time
  doesn't let a hold go, a restart does, and only a held code is spent
  (`invites-before-after.test.ts`).

### The job queue (`server/jobs.ts`)

- A job whose start the database won't note is failed, and the jobs after
  it in its lane still run; a report after a job ended changes nothing; a
  job under way when the server stopped is failed when it starts
  (`jobs.test.ts`).
- Before and after: every job's row is the same in the old queue and the
  new in every sequence of five events, but that a finished job never
  moves again (`jobs-before-after.test.ts`).

## Fixture cases

`packages/desktop/tools/make-fixtures.ts` builds these with ffmpeg:

1. `single-m4b/book.m4b`: one file, three embedded chapters, cover,
   full tags including series.
2. `multi-mp3/`: five MP3 files named `01.mp3` to `05.mp3` with track
   tags out of order relative to filenames, so tag order wins.
3. `multi-m4a-natural/`: files `Chapter 1` to `Chapter 12` with no
   track tags, so natural sort wins.
4. `loose.mp3`: a file at the fixture root with no folder.
5. `quiet/` and `loud/`: same tone at minus 30 and minus 10 LUFS to
   prove normalization brings them within 1 LU of each other.
6. `gaps/`: one file with three silences of 2, 3, and 5 seconds.
7. `opus/` and `flac/`: one file each to prove probe handles them.
8. `nested/Series/Book One/` and `nested/Series/Book Two/`.

Scan tests assert the exact book count, order, titles, chapter counts,
and durations for every fixture.

## Real library cases

Run with `RIBBON_BOOKS=books`. Asserts against the user's folder:

- Exactly two books found.
- `Horus Rising` has 22 files ordered 1 to 22 by track tag, title
  `Horus Rising`, author `Dan Abnett`, cover from `cover.jpg`.
- Its 22 inferred chapters are named `Chapter 1` to `Chapter 22`.
- `EgoIstheEnemy_ep6.mp3` is a one-file book with duration near
  24 977 946 ms and an embedded PNG cover.

## Rust cases

Run with `cargo test --release` in `packages/desktop/src-tauri`.

- The walk skips `.ribbon` and hidden entries and classifies audio and
  image files by extension.
- Probing `Horus Rising/Chapter 10.m4a` yields the title, artist,
  album, track `10`, a duration over one second, and an attached
  picture, all from the `ilst` atom.
- Probing the seven-hour MP3 yields a duration over an hour, a title,
  and an attached picture, from ID3v2.
- When `E:\CODE\odio-bench` exists (1,000 hard-linked books, 23,000
  files), the test prints walk and probe timings. Target: under five
  seconds warm for the full probe.
- Reading a path outside the library scope is rejected.
- ffprobe spawn with a missing binary returns a typed error.
- The asset protocol serves a range request with the right
  `Content-Range`.

## Load-path cases (`core/scan/scan.ts`, `app/controller.ts`)

- A library with records paints from `library.csv` and `files.csv`
  before any audio file is touched.
- Positions for every book come from one `readTextDir` call.
- A rescan behind a visible library preserves the open book's live
  chapter list.
- The ffprobe reference scanner returns files in walk order regardless
  of which probe finished first.
- `ensureChapters` is a no-op when every file is marked probed, probes
  only unprobed files otherwise, persists the `probed` flag, and the
  result survives `loadLibrary`.
- Files the scanner could not read are reported as errors, not books.

## Before and after

When something that works is rewritten without meaning to change what it
does (a state machine written down, say), passing tests show only what
they test. So the old code is kept beside the tests (`test/before/`), and
the old and the new are run together through every sequence of events up
to a length, and many longer ones at random but the same each run, and
compared after every step on everything anyone could see: what was shown,
what was done to the audio, what was written to the log. The differences
the rewrite means to make are listed in the test, each reached at least
once so the walk is known to get that far, and any other fails it. This
is the real code against the real code, not a model of it; when either
is changed on purpose, the old copy and its test go.

## Manual checklist before pinging the user

- [ ] App opens, library folder picker works, scan shows both books.
- [ ] Play, pause, seek in `Horus Rising` crosses file 1 to file 2
      with no audible gap.
- [ ] Pause for 15 seconds, play: audio rewinds by 2 seconds.
- [ ] Speed 1.5x sounds pitch-correct. Time remaining updates.
- [ ] Quit the app mid-book, reopen: it resumes where it was.
- [ ] Position file exists at `.ribbon/positions/<id>.csv` and is
      readable in a text editor.
- [ ] Media keys play and pause. Windows media overlay shows title and
      cover.
- [ ] Sleep timer for one minute fades and stops.
- [ ] Bookmark saves and shows in the list with a note.

## Considered and not used

### Formal verification with TLA+ (November 2026)

TLA+ writes a protocol down as a state machine, and its model checker
(TLC) tries every order of the steps, looking for one that breaks a
stated rule. It was looked at for the position log's merge, adopting a
place from another device, book edits on the server and whole-book
transcription, and left out:

- It checks a model of the design written by hand, not Ribbon's code.
  Only more tests tie the two together.
- Of Ribbon's costly bugs, one was its kind: 0.22.2's edits sync, which
  lost a rename made on another device. The rest were layout (the
  0.12.0 resize), the platform (MP3 seeks, WebKit suspending hidden
  pages), speed (IPC, the share) and the speech model (whisper loops).
- The sync leaves that kind little room: each device writes only its
  own log, edits are last-wins per field, and the server stores what
  it's sent.
- A spec in a notation nobody here reads fluently is a spec nobody
  reviews.

If the merge rules need checking beyond their unit tests, property
tests on the real code come first (fast-check against `mergePlace`).
Look again only when a design needs devices to coordinate, such as two
machines sharing out work, and "what if this happens while that does"
can't be settled on paper.
