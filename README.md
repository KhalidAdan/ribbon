# Ribbon

A home for your books, read or heard: a reader and a player for the EPUBs
and audiobooks you own, as files, with one place in every book and
read-along between the two. No DRM, no store, and nothing in anyone else's
cloud. [docs/NORTHSTAR.md](docs/NORTHSTAR.md) says what it is and refuses to
be.

## Two ways to run it

| | What you install | What you get |
| --- | --- | --- |
| **On one computer** | The desktop app | All of Ribbon, from your own folders: reading, listening and read-along. No account, and nothing else to run. |
| **Everywhere** | The desktop app and a server, then the Apple app if you want it | The iPhone, iPad and Apple TV, other people with places of their own, and your place in every book on every device. |

Start with the desktop app. A server is something you add when you want more
than one computer, and your books move to it with your place in each.

## Install

**The desktop app**, for Windows x64 and Macs with Apple Silicon: download it
from [Releases](https://github.com/KhalidAdan/ribbon/releases). Install
[ffmpeg](https://ffmpeg.org) as well (`brew install ffmpeg` on a Mac): Ribbon
reads chapters, measures loudness and makes bookmark clips with it, and it
isn't in the download.

The builds aren't signed yet. The first time you open a new version on a Mac,
macOS refuses it: open it from System Settings → Privacy & Security → Open
Anyway. Windows may warn that it doesn't know the publisher. To update, close
Ribbon and install the new version over it; everything carries over.

**The server** runs on a machine of your own, in Docker or with Node:
[packages/server/README.md](packages/server/README.md).

**The iPhone, iPad and Apple TV app** needs a server. For now you build it
with Xcode: [packages/apple/README.md](packages/apple/README.md).

## What's in this repository

```text
packages/
  core/         @ribbon/core: pure logic, no files or network, for the app and the server
  host-node/    @ribbon/host-node: file and process access on Node
  server/       @ribbon/server: the server
  desktop/      @ribbon/desktop: the desktop app
    src/          its web side: app/ (state and actions), reader/, player/, ui/, host/
    src-tauri/    its Rust side, and the crates the server builds (ebook/, frames/)
    test/         its tests
    tools/        the command line, fixtures and the end-to-end checks
  apple/        the iPhone, iPad and Apple TV app, in Swift
tools/          checks for the whole repository
docs/           how it all works, and why
```

It's one repository, with npm workspaces, because the server and the desktop
share their logic: a change to how a book is read, or to what the server sends,
is one change across every part it touches.

## Build it yourself

Node 24 or newer, Rust stable, and `ffmpeg` with `ffprobe` on the PATH.
Building the speech side (whisper.cpp, for read-along) also needs CMake. On
Windows it needs LLVM (for libclang, expected in `C:\Program Files\LLVM`) and
the Vulkan SDK with `VULKAN_SDK` set; on a Mac, Xcode, and whisper.cpp runs on
Metal ([docs/MAC.md](docs/MAC.md)). `npm run tauri` and `tauri:dev` set how
whisper.cpp is compiled on each system (`packages/desktop/tools/with-build-env.mjs`). Cargo
builds into `target/` at the repository's root, because whisper.cpp's shader
build is too deep for Windows paths under `packages/desktop/src-tauri/target/`.

```sh
npm install
npm run tauri:dev          # the desktop app
```

On first launch, add a folder of books. Ribbon scans it, writes its records to
`<folder>/.ribbon/`, and opens the library. An EPUB goes with its audiobook;
an EPUB with no audiobook is a book to read
([docs/READING.md](docs/READING.md), section 2). Add more folders from
Settings: the library is every folder together, and the books stay where they
are. Launch with a folder as the argument, or set `RIBBON_LIBRARY`, to add it
without the picker.

### In a browser

The same UI runs in a browser tab against a folder on this machine, served by
a Vite plugin. It is a development harness, not a server.

```sh
RIBBON_DEV_LIBRARY=path/to/books npm run dev     # defaults to ./books if present
```

Then open http://localhost:1420. In dev builds the app controller is exposed
as `window.__ribbon`.

### Tests

```sh
npm test                       # unit and fixture tests; ffmpeg generates fixtures once
RIBBON_BOOKS=books npm test    # also assert against a real library folder
npm run typecheck
npm run test:rust              # the Rust side
npm run ribbon -- scan books   # scan from the command line, no app
npm run ribbon -- chapters books "Horus Rising"
```

The server has its own: `npm test` and `npm run typecheck` in `packages/server/`. The
end-to-end checks run the built app: [packages/desktop/tools/e2e/README.md](packages/desktop/tools/e2e/README.md).

## Read more

| | |
| --- | --- |
| [docs/NORTHSTAR.md](docs/NORTHSTAR.md) | What Ribbon is and refuses to be |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it fits together, in diagrams, and where to start reading code |
| [docs/SERVER.md](docs/SERVER.md) | The server's design |
| [docs/READING.md](docs/READING.md) | The reader and read-along |
| [docs/POSITION-FORMAT.md](docs/POSITION-FORMAT.md) | The position log, a format anyone can read and write |
| [docs/DESIGN.md](docs/DESIGN.md) | The look |
| [docs/RELEASING.md](docs/RELEASING.md) | Cutting a release |
| [docs/MAC.md](docs/MAC.md) | Developing on a Mac |
| [docs/TEST-PLAN.md](docs/TEST-PLAN.md) | What "correct" means |
| [docs/PLAN.md](docs/PLAN.md) | How version one was built |

## Licence

MIT. See [LICENSE](LICENSE).
