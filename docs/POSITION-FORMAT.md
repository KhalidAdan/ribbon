# The Ribbon position log

**Version 1.1. A file format for keeping your place in a book, which any
player, reader or read-along app can read and write.** Version 1.1 adds
places in text editions (section 3.6); everything written by version 1
is still version 1.1.

Your place in a book belongs to you, not to an app or a server. This
format stores it as plain files beside the books. Any file sync you
already run (Syncthing, Dropbox, iCloud Drive, OneDrive, a network share)
carries it between your devices. It is designed so that dumb file sync
can never lose a position or produce a conflict. It also lets other
apps join in without anyone coordinating with anyone.

This document is the specification. Ribbon is one implementation; the
reference code is `src/core/poslog.ts`. The words MUST, SHOULD and MAY
are used as in RFC 2119.

## 1. Why another format

No existing standard fits. Research (October 2026) covered Readium
Locators, OPDS Progression, the W3C Audiobooks and Web Annotation
recommendations, Media Fragments, EPUB CFI and Media Overlays,
KOReader's kosync, Storyteller, Audiobookshelf, Calibre, Hardcover and
the closed players. Every format that syncs positions assumes a server
that arbitrates conflicts. Every format that works offline has no
merge rules. None carries finished dates, history and bookmarks
together.

So this format reuses the pieces that are right and adds only what is
missing:

| Need                    | Reused from                                      |
| ----------------------- | ------------------------------------------------ |
| Where in the book       | Readium Locator (`href`, `locations`, `text`)    |
| Time in a file          | Media Fragments `t=` (W3C)                       |
| Device fields           | OPDS Progression (`device.id` as a URI, `name`)  |
| Bookmarks and notes     | W3C Web Annotation (`motivation`, selectors)     |
| Book identity           | URN identifiers (`urn:isbn:`, `urn:asin:`, …)    |
| Merge                   | New here: single-writer logs                     |

## 2. Files

```
<library>/.ribbon/positions/
  <device>.ndjson        one device's log; ONLY that device writes it
  <device>.json          who the device is
  <book-id>.csv          legacy: one position per book (Ribbon 0.4 and earlier)
```

`<device>` is the device's identifier without its `urn:uuid:` prefix.
For example: `5f0c2a1e-…-9b3d.ndjson`.

**Single writer.** A device MUST write only its own `.ndjson` and
`.json` files. It MUST NOT modify another device's files. Because no two
devices ever write the same file, file sync cannot produce a conflict:
there is nothing to conflict over.

**Append only.** A device appends records to its log, one JSON object
per line, terminated by `\n`, encoded as UTF-8. An interrupted append or
an interrupted sync can leave the last line incomplete. Readers MUST
ignore any line that does not parse, and MUST NOT treat it as an error.

**The device file** says who wrote the log:

```json
{ "id": "urn:uuid:5f0c2a1e-…", "name": "Desktop", "app": "ribbon/0.5.0", "format": "ribbon-position-log/1" }
```

`name` is for people and MAY be empty. `id` MUST be a random UUID made
once per installation. It MUST NOT be derived from hardware, the user or
the hostname.

**Compaction.** A log only grows. Its owner MAY rewrite it to remove
`pos` records that a later `pos` for the same book has superseded. It
MUST keep every other record. It MUST write the new file beside the old
one and rename it into place, so a reader never sees a half-written log.
Ribbon compacts a log when it passes 256 KB.

## 3. Records

Every record carries these fields:

| Field  | Type    | Meaning                                                              |
| ------ | ------- | -------------------------------------------------------------------- |
| `v`    | integer | Format version. `1`.                                                 |
| `k`    | string  | Kind: `pos`, `read`, `session`, `mark`, `del`.                       |
| `dev`  | string  | The writing device, `urn:uuid:…`.                                    |
| `seq`  | integer | Increases with every record a device writes, never repeats.         |
| `t`    | string  | When, as ISO 8601 UTC with milliseconds: `2026-10-18T21:04:03.211Z`. |
| `book` | object  | Which book (section 4).                                              |
| `x`    | object  | OPTIONAL. Extension fields, keyed by a reverse domain or a URI.      |

Readers MUST ignore fields and kinds they do not understand. A device
compacting its own log MUST keep them.

### 3.1 `pos`: where you are

```json
{"v":1,"k":"pos","dev":"urn:uuid:5f0c…","seq":1760821443211,"t":"2026-10-18T21:04:03.211Z",
 "book":{"ids":["urn:ribbon:e26d80dc","urn:asin:B00CGH53PY"],"dur_ms":44104585},
 "why":"pause","ms":15834000,
 "loc":{"href":"Horus Rising/Chapter 05.m4a","type":"audio/mp4",
        "locations":{"fragments":["t=1033.12"],"progression":0.437,"totalProgression":0.359,"position":5}}}
```

| Field  | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| `ms`   | Milliseconds from the start of the book as the writer has it. The canonical place. Left out for a text edition (section 3.6). |
| `why`  | What made the write (below).                                                     |
| `loc`  | OPTIONAL. A Readium Locator for the same place.                                  |

A locator lets an app that thinks in files or text find the place. For
audio, `href` is the file, library-relative. `locations.fragments` holds
a Media Fragment `t=` in decimal seconds within that file.
`progression` is within the file and `totalProgression` is within the
book. A reader or read-along app MAY add `text.before`, `text.highlight`
and `text.after`, which locate the place by its words in any edition.

`why` is one of these:

- `pause`: the listener paused or stopped.
- `seek`: the listener moved deliberately (scrubbing, skipping, a chapter, a bookmark).
- `periodic`: written while playing, to keep the place.
- `end`: the book reached its end.
- `close`: the app was closing or going to the background.
- `open`: written on opening a book, before the listener did anything.
- `import`: carried over from another format.
- `remote`: adopted from another device's record (section 5).

### 3.2 `read`: a listen-through

Each time someone starts a book from the beginning, they begin a new
read. Finishing it closes the read. Starting again opens another, so a
re-listen never erases the first.

```json
{"v":1,"k":"read","dev":"urn:uuid:5f0c…","seq":…,"t":"…","book":{…},
 "id":"urn:uuid:0d1e…","started":"2026-09-01T19:00:00.000Z","finished":"2026-10-02T22:41:10.000Z"}
```

A `read` with the same `id` written later replaces the earlier one. That
is how a finish date is added or corrected. `finished` is absent while
the read is open. `started` and `finished` MAY be edited by hand.

### 3.3 `session`: what was listened to

OPTIONAL. Readers MUST NOT depend on sessions. A writer MUST let the
listener turn them off.

```json
{"v":1,"k":"session","dev":"…","seq":…,"t":"…","book":{…},
 "start":"2026-10-18T20:31:07.000Z","end":"2026-10-18T21:04:03.000Z","from_ms":14012000,"to_ms":15834000,"listened_ms":1958000,"speed":1.25}
```

`listened_ms` is wall-clock time spent listening. At a speed above 1 it
is less than `to_ms - from_ms`.

### 3.4 `mark`: bookmarks, notes and highlights

A W3C Web Annotation, kept compact. `id` is stable. `motivation` is
`bookmarking`, `commenting` or `highlighting`.

```json
{"v":1,"k":"mark","dev":"…","seq":…,"t":"…","book":{…},
 "id":"urn:uuid:7a2b…","motivation":"bookmarking","created":"…","modified":"…",
 "target":{"ms":15834000,"selector":{"type":"FragmentSelector","conformsTo":"http://www.w3.org/TR/media-frags/","value":"t=15804,15834"}},
 "body":"The Warmaster's first doubt"}
```

### 3.5 `del`: taking something back

```json
{"v":1,"k":"del","dev":"…","seq":…,"t":"…","book":{…},"of":"urn:uuid:7a2b…"}
```

This removes the `mark` or `read` with that `id`, as of `t`. A record
with the same `id` written after `t` brings it back.

### 3.6 Places in a text (1.1)

A reader keeps its place in a text edition, such as an EPUB, as a `pos`
record without `ms`. Its `loc` is REQUIRED, and is a Readium Locator
into the text:

```json
{"v":1,"k":"pos","dev":"urn:uuid:5f0c…","seq":1760830000000,"t":"2026-10-18T23:46:40.000Z",
 "book":{"ids":["urn:ribbon:aec8d2c8-text","urn:isbn:9781836093152","urn:uuid:9c3e2701-97e8-4a84-8845-fac671bbf378"]},
 "why":"close",
 "loc":{"href":"OEBPS/08-40k-Content-6.xhtml","type":"application/xhtml+xml",
        "locations":{"progression":0.1068,"totalProgression":0.1338,"fragments":["_idTextAnchor009"]},
        "text":{"before":"break out on his ship due to ","highlight":"misunderstandings."}}}
```

- `href` is the content document, as a path from the root of the EPUB.
- `progression` is how far through that document the place is, and
  `totalProgression` how far through the book, both by characters of
  text, counting only the reading order.
- `fragments` MAY name the nearest element id at or before the place.
- `text` SHOULD quote the words at the place. A reader finds a place by
  its words first, nearest the progression given, then by progression
  alone, so a place survives another text size, window or layout.

The claims name the text edition (section 4): the EPUB's own ISBN and
`urn:uuid:` identifier, and for Ribbon `urn:ribbon:<book>-text`. They
never include the audiobook's claims: a text and its narration are two
editions, each with its own place. Places in a text merge exactly as
places in audio do (section 5), with records of the same edition only.
A fresh start is a `totalProgression` of 0 with a `why` of `open`,
`periodic` or `import`.

A reader of version 1 skips a `pos` record without `ms` as one it does
not understand, and a device compacting its own log keeps the latest
`pos` for each set of claims, so text and audio places never displace
each other.

## 4. Which book

`book.ids` is a set of **claims**. Each claim is a URN that names the
book:

| Claim                    | Meaning                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `urn:ribbon:<id>`        | Ribbon's id: CRC-32 of the library-relative path and total size.        |
| `urn:isbn:<13 digits>`   | The edition's ISBN.                                                     |
| `urn:asin:<asin>`        | Audible's ASIN.                                                         |
| `urn:uuid:<uuid>`        | An identifier the book carries itself (an EPUB's `dc:identifier`).      |
| `urn:kosync:<md5>`       | KOReader's partial-MD5 of the file, for apps that bridge to kosync.     |

Two records are about the same book if they share any claim. A writer
SHOULD put every claim it knows on every record. That is how a phone app
that knows only the ASIN can find the place a desktop player wrote. A
claim names an edition, and a different narration is a different
edition. Mapping a place between editions or between text and audio is
outside this version (section 7).

`book.dur_ms` is the length of the edition the writer played. It is used
to sanity-check a match, never to identify a book.

Titles and paths are deliberately absent from `book`. The log says where
you were, not what you read, to anyone who can read the folder.

## 5. Merging

To find the place in a book, a reader:

1. Reads every `*.ndjson` in `positions/`, ignoring lines that do not parse.
2. Keeps the `pos` records whose claims match the book.
3. Within each device, takes the record with the highest `seq`. A
   device's own order is its `seq`, whatever its clock said.
4. Across devices, takes the record with the latest `t`.
   - A `t` more than 5 minutes ahead of the reader's own clock comes
     from a clock that runs fast. It counts as written 5 minutes ago. It
     still beats older records, but never one written lately by a clock
     that is right.
   - On a tie, the greater `dev` string wins, so every reader picks the
     same record.
5. **A fresh start never wins.** A record with `ms` of 0 and a `why` of
   `open`, `periodic` or `import` loses to any record with `ms` above 0.
   An app that opened a book and wrote its starting place must not reset
   another device's progress.

The result is the place. It MAY be earlier than another record's place:
a deliberate rewind is a real place. An app that wants "the furthest
point reached" SHOULD derive it separately and MUST NOT use it to
resolve the place.

**A newer place from elsewhere.** If the merged place came from another
device and differs from where this device has the book paused, the app
SHOULD move there before the listener presses play. Ribbon does. An app
that is playing when it notices MAY ask the listener instead.

**Writing after adopting.** When an app moves to another device's
place, it MAY write a `pos` with `why` of `remote`. It MUST NOT give
that record a `t` earlier than the record it adopted.

**Reads and marks** are the union of all devices' records. The latest
`t` wins per `id`, and `del` records remove.

**Legacy files.** Readers SHOULD also read `<book-id>.csv` files, which
have columns `book_id,offset_ms,updated_at,device`. They are read as
`pos` records with `why` of `import`. Each file counts as a device of
its own, named by its `device` column and file name. Ribbon 0.5 still
writes these beside the log, so earlier versions on other machines keep
working. A later version will stop.

## 6. Privacy

- The device identifier is random and the device name may be blank.
- The log carries no titles, authors or paths in `book`. The `loc.href`
  of an audio file is library-relative, and writers MAY leave it out.
- Sessions are optional and can be turned off. Turning them off SHOULD
  stop new `session` records. Deleting one's own log removes one's
  history from the folder.

## 7. Not in version 1.1

- **Mapping between editions, and between text and audio.** Version 1.1
  records what the writer knows, `text` anchors included when it has
  them. A future version may record how a place was mapped (a Media
  Overlay, a transcript match, chapter and progression, or proportion)
  so that an approximate mapping never overwrites an exact one.
- **Alignment data** (EPUB Media Overlays, sentence timelines) is
  referenced through identity claims, not carried.

## 8. Ribbon's implementation

- Positions are kept on the machine first: in the Ribbon folder's local
  mirror, flushed to disk. They reach the log beside the books within
  fifteen seconds while playing, and at once on a pause, a seek or a
  close. A share that is away gets them when it is back.
- The device identifier is made once and kept in the Ribbon folder's
  `settings.json`.
- Reading places are kept on the machine first too, in `settings.json`
  as the reader moves. They reach the log five seconds after the reader
  settles on a page, and at once on a jump (the contents, a link) or on
  closing the book.
- `read` records start and finish listen-throughs. Sessions are on by
  default and can be turned off in Settings.
- Bookmarks are `mark` records with a `motivation` of `bookmarking`.
  Adding one writes a `mark`, editing its note writes it again with a
  later `modified`, and deleting it writes a `del`. The `body` is the
  note, and the selector is the thirty seconds before `target.ms`.
- A bookmark's `id` is a version 8 UUID made from the Ribbon book id and
  the offset, so the same place in the same book has the same id on
  every device.
- Each bookmark keeps a 30-second Opus clip in `bookmarks/clips/`, named
  `<book-id>-<offset_ms>.opus`. A `mark` names its clip in
  `x["urn:ribbon:clip"]`, relative to `bookmarks/`.
- Ribbon 0.5 still writes `bookmarks/<book-id>.csv` (columns
  `book_id,offset_ms,created_at,note,clip`) after every change, so
  Ribbon 0.4 on other machines keeps working. Readers merge its rows
  into the marks as `mark` records of a device of their own, written at
  `created_at`, with the id above. A note edited or a bookmark deleted
  later wins over the row. A bookmark that Ribbon 0.4 deletes leaves the
  CSV but stays in the log.
