# Odio test plan

The North Star says the difference between "fine" and "I would never
switch" lives in a dozen small behaviours. Every one of those
behaviours is a pure function in `src/core` with a table of cases
here. If a behaviour is not in this file, it is not done.

## Layers

| Layer          | Tool                    | Runs where          | What it proves                      |
| -------------- | ----------------------- | ------------------- | ----------------------------------- |
| Unit           | Vitest                  | `npm test`          | Every decision in `src/core`.       |
| Fixture        | Vitest + ffmpeg         | `npm test`          | Scan and probe against real codecs. |
| Real library   | Vitest, opt-in          | `ODIO_BOOKS=books npm test` | The user's actual files.    |
| Rust           | `cargo test`            | `npm run test:rust` | Tauri commands and path scoping.    |
| Manual         | Checklist below         | The app             | Audio, keys, lock screen.           |

Fixtures are generated into `test/fixtures/generated/` by
`tools/make-fixtures.ts` using ffmpeg's `sine` and `anullsrc` sources.
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
- Hidden files and the `.odio` folder are skipped.

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
- Speed changes do not change wall-clock duration mode but do change
  the wall-clock time an end-of-chapter timer fires.

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

## Fixture cases

`tools/make-fixtures.ts` builds these with ffmpeg:

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

Run with `ODIO_BOOKS=books`. Asserts against the user's folder:

- Exactly two books found.
- `Horus Rising` has 22 files ordered 1 to 22 by track tag, title
  `Horus Rising`, author `Dan Abnett`, cover from `cover.jpg`.
- Its 22 inferred chapters are named `Chapter 1` to `Chapter 22`.
- `EgoIstheEnemy_ep6.mp3` is a one-file book with duration near
  24 977 946 ms and an embedded PNG cover.

## Rust cases

- Reading a path outside the library scope is rejected.
- ffprobe spawn with a missing binary returns a typed error.
- The asset protocol serves a range request with the right
  `Content-Range`.

## Manual checklist before pinging the user

- [ ] App opens, library folder picker works, scan shows both books.
- [ ] Play, pause, seek in `Horus Rising` crosses file 1 to file 2
      with no audible gap.
- [ ] Pause for 15 seconds, play: audio rewinds by 2 seconds.
- [ ] Speed 1.5x sounds pitch-correct. Time remaining updates.
- [ ] Quit the app mid-book, reopen: it resumes where it was.
- [ ] Position file exists at `.odio/positions/<id>.csv` and is
      readable in a text editor.
- [ ] Media keys play and pause. Windows media overlay shows title and
      cover.
- [ ] Sleep timer for one minute fades and stops.
- [ ] Bookmark saves and shows in the list with a note.
