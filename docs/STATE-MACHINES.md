# State machines

Much of Ribbon is a state machine: something that is in one of a few states
and moves between them as things happen. A book is paused, then starting,
then playing; a folder is idle, then scanned; a sleep timer counts down, or
waits while nothing plays. Most of them grew as a flag here and a nullable
field there, and a flag kept apart from the others can disagree with them:
"Reconnecting…" left on screen after the reconnecting stopped, minutes lost
from a sleep timer, a book that downloaded and then didn't play.

This file is the map: every state machine found in a sweep of the whole
repository (November 2026), where it lives, its states, and whether it is
written down yet. Read it before adding a flag.

## How one is written down

1. **One status.** The state is a union, each status carrying only what it
   needs, never several fields that have to agree. In `core/sleep.ts` a
   running clock knows when it ends and a held one how much it has left, so
   the time spent held can't be counted wrongly; there is nowhere to put it.
2. **One place changes it.** A transition function, or a table that answers
   every event in every status (`NEXT` in `core/playback.ts`; the compiler
   holds it to an answer for each). The code around it says what happened,
   and the machine says what that means. Nothing else sets the status.
3. **In core when it needs no files**, so it's tested on its own, like the
   rest of `packages/core`.
4. **Its picture in its doc comment**: the states, and what moves between
   them, in a few lines of text.
5. **Tested by status and event.** When a machine that already worked is
   rewritten, the old one is kept in `test/before/` and both are run through
   every sequence of events up to a length, so the rewrite is proved to do
   what the old one did, except where it's meant not to
   ([TEST-PLAN.md](TEST-PLAN.md), "Before and after").
6. **Listed here**, with the commit or PR that wrote it down.

Three shapes come up again and again, so each has a name and a home:

| Shape | Where | Used by |
| --- | --- | --- |
| **Only the newest ask counts.** Each ask supersedes the ones before it; slow work checks it's still the newest after every wait. | `Latest`, `core/latest.ts` | Opening a book for the player and for the reader. The engine's intent number and the reader's `still()` are the same idea, older. |
| **One at a time, once more when asked again.** An ask while it runs isn't lost or run beside it: it's one more run after, shared by every ask made meanwhile. | `Rerun`, `core/rerun.ts` | A folder's scans. `ServerLog.sync` (`run`/`again`) is the same idea, older. |
| **A table of every status by every event.** | `nextStatus`, `core/playback.ts` | Whether a book plays. |

## Written down

| Machine | Where | States |
| --- | --- | --- |
| Whether a book plays | [`core/playback.ts`](../packages/core/src/playback.ts), told by [`player/engine.ts`](../packages/desktop/src/player/engine.ts) (`move`) | paused, starting, loading, playing, buffering, reconnecting |
| The sleep timer | [`core/sleep.ts`](../packages/core/src/sleep.ts), ticked by the controller | off, counting, held, chapter, done |
| Opening a book, in the player or the reader | `Latest` in `AppController` (`opening`, `readerOpening`) | each ask current until a newer one begins |
| A folder's scans | `Rerun` in `AppController` (`Opened.scans`) | idle, running, running with one more after |
| A page swipe | [`reader/swipe.ts`](../packages/desktop/src/reader/swipe.ts) | idle, pressed, dragging, springing back, sliding (each slide numbered) |
| A book's loudness and silence, measured | [`app/jobs.ts`](../packages/desktop/src/app/jobs.ts) (`JobStatus`) | queued, running, done, failed |
| Transcribing a whole book | [`app/transcribing.ts`](../packages/desktop/src/app/transcribing.ts) (`transcribeWhole`) | its result: whole, stopped, failed |
| A chapter-name lookup | `ui/ChapterList.tsx` (`lookup`) | idle, busy, found, error |
| A dialog opening and closing | `ui/modal.ts` (`useModal`) | closed, open, closing |
| How a server's book reads along | [`packages/server/src/library/readalong.ts`](../packages/server/src/library/readalong.ts) (`stateOf`) | derived from its records, one function |
| A listen-through, read from the log | [`core/stats.ts`](../packages/core/src/stats.ts) (`openRead`, `endOf`) | going, finished, left |
| The daily goal's note | [`core/goal.ts`](../packages/core/src/goal.ts) (`GoalWatch`) | one transition, `see` |
| Resuming and recovering | `core/resume.ts`, `core/recovery.ts` | pure policies; their state is the player's |
| Whether the Apple app's narration plays | [`Listening/Listening.swift`](../packages/apple/Ribbon/Listening/Listening.swift) (`Status`, `next`, `on`) | paused (on its own or not), playing, carded, ended, closed |
| The Apple app's player | [`Listening/BookPlayer.swift`](../packages/apple/Ribbon/Listening/BookPlayer.swift) (`State`, `next`) | resting, paused, playing, held |
| Still listening? | [`Listening/Dozing.swift`](../packages/apple/Ribbon/Listening/Dozing.swift) (`Status`, `become`) | awake, asked, stopping |
| What the remote's next press wakes | [`Remote.swift`](../packages/apple/Ribbon/Remote.swift) (`wait`, `pressed`) | free, waiting (any number, by name) |

## Not written down yet

What holds each one today, in the fields that have to agree. These are the
next to write down, roughly in order of how much they touch.

### The desktop app

| Machine | Where | What holds it today |
| --- | --- | --- |
| The reader's session | `AppState.reading` ([`app/reading.ts`](../packages/desktop/src/app/reading.ts)), written by the controller | `status` (opening, ready, failed) and eleven optional fields beside it: `text`, `place`, `alignment`, `readsAlong`, `listening`, `exporting`, `exported`, `following`, `finding`, `found`, `highlights`; privately `rd`, `readingCtx`, `readingKeeper` |
| What's on screen | `AppState` | `pane`, `readerBookId`, `readerFromBookcase`, `seriesKey`, `playerExpanded`, `playerDrawer`, with `reading` drawn over everything |
| The library's lifecycle | `AppState.phase` | `phase` (boot, pick, loading, ready), `sources`, `error`, and the controller's `opened` |
| The book open in the player | the controller | `current`, `resumeOffer`, `previewing`, `theEnd`, and privately `pausedAt`, `listenedFrom`, `listening`, `chapterProbe` |
| Transcribing, here and for a server | the controller | `hearing`, `hearAgain`, `transcribingServer`, `downloadedToTranscribe`, `untranscribable`, `serverRetry`, `awakeFor`; `transcribingForServer` and `speech` in `AppState` |
| A folder's link to its server | `Opened` | `server`, `serverPlaces`, `serverAdmin`, `serverRefresh`, `serverRefreshSoon`, `serverImports` |
| Questions and offers | `AppState` | `seriesSetup`, `seriesNew`, `moveOffer`, `spaceShort`, `editBook`, `speechNudge`, `goalMet`, `readOnlyNotice` |
| Saving the app's settings | the controller | `settingsTimer`, `settingsWrite`, and writes made directly |
| Keeping places | [`app/positions.ts`](../packages/desktop/src/app/positions.ts) (`PositionKeeper`) | `closed`, `readOnly`, `failures`, `localDirty`, two timers, two runs |
| A server's places, carried | [`app/server/server-log.ts`](../packages/desktop/src/app/server/server-log.ts) | `kept` (null until read), `run`, `again`: a `Rerun` by hand |
| Laying out a book | [`reader/layout-engine.ts`](../packages/desktop/src/reader/layout-engine.ts) | worker, local or gone (`worker`, `local`), `busy`, generations |
| Scrolling and turning in the reader | `reader/ReadingView.tsx` | refs: `quiet`, `pending`, `anchor`, `putBack`, `pressed`, `drawn` |
| Choosing text in the reader | `reader/ReadingView.tsx` | `tap`, `chosen`, `dragging`, and `was` for the narrator coming into view |
| Looking up descriptions | [`app/about.ts`](../packages/desktop/src/app/about.ts) | `abort` doubling as "running" |
| A dialog's work | `ui/Servers.tsx`, `ui/EditBook.tsx`, `ui/PlayerPane.tsx` | `busy`, `saving`, `error`, `freed` per dialog |
| Updating Ribbon | [`app/updates.ts`](../packages/desktop/src/app/updates.ts) (`Updater`) | `first`, `every`, `checking`, `downloaded` with `status.ready` |
| The book in hand on the bookcase | `bookcase3d/lamplit-case.ts`, `ui/BookcasePage.tsx` | `selected` there, `taken` in React, `lastTaken` in the module |
| A tool's run, and stopping it | `host/tauri.ts` (`run`, `stream`) | spawning, spawned, stopped: an abort listener added after the spawn |

### The server

| Machine | Where | What holds it today |
| --- | --- | --- |
| What's been worked out about a book | `book.json` (`StoredBook`, `library/books.ts`) | `analysis`, `filled`, `described`, `placed`, `records`, `ebook`, each read, changed and written back whole by its own job |
| A book, and work still running on it | `library/importer.ts`, `library/books.ts`, `library/routes.ts` | being added (`<id>.adding-*`), listed, deleted (a `deleted_book` row and `.deleting-*`) |
| The job queue | `jobs.ts` | `state` (waiting, running, done, failed) with `started_at`, `finished_at`, `error`: a union, its updates unchecked |
| Invites | `invites.ts` | `reserved_at`, `used_at`, `expires_at`: fresh, held, held too long, used, expired |
| Listen-throughs, written | `readalong-routes.ts` and the desktop's controller | each writes `read` records its own way |
| A book's read-along, made and kept | `library/readalong.ts` | `made`, `standings`, stamped, no work shared |

### The Apple app

| Machine | Where | What holds it today |
| --- | --- | --- |
| Reading along by remote | `Reading/ReadingSession.swift` | `cursor`, `narrator`, `following`, `marking`, `deleting`, `atDozed` |
| The app's screens and the open book | `RibbonApp.swift` (`AppModel`) | `server`, `library`, `adding`, `opening`, `problem`, `listening`, `reading`, `finished`, `path` |
| The sleep timer | `Listening.swift` | an enum, nearly written down: its clock holds and goes on with the narration's status (`on`), but it's set and fired in four places, not one |
| Places told to the server | `Listening.swift` | `toldAt`, `telling`, `unsent`, `checkedAt`, `lookingAgain` |
| The daily goal | `Library/Goal.swift` | `met`, `waiting`, `belowOn`, `asking` and more |
| Presses in the reader | `Reading/ReaderViewController.swift` | `selectHeld`, `heldLong`, `repeater`, `gliding`, `swiped` |
| The bookcase, built and drawn | `Bookcase/Bookcase.swift`, `ShelfRow.swift`, `LongShelf.swift` | `builtFor`, `rows`; `still`, `live`, `picturing`; `walking`, `ready` |

### The Rust side

| Machine | Where | What holds it today |
| --- | --- | --- |
| Quitting | `src-tauri/src/quit.rs` | one `HEARD` flag, shared by every quit |
| The speech model | `src-tauri/speech/src/lib.rs` | a `Mutex<Option<Listener>>`: none, loaded, or busy while locked |
| The read-along export | `src-tauri/src/ebook/export.rs` | a temporary folder per process, a `failed` slot as the stop |
| A file in a scan | `src-tauri/src/scan.rs`, `core/host.ts` | `pending` and `fresh` together, and a zero duration for unreadable |
| A download | `src-tauri/src/server.rs`, `src-tauri/src/speech.rs`, `host-node` | how big the `.part` file is |
| Staying awake | `src-tauri/src/awake.rs` | one holder, no count |
| A file's frame index | `src-tauri/src/frames.rs` | a cache and one lock for every file |
