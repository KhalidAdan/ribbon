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

Four shapes come up again and again, so each has a name and a home:

| Shape | Where | Used by |
| --- | --- | --- |
| **Only the newest ask counts.** Each ask supersedes the ones before it; slow work checks it's still the newest after every wait. | `Latest`, `core/latest.ts` | Opening a book for the player and for the reader. The engine's intent number and the reader's `still()` are the same idea, older. |
| **One at a time, once more when asked again.** An ask while it runs isn't lost or run beside it: it's one more run after, shared by every ask made meanwhile. | `Rerun`, `core/rerun.ts` | A folder's scans. `ServerLog.sync` (`run`/`again`) is the same idea, older. |
| **A table of every status by every event.** | `nextStatus`, `core/playback.ts` | Whether a book plays. |
| **One at a time per book, and nothing after it's gone.** Each write into a thing's folder takes its turn; slow work is done before the turn, and only what it found is kept in it. Deleting it is a turn too, so nothing writes there after. | `inTurn`, `packages/server/src/library/book-folder.ts` | Everything written into a book's folder on the server. |

## Written down

| Machine | Where | States |
| --- | --- | --- |
| Whether a book plays | [`core/playback.ts`](../packages/core/src/playback.ts), told by [`player/engine.ts`](../packages/desktop/src/player/engine.ts) (`move`) | paused, starting, loading, playing, buffering, reconnecting |
| The sleep timer | [`core/sleep.ts`](../packages/core/src/sleep.ts), ticked by the controller | off, counting, held, chapter, done |
| Opening a book, in the player or the reader | `Latest` in `AppController` (`opening`, `readerOpening`) | each ask current until a newer one begins |
| A folder's scans | `Rerun` in `AppController` (`Opened.scans`) | idle, running, running with one more after |
| A page swipe | [`reader/swipe.ts`](../packages/desktop/src/reader/swipe.ts) | idle, pressed, dragging, springing back, sliding (each slide numbered) |
| The reader's session | [`core/reading/session.ts`](../packages/core/src/reading/session.ts) (`readingAfter`), told by the controller (`toReading`) | opening, failed, ready; a ready book's export: none, exporting, made, failed; a ready book reads along or reads only, and goes back to reading only when read-along is turned off for it |
| What's on screen | [`core/screen.ts`](../packages/core/src/screen.ts) (`screenAfter`), told by the controller (`toScreen`) | library, settings, stats, bookcase, a series' page (its series), a book's page (its book, from the bookcase or not); the full player closed or open on a drawer; the reader over both |
| The library's lifecycle | [`core/lifecycle.ts`](../packages/core/src/lifecycle.ts) (`phaseOf`), each folder's `SourceStatus.state` set by the controller | a folder: opening, open, failed; the app: boot, pick, loading, ready, worked out from its folders and never set |
| Transcribing, here and for a server | [`core/transcriber.ts`](../packages/core/src/transcriber.ts) (`transcribingAfter`), told by the controller (`toTranscribing`) | the open book: idle, hearing (once more after); a server's worker: idle, working, waiting a while; awake worked out from them. Beside it, as sets of books rather than a status: `downloadedToTranscribe`, `untranscribable` |
| A book's loudness and silence, measured | [`app/jobs.ts`](../packages/desktop/src/app/jobs.ts) (`JobStatus`) | queued, running, done, failed |
| Transcribing a whole book | [`app/transcribing.ts`](../packages/desktop/src/app/transcribing.ts) (`transcribeWhole`) | its result: whole, stopped, failed |
| A chapter-name lookup | `ui/ChapterList.tsx` (`lookup`) | idle, busy, found, error |
| Moving the Ribbon folder | [`core/home-move.ts`](../packages/core/src/home-move.ts) (`homeMoveAfter`), told by the controller (`toHomeMove`); the copy itself in `home_move.rs` | none, asking (the plan), refused (why), moving (bytes done), failed (why), restarting |
| A dialog opening and closing | `ui/modal.ts` (`useModal`) | closed, open, closing |
| How a server's book reads along | [`packages/server/src/library/readalong.ts`](../packages/server/src/library/readalong.ts) (`stateOf`) | derived from its records, one function |
| What's been worked out about a server's book | [`packages/server/src/library/book-folder.ts`](../packages/server/src/library/book-folder.ts) (`BookInTurn.change`, `changeStored`) | `book.json`, changed in one step on the record as it is then: each job keeps only what it worked out (`analysis`, `filled`, `described`, `placed`, `records`, `ebook`) |
| A server's book, and work still running on it | `book-folder.ts` (`inTurn`, `removeBookDir`), and the search index (`SearchIndex.index`) | added, listed, written in its turn, deleted in its turn: nothing is written or indexed for it after |
| The server's job queue | [`packages/server/src/jobs.ts`](../packages/server/src/jobs.ts) (`NEXT`, `move`) | waiting, running, done, failed |
| Invites | [`packages/server/src/invites.ts`](../packages/server/src/invites.ts) (`statusOf`, `NEXT`) | fresh, held, used, expired |
| A listen-through, written | [`core/listen-through.ts`](../packages/core/src/listen-through.ts) (`readAfter`), asked by the server's `/listened`, `/finished` and `/unfinished` | none, going, finished |
| A server's book's read-along, made and kept | `packages/server/src/library/readalong.ts` (`ReadAlongs.of`) | not made, or made with its stamp; made again when its stamp changes |
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
| The book open in the player | the controller | `current`, `resumeOffer`, `previewing`, `theEnd`, and privately `pausedAt`, `listenedFrom`, `listening`, `chapterProbe` |
| A folder's link to its server | `Opened` | `server`, `serverPlaces`, `serverAdmin`, `serverRefresh`, `serverRefreshSoon`, `serverImports` |
| Questions and offers | `AppState` | `seriesSetup`, `seriesNew` (one at a time, kept so by hand), `moveOffer`, `spaceShort`, `editBook`, `speechNudge`, `goalMet`, `readOnlyNotice` |
| Saving the app's settings | the controller | `settingsTimer`, `settingsWrite`, and writes made directly |
| Keeping places | [`app/positions.ts`](../packages/desktop/src/app/positions.ts) (`PositionKeeper`) | `closed`, `readOnly`, `failures`, `localDirty`, two timers, two runs |
| A server's places, carried | [`app/server/server-log.ts`](../packages/desktop/src/app/server/server-log.ts) | `kept` (null until read), `run`, `again`: a `Rerun` by hand |
| Laying out a book | [`reader/layout-engine.ts`](../packages/desktop/src/reader/layout-engine.ts) | worker, local or gone (`worker`, `local`), `busy`, generations |
| Scrolling and turning in the reader | `reader/ReadingView.tsx` | refs: `quiet`, `pending`, `anchor`, `putBack`, `pressed`, `drawn` |
| Choosing text in the reader | `reader/ReadingView.tsx` | `tap`, `chosen`, `dragging`, and `was` for the narrator coming into view |
| Looking up descriptions | [`app/about.ts`](../packages/desktop/src/app/about.ts) | `abort` doubling as "running" |
| A dialog's work | `ui/Servers.tsx`, `ui/EditBook.tsx`, `ui/PlayerPane.tsx` | `busy`, `saving`, `error`, `freed` per dialog |
| Updating Ribbon | [`app/updates.ts`](../packages/desktop/src/app/updates.ts) (`Updater`) | `first`, `every`, `checking`, `downloaded` with `status.ready` |
| The book in hand on the bookcase | `bookcase3d/lamplit-case.ts`, `ui/BookcasePage.tsx` | `selected` (asked for) and `lifted` (off its shelf) there, `taken` in React, `lastTaken` in the module |
| The bookcase's lamps coming on | [`core/bookcase/lighting.ts`](../packages/core/src/bookcase/lighting.ts) (`nextToLight`, `lampsOnInView`), run by `bookcase3d/lamplit-case.ts` | each shelf dark or `lit`; `lighting` (one at a time), `laid` (a generation), `view`, and `moving` holding back the shelves out of view |
| The bookcase's shaders, compiled ahead | `bookcase3d/warm-up.ts` | `warming`, `idle` (asked of the library's invitation: still on screen), and what was done, kept in `localStorage` by version and lamp count |
| A tool's run, and stopping it | `host/tauri.ts` (`run`, `stream`) | spawning, spawned, stopped: an abort listener added after the spawn |
| A listen-through, written | the controller (`beginListening`, `markFinished`, `markUnfinished`, `listenAgain`) | each writes `read` records its own way; `readAfter` in `core/listen-through.ts` answers the same, but for one thing: marking a finished book finished writes nothing there, where the controller writes another listen-through, begun and finished at once |

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
