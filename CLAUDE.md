# Working on Ribbon

Ribbon is a home for your books, read or heard: a reader and a player for
the EPUBs and audiobooks you own, as files, with one place in every book
and read-along between the two. Tauri 2 (Rust) with a web UI (React 19,
Tailwind 4). Start with these, in this order:

- [docs/NORTHSTAR.md](docs/NORTHSTAR.md): what Ribbon is and refuses to be. Settles most product questions.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together, in diagrams; where to start reading code.
- [docs/READING.md](docs/READING.md): the reader and read-along. [docs/POSITION-FORMAT.md](docs/POSITION-FORMAT.md): the position log.
- [docs/DESIGN.md](docs/DESIGN.md): the look. [docs/PLAN.md](docs/PLAN.md): how version one was built.
- [docs/RELEASING.md](docs/RELEASING.md): cutting a release. [docs/MAC.md](docs/MAC.md): macOS and the phone.

## How the owner works

- **Clean, human-readable code.** The owner is a Java and JavaScript
  developer who reads every PR. Match the repository's voice: comments in
  plain English that say why, names a reader understands, classes behind
  clear abstractions (`BookText`, `LayoutEngine`, `AppController`).
- **Measure first.** No speed work without numbers before and after, from
  the built app, at 1x and at 6x CPU slowdown (`npm run e2e -- speed`). PRs
  carry the numbers.
- **One PR per change**, each with what it does, why, and how it was checked.
  Merges to `main`, releases and installs happen when the owner says so in
  chat. A release is both Windows installers on GitHub (docs/RELEASING.md),
  and installing waits until Ribbon is closed.
- **Every check before a release** (`npm run e2e` at 1x and 6x): the 0.12.0
  resize regression shipped because nothing covered resizing.
- **Phones are coming** (iOS 16.4+ and Android): new work must not depend on
  anything only Windows has.

## Hard rules

- **Never write to the owner's real library.** It is a network share;
  reading to measure is fine, writing (`.ribbon/` records, covers, test runs)
  is not. Tests and the e2e checks use a local copy (`.e2e/library`).
- **This repository is public.** No addresses, hostnames or details of the
  owner's machines or network in it.
- **No DRM**, no AAX, no stores, no servers (docs/NORTHSTAR.md).
- **Never Electron.** The UI is the web in a Tauri shell; native work goes in
  Rust or a Tauri plugin. The ui.sh skills (Tailwind Labs) are for UI work.
- **Culvert** (the owner's npm packages, `@culvert/stream`, `@culvert/csv`)
  is the plumbing for scans and records: Source, Transform, Sink and `pipe()`,
  not ad-hoc streams.

## Where things are

| | |
| --- | --- |
| `src/core/` | Pure TypeScript, no DOM or Tauri; everything decided here is unit-tested (`test/`). |
| `src/app/controller.ts` | `AppController`: the app's state and every action; its doc comment is the map. |
| `src/reader/` | The reader: layout in a worker (`layout-engine.ts`), pages, scroll, swipes, snapshots. |
| `src/player/engine.ts` | Playback: two audio elements, gapless, loudness, MP3s from the exact frame. |
| `src/ui/` | Everything else on screen. `useAppState(selector)` so a player tick redraws only what shows the time. |
| `src-tauri/src/` | Rust: the scanner (`scan.rs`, `tags.rs`), EPUBs (`ebook/`), speech (`speech.rs`, whisper.cpp), MP3 frames (`frames.rs`), the Ribbon folder (`home.rs`). |
| `tools/` | The CLI, fixtures, screenshots, flows, and the end-to-end checks (`tools/e2e`). |

## Commands

```bash
npm install
npm run tauri:dev                       # the desktop app, from source
npm test && npm run typecheck           # unit tests and types
npm run test:rust                       # the Rust side
npm run e2e -- --build                  # the end-to-end checks (Windows; tools/e2e/README.md)
npm run e2e -- speed --slow 6           # the speed report, as a slow machine
npm run tauri build                     # the installers
npm run ribbon -- scan <folder>         # the scan, from the command line
```

`npm run tauri`, `tauri:dev` and `test:rust` go through
`tools/with-build-env.mjs`, which sets how whisper.cpp is compiled on each
system; a bare `cargo build` on Windows makes a speech side too slow to use.

Environment: `RIBBON_LIBRARY` (a folder to open, or the first argument),
`RIBBON_HOME` (the Ribbon folder, `%LOCALAPPDATA%\Ribbon` by default),
`RIBBON_PROFILE=1` (the measurement build: React's profiler and
`window.__ribbon`), `RIBBON_DEV_LIBRARY` (the browser harness's folder),
`RIBBON_E2E_LIBRARY`, `RIBBON_SCAN_PATH` and `RIBBON_MIN_READ` (the scan
benchmark in `src-tauri`).

## Lessons that cost hours

- **Per-file round trips are the cost over a share**, not bytes: never open
  or write a file per book on the way to the first paint. Paint from the
  folder walk, then stream tags.
- **Tauri IPC:** a `Channel` message over 8 KB takes a slow fetch path on
  WebView2. Stream with events and keep command replies small.
- **Hidden windows lie about time:** Chromium throttles timers and stops
  `requestAnimationFrame` in a hidden or covered window. Never trust a timing
  from one; anything waiting on a frame needs a timeout.
- **`tauri dev` adds about 3 s** to startup; measure startup on a `tauri build`.
- **The webview guesses MP3 seeks** (VBR without a Xing header lands minutes
  off): `frames.rs` indexes frames and serves MP3s from the exact one.
- **Muting the player in a test:** route the engine's gain node to a
  `MediaStreamDestination`; disconnecting it freezes playback.
- **Stacked PRs:** merge without deleting branches until the last is in, or
  GitHub closes the ones stacked on them (docs/RELEASING.md).
- **On Windows, from Git Bash:** a `\\server\share` path is mangled; use
  PowerShell for those. Write code with files rather than shell heredocs,
  which mangle backslashes.
