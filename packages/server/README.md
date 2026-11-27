# Ribbon server

The books, and each person's place in them, for the people you invite. The
design is [docs/SERVER.md](../docs/SERVER.md); this is how to run it.

You don't need a server to use Ribbon: the desktop app runs alone from your
folders. Run one when you want the iPhone, iPad and Apple TV app, or people
with places of their own.

What it does:

- **Accounts.** People sign in with a name and a password the server keeps,
  and the admin invites them; or with passkeys, through a Pocket ID instance
  you run beside it ("Signing in with Pocket ID", below).
- **Adding a folder.** The admin points the server at a folder on its
  machine (in Ribbon, Settings → Add a folder, as the admin); it copies in
  each book it doesn't have yet, reads its chapters, makes its covers, and
  measures its loudness and silences once. What Ribbon already worked out
  beside a book in the folder's `.ribbon/` (chapters, corrections, what was
  heard of the narration and how it lines up with the text) comes in with
  it, and adding the folder again fills in what a book already here is
  missing. The folder is only ever read.
- **Moving in from the desktop.** The position logs in a folder's `.ribbon/`
  come in with its books, as the places of the person adding it: where they
  were, their bookmarks and their listening history. Signing in to your own
  server, the desktop offers to do this for your folders (docs/SERVER.md,
  section 11).
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
- **Read-along for the Apple TV** (packages/apple/README.md): each book's text with when
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
them with ffprobe and makes covers with ffmpeg. PDFs (docs/COMICS.md,
section 12) are read with pdf.js, which draws on `@napi-rs/canvas`: npm
installs it with the server where a build of it exists for the machine, and
without it a PDF is still added and downloaded, with no cover and no pages
drawn for the apps that are sent them, and no comic's pages have small
pictures for a reader's strip. The server runs Ribbon's own
logic (`@ribbon/core`), and one install at the repository's root brings it all:

```bash
npm install
cd server
npm start
```

The first start prints a link: open it to make the admin account. Until
someone does, every start prints it again.

```text
No one can sign in yet. Open http://localhost:7766/invite/… to make the admin account.
```

Read-along needs two of Ribbon's own commands, built with Rust: `ribbon-ebook`
(packages/desktop/src-tauri/ebook), to read EPUBs as the apps do, and `ribbon-frames`
(packages/desktop/src-tauri/frames), to send an MP3 from the exact moment a streaming player
asks for, rather than leave it to seek by guess:

```bash
cargo build --release --manifest-path packages/desktop/src-tauri/Cargo.toml -p ribbon-ebook -p ribbon-frames
```

The server finds them in the repository's `target/` folder, or wherever
`RIBBON_EBOOK_TOOL` and `RIBBON_FRAMES_TOOL` say. Without them, everything
else works and asking for a read-along says the server can't.

A CBR, a comic in a RAR archive, needs a third, `ribbon-cbr`
(packages/desktop/src-tauri/cbr), which writes it out as the CBZ the server
keeps (docs/COMICS.md, section 13). Add `-p ribbon-cbr` to the line above, or
say where it is with `RIBBON_CBR_TOOL`. Without it a CBR in a folder is left
out, and the import says why; the Docker image has all three.

The narration is transcribed by the apps, on a computer with a graphics
card, signed in as the server's admin: on a 4-core virtual machine whisper
hears 0.8 times as fast as the book plays (base) or 0.22 times (small),
where an Apple M2's graphics hear 29 to 45 times as fast.

## In Docker

The simplest way: each release publishes an image, and `compose.yaml` here runs
it. Copy that file into a folder of its own, then:

```bash
mkdir ribbon-data
RIBBON_BOOKS=/path/to/your/books docker compose up -d
docker compose logs
```

Make `ribbon-data` first: the server runs as user 1000, and it can't write to a
folder Docker makes, which belongs to root. If `id -u` says you aren't user 1000,
give your own numbers as `RIBBON_UID` and `RIBBON_GID` too.

The first start prints the link that makes the admin account. To update, `docker
compose pull` and `docker compose up -d`: everything it keeps is in `ribbon-data`.

To build the image yourself, from the repository's root (it holds the shared
logic, ffmpeg, and the EPUB parser and MP3 frame index for read-along):

```bash
docker build -f packages/server/Dockerfile -t ribbon-server .
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
server reads it itself. When the books are on a network share the apps
mount, mount the share on the server's machine as well, give it to the
container read-only, and name it in `RIBBON_FOLDERS`. The server looks for a
picked folder at its path, then under those folders: a folder picked as
`M:\Books\Dune` or `\\nas\media\Books\Dune` on Windows, or
`/Volumes/media/Books/Dune` on a Mac, is found at `/media/Books/Dune`. For a
share mounted on the server's machine at `/mnt/media`:

```bash
--mount type=bind,source=/mnt/media,target=/media,readonly,bind-propagation=rslave \
  -e RIBBON_FOLDERS=/media
```

`rslave` lets the container see the share even when it's mounted after the
container starts.

To update, pull, build again, and replace the container (`docker rm -f
ribbon-server`, then the same `docker run`): everything it keeps is in the
data folder.

**Comics from before they had details of their own** (docs/BOOK-DETAILS.md,
section 6) are moved into them once, the first time a newer server starts:
each one's ComicInfo.xml read again, its name made from its details, and its
edits moved into the new fields, in one transaction, with the edits as they
were kept beside them (`book_edit.edits_before_move`). To see what that will
do first, try it on a copy:

```bash
npm run try-comic-move -- /path/to/ribbon-data /path/to/a/new/folder
```

(in the container: `docker exec ribbon-server node --import tsx
src/try-comic-move.ts /data /tmp/comic-move`.) It copies the database and
each comic's record into the new folder, reads each comic's file where it
is, writes nothing to the data folder, and prints every comic before and
after: its name, byline, series, issue or volume, the issues it collects,
its title and its edits. To move a server to another machine, copy its data folder:
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
| `RIBBON_SECRET` | made on the first start | A secret of the server's own, for the accounts it keeps. Kept in the data folder unless given here. |
| `RIBBON_SIGN_IN` | `accounts` | How people prove who they are: `accounts`, a name and a password the server keeps, or `pocket-id`. |
| `RIBBON_POCKET_ID_URL` | none | With `pocket-id`: the instance's address, such as `https://id.example.com`. |
| `RIBBON_POCKET_ID_CLIENT_ID`, `RIBBON_POCKET_ID_CLIENT_SECRET` | none | With `pocket-id`: the client registered there for this server. |
| `RIBBON_ADMINS` | none | With `pocket-id`: this server's admins, separated by commas, each by their Pocket ID username or, safer, by their id there (a username belongs to whoever holds it now). Being listed gives the role at their next sign-in; taking a name off the list doesn't take the role away. |
| `RIBBON_EBOOK_TOOL` | `target/release/ribbon-ebook`, else `target/debug/` | The EPUB parser, for read-along. |
| `RIBBON_FRAMES_TOOL` | `target/release/ribbon-frames`, else `target/debug/` | The MP3 frame index, so a streamed MP3 starts at the exact moment. |
| `RIBBON_CBR_TOOL` | `target/release/ribbon-cbr`, else `target/debug/` | The CBR reader, so a comic in a RAR archive can be added. |
| `RIBBON_DESCRIPTIONS` | none | `audible`: a book that came with no description, and has no EPUB with one, gets Audible's summary, after each folder is added and when the server starts. It asks Audible's catalog, sending only the book's title and author, and takes a recording only by one of its authors and as long as it (within 3%). A description already there is never replaced, and each book is asked about once. Unset, the server asks no one. |
| `RIBBON_AUDIBLE_STORE` | `us` | Which Audible store to ask: `us`, `uk`, `ca`, `au`, `de`, `fr`, `it`, `es`, `in` or `jp`. |
| `RIBBON_COMICVINE_KEY` | none | Your own key for [ComicVine's API](https://comicvine.gamespot.com/api/), which comes with an account there and is for non-commercial use. With it, the admin can look a comic up from the desktop's edit form ("Look it up"), and a comic whose ComicInfo.xml names its issue's page on ComicVine (`Web`) is matched to that issue after each folder is added and when the server starts; the server never searches by itself. Only what names a comic is sent: a series' name, a number, a year, or a ComicVine address. What ComicVine says is kept with the comic, under anything set by hand, and shown with a link back to its page; searches are kept for a day. One request at a time, no more than 180 an hour to each of its resources. Unset, the server asks no one. Ribbon comes with no key: a key is one site's own. |
| `RIBBON_FOLDERS` | none | Where the server has the share the apps add folders from, so a folder picked on a Windows PC or a Mac is found here: the longest stretch of its path that's under one of these. Separated by `:` (`;` on Windows). Unset, a folder is found only at the path it was picked at. |

## Signing in with Pocket ID

[Pocket ID](https://pocket-id.org) signs people in with passkeys, and one
instance can do it for every app you run. With it, Ribbon keeps no
passwords and sends no invites: who may come in is decided in Pocket ID,
and what they may do here stays Ribbon's.

1. In Pocket ID, under Administration → OIDC Clients, add a client for
   Ribbon. Not a public client: the server keeps its secret. Its callback
   URL is your server's address followed by `/sign-in/callback`.
2. Choose who may use it: the client's allowed user groups, or everyone.
3. Start the server with `RIBBON_SIGN_IN=pocket-id`, the instance's address
   and the client's id and secret (Settings, below), and your own Pocket ID
   username in `RIBBON_ADMINS`.

Someone signing in for the first time becomes a person here, with nothing
yet. Their name and picture are Pocket ID's, as of their last sign-in.

**Changing a server that has accounts already.** Its people keep their
places, goals and devices if you say who each of them is at Pocket ID
before they sign in there:

```bash
npm run link                  # everyone on this server
npm run link -- annie ann     # annie here will sign in to Pocket ID as ann
```

In the container that is `docker exec ribbon-server node --import tsx
src/link.ts annie ann`. Someone is expected for two weeks, so say it once
their Pocket ID account exists and not long before they'll sign in. Devices already signed in stay signed in. The apps
need Ribbon 0.42 or later to sign in again: an older one asks for a password
and is told to update.

## An assistant, for a comic's panels and details

The server has an MCP at `/mcp` (docs/COMICS.md, section 14): an assistant
you point at it can list the comics, look at a page, and say what its
panels are and in what order, so a comic can be read a panel at a time.
It can also fill in a comic's details from wherever you tell it to look,
by the names of a comic's own (docs/BOOK-DETAILS.md, section 5): its
series, its issue or its volume and the issues it collects, its title (the
story's own name), its people by what they did, its cover date and day on
sale, and the rest; and make any page of a comic its cover. What it sets is
kept as the desktop's edit form keeps it, and can be taken back there.
It answers only to a key you make, and only an admin's:

```bash
npm run key -- khalid            # a key that acts as the admin "khalid", shown once
```

In Docker: `docker exec ribbon-server node --import tsx src/key.ts khalid`.
It prints the key and the line that gives it to Claude Code. The key is a
session like a device's, good for a year. The pages the assistant looks at
are sent to whoever runs it, so make a key only for one you would show your
comics to. Looking at a page needs the canvas the server draws PDFs with
(`@napi-rs/canvas`, above).

## Reaching it from elsewhere

The server speaks plain HTTP on this machine. How anyone else reaches it is
yours to choose: a reverse proxy with HTTPS (Caddy, nginx), Tailscale Serve,
a tunnel. Passwords are only accepted over HTTPS, or from this machine, and
the iPhone app needs HTTPS anyway. Set `RIBBON_URL` to the address people
use, so invite links point there.

## Inviting people

In the desktop app, signed in as the admin: Settings, People, "Invite
someone". It makes a link that's good once, for a week, to send to them
yourself. The same section lists everyone on the server, and signs someone
out of every device of theirs.

A server that signs people in with Pocket ID sends no invites: add the
person in Pocket ID, and they are listed under People once they have signed
in.

The link, without the app (`POST /api/invites`):

```bash
curl -X POST "$RIBBON_URL/api/invites" -H "authorization: Bearer <your token>"
```

## Adding a folder

Signed in as the admin, give the folder's full path on the server's machine,
or on the computer it was picked on when it's under `RIBBON_FOLDERS`.
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
