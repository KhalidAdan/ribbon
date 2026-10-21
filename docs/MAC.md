# Ribbon on the Mac, and then the phone

Ribbon was built and shipped on Windows. This is how to pick it up on a Mac,
what has not been tried there yet, and the plan for the phone, which the
North Star's picture of success needs (headphones in the car, the page in
bed).

## 1. Setting up the Mac

1. **Xcode** from the App Store, opened once to accept its licence, then the
   command line tools: `xcode-select --install`.
2. **Homebrew** ([brew.sh](https://brew.sh)), then the tools Ribbon uses:

   ```bash
   brew install node cmake ffmpeg gh
   ```

   `ffmpeg` brings `ffprobe`; Ribbon runs both by name.
3. **Rust** through rustup ([rustup.rs](https://rustup.rs)), and for the phone,
   later, its targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.
4. **The repository:**

   ```bash
   gh auth login
   gh repo clone KhalidAdan/ribbon
   cd ribbon
   npm install
   npm run tauri:dev
   ```

   The first build compiles whisper.cpp, with Metal, for several minutes.
5. **The library.** Reach the share the way Windows does (the same VPN), then
   Finder → Go → Connect to Server, and add the folder under `/Volumes` in
   Ribbon. As on Windows: never point tests at it.
6. **Claude Code.** Sessions and Claude's notes about this project do not move
   between machines on their own: the Mac starts with this repository and its
   [CLAUDE.md](../CLAUDE.md). To bring the notes over too (they hold details
   kept out of this public repository, like where the library lives), copy the
   files in the Windows machine's `%USERPROFILE%\.claude\projects\E--CODE-odio\memory\`
   into the Mac's memory folder for the clone; `/memory` in Claude Code there
   opens it.

## 2. What has not been tried on macOS yet

The code is ready for the Mac on paper; nothing has run there. Check these
first, roughly in this order:

- **The build.** `Cargo.toml` builds whisper.cpp with Metal on Apple's systems
  and Vulkan elsewhere, and `tools/with-build-env.mjs` sets compiler flags on
  Windows only. If whisper-rs fails to build, that is the place to look.
- **ffmpeg from the Dock.** An app opened from the Dock gets only the system's
  PATH; `lib.rs` adds Homebrew's folders (`/opt/homebrew/bin`, `/usr/local/bin`)
  before anything starts. Check a built `Ribbon.app`, not only `tauri:dev`,
  which inherits the terminal's PATH.
- **WKWebView, not Chromium.** The custom protocols (`asset:`, `ribbonmp3:`) are
  in the CSP as schemes, which is how WebKit names them. The layout worker
  needs OffscreenCanvas (macOS 13.3 and later); without it the engine lays out
  on the page. Check: MP3, M4B and FLAC play; bookmark clips (Opus) play; the
  Media Session keys work; read-along follows.
- **The end-to-end checks do not run on a Mac.** They drive WebView2 over its
  debugging port, and WKWebView has none. Test by hand, with Safari's Web
  Inspector on a dev build (Safari → Settings → Advanced → Show features for
  web developers, then Develop → the Mac's name → Ribbon). A way to automate
  WebKit later: run the same checks against the browser harness
  (`npm run dev`) in Playwright's WebKit, which is close to Safari.
- **Installers.** `npm run tauri build` makes `Ribbon.app` and a `.dmg` under
  `target/release/bundle/`. Unsigned, they run on this Mac; other Macs warn
  until they are signed with a Developer ID and notarized, which needs the
  paid Apple Developer Program. The build asks for macOS 11, the first on
  Apple Silicon (`bundle.macOS.minimumSystemVersion`): `tauri build` compiles
  whisper.cpp for that version, and its `std::filesystem` needs 10.15 or later.
  Tauri's default, 10.13, fails with Xcode 26 ("'path' is unavailable").

## 3. The phone

Tauri 2 builds for iOS and Android from the same code. Ribbon targets
**iOS 16.4 and later** (the first with OffscreenCanvas, which the layout
worker needs) and Android after it.

The Xcode project is in `src-tauri/gen/apple`, made by `npm run tauri ios init`
from `tauri.conf.json` (`bundle.iOS`: the minimum version, and Accelerate,
which whisper.cpp needs and Xcode only links when the project lists it).

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
npm run tauri ios build -- --target aarch64-sim --debug          # the simulator
APPLE_DEVELOPMENT_TEAM=<team> npm run tauri ios build -- --debug   # a phone: Ribbon.ipa
xcrun devicectl device install app --device <phone> src-tauri/gen/apple/build/arm64/Ribbon.ipa
```

A phone needs Developer Mode (Settings → Privacy & Security, once it has been
plugged into the Mac) and, the first time, the developer trusted (Settings →
General → VPN & Device Management). A free Apple ID's Personal Team is enough
for your own iPhone, but the app has to be installed again every seven days;
TestFlight and the App Store need the paid program. The team is the signer's:
**a device build writes it into `project.pbxproj`, and it never goes into this
public repository** (the macOS checks fail on it). Leave that change out of
commits, or `xcodegen generate` in `src-tauri/gen/apple` drops it.

The library is a folder you choose, on the phone as everywhere: Ribbon never
makes a folder of books of its own. Choosing one on iOS needs a native folder
picker (the dialog plugin has none on mobile), with access that lasts beyond the
picker. Nothing that runs ffmpeg (loudness, silence, bookmark clips, the
read-along export) is offered, since iOS starts no processes. The notch, the
Dynamic Island and the home indicator get their room (`viewport-fit=cover`,
the `safe-area` padding).

### What stands in the way, riskiest first

1. **Background audio through the webview.** The North Star makes lock
   screen controls and background audio table stakes. **Answered for the
   audio itself:** with the `audio` background mode
   (`src-tauri/Info.ios.plist`, which Tauri merges into the app's
   Info.plist), a book on the iPhone SE played on through a night with the
   screen locked, Web Audio's gain node (Ribbon's loudness) included, with no
   native audio session of Ribbon's own. Still open: lock-screen controls
   (Now Playing and the remote commands), and whether the sleep timer fires
   on time while the phone is locked. If either needs it, the session and
   the controls move to native code.
2. **ffmpeg cannot run on a phone.** iOS starts no processes. Today ffmpeg
   does the loudness and silence scans, cuts bookmark clips, decodes speech
   for whisper, and builds the read-along export. The way through that serves
   every platform: decode in Rust with `symphonia` (MP3, AAC, FLAC, Vorbis),
   measure loudness with the `ebur128` crate, find silences in the samples
   ourselves, and encode clips with libopus. That also ends the desktop's need
   for ffmpeg on the PATH, which is the first thing anyone else installing
   Ribbon would trip on.
3. **Where the books come from.** The car has no share. The phone needs books
   kept on it: pick a folder through the Files app (which can also reach a
   server), and keep chosen books on the device. Positions are files beside
   the books, as on the desktop, and travel with them. This is a product
   decision to make before the code: which books, how chosen, how they come
   off again.
4. **Speech.** Whisper on Metal is the same crate with another feature
   (`Cargo.toml` already says so). But the phone may not need to transcribe at
   all: the desktop's transcripts are files in `.ribbon/aligned/`, and they come
   with the books. Transcribe on the phone only what nothing else has.
5. **The reader on a slow phone.** Built for this from the start: the layout
   worker, swipes that follow the finger, a book that opens to its snapshot.
   Measure on a real device; `npm run e2e -- speed --slow 6` is the desktop's
   stand-in for one.

Android comes after. Its webview is Chromium, so the end-to-end checks can
drive it through `adb forward` and the same debugging port.
