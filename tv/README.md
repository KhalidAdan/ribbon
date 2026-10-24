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
  on whoever read last. Each person's library and places are their own, from
  their own sign-in. Someone else signs another person in (the server's
  address is filled in); holding Select on a person takes them off this TV,
  and their places stay on the server.
- **The library**, as the desktop's: Continue (the books you're in the
  middle of, most recent first), each series as a card with where you are in
  it, then every other book. A card is one button, which opens the book's
  page; play is there. While a book plays, its title at the top opens the
  player. Switch reader, below the books, goes back to Who's reading; so
  does Menu, when there's more than one person.
- **A book's page**: where you are as a sentence, Continue listening and Read
  along, the facts, the description, and the rest of its series.
- **The player**: the chapter and how far into it, the transport (chapters,
  thirty seconds back and on), speed, the sleep timer, and the chapter list.
  The player and the reader share one narration: leaving either leaves the
  book playing.
- **Read along**: the book as one long column (scroll only, no pages), set in
  the reader's own face (Newsreader). The sentence being read is washed in
  amber, and the column glides when it leaves the middle of the screen. Once
  the narration has played five seconds with your sentence following it, the
  words not being read step back (the river); moving off the narrator, or
  pausing, brings them back at once (a tenth of a second). A book whose
  read-along is by chapter says so for a few seconds as it opens: the words
  can be up to a minute from the voice.
- **The Siri Remote**: up and down step a sentence, a swipe on the touch
  surface glides through several. Left listens from the sentence you're on,
  and right returns to the narrator; away from the narrator, Listen from here
  and Return to narrator say so either side of your sentence. "What did they
  just say?": Left again at once (within about 0.6 s) goes back one more
  sentence and reads from there, and again. Play or Select reads from the
  sentence you're on; on the sentence being read, it pauses and goes on. Menu
  brings you back to the narrator when you've wandered off, and out of the
  book when you haven't.
- **Bookmarks**: hold Select on a sentence, take in more with up and down, and
  Select keeps it. It's the bookmark the desktop makes of words selected in
  its reader (docs/POSITION-FORMAT.md, section 3.4), so it's on every device,
  in the audiobook's bookmarks too. Bookmarked words are underlined in amber,
  as on the desktop; holding Select on them offers to delete the bookmark.
  The player lists the book's bookmarks, and listens from the one chosen.
- **Find a line**: Search, at the top of the library, opens with its field
  ready, so holding the remote's microphone button and saying what you
  remember is enough ("where the scarecrow gets his brains"); typing works
  too. The server searches every book's sentences, and choosing one opens
  Read along on it, the narrator where it was: left listens from it.
- **Your place** goes to the server as you listen, the way the phone's and
  the desktop's do, and the book opens at the newest of your places on any
  device, listening or reading.
- **Resuming** goes back by as much as the time away asks, as the desktop's
  does (src/core/resume.ts, mirrored in `Listening/Resume.swift`): two
  seconds after a short pause, ten after a few minutes, thirty after a night,
  a minute after a week, never into the chapter before, and to the start of a
  sentence where the read-along places it. After a day away the player offers
  to start the chapter over.
- **Chapter cards**: crossing into a new chapter while the player or the
  reader is on screen, the narration waits 2.6 seconds while the chapter's
  number and title fill the screen in Newsreader, wiped in and out left to
  right, as Kurosawa's intertitles are. Never on a chapter you skipped or
  sought to, nor while a sleep timer is about to stop it, an end-of-chapter
  timer is set, or Still listening? is asking. Play pauses it as ever.
- **Dozing off**: after forty minutes of narration with nothing pressed or
  touched and no sleep timer, a quiet Still listening? Any press answers it
  and does nothing else. With no answer within a minute the narration stops
  at the end of the sentence (it fades out, as the sleep timer does, in a
  book without a read-along), and the TV keeps where you dozed off: the
  moment of the narration at your last press or touch. Next time the player
  offers Go back to where you dozed off, and the reader opens with your
  sentence there, Left to listen from it and Right to go on from where it
  stopped. That moment is kept on this TV for each person and book, as the
  speed is: it's about this sofa, and the position log every app shares has
  no record for it. The Siri Remote has no motion sensors, so presses and
  touches are all there is to go by (`Remote.swift`), and only while Ribbon
  is in front: behind the home screen, its presses go to other apps.
- **The end of a book**: a quiet card with when it was started and
  finished and the time spent listening on every device (the server's
  sessions), then Up next in the series, for you to start when you choose:
  there's no countdown.
- **Your passages**: paused for five minutes in the player or the reader
  with nothing pressed, your bookmarked passages from every book drift by,
  set in Newsreader with the book's title. Any press brings back where you
  were, and does nothing else. Not after the sleep timer, dozing off or the
  book's end stopped it: you're asleep, and the TV goes to sleep as usual.
  The TV's own screen saver waits while they show, for an hour at most.
- **Listening sessions** are kept on the server as the desktop keeps them,
  for the end of a book; Keep listening sessions, below the library, turns
  that off for you on this TV (docs/POSITION-FORMAT.md, section 3.3).

## Where the read-along comes from

`GET /api/books/:id/readalong` (server/src/readalong-routes.ts): the book's
paragraphs, and when each sentence is read. The server makes it once per
book, with the same code the apps use: the EPUB parsed by `ribbon-ebook`
(src-tauri/ebook) and paired with the narration by `src/core/reading/`. A
sentence is marked only where it is placed to the sentence (a transcript or
a Media Overlay around it); elsewhere the remote still steps through it and
Play still reads from it. Its `check` says how much of the book is placed
to the sentence, and how far off the moments heard in it are when each is
left out and placed from the ones either side; the server logs it when it
makes a read-along, and the TV says when the book is by chapter.

`GET` and `POST /api/books/:id/place` give and keep the person's place as a
sentence and a moment, so the TV keeps no position log of its own.
`POST /api/books/:id/listened` keeps a stretch of listening (opening a
listen-through as it starts, a session as it ends) and `POST
/api/books/:id/finished` closes the listen-through and says how it went.
`GET /api/bookmarks` lists the person's bookmarks in every book, for the
passages.

## The code

| File | What |
| --- | --- |
| `RibbonApp.swift` | `AppModel`: who's reading, the screens open over the library, the narration. |
| `Server/RibbonServer.swift` | The API, as the TV uses it. |
| `Server/Account.swift` | Everyone signed in here, in the Keychain, and this TV's device id. |
| `PeopleView.swift`, `SignInView.swift` | Who's reading, and signing in. |
| `Library/Library.swift` | A person's books and how far through each, grouped as the desktop's shelf. |
| `Library/LibraryView.swift`, `Library/BookView.swift` | The library, and a book's page with its series. |
| `Remote.swift` | Every press and touch, seen first: when the person last did anything, and the one press that only wakes something. |
| `Listening/Listening.swift` | The book being listened to: play, chapters, speed, the sleep timer, the place, resuming, chapter cards, the end. |
| `Listening/Resume.swift` | How far back resuming goes, as the desktop's `src/core/resume.ts`. |
| `Listening/Dozing.swift` | Still listening?, and where you dozed off. |
| `Listening/Cards.swift`, `Listening/FinishedView.swift`, `Listening/PassagesView.swift` | A chapter's card and Still listening?, the end of a book, and the passages. |
| `Library/SearchView.swift` | Find a line, by voice or typing, in every book. |
| `Listening/Bookmarks.swift` | A book's bookmarks from every device: made of whole sentences here, words or moments elsewhere. |
| `Listening/BookPlayer.swift` | The narration, streamed: the book's files as one timeline. |
| `Listening/PlayerView.swift` | The full player, and the chapter list. |
| `Reading/ReadAlong.swift` | The read-along as the server sends it, and its sentences in order. |
| `Reading/ReadingSession.swift` | A book open: the remote's sentence, the narrator's, playing, the place. |
| `Reading/BookLayout.swift` | The text set in type by TextKit, once, so every sentence's place is known. |
| `Reading/ReaderViewController.swift` | The column on screen, and the remote. |
| `Look.swift`, `Kit.swift`, `Format.swift` | Colours and faces (docs/DESIGN.md), the shapes screens are built from, and times written as the desktop writes them. |
| `Assets.xcassets` | The icon in layers, as tvOS tilts it, and the Top Shelf pictures: made from the app's own icon by `make-icons.sh`. |

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
`RIBBON_PASSWORD`: the simulator's on-screen keyboard is slow. With
`RIBBON_QUICK_WAITS` set (`SIMCTL_CHILD_RIBBON_QUICK_WAITS=1`), it asks Still
listening? after 20 seconds instead of forty minutes, stops 10 seconds later
instead of a minute, and shows the passages after 15 seconds' pause instead
of five minutes. A short silent book (ffmpeg's `anullsrc`) on the scratch
server checks the player without the simulator playing a book aloud. A keyboard
can't hold Select or press Menu, so in a debug build the reader takes Page
Down as Select held and Delete as Menu. The simulator
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

Pages, text sizes, loudness, notes on bookmarks, and books without a narration.

MP3s are never sought in by Apple's player, which goes by the average bitrate
and lands minutes off in a long VBR book: the TV asks the server for the file
from the moment (`?ms=`), and the server sends it from that moment's frame.
