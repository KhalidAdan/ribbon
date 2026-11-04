# Ribbon on the Apple TV, the iPad and the iPhone

A book from your Ribbon server, its text on the screen and its narration
playing, the sentence being read marked in amber as it goes: read-along
from the sofa. The TV only draws and plays; the server does the thinking
(docs/SERVER.md, section 8).

tvOS has no web view, so Ribbon's own UI can't run on it, and Tauri doesn't
build for it: this is a small native app in SwiftUI and UIKit, talking to the
server's API. It keeps only who has signed in on it; tvOS may clear an app's
files at any time, so the audio streams and the place lives on the server.

The same app runs on the iPad and the iPhone, with the TV's screens by touch
(below). They have a web view, so that's a choice, not a need: the TV's
read-along is the one the owner reads with, and every device you read and
listen on is a thin client of the server (docs/NORTHSTAR.md). Like the TV it
has no folders of its own and never transcribes, so all three need a server;
only the desktop app runs without one. Ribbon in Tauri stays the
whole app on the desktop; on the iPhone it retires once this app keeps books
for listening without a network.

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
  it, then every other book. The series are the server's (`GET
  /api/series`), the same on every device, with each book's number and its
  title as the series lists it. A card is one button, which opens the
  book's page; play is there. While a book plays, its title at the top opens the
  player. Menu goes back to Who's reading, when there's more than one person.
- **Stats**, at the top of the library, as the desktop's Stats has them:
  this week as a sentence, a day lately, the streak and the books finished
  this year; a square for each day of the last year; the books and authors
  you spent most time with, the narrators listened to most; and the books
  finished lately. The server counts them from every device's listening
  sessions and time spent reading (`GET /api/stats`).
- **Time spent reading** counts, as listening does: in the reader, with the
  narration paused, from the first move to the last and a minute after,
  ending after five minutes without one. It goes to the server as the
  desktop's reader keeps it (`POST /api/books/:id/reading`), under Keep
  listening sessions.
- **Settings**, from your name at the top of the library: Keep listening
  sessions (as the desktop's Settings has it, docs/POSITION-FORMAT.md,
  section 3.3: off, the end of a book won't count the time spent on this TV),
  who's signed in to which server, and Switch reader.
- **A book's page**: where you are as a sentence, Continue listening and Read
  along, and More: Mark as finished, or not finished after all, and Start
  again from the beginning, as the desktop's book page has them. Then the
  facts, the description, your history with it (every listen-through, when
  it started and how it ended, and the time spent in it on every device),
  and the rest of its series. Listen again, on a finished book, always
  starts from the beginning as a new listen-through, as the desktop's does.
- **The player**: the chapter and how far into it, the transport (chapters,
  thirty seconds back and on), speed, the sleep timer, and the chapter list.
  The player and the reader share one narration: leaving either leaves the
  book playing. Every book plays at the same loudness, as on the desktop:
  the server measures each once, and the app brings it to −18 LUFS without
  its peaks clipping, at most 12 dB either way (`Listening/Loudness.swift`,
  mirroring packages/core/src/loudness.ts). Apple's player volume stops at
  1, so the gain is made on the samples, by an audio tap on each file.
  Speed is per book, and follows you: a book opens at the speed it was
  last heard at on any device (its newest listening session), unless this
  device chose one for it since, as the desktop does
  (packages/core/src/settings.ts, `speedToPlay`). Paused, the transport
  moves the place and leaves it paused, as the desktop's does. The sleep
  timer counts listening: its clock waits while the book is paused, it fades
  over the last fifteen seconds, and +15 min turns one waiting for the
  chapter's end into minutes, as the desktop's (packages/core/src/sleep.ts).
- **Read along**: the book as one long column (scroll only, no pages), set in
  the reader's own face (Newsreader). The sentence being read is washed in
  amber, and the column glides when it leaves the middle of the screen. Once
  the narration has played five seconds with your sentence following it, the
  words not being read step back (the river); moving off the narrator, or
  pausing, brings them back at once (a tenth of a second). A book whose
  read-along is by chapter says so for a few seconds as it opens: the words
  can be up to a minute from the voice. Reading on away from the narrator
  while it's paused is reading, as it is on the desktop: once you rest on a
  sentence for five seconds, and as you leave the book, it goes to the
  server as your reading place, so every device opens there and Continue
  listening carries on from it. On the iPad and the iPhone, the contents
  (the list beside Aa) go to a chapter's first sentence.
- **Books that are only their text** are on the shelf as on the desktop,
  "EPUB" where a recording would say how long it is, and "42% read" once
  started. Their page reads them (Read, Continue reading), in the same column
  with nothing to play: where you are is the sentence you're on, kept as your
  reading place, and the server finds lines in them too.
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
  The player bookmarks the moment playing (Bookmark this moment), as the
  desktop's player does, and so does the lock screen's bookmark; either
  offers a note, typed or said. The player lists the book's bookmarks from
  every device with their notes, and listens from the one chosen; holding
  one offers to write or change its note, or to delete it.
- **Search**, at the top of the library, opens with its field ready, so
  holding the remote's microphone button and saying a title, an author, or
  what you remember is enough ("where the scarecrow gets his brains");
  typing works too. The books whose title, author, narrator or series have
  every word come first, as the desktop's search finds them, and choosing
  one opens its page. Then the lines: the server searches every book's
  sentences, and choosing one opens Read along on it, the narrator where it
  was: left listens from it.
- **Your place** goes to the server as you listen, the way the phone's and
  the desktop's do, and the book opens at the newest of your places on any
  device, listening or reading: Continue listening carries on from where you
  read to, when that's newer, as the desktop's does. A book left paused here
  doesn't keep an old place: after half a minute paused, playing on asks the
  server first, and so does coming back to the app, so it carries on from
  where another device left it rather than tell the server this one's older
  place as the newest (the desktop's `takeSharePositions`).
- **Resuming** goes back by as much as the time away asks, as the desktop's
  does (packages/core/src/resume.ts, mirrored in `Listening/Resume.swift`): two
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

## On the iPad and the iPhone

Everything above, with the finger for the remote. Every size is the TV's,
drawn at seven tenths on the iPad and at 0.65 on the iPhone (`Look.scale`):
the TV's 24-point text is the iPad's 17, and its 26-point rows the phone's
17. What the TV sets side by side (a book's page, the player, the end of a
book) stacks when the screen is upright. The iPad's reader column is narrow
enough for an iPad mini held upright, so turning the iPad keeps every line
where it was; the iPhone's is its screen less 20 points either side, in
19-point Newsreader, about forty letters a line.

The iPhone is held upright, and on a screen as narrow as a phone's
(`narrow`, under 500 points: also an iPad sharing its screen) what the TV
sets in a row wraps or says less. The edges are a phone's 20 points; the
library's bar is Ribbon's mark with Search and the settings as their glyphs,
and the book playing has a row of its own under it; the cards in a row are
as wide as the screen and the shelf is two to a row; a book's buttons stack;
the player has its cover above its title and the sleep timer's choices on
two rows; and the reader's buttons say From here and To narrator.

- **Taps** for the focus and Select: the primary button is in inverted ink, as
  the desktop's is, and a press shrinks a button to 97% and a card to 98%
  (docs/DESIGN.md, section 7). Menu is a way back at the top left of each
  screen, named for where it goes; sheets have Done, and the sign-in Cancel.
  From the library, Who's reading is Switch reader, in Settings.
- **The reader**: the finger moves the column, and the sentence at the eye
  line, a third of the way down, is the one you're on, as a swipe on the
  remote glides through them. Tapping a sentence goes to it, and tapping it
  again listens from it. Under the column are the remote's buttons: Listen
  from here and Return to narrator either side of play when you're away from
  the narrator, and, following it, Again, which is the remote's Left (from
  the start of the sentence being read, and a sentence further back each
  time). Holding a sentence starts a bookmark, tapping or scrolling takes in
  more, and Keep bookmark or Cancel finish it; holding a bookmark offers to
  delete it. Turning the iPad keeps your sentence where the eyes are.
- **Aa**, at the far right of the reader's buttons while you follow the
  narrator, opens a low sheet, as Apple Books does: the words bigger or
  smaller (eight sizes, the third the device's own) and the lines snug,
  normal or roomy. The book is set again behind the sheet at each choice, your
  sentence staying where the eyes are, and the choice is kept on the device,
  since a small phone reads bigger than an iPad (`TextSettings`).
- **A keyboard** in the reader: the arrows are the remote's edges and space
  is its Play.
- **Any touch** answers Still listening? and brings back the screen from the
  passages, and goes no further, as a press does on the TV (`Remote.swift`).
- **The lock screen**, Control Center, headphones and the car: play and
  pause, thirty seconds back and on, the chapter before and the next (a
  double or triple press of the headphones), and the place on the line, with
  the cover. A phone call, Siri, or the headphones coming out pause the book
  as Pause does, its place kept; a call that ends gives it back, a little
  before where it stopped. A stream that drops partway is asked for again
  from the moment it reached (`BookPlayer.swift`).

## Where the read-along comes from

`GET /api/books/:id/readalong` (packages/server/src/readalong-routes.ts): the book's
paragraphs, and when each sentence is read. The server makes it once per
book, with the same code the apps use: the EPUB parsed by `ribbon-ebook`
(packages/desktop/src-tauri/ebook) and paired with the narration by `packages/core/src/reading/`. A
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
| `Listening/Resume.swift` | How far back resuming goes, as the desktop's `packages/core/src/resume.ts`. |
| `Listening/Loudness.swift` | Every book at the same loudness, as the desktop's `packages/core/src/loudness.ts`: the gain, and the tap that makes it. |
| `Listening/Dozing.swift` | Still listening?, and where you dozed off. |
| `Listening/Cards.swift`, `Listening/FinishedView.swift`, `Listening/PassagesView.swift` | A chapter's card and Still listening?, the end of a book, and the passages. |
| `Library/StatsView.swift` | What you've been listening to, as the desktop's Stats. |
| `Library/SearchView.swift` | Search, by voice or typing: a book by its title, author or narrator, or a line in every book. |
| `Listening/Bookmarks.swift` | A book's bookmarks from every device: made of whole sentences here, words or moments elsewhere. |
| `Listening/BookPlayer.swift` | The narration, streamed: the book's files as one timeline. |
| `Listening/PlayerView.swift` | The full player, and the chapter list. |
| `Reading/ReadAlong.swift` | The read-along as the server sends it, and its sentences in order. |
| `Reading/ReadingSession.swift` | A book open: the remote's sentence, the narrator's, playing, the place. |
| `Reading/BookLayout.swift` | The text set in type by TextKit, once, so every sentence's place is known. |
| `Reading/ReaderViewController.swift` | The column on screen, and the remote. |
| `Look.swift`, `Kit.swift`, `Format.swift` | Colours and faces (docs/DESIGN.md), the TV's sizes as the iPad draws them, the shapes screens are built from and how a press shows on each, and times written as the desktop writes them. |
| `Assets.xcassets` | The icon in layers, as tvOS tilts it, and the Top Shelf pictures; the iPad's icon whole. All made from the app's own icon by `make-icons.sh`. |

## Building it

Xcode (with the tvOS and iOS platforms), [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`), and the repository's npm packages, which bring the
fonts (`npm install` at the root).

```bash
cd tv
xcodegen generate
open Ribbon.xcodeproj
```

The Xcode project is made from `project.yml` and isn't kept in the
repository. It has one app, `Ribbon`, for both the Apple TV and the iPad
(`app.ribbon.tv` on each, as one app). Pick your team in Xcode's Signing tab
when running on a real Apple TV or iPad; it goes into the generated project
only, never into this public repository.

### In the simulator

Against a scratch server (packages/server/README.md), never the real one:

```bash
xcodebuild -project Ribbon.xcodeproj -scheme Ribbon -sdk appletvsimulator -derivedDataPath build build
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

On the iPad simulator, the same, for the iOS simulator:

```bash
xcodebuild -project Ribbon.xcodeproj -scheme Ribbon -destination 'generic/platform=iOS Simulator' -derivedDataPath build build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/Ribbon.app
SIMCTL_CHILD_RIBBON_SERVER=http://localhost:7766 SIMCTL_CHILD_RIBBON_NAME=<name> SIMCTL_CHILD_RIBBON_PASSWORD=<password> xcrun simctl launch booted app.ribbon.tv
```

iPadOS leaves what's typed in a password field out of screenshots, so a
screenshot of the sign-in shows that field empty.

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

### On an iPad or an iPhone

Connect it to the Mac, with Developer Mode on (Xcode 27's Device Hub shows
it; iPadOS and iOS offer the switch, in Settings → Privacy & Security, only
once Xcode has reached for the device), and your Apple ID in Xcode's
Accounts. Then run the `Ribbon` scheme on it, or from the command line:

```bash
xcodebuild -project Ribbon.xcodeproj -scheme Ribbon -configuration Release -destination 'platform=iOS,id=<udid>' -derivedDataPath build DEVELOPMENT_TEAM=<team> -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device <device> build/Build/Products/Release-iphoneos/Ribbon.app
```

The first time, trust the developer on the device (Settings → General → VPN &
Device Management). A free Apple ID signs it for seven days.

## The contract with the server

`RibbonTests/Contract/` holds the server's real answer to everything this app
asks, written by `packages/server/test/api-contract.test.ts` from a running server, and
`RibbonTests/ContractTests.swift` decodes each with the app's own types. Change
what the server answers and the server's test fails until the files are written
again (`npx vitest run test/api-contract -u`); this app's test then says whether
it can still read them.

```bash
xcodebuild test -project Ribbon.xcodeproj -scheme Ribbon -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=NO
```

## Not yet

On the iPhone, books stream as they do on the iPad and the TV: nothing is
downloaded for listening without a network yet. On the iPad, a window
narrower than the reader's column (Split View, or a small window beside
others) cuts the column's edges. While a book is paused
in the player or the reader, the iPad's screen stays on for the passages, an
hour at most, as the TV's does.

Pages, and trimming silences. The contents on the TV: the player's chapter
list moves the narrator instead, and a book that is only its text has no
player, so on the TV it's read with up, down and swipes. A bookmark made
here keeps no thirty-second clip, as the desktop's do: the desktop plays a
bookmark's lead-in from the book itself anyway.

MP3s are never sought in by Apple's player, which goes by the average bitrate
and lands minutes off in a long VBR book: the TV asks the server for the file
from the moment (`?ms=`), and the server sends it from that moment's frame.
