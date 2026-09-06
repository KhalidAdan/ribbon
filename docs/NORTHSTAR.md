# Audiobook Player (working title)

**The listener for books you own.**

Local files. Local position. Nothing to sign in to.

---

## What this is

An audiobook player that treats your files as the source of truth. It plays
the M4B, MP3, Opus, and FLAC you already have, remembers exactly where you
were in every book forever, and moves that position between your devices as
a file rather than through a service.

It exists because every audiobook app feels the same. They all stop at play,
pause, and chapters. The difference between "fine" and "I would never switch"
lives in a dozen small behaviours around resume, speed, loudness, and sleep
that nobody bothers to get right, and in one big one: your listening position
belongs to you, not to a store.

## What it refuses to be

**Not a DRM client.** The player never opens an AAX file. Decrypting Audible
purchases is a personal decision made with existing tools, outside this
product. Shipping the decryption would put the whole project under the
DMCA anti-trafficking clause and tie it to Audible's key scheme, which changes
whenever they like. The line is simple: if the file plays in ffmpeg without a
key, it plays here.

**Not a store, not a social network.** No catalogue, no recommendations, no
friends. The library is the folder.

**Not a server.** Version one talks to the filesystem and to a sync folder.
Server-backed libraries are a client story for version two, not a reason to
run a daemon.

**Not a reader.** Read-listen sync is on the radar, but the player stays a
player. The reading side is a separate product that shares a position format.

## Principles

**Position is a file.** Every book has one small position file: book id,
offset, timestamp, device. Last write wins. The existing sync engine moves it
like any other file. No account, no server, and it survives the app being
uninstalled.

**Resume is the product.** The moment you press play after a pause is where
audiobook apps win or lose. Rewind scaled to how long you were gone. Two
seconds after ten seconds, thirty after a night, and an offer to replay the
chapter start after a week.

**Never touch the volume knob.** Narrators vary by ten decibels. Every book
gets a one-time loudness scan on import and plays back normalized. The user
should not know this feature exists.

**Speed without artefacts.** Per-book speed, pitch-corrected. Silence
trimming shortens gaps rather than deleting them, so two-times never sounds
like a robot. Time remaining is always shown at the current speed.

**Chapters are real and editable.** M4B markers when present, inferred from
file boundaries for multi-file books, and correctable by hand when the
publisher got them wrong. Corrections live beside the book as a file.

**The story is more important than the timer.** Sleep timer ends at a
chapter, fades rather than cuts, and extends with a tap or a shake.

**Platform plumbing is table stakes, not a feature.** Lock screen controls,
headphone buttons, background audio, and sample-accurate seeking in AAC must
be flawless before anything above is worth doing.

**Culvert is the plumbing.** Library scanning, import pipelines, loudness
scans, and sync map files are streams and CSV. The player does not reinvent
them.

## What we ship first

One player, one platform, one library folder. It must nail:

- Library scan of a folder tree with cover art and series ordering from tags
- Gapless playback across multi-file books
- Position file per book, synced by the existing engine
- Scaled resume rewind
- Per-book speed with pitch correction and silence trimming
- Loudness normalization on import
- Chapter navigation, inferred chapters, hand corrections
- Sleep timer with end-of-chapter and fade
- Bookmarks that keep the last thirty seconds of audio plus a note
- Lock screen, headphone, and background audio integration

The player currently living inside the sync engine is the seed. It gets
extracted, not extended in place, so the sync engine goes back to being a
sync engine.

## What comes next

**Version two: the best Audiobookshelf client.** Audiobookshelf is already
the de facto self-hosted audiobook server with a client API. Rather than
build another server, become the client people choose. The position file
model stays for people without a server; Audiobookshelf becomes a second
library source with its own progress sync.

**On the radar, not committed:**

- **Read-listen position sync.** A forced-alignment pipeline from M4B and
  EPUB to an EPUB 3 Media Overlay, so one position carries across reading and
  listening. Storyteller already does the alignment; the product work is the
  shared position format.
- **Transcript search.** If whisper is already running for alignment, a
  library-wide "where did they say that" search falls out of it.
- **Listening stats.** Time per book, per week, per narrator. Local only.

Nothing above gets added until the version one list is boringly reliable.

## What success looks like

You put on your headphones in the car. The book starts where you left it in
the kitchen, rewinds just enough that you catch the sentence you were in the
middle of, at the speed you chose for this narrator, at the same volume as
the last book. You never opened the app to make any of that happen. You have
not thought about where the files are in months.

The app disappears. The book is what is left.
