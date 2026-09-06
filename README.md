# Odio

The listener for books you own. Local files, local position, nothing to
sign in to. See [docs/NORTHSTAR.md](docs/NORTHSTAR.md) for what this is
and refuses to be, [docs/PLAN.md](docs/PLAN.md) for how it is built, and
[docs/TEST-PLAN.md](docs/TEST-PLAN.md) for what "correct" means.

## Run it

Requirements: Node 20 or newer, Rust stable, and `ffmpeg` plus `ffprobe`
on the PATH.

```sh
npm install
npm run tauri:dev          # the desktop app
```

On first launch, choose a folder of audiobooks. Odio scans it, writes
its records to `<folder>/.odio/`, and opens the library.

## Develop in a browser

The same UI runs in a browser tab against a folder on this machine,
served by a Vite plugin. It is a development harness, not a server.

```sh
ODIO_DEV_LIBRARY=path/to/books npm run dev     # defaults to ./books if present
```

Then open http://localhost:1420. In dev builds the app controller is
exposed as `window.__odio`.

## Test

```sh
npm test                       # unit and fixture tests; ffmpeg generates fixtures once
ODIO_BOOKS=books npm test      # also assert against a real library folder
npm run typecheck
npm run odio -- scan books     # scan from the command line, no app
npm run odio -- chapters books "Horus Rising"
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

Everything durable lives beside the books in `.odio/`, all CSV:

| File                          | Meaning                                       |
| ----------------------------- | --------------------------------------------- |
| `library.csv`, `files.csv`    | Scan cache. Rebuilt any time.                 |
| `chapters/<id>.csv`           | Effective chapters.                           |
| `corrections/<id>.csv`        | Your hand edits to chapters. Sync this.       |
| `positions/<id>.csv`          | Where you are. Sync this. Last write wins.    |
| `settings/<id>.csv`           | Per-book speed.                               |
| `loudness/<id>.csv`           | Measured LUFS and the gain applied.           |
| `silence/<id>.csv`            | Gaps that get shortened during playback.      |
| `bookmarks/<id>.csv`, `clips/`| Bookmarks and their thirty-second clips.      |
| `covers/<id>.jpg`             | Cover art pulled out of the files.            |

A book id is the CRC-32 of its library-relative path and total size, so
the same folder on another machine gets the same id.
