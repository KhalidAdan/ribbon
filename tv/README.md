# Ribbon on the Apple TV

A book from your Ribbon server, its text on the screen and its narration
playing, the sentence being read marked in amber as it goes: read-along
from the sofa. The TV only draws and plays; the server does the thinking
(docs/SERVER.md, section 8).

tvOS has no web view, so Ribbon's own UI can't run on it, and Tauri doesn't
build for it: this is a small native app in SwiftUI and UIKit, talking to the
server's API. It keeps only who has signed in on it; tvOS may clear an app's
files at any time, so the audio streams and the place lives on the server.

## What it does

- **Sign in** to a Ribbon server once: its address, your name, your password.
  The sign-in is kept in the Keychain.
- **Who's reading?** Several people can use one TV, as with Jellyfin: each
  signs in once, and with more than one the TV asks who's reading, starting
  on whoever read last. Each person's shelf and place are their own, from
  their own sign-in. Someone else signs another person in (the server's
  address is filled in); holding Select on a person takes them off this TV,
  and their places stay on the server.
- **The shelf**: the server's books that have both a text and a narration.
  Switch reader, below the books, goes back to Who's reading; so does Menu,
  when there's more than one person.
- **Read along**: the book as one long column (scroll only, no pages), set in
  the reader's own face (Newsreader). The sentence being read is washed in
  amber, and the column glides when it leaves the middle of the screen.
- **The Siri Remote**: up and down step a sentence, left and right a
  paragraph, a swipe on the touch surface glides through several. Play or
  Select reads from the sentence you're on; on the sentence being read, it
  pauses and goes on. Menu brings you back to the narrator when you've
  wandered off, and out of the book when you haven't.
- **Your place** goes to the server as you listen, the way the phone's and
  the desktop's do, and the book opens at the newest of your places on any
  device, listening or reading.

## Where the read-along comes from

`GET /api/books/:id/readalong` (server/src/readalong-routes.ts): the book's
paragraphs, and when each sentence is read. The server makes it once per
book, with the same code the apps use: the EPUB parsed by `ribbon-ebook`
(src-tauri/ebook) and paired with the narration by `src/core/reading/`. A
sentence is marked only where it is placed to the sentence (a transcript or
a Media Overlay around it); elsewhere the remote still steps through it and
Play still reads from it.

`GET` and `POST /api/books/:id/place` give and keep the person's place as a
sentence and a moment, so the TV keeps no position log of its own.

## The code

| File | What |
| --- | --- |
| `RibbonApp.swift` | `AppModel`: signed in or not, the book open. |
| `Server/RibbonServer.swift` | The API, as the TV uses it. |
| `Server/Account.swift` | Everyone signed in here, in the Keychain, and this TV's device id. |
| `PeopleView.swift`, `ShelfView.swift`, `SignInView.swift` | The screens before a book: who's reading, their books, signing in. |
| `Reading/ReadAlong.swift` | The read-along as the server sends it, and its sentences in order. |
| `Reading/ReadingSession.swift` | A book open: the remote's sentence, the narrator's, playing, the place. |
| `Reading/BookPlayer.swift` | The narration, streamed: the book's files as one timeline. |
| `Reading/BookLayout.swift` | The text set in type by TextKit, once, so every sentence's place is known. |
| `Reading/ReaderViewController.swift` | The column on screen, and the remote. |
| `Look.swift` | Colours and faces (docs/DESIGN.md). |

## Building it

Xcode (with the tvOS platform), [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`), and the repository's npm packages, which bring the
fonts (`npm install` at the root).

```bash
cd tv
xcodegen generate
open RibbonTV.xcodeproj
```

The Xcode project is made from `project.yml` and isn't kept in the
repository. Pick your team in Xcode's Signing tab when running on a real
Apple TV; it goes into the generated project only, never into this public
repository.

### In the simulator

Against a scratch server (server/README.md), never the real one:

```bash
xcodebuild -project RibbonTV.xcodeproj -scheme Ribbon -sdk appletvsimulator -derivedDataPath build build
xcrun simctl install booted build/Build/Products/Debug-appletvsimulator/Ribbon.app
SIMCTL_CHILD_RIBBON_SERVER=http://localhost:7766 SIMCTL_CHILD_RIBBON_NAME=<name> SIMCTL_CHILD_RIBBON_PASSWORD=<password> xcrun simctl launch booted app.ribbon.tv
```

A debug build fills the sign-in in from `RIBBON_SERVER`, `RIBBON_NAME` and
`RIBBON_PASSWORD`: the simulator's on-screen keyboard is slow. The simulator
reaches a server on this Mac at `localhost`. The arrow keys are the remote's
edges and Return is Select; Menu and Play/Pause are on the Simulator's own
Apple TV Remote.

How long opening a book takes is in the system log:

```bash
xcrun simctl spawn booted log show --last 5m --info --predicate 'subsystem == "app.ribbon.tv"'
```

### On an Apple TV

Pair it with Xcode once: the TV and the Mac on the same network, then on the
TV Settings → Remotes and Devices → Remote App and Devices, and in Xcode's
Devices window, Pair Nearby Device with the PIN the TV shows. Then run the
`Ribbon` scheme on it. A free Apple ID signs it for seven days, as on the
iPhone (docs/MAC.md); the paid program signs it for a year and allows
TestFlight.

## Not yet

Pages, text sizes, speed, the sleep timer, loudness, bookmarks, books
without a narration, and the app icon. MP3s are sought by Apple's player,
which may land off in a VBR file with no seek table (the reason
`src-tauri/src/frames.rs` exists); the books tried so far are CBR.
