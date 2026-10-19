# Ribbon

The listener for books you own. Local files, local position, nothing to
sign in to. See [docs/NORTHSTAR.md](docs/NORTHSTAR.md) for what this is
and refuses to be, [docs/PLAN.md](docs/PLAN.md) for how it is built,
[docs/READING.md](docs/READING.md) for reading the EPUB beside a book, and
[docs/TEST-PLAN.md](docs/TEST-PLAN.md) for what "correct" means.

## Run it

Requirements: Node 20 or newer, Rust stable, and `ffmpeg` plus `ffprobe`
on the PATH. Building the speech side (whisper.cpp, for read-along) also
needs CMake, LLVM (for libclang; `.cargo/config.toml` expects
it in `C:\Program Files\LLVM`) and the Vulkan SDK with `VULKAN_SDK` set.
Cargo builds into `target/` at the repository's root, because whisper.cpp's
shader build is too deep for Windows paths under `src-tauri/target/`.

```sh
npm install
npm run tauri:dev          # the desktop app
```

On first launch, add a folder of audiobooks. Ribbon scans it, writes
its records to `<folder>/.ribbon/`, and opens the library. Add more
folders from Settings: the library is every folder together, and the
books stay where they are. The shelf is on screen from folder names
before a single tag is read; durations fill in behind it. Launch with a
folder as the argument, or set `RIBBON_LIBRARY`, to add it without the
picker. The list of folders lives in the Ribbon folder
(`%LOCALAPPDATA%\Ribbon\sources.tsv`).

## Develop in a browser

The same UI runs in a browser tab against a folder on this machine,
served by a Vite plugin. It is a development harness, not a server.

```sh
RIBBON_DEV_LIBRARY=path/to/books npm run dev     # defaults to ./books if present
```

Then open http://localhost:1420. In dev builds the app controller is
exposed as `window.__ribbon`.

## Test

```sh
npm test                       # unit and fixture tests; ffmpeg generates fixtures once
RIBBON_BOOKS=books npm test      # also assert against a real library folder
npm run typecheck
npm run ribbon -- scan books     # scan from the command line, no app
npm run ribbon -- chapters books "Horus Rising"
```

## Layout

```
src/core      pure TypeScript decisions, no I/O, exhaustively tested
src/host      the Host seam: node.ts (tests, CLI), tauri.ts (app), browser.ts (dev)
src/app       library service, background jobs, controller, media session
src/player    the two-element gapless engine
src/ui        React + Tailwind, built with the ui.sh design skill
src-tauri     Rust shell: scoped fs, ffmpeg via shell plugin, asset protocol
tools         CLI, fixture generator, Vite dev-library plugin
test          Vitest suites, one per core module plus scan and library
```

## What is on disk

Everything durable lives beside the books in `.ribbon/`, all CSV:

| File                          | Meaning                                       |
| ----------------------------- | --------------------------------------------- |
| `library.csv`, `files.csv`    | Scan cache. Rebuilt any time.                 |
| `chapters/<id>.csv`           | Effective chapters.                           |
| `corrections/<id>.csv`        | Your hand edits to chapters. Sync this.       |
| `positions/<device>.ndjson`   | Where you are, one log per device. Sync this. See [docs/POSITION-FORMAT.md](docs/POSITION-FORMAT.md). |
| `positions/<id>.csv`          | Where you are, as Ribbon 0.4 wrote it. Still kept for older versions. |
| `edits/<id>.csv`              | Your corrections to a book's details.        |
| `settings/<id>.csv`           | Per-book speed.                               |
| `loudness/<id>.csv`           | Measured LUFS and the gain applied.           |
| `silence/<id>.csv`            | Gaps that get shortened during playback.      |
| `bookmarks/<id>.csv`, `clips/`| Bookmarks and their thirty-second clips.      |
| `covers/<id>.jpg`             | Cover art pulled out of the files.            |
| `pairing/<id>.csv`            | How you paired the EPUB's chapters with the audio's, by hand. Sync this. |
| `heard/<id>.csv`              | What the narrator says at chapter starts and checkpoints, and where each is in the EPUB, heard on a machine with a speech model. |

A book id is the CRC-32 of its library-relative path and total size, so
the same folder on another machine gets the same id.
