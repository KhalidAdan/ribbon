# Ribbon

**A home for your books, read or heard.**

Local files. One place in every book. Nothing in the cloud.

---

## What this is

A reader and a player for the books you own, as files: the EPUB and the
audiobook, alone or side by side. It reads the EPUB on a page as well
typeset as any reader's, plays the M4B, MP3, Opus and FLAC you already
have, and keeps your place in every book forever, whether you were reading
or listening. That place moves between your devices through your own
server, or as a file in a folder you sync, never through someone else's
service.

Text is a first-class citizen, not a feature bolted onto a player. A book
you only have as an EPUB is a book like any other. A book you have both
ways is one book: read on the train, put the headphones on to walk home,
read again in bed, and it is always where you left off, with the sentence
being narrated marked on the page when you want it.

It exists because every audiobook app and every ebook reader feels the
same, and none of them treats the two editions of one book as one book.
The difference between "fine" and "I would never switch" lives in a dozen
small behaviours that nobody bothers to get right: resume, speed, loudness,
sleep, a page that turns the moment you ask, a book that opens where you
were before you notice it opening. And in one big one: your place belongs
to you, not to a store.

## What it refuses to be

**Not a DRM client.** Ribbon never opens an AAX file or an EPUB locked with
DRM. Removing DRM from what you bought is a personal decision made with
existing tools, outside this product. Shipping it would put the whole
project under the DMCA anti-trafficking clause and tie it to key schemes
that change whenever their owners like. The line is simple: if the audio
plays in ffmpeg without a key and the EPUB opens without one, it is yours
to read and hear here.

**Not a store, not a social network.** No catalogue, no recommendations, no
friends. The library is your books, in your folders or on your own server.

**Not someone else's service.** Your own server, your own people, nothing in
the cloud. Ribbon runs on a machine you choose, for the people you invite
([SERVER.md](SERVER.md)). No store, no tracking, no one else's service.

**Not two apps.** A book you own as audio and as an EPUB is one book with one
place, and reading it is as much the product as hearing it. Not a reader
for every format: EPUBs without DRM, the way the audio is files without DRM.

## Principles

**Your place is yours.** Every book keeps your place in a small log: where
you were reading, where you were listening, when, on which device. The
newest wins. In a folder, the log is files beside the book, and any sync
moves them like any other file. On a server, each person's log is kept in
the server's database, and comes back as a file in the same format whenever
they ask for it. Either way it's readable, theirs to take away, and it
survives the app being uninstalled.

**Folders still work.** Ribbon without a server is the app it was: your
books in a folder, your place beside them, nothing to sign in to.

**One place, two editions.** Reading and listening each keep their own exact
place. Switching maps one onto the other: first by chapter and how far
through it, then exactly, from the publisher's read-along data or from
Ribbon's own alignment of the narration to the text. An approximate mapping
never overwrites an exact place.

**The page is the product too.** Ribbon lays out every line itself, in its
own type, so it knows where every word is on every page: pages, scrolling,
an exact place and a highlighted sentence are one problem. Pages follow a
finger and turn the moment they are asked; the whole book scrolls without a
hitch; a book opens to your page before you notice it opening; resizing the
window never loses the text.

**Resume is the product.** The moment you press play after a pause is where
audiobook apps win or lose. Rewind scaled to how long you were gone. Two
seconds after ten seconds, thirty after a night, and an offer to replay the
chapter start after a week.

**Never touch the volume knob.** Narrators vary by ten decibels. Every book
plays back at the same loudness, from a one-time scan. You should not know
this feature exists.

**Speed without artefacts.** Per-book speed, pitch-corrected. Silence
trimming shortens gaps rather than deleting them, so two-times never sounds
like a robot. Time remaining is always shown at the current speed.

**Chapters are real and editable.** M4B markers when present, inferred from
file boundaries for multi-file books, and correctable by hand when the
publisher got them wrong. Corrections live beside the book as a file.

**The story is more important than the timer.** Sleep timer ends at a
chapter, fades rather than cuts, and extends with a tap or a shake.

**Platform plumbing is table stakes, not a feature.** Lock screen controls,
headphone buttons, background audio, sample-accurate seeking, and a reader
that is fast on a slow phone must be flawless before anything above is
worth doing. Checked before every release, in the built app
([RELEASING.md](RELEASING.md)).

**Culvert is the plumbing.** Library scanning, import pipelines, loudness
scans, and sync map files are streams and CSV. Ribbon does not reinvent
them.

## Version one

One app, one platform (the desktop), one library of folders. Shipped, as of
0.12:

- **The library.** Folders of books, scanned fast, with cover art and series;
  audiobooks, EPUBs, and the two paired as one book.
- **Listening.** Gapless playback across multi-file books; scaled resume
  rewind; per-book speed with pitch correction and silence trimming; even
  loudness; chapters inferred and corrected by hand; a sleep timer that ends
  at a chapter and fades; bookmarks that keep the last thirty seconds of
  audio and a note; lock screen, headphone and background audio.
- **Reading.** The EPUB typeset by Ribbon, in pages or one long scroll;
  swipes, keys and clicks to turn; highlights kept as bookmarks; opening to
  the page you left at once.
- **Both.** One place across reading and listening; read-along, the sentence
  being narrated marked and the page turning with the narrator, from the
  narration transcribed on this machine; and a read-along EPUB to take to
  any reader that plays Media Overlays.
- **Position files** beside the books, synced by the existing engine.

## What comes next

**The phone.** The picture of success below has three places in it, and
version one is one of them. Ribbon on iOS (16.4 and later) and Android, with
the books downloaded to the device from your server, its place moving with
you. The plan and what stands in its way are in [MAC.md](MAC.md).

**The server.** A phone can't prepare a book (no ffmpeg, no transcribing), a
network share won't always take its writes, the Apple TV needs something to
talk to, and the people you share books with need places of their own.
Ribbon's own server prepares each book once, keeps each person's place in
its database, and gives every device the finished book. It runs on a machine you choose, for
the people you invite. The design is in [SERVER.md](SERVER.md).

**On the radar, not committed:**

- **Search inside a book, and looking up a word.** What any good reader does.
- **Transcript search.** Whisper already runs for read-along, so a
  library-wide "where did they say that" search falls out of it.
- **Reading in the stats.** Time per book, per week, per narrator is kept for
  listening; reading should count too. Local only.

Nothing above gets added until version one is boringly reliable.

## What success looks like

You put on your headphones in the car. The book starts where you left it in
the kitchen, rewinds just enough that you catch the sentence you were in the
middle of, at the speed you chose for this narrator, at the same volume as
the last book. At night you open the book instead, and it is on the page
where the narrator stopped, the page under your thumb before you have
finished reaching for it. You never opened the app to make any of that
happen. You have not thought about where the files are in months.

The app disappears. The book is what is left.
