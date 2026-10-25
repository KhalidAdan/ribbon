# Ribbon server

The books, and each person's place in them, for the people you invite. The
design is [docs/SERVER.md](../docs/SERVER.md); this is how to run it.

Built so far:

- **Accounts.** People sign in with a name and a password (Better Auth), and
  the admin invites them.
- **Adding a folder.** The admin points the server at a folder on its
  machine (in Ribbon, Settings → Add a folder, as the admin); it copies in
  each book it doesn't have yet, reads its chapters, makes its covers, and
  measures its loudness and silences once. What Ribbon already worked out
  beside a book in the folder's `.ribbon/` (chapters, corrections, what was
  heard of the narration and how it lines up with the text) comes in with
  it, and adding the folder again fills in what a book already here is
  missing. The folder is only ever read.
- **Filling in what a book came without**, from its own EPUB, after it's
  added: its description, and real names for chapters its files only number
  ("Chapter 1" to "Chapter 37"), from the EPUB's contents. Never over
  anything set by hand, and nothing is looked up elsewhere. Books added
  before are filled in when the server starts (docs/SERVER.md, section 9).
- **The library**, for the apps: the list, each book, covers and files, with
  HTTP caching (ETags, immutable covers, resumable downloads).
- **Places**, each person's position log, in the database: read by cursor,
  with events when a place moves or the library changes, and handed back
  whole as a file in the position-log format (`GET /api/places/export`).
  A server that kept places as files before takes them in when it starts.
- **The apps connect.** In Ribbon, Settings → Connect to a server: the
  server's books join the shelf, and each one downloads before it plays.
  Each person's place follows them between their devices, as soon as it
  moves.
- **Read-along for the Apple TV** (tv/README.md): each book's text with when
  each sentence is read (`GET /api/books/:id/readalong`), made once with the
  same code as the apps', and the person's place in it as a sentence
  (`GET` and `POST /api/books/:id/place`); their bookmarks, in a book and in
  every book; and their listening, kept as the desktop keeps it, so the end
  of a book can say how long it took (`POST /api/books/:id/listened` and
  `…/finished`).
- **The narration's transcript**, so read-along goes by sentence
  (docs/SERVER.md, section 9). The server doesn't transcribe: the admin's
  Mac or PC with a graphics card transcribes each book whole and sends it
  (`PUT /api/books/:id/transcript`), working through the books still
  missing minutes (`GET /api/library/transcripts`). Until a book's
  transcript is whole, it's read only, on every device (#152).

## Running it

Node 24 or later, and ffmpeg (with ffprobe) on the `PATH`: adding books reads
them with ffprobe and makes covers with ffmpeg. The server shares Ribbon's own
logic (`src/core/`), so install the repository's packages too:

```bash
npm install
cd server
npm install
npm start
```

The first start prints a link: open it to make the admin account. Until
someone does, every start prints it again.

```text
No one can sign in yet. Open http://localhost:7766/invite/… to make the admin account.
```

Read-along needs two of Ribbon's own commands, built with Rust: `ribbon-ebook`
(src-tauri/ebook), to read EPUBs as the apps do, and `ribbon-frames`
(src-tauri/frames), to send an MP3 from the exact moment a streaming player
asks for, rather than leave it to seek by guess:

```bash
cargo build --release --manifest-path src-tauri/Cargo.toml -p ribbon-ebook -p ribbon-frames
```

The server finds them in the repository's `target/` folder, or wherever
`RIBBON_EBOOK_TOOL` and `RIBBON_FRAMES_TOOL` say. Without them, everything
else works and asking for a read-along says the server can't.

The narration is transcribed by the apps, on a computer with a graphics
card, signed in as the server's admin: on a 4-core virtual machine whisper
hears 0.8 times as fast as the book plays (base) or 0.22 times (small),
where an Apple M2's graphics hear 29 to 45 times as fast.

## In Docker

From the repository's root (the image holds the app's own logic the
server runs, ffmpeg, the EPUB parser and MP3 frame index for read-along, and
speech with its model, compiled for the processor of the machine that builds
it, so build it where it runs):

```bash
docker build -f server/Dockerfile -t ribbon-server .
docker run -d --name ribbon-server --restart unless-stopped --network host \
  --user "$(id -u):$(id -g)" -e RIBBON_URL=https://your-server.example \
  -v ~/ribbon-data:/data ribbon-server
```

`--network host` keeps it on this machine's loopback, where a proxy such as
Tailscale Serve reaches it as from this machine. Keep the data folder on a
disk with ordinary file locking (not one mounted through FUSE, such as NTFS
on Linux): SQLite needs it. The books can live elsewhere, mounted over
`/data/books`.

Adding a folder from the app sends the server the folder's path, and the
server reads it there itself. When the books are on a network share the
apps mount, mount the share on the server's machine as well and give it to
the container read-only at the path the apps see it at, so the same path
works on both. For a share a Mac has at `/Volumes/media`, mounted on the
server's machine at `/mnt/media`:

```bash
--mount type=bind,source=/mnt/media,target=/Volumes/media,readonly,bind-propagation=rslave
```

`rslave` lets the container see the share even when it's mounted after the
container starts. A Windows path (`\\server\share`, `M:\`) can't be given
the same way yet, so add folders from a Mac, or on the server's own machine.

To update, pull, build again, and replace the container (`docker rm -f
ribbon-server`, then the same `docker run`): everything it keeps is in the
data folder. To move a server to another machine, copy its data folder:
the database as `sqlite3 ribbon.db ".backup copy.db"` takes it (a plain copy
of a running one may be torn), then `secret`, `people/` and `books/`. The
same secret keeps everyone signed in; a new address means the apps connect
again.

## Settings

From the environment:

| Variable | Default | What it is |
| --- | --- | --- |
| `RIBBON_DATA` | `ribbon-data`, where it's started | Its data folder: the database, the books, each person's places. Back it up. |
| `RIBBON_HOST` | `127.0.0.1` | Where it listens. This machine only, until you choose otherwise. |
| `RIBBON_PORT` | `7766` | |
| `RIBBON_URL` | `http://localhost:7766` | The address people use to reach it. Invite links are made from it. |
| `RIBBON_SECRET` | made on the first start | Signs sessions. Kept in the data folder unless given here. |
| `RIBBON_EBOOK_TOOL` | `target/release/ribbon-ebook`, else `target/debug/` | The EPUB parser, for read-along. |
| `RIBBON_FRAMES_TOOL` | `target/release/ribbon-frames`, else `target/debug/` | The MP3 frame index, so a streamed MP3 starts at the exact moment. |
| `RIBBON_DESCRIPTIONS` | none | `audible`: a book that came with no description, and has no EPUB with one, gets Audible's summary, after each folder is added and when the server starts. It asks Audible's catalog, sending only the book's title and author, and takes a recording only by one of its authors and as long as it (within 3%). A description already there is never replaced, and each book is asked about once. Unset, the server asks no one. |
| `RIBBON_AUDIBLE_STORE` | `us` | Which Audible store to ask: `us`, `uk`, `ca`, `au`, `de`, `fr`, `it`, `es`, `in` or `jp`. |

## Reaching it from elsewhere

The server speaks plain HTTP on this machine. How anyone else reaches it is
yours to choose: a reverse proxy with HTTPS (Caddy, nginx), Tailscale Serve,
a tunnel. Passwords are only accepted over HTTPS, or from this machine, and
the iPhone app needs HTTPS anyway. Set `RIBBON_URL` to the address people
use, so invite links point there.

## Inviting people

Signed in as the admin, `POST /api/invites` makes a link that's good once,
for a week. The admin pages that do this come later; until then:

```bash
curl -X POST "$RIBBON_URL/api/invites" -H "authorization: Bearer <your token>"
```

## Adding a folder

Signed in as the admin, give the folder's full path on the server's machine.
It runs as a job; ask for the job to see how it's going:

```bash
curl -X POST "$RIBBON_URL/api/library/import" -H "authorization: Bearer <your token>" \
  -H "content-type: application/json" -d '{"folder": "/srv/audiobooks"}'
curl "$RIBBON_URL/api/jobs/<job id>" -H "authorization: Bearer <your token>"
```

A book already on the server, by its files or its ISBN or ASIN, is skipped.

## How the library reads along

Signed in as the admin, every book with text and narration, and how it reads
along: by sentence, or by chapter and why (being transcribed, waiting for a
device's transcript, its EPUB unreadable, its text and narration not
pairing, or transcribed and still by chapter, which needs a person to look
at it). Those come first:

```bash
curl "$RIBBON_URL/api/library/readalong" -H "authorization: Bearer <your token>"
```

## Tests

```bash
npm test
npm run typecheck
```
