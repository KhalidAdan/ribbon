import MediaPlayer
import Observation
import UIKit

/// The book being listened to: the TV's one narration, which the player
/// shows as a player and the reader as the sentence being read. One book at
/// a time, as on the desktop: starting another stops this one, and its place
/// is kept.
///
/// The place goes to the server as it moves, the way the apps write theirs
/// (docs/POSITION-FORMAT.md, `why`), so the phone and the desktop carry on
/// where the TV left off. So does each stretch of listening, as the desktop
/// keeps one, unless the person turned that off, so the end of the book can
/// say how long it took.
///
/// Resuming goes back a little, by as much as the time away asks (Resume).
/// After a while paused, it first asks the server where the person is: another
/// device may have moved on in the book meanwhile, and playing on from this
/// one's older place would tell that as the newest (`lookAgain`), as the
/// desktop moves a paused book to a newer place (`takeSharePositions`).
/// Crossing into a new chapter, where the book is on screen, the narration
/// waits a moment while the chapter's card shows. Played on for forty
/// minutes with nothing pressed, it asks whether you're still listening
/// (Dozing).
///
/// Whether it plays is one status, changed in one place (`on`), by a table
/// that answers every event in every status (`next`); the player follows
/// it, and so do the screen kept awake while it plays, the sleep timer's
/// clock, the doze and how loud it plays (docs/STATE-MACHINES.md):
///
/// ```
///  paused ── play ──▶ playing ── a chapter's start, on screen ──▶ carded ── its moment passes ──▶ playing
///  playing, carded ── paused, by hand or the system ──▶ paused
///  playing, carded ── stopped on its own: the sleep timer, dozing off ──▶ paused, on its own
///  any ── the last file's end ──▶ ended ── play ──▶ playing, from the start, a new listen-through
///  paused, ended ── moved ──▶ paused
///  any ── closed ──▶ closed
/// ```
@MainActor
@Observable
final class Listening {
    let book: ServerBook
    let detail: ServerBookDetail
    /// Its bookmarks, which the reader and the player share.
    let bookmarks: Bookmarks
    let dozing: Dozing

    /// Whether it plays: changed only by `on`.
    private(set) var status: Status
    /// The moment of the recording, a few times a second while it plays.
    private(set) var positionMs: Int
    private(set) var speed: Double
    /// When the sleep timer stops the narration, if it's set.
    private(set) var sleep: Sleep?
    /// After a day away: the start of the chapter, offered until it's taken or something else is chosen.
    private(set) var resumeOffer: ResumeOffer?
    /// How the listen-through went, once the book has ended and the server has closed it.
    private(set) var finishedRead: ListenThrough?

    /// Playing, as far as anyone asks: while a chapter's card holds it too.
    var playing: Bool { status.plays }
    /// When it was last paused or stopped, and whether it stopped on its own: resuming goes back by how long, and
    /// a book the sleep timer, dozing off or its end stopped doesn't bring up the passages (AppModel).
    var pausedAt: Date? { status.pausedAt }
    var stoppedOnItsOwn: Bool { status.onItsOwn }
    /// The chapter whose card shows while the narration waits for it, by its place in the list.
    var card: Int? { status.card }

    enum Status: Equatable {
        /// Nothing plays. `since` is when it stopped, for how far resuming goes back, or nil for a place chosen
        /// exactly; `onItsOwn` when the sleep timer or dozing off stopped it.
        case paused(since: Date?, onItsOwn: Bool)
        case playing
        /// Playing, and waiting a moment while this chapter's card shows: the player is held.
        case carded(Int)
        /// Played to its end, then: nothing is left to play.
        case ended(Date)
        /// Out of the book: nothing plays it again.
        case closed

        var plays: Bool {
            switch self {
            case .playing, .carded: true
            case .paused, .ended, .closed: false
            }
        }

        var pausedAt: Date? {
            switch self {
            case .paused(let since, _): since
            case .ended(let at): at
            case .playing, .carded, .closed: nil
            }
        }

        var onItsOwn: Bool {
            switch self {
            case .paused(_, let onItsOwn): onItsOwn
            case .ended: true
            case .playing, .carded, .closed: false
            }
        }

        var card: Int? {
            if case .carded(let index) = self { return index }
            return nil
        }
    }

    /// What happens to the narration: what the person asks, what the player and the system say, and the narration
    /// reaching a chapter's start.
    enum Event {
        /// Play, from a moment, or on from where the player is (nil).
        case play(from: Int?)
        /// Paused, by the person or by the system: a call, the headphones going.
        case pause
        /// Stopped on its own: the sleep timer, or dozing off.
        case stopOnItsOwn
        /// A chapter's start, reached with the book on screen: the narration waits while its card shows.
        case card(Int)
        /// The card has shown for its moment: on from the chapter's start, or from where it waits (nil).
        case cardPassed(from: Int?)
        /// The last file played to its end.
        case end
        /// Moved while it doesn't play: to a place chosen exactly (nil), or to one another device kept then.
        case move(since: Date?)
        /// Out of the book.
        case close
    }

    /// What each event makes of each status: the next, or nil where it changes nothing.
    static func next(_ status: Status, on event: Event, at now: Date) -> Status? {
        switch (status, event) {
        case (.closed, _): return nil
        case (_, .close): return .closed
        case (_, .play): return .playing
        case (.playing, .pause), (.carded, .pause): return .paused(since: now, onItsOwn: false)
        case (.playing, .stopOnItsOwn), (.carded, .stopOnItsOwn): return .paused(since: now, onItsOwn: true)
        case (.paused, .pause), (.paused, .stopOnItsOwn), (.ended, .pause), (.ended, .stopOnItsOwn): return nil
        case (.playing, .card(let index)): return .carded(index)
        case (_, .card): return nil
        case (.carded, .cardPassed): return .playing
        case (_, .cardPassed): return nil
        case (_, .end): return .ended(now)
        case (.paused(_, let onItsOwn), .move(let since)): return .paused(since: since, onItsOwn: onItsOwn)
        // Moved back into a book played to its end: paused there, as it stopped, on its own.
        case (.ended, .move(let since)): return .paused(since: since, onItsOwn: true)
        // Moved while it plays is played from there instead.
        case (.playing, .move), (.carded, .move): return nil
        }
    }

    enum Sleep: Equatable {
        /// After so many minutes of listening: when that is if it plays on, and, while it's paused, since when. The
        /// clock holds while it's paused, as the desktop's does (packages/core/src/sleep.ts).
        case at(Date, pausedAt: Date?)
        /// At the end of the chapter that was playing.
        case endOfChapter(endMs: Int)
    }

    struct ResumeOffer: Equatable {
        let chapterStartMs: Int
        let awayMs: Int
    }

    /// Every moment heard, for the reader to follow.
    @ObservationIgnored var onTime: ((Int) -> Void)?
    /// The narration stopped on its own: at the book's end, the sleep timer's, or dozing off.
    @ObservationIgnored var onStop: (() -> Void)?
    /// The book played to its end.
    @ObservationIgnored var onFinish: (() -> Void)?
    /// Whether a chapter's card can show now: the book is on screen, and the app is in front (AppModel).
    @ObservationIgnored var showsCards: () -> Bool = { false }
    /// Whether the app is in front, where its presses can be seen: behind the home screen, nobody is asked if
    /// they're still listening, since their presses go to other apps.
    @ObservationIgnored var inFront: () -> Bool = { true }
    /// Whether this person keeps their stretches of listening as sessions (docs/POSITION-FORMAT.md, section 3.3).
    @ObservationIgnored var keepsSessions = true
    /// The book's sentences, once the reader or the doze has needed them: resuming starts at one, and dozing off
    /// stops at the end of one.
    @ObservationIgnored var sentences: Sentences?
    /// A finished book started again from its start: a new listen-through, which its next stretch opens.
    @ObservationIgnored var startingAgain = false
    /// Where the person is in this book on the server, newest of every device, listening or reading (AppModel).
    @ObservationIgnored var newestPlace: (() async -> (ms: Int, at: Date?)?)?

    @ObservationIgnored private let player: any Player
    @ObservationIgnored private let server: RibbonServer
    @ObservationIgnored private var toldAt = Date.distantPast
    /// Places told and not answered yet, and whether the last one answered failed: until each has landed, the
    /// server's newest place may be older than this one, and is no place to move to.
    @ObservationIgnored private var telling = 0
    @ObservationIgnored private var unsent = false
    /// When the server last said nothing was newer than this place: as the book opened, or a place told landed.
    @ObservationIgnored private var checkedAt = Date()
    /// Asking the server where the person is, before playing on: a second press meanwhile waits for it.
    @ObservationIgnored private var lookingAgain = false
    /// The stretch of listening playing now: from when, and from which moment.
    @ObservationIgnored private var stretch: (start: Date, fromMs: Int, speed: Double)?
    /// The moment heard last while playing on; nil after a move, so a chapter is crossed only by playing into it.
    @ObservationIgnored private var lastHeard: Int?
    /// The next moment to stop or wait at, met by a timer set as it nears.
    @ObservationIgnored private var mark: (ms: Int, kind: Mark, timer: Timer)?
    /// The last chapter carded, so a card shows once for each crossing.
    @ObservationIgnored private var carded: Int?
    @ObservationIgnored private var cardShown: Task<Void, Never>?
    /// The read-along is being asked for, for its sentences.
    @ObservationIgnored private var learning = false

    private enum Mark: Equatable {
        case dozed, chapter(Int)
    }

    /// While the narration plays, the place goes to the server this often.
    private static let tellEvery: TimeInterval = 15
    /// Paused longer than this, playing on first asks the server where the person is.
    private static let lookAgainAfter: TimeInterval = 30
    /// The sleep timer fades the narrator out over this long before it stops, as the desktop's (packages/core/src/sleep.ts).
    private static let fadeMs = 15_000
    /// Thirty seconds back and on, from the buttons and from the lock screen, the headphones and the car.
    static let skipMs = 30_000
    /// How long the narration waits on a chapter's card, which wipes in and out either side.
    static let cardHold: Duration = .seconds(2.6)
    /// The speeds there are, and the step between them, as the desktop's (packages/core/src/speed.ts).
    static let slowest = 0.5
    static let fastest = 3.0
    static let speedStep = 0.05

    /// `placedAt` is when the place started from was kept: resuming from it goes back by how long ago that was. `heard`
    /// is the speed the book was last heard at, on any device, and when. `player` plays it; BookPlayer, streaming the
    /// book's files from the server, unless the tests give a stand-in.
    init(book: ServerBook, detail: ServerBookDetail, startMs: Int, placedAt: Date?, heard: (speed: Double, at: Date)? = nil, server: RibbonServer, player given: (any Player)? = nil) {
        self.book = book
        self.detail = detail
        self.server = server
        bookmarks = Bookmarks(server: server, bookId: book.id)
        dozing = Dozing(account: server.account, book: book, at: startMs)
        positionMs = startMs
        status = .paused(since: placedAt, onItsOwn: false)
        let kept = UserDefaults.standard
        speed = Self.speedToPlay(
            chosen: kept.object(forKey: Self.speedKey(server.account, book)) as? Double ?? 1,
            at: kept.object(forKey: Self.speedAtKey(server.account, book)) as? Date,
            heard: heard
        )
        var fileStart = 0
        player = given ?? BookPlayer(files: detail.files.map { file in
            defer { fileStart += file.durationMs }
            return .init(url: server.fileURL(book: book.id, path: file.path), startMs: fileStart, durationMs: file.durationMs)
        }, cookie: server.account.cookie, gainDb: detail.gainDb)
        player.speed = speed
        player.nowPlayingTitle = book.title
        player.nowPlayingAuthor = book.author
        player.onTime = { [weak self] ms in self?.heard(ms) }
        player.onEnd = { [weak self] in self?.ended() }
        player.onSystemPause = { [weak self] in self?.pausedBySystem() }
        player.onSystemResume = { [weak self] in Task { await self?.carryOn() } }
        listenToRemoteCommands()
        showCover()
    }

    // What there is to show ------------------------------------------------

    var durationMs: Int { book.durationMs }

    /// Listening going on now and not sent yet: the stretch playing, in wall-clock time (the daily goal counts it).
    var stretchMs: Int {
        guard playing, let stretch else { return 0 }
        return max(0, Int(Date().timeIntervalSince(stretch.start) * 1000))
    }

    /// Whether anything has played yet: before, Play resumes from the place kept.
    var loaded: Bool { player.loaded }

    var chapters: [ServerBookDetail.Chapter] { detail.chapters }

    /// The chapter playing, by its place in the book's list.
    var chapterIndex: Int {
        max(0, chapters.lastIndex { $0.startMs <= positionMs } ?? 0)
    }

    var chapter: ServerBookDetail.Chapter? {
        chapters.indices.contains(chapterIndex) ? chapters[chapterIndex] : nil
    }

    /// Where the person dozed off, while it's behind where the narration is: what going back there would give.
    var dozedOffer: Int? {
        dozing.dozedAt.flatMap { $0 < positionMs - 5_000 ? $0 : nil }
    }

    // What the remote asks -------------------------------------------------

    /// Play from a moment of the book: a place chosen, so it plays from there exactly, with no rewind on the next
    /// resume and nothing to offer.
    func play(from ms: Int) {
        positionMs = min(max(0, ms), durationMs)
        resumeOffer = nil
        guard on(.play(from: positionMs)) else { return }
        tell(.seek)
    }

    /// Play on from where the person is. After a while paused, ask the server first: another device may have moved on
    /// (`lookAgain`). Then back a little (`resume`). The moment it plays from, before any lead-in.
    @discardableResult
    func carryOn() async -> Int {
        guard !playing, !lookingAgain else { return positionMs }
        if Date().timeIntervalSince(checkedAt) > Self.lookAgainAfter {
            lookingAgain = true
            await lookAgain()
            lookingAgain = false
        }
        // Pressed again, or played some other way, while the server was asked.
        guard !playing else { return positionMs }
        return resume()
    }

    /// Where the person is on the server, asked again; when another device has moved on since this one's place, go
    /// there. Nothing moves while it plays, or while a place told here hasn't landed.
    func lookAgain() async {
        guard !playing, let newestPlace, let found = await newestPlace() else { return }
        checkedAt = Date()
        catchUp(to: found.ms, at: found.at)
    }

    /// The person is somewhere else in the book, kept by another device since this one's place: go there, paused,
    /// and resuming goes back by how long ago that was. The server's newest place differs from this one only when
    /// it's newer, once every place told from here has landed.
    func catchUp(to ms: Int, at: Date?) {
        let target = min(max(0, ms), durationMs)
        guard !playing, telling == 0, !unsent, abs(target - positionMs) > 1_000 else { return }
        positionMs = target
        guard on(.move(since: at ?? pausedAt)) else { return }
        resumeOffer = nil
        // Wherever this device dozed off, the person has been awake elsewhere since.
        dozing.forget()
        player.updateNowPlaying()
        onTime?(target)
    }

    /// Play from where it is, or from the place kept when nothing has played yet: back a little first, by as much
    /// as the time away asks (Resume), never into the chapter before, and from a sentence's first word where the
    /// read-along places it. The moment it plays from, before any lead-in.
    ///
    /// A book played to its end has nothing left to play: it plays again from its start, as Listen does a finished
    /// book (AppModel), as a new listen-through.
    @discardableResult
    func resume() -> Int {
        if case .ended = status {
            startingAgain = true
            play(from: 0)
            return 0
        }
        let awayMs = pausedAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
        let chapterStart = chapter?.startMs ?? 0
        var target = Resume.position(positionMs, after: awayMs, chapterStartMs: chapterStart)
        var leadIn = 0
        if let sentences, sentences.count > 0, target != positionMs || !player.loaded {
            let sentence = sentences[sentences.read(at: target)]
            if sentence.exact {
                target = max(chapterStart, sentence.ms)
                leadIn = ReadingSession.leadInMs
            }
        }
        resumeOffer = Resume.rewind(after: awayMs).offersChapterRestart && chapterStart < target ? ResumeOffer(chapterStartMs: chapterStart, awayMs: awayMs) : nil
        if player.loaded && target == positionMs {
            on(.play(from: nil))
        } else {
            positionMs = target
            on(.play(from: max(chapterStart, target - leadIn)))
        }
        return target
    }

    func pause() {
        stopPlaying(onItsOwn: false)
    }

    func playPause() {
        if playing { pause() } else { Task { await carryOn() } }
    }

    /// Back or on, by thirty seconds, as the desktop's buttons go: playing on from there, or paused there.
    func skip(by ms: Int) {
        move(to: positionMs + ms)
    }

    /// Bookmark the moment playing, on every device, as the desktop's player does: from the player and the lock screen.
    @discardableResult
    func bookmarkHere() async -> ServerBookmark? {
        try? await bookmarks.add(at: positionMs)
    }

    /// A moment chosen: played from, or, while paused, the place moved there exactly and still paused.
    func move(to ms: Int) {
        guard !playing else { return play(from: ms) }
        positionMs = min(max(0, ms), durationMs)
        guard on(.move(since: nil)) else { return }
        resumeOffer = nil
        player.updateNowPlaying()
        onTime?(positionMs)
        tell(.seek)
    }

    /// The previous chapter, or the start of this one when it's been playing a while; or the next. Paused, it stays
    /// paused there, as the desktop's buttons do.
    func chapter(by step: Int) {
        guard let chapter else { return }
        if step < 0 && positionMs - chapter.startMs > 3_000 { return move(to: chapter.startMs) }
        let target = min(max(0, chapterIndex + step), chapters.count - 1)
        move(to: chapters[target].startMs)
    }

    /// The start of the chapter, offered after a long time away.
    func restartChapter() {
        guard let offer = resumeOffer else { return }
        play(from: offer.chapterStartMs)
    }

    func dismissResumeOffer() {
        resumeOffer = nil
    }

    /// Back to where the person dozed off, from its sentence's start where that's known.
    func goBackToDozed() {
        guard let ms = dozing.dozedAt else { return }
        dozing.forget()
        // The moment kept may be in the lead-in before a sentence listened from: that sentence is the one.
        if let sentences, sentences.count > 0, case let sentence = sentences[sentences.read(at: ms + ReadingSession.leadInMs)], sentence.exact {
            play(from: max(0, sentence.ms - ReadingSession.leadInMs))
        } else {
            play(from: ms)
        }
    }

    func setSpeed(_ value: Double) {
        speed = (min(max(value, Self.slowest), Self.fastest) / Self.speedStep).rounded() * Self.speedStep
        player.speed = speed
        UserDefaults.standard.set(speed, forKey: Self.speedKey(server.account, book))
        UserDefaults.standard.set(Date(), forKey: Self.speedAtKey(server.account, book))
        player.updateNowPlaying()
    }

    /// The speed a book plays at: the one it was last heard at, on any device, unless this one chose one since, as
    /// the desktop chooses (packages/core/src/settings.ts, `speedToPlay`). A choice from before this was kept has no
    /// time, and gives way.
    nonisolated static func speedToPlay(chosen: Double, at chosenAt: Date?, heard: (speed: Double, at: Date)?) -> Double {
        guard let heard, heard.at > (chosenAt ?? .distantPast) else { return chosen }
        return heard.speed
    }

    /// Stop after so many minutes of listening, fading out; nil turns the timer off.
    func sleep(after minutes: Int?) {
        sleep = minutes.map { .at(Date().addingTimeInterval(TimeInterval($0 * 60)), pausedAt: playing ? nil : Date()) }
        fade()
    }

    /// More minutes: on a timer counting down, added to what's left; on one waiting for the chapter's end, from now,
    /// as the desktop's does.
    func extendSleep(by minutes: Int) {
        let more = TimeInterval(minutes * 60)
        switch sleep {
        case .at(let date, let paused?): sleep = .at(date.addingTimeInterval(more), pausedAt: paused)
        case .at(let date, nil): sleep = .at(max(date, Date()).addingTimeInterval(more), pausedAt: nil)
        case .endOfChapter: sleep = .at(Date().addingTimeInterval(more), pausedAt: playing ? nil : Date())
        case nil: return
        }
        fade()
    }

    /// How long until a timer counting down stops the narration, its clock held while paused; nil for none, or one
    /// waiting for the chapter's end.
    var sleepLeftMs: Int? {
        guard case .at(let date, let paused) = sleep else { return nil }
        return max(0, Int(date.timeIntervalSince(paused ?? Date()) * 1000))
    }

    /// Stop at the end of the chapter playing.
    func sleepAtChapterEnd() {
        sleep = chapter.map { .endOfChapter(endMs: $0.endMs) }
        fade()
    }

    /// Out of the book: the narration stops, and the place is kept.
    func stop() {
        endStretch()
        if player.loaded { tell(.close) }
        on(.close)
        for command in Self.remoteCommands { command.removeTarget(nil) }
    }

    // Inside -----------------------------------------------------------------

    /// The one place the status changes. Whoever calls says what happened; `next` says what that means; and here the
    /// player follows, and with it the screen kept awake while it plays, the stretch of listening, the sleep timer's
    /// clock, the doze, and how loud it plays. False when the event changes nothing.
    @discardableResult
    private func on(_ event: Event) -> Bool {
        guard let next = Self.next(status, on: event, at: Date()) else { return false }
        let was = status
        // Set before the player is told, so the moment a pausing player gives is only a moment.
        status = next
        switch event {
        case .play(let from?):
            moved()
            player.play(from: from)
        case .play(nil):
            // On from where it is: nothing has moved, so a chapter just ahead is still crossed by playing into it.
            player.resume()
        case .card(let index):
            player.hold()
            cardShown = Task { [weak self] in
                try? await Task.sleep(for: Self.cardHold)
                guard !Task.isCancelled else { return }
                self?.cardPassed(index)
            }
        case .cardPassed(let from):
            cardShown = nil
            if let from { player.play(from: from) } else { player.resume() }
        case .pause, .stopOnItsOwn:
            moved()
            player.pause()
        case .end, .move:
            moved()
            player.unload(at: positionMs)
        case .close:
            moved()
            player.stop()
        }
        if next.plays && !was.plays {
            // The sleep timer's clock goes on from where it held.
            if case .at(let date, let paused?) = sleep { sleep = .at(date.addingTimeInterval(Date().timeIntervalSince(paused)), pausedAt: nil) }
            if stretch == nil { beginStretch() }
            // The screen stays on while the book is read along to.
            KeepAwake.set("narration", true)
        } else if was.plays && !next.plays {
            // The sleep timer's clock holds, and nobody is asked whether they're still listening.
            if case .at(let date, nil) = sleep { sleep = .at(date, pausedAt: Date()) }
            dozing.stopped()
            KeepAwake.set("narration", false)
            endStretch()
        }
        if case .play = event {
            player.nowPlayingChapter = chapter?.title ?? ""
            player.updateNowPlaying()
        }
        fade()
        return true
    }

    /// Paused, by the person or on its own, and told.
    private func stopPlaying(onItsOwn: Bool) {
        guard on(onItsOwn ? .stopOnItsOwn : .pause) else { return }
        tell(.pause)
    }

    /// How loud the narration plays: fading out over the sleep timer's last stretch, and to where it stops for
    /// someone who dozed off with no sentence to end at; in full otherwise, and whenever it doesn't play. Set as it
    /// plays, and whenever what it hangs on changes.
    private func fade() {
        guard playing else {
            player.volume = 1
            return
        }
        var loudness = dozing.loudness(at: positionMs, speed: speed, fadeMs: Self.fadeMs)
        if let left = sleepDueMs, left < Self.fadeMs { loudness = min(loudness, Float(max(0, left)) / Float(Self.fadeMs)) }
        player.volume = loudness
    }

    /// How long until the sleep timer stops the narration, as it's heard: the minutes left, or the rest of the chapter
    /// at the speed it plays.
    private var sleepDueMs: Int? {
        switch sleep {
        case .at: sleepLeftMs ?? 0
        case .endOfChapter(let endMs): Int(Double(endMs - positionMs) / speed)
        case nil: nil
        }
    }

    /// The system paused the narration: a phone call, the headphones out, a stream that couldn't be had again
    /// (BookPlayer). Paused here too, as by hand: its place kept, and resuming goes back a little.
    private func pausedBySystem() {
        stopPlaying(onItsOwn: false)
    }

    /// The narration moves or stops: what it was about to stop or wait at no longer stands.
    private func moved() {
        lastHeard = nil
        mark?.timer.invalidate()
        mark = nil
        dozing.moved()
        cardShown?.cancel()
        cardShown = nil
    }

    private func heard(_ ms: Int) {
        let chapterBefore = chapterIndex
        positionMs = ms
        if chapterIndex != chapterBefore {
            player.nowPlayingChapter = chapter?.title ?? ""
            player.updateNowPlaying()
        }
        onTime?(ms)
        guard status == .playing else { return }
        sleepIfDue()
        dozeIfDue(ms)
        guard status == .playing else { return }
        fade()
        meetNextMark(ms)
        lastHeard = ms
        if Date().timeIntervalSince(toldAt) > Self.tellEvery { tell(.periodic) }
    }

    /// The sleep timer: the narrator fades over its last stretch (`fade`), then stops.
    private func sleepIfDue() {
        guard let left = sleepDueMs, left <= 0 else { return }
        sleep = nil
        stopPlaying(onItsOwn: true)
        onStop?()
    }

    /// Forty minutes with nothing pressed: ask, quietly, and a minute later stop at the end of the sentence. Nothing is
    /// asked once it has stopped, as the sleep timer stops it on this moment.
    private func dozeIfDue(_ ms: Int) {
        dozing.heard(ms, quiet: sleep != nil || !inFront() || status != .playing)
        guard dozing.asked != nil else { return }
        learnSentences()
        guard dozing.due else { return }
        if let sentences, sentences.count > 0, case let sentence = sentences[sentences.read(at: ms)], sentence.exact, sentence.endMs > ms {
            dozing.stop(at: sentence.endMs, fades: false)
        } else {
            // A book without its sentences timed fades out instead, as the sleep timer does.
            dozing.stop(at: ms + Int(Double(Self.fadeMs) * speed), fades: true)
        }
    }

    /// The sentences of a book with a read-along, for stopping at the end of one: the reader's, or the server's,
    /// asked for once a minute before they're needed.
    private func learnSentences() {
        guard sentences == nil, book.ebook, !learning else { return }
        learning = true
        let (server, id) = (server, book.id)
        Task { [weak self] in
            let made = try? await server.readAlong(id)
            guard let self else { return }
            if self.sentences == nil, let made { self.sentences = Sentences(made) }
            self.learning = false
        }
    }

    /// The next moment to stop or wait at, met exactly: the player says where it is only five times a second, so a
    /// timer is set as the moment nears, and a tick past it meets it a little late rather than not at all.
    private func meetNextMark(_ ms: Int) {
        guard let (at, kind) = nextMark(after: lastHeard ?? ms) else {
            mark?.timer.invalidate()
            mark = nil
            return
        }
        if ms >= at { return reach(kind) }
        let wait = Double(at - ms) / speed / 1000
        guard wait < 0.6, mark?.ms != at || mark?.kind != kind else { return }
        mark?.timer.invalidate()
        let timer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.mark?.ms == at else { return }
                self.mark = nil
                if self.status == .playing { self.reach(kind) }
            }
        }
        mark = (at, kind, timer)
    }

    /// What's ahead: where a dozing listener stops, and the next chapter's start, for its card. A card waits on
    /// nothing that would stop the narration soon: the sleep timer's last stretch, an end-of-chapter timer, a question.
    private func nextMark(after ms: Int) -> (Int, Mark)? {
        if let stop = dozing.stop { return (stop.ms, .dozed) }
        let sleepsSoon: Bool
        switch sleep {
        case .at: sleepsSoon = (sleepLeftMs ?? 0) < 15_000
        case .endOfChapter: sleepsSoon = true
        case nil: sleepsSoon = false
        }
        guard !sleepsSoon, dozing.asked == nil, let next = chapters.firstIndex(where: { $0.startMs > ms }), next != carded else { return nil }
        return (chapters[next].startMs, .chapter(next))
    }

    /// Kurosawa's beat between scenes: crossing into a chapter with the book on screen, the narration waits while the
    /// chapter's card shows, then goes on from the chapter's first moment (`cardPassed`). Still playing all the while,
    /// as far as anyone asks: Play pauses it, a place chosen goes there, and either takes the card away.
    private func reach(_ kind: Mark) {
        switch kind {
        case .dozed:
            let at = positionMs
            stopPlaying(onItsOwn: true)
            dozing.dozed(stoppedAt: at)
            onStop?()
        case .chapter(let index):
            carded = index
            guard showsCards() else { return }
            on(.card(index))
        }
    }

    /// The chapter's card has shown for its moment: the narration goes on.
    func cardPassed(_ index: Int) {
        guard status == .carded(index) else { return }
        // A timer a little late has played into the chapter: from its start again, so its first word isn't clipped.
        let start = chapters[index].startMs
        on(.cardPassed(from: abs(player.positionMs - start) > 150 ? start : nil))
    }

    private func ended() {
        positionMs = durationMs
        tell(.end)
        // The last stretch counts before the listen-through closes.
        let last = endStretch()
        on(.end)
        let (server, id) = (server, book.id)
        Task { [weak self] in
            await last?.value
            let read = try? await server.finished(id)
            self?.finishedRead = read
        }
        onStop?()
        onFinish?()
    }

    /// A stretch of listening begins: the server opens its listen-through now, as the desktop does as playing
    /// starts, so it's open even if the TV never says the stretch ended.
    private func beginStretch() {
        let begun = (start: Date(), fromMs: positionMs, speed: speed)
        stretch = begun
        let (server, id, again, keep) = (server, book.id, startingAgain, keepsSessions)
        startingAgain = false
        Task { try? await server.listened(from: begun.start, to: begun.start, fromMs: begun.fromMs, toMs: begun.fromMs, speed: begun.speed, again: again, keep: keep, in: id) }
    }

    /// The stretch of listening that just ended, to the server: a session, as the desktop keeps one, when it's long
    /// enough and the person keeps them.
    @discardableResult
    private func endStretch() -> Task<Void, Never>? {
        guard let stretch else { return nil }
        self.stretch = nil
        let (server, id, toMs, keep) = (server, book.id, positionMs, keepsSessions)
        return Task { try? await server.listened(from: stretch.start, to: Date(), fromMs: stretch.fromMs, toMs: toMs, speed: stretch.speed, again: false, keep: keep, in: id) }
    }

    private func tell(_ why: Why) {
        toldAt = Date()
        telling += 1
        let (ms, server, id) = (positionMs, server, book.id)
        Task { [weak self] in
            let landed = (try? await server.tell(ms, why: why, in: id)) != nil
            guard let self else { return }
            self.telling -= 1
            self.unsent = !landed
            if landed { self.checkedAt = Date() }
        }
    }

    /// The cover, for the lock screen and Now Playing, once it's here.
    private func showCover() {
        guard let hash = book.cover?.hash else { return }
        let server = server
        Task { [weak self] in
            guard let cover = try? await server.cover(hash, width: 800), let self else { return }
            self.player.nowPlayingCover = cover
            self.player.updateNowPlaying()
        }
    }

    /// What the system asks of the narration from outside the app: the TV's own play and pause, Control Center, the
    /// phone's lock screen, headphones and the car.
    private static var remoteCommands: [MPRemoteCommand] {
        let center = MPRemoteCommandCenter.shared()
        return [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand, center.skipBackwardCommand, center.skipForwardCommand,
                center.previousTrackCommand, center.nextTrackCommand, center.changePlaybackPositionCommand, center.bookmarkCommand]
    }

    /// Play and pause; thirty seconds back and on; the chapter before and the next (a double or triple press of the
    /// headphones); the place on the lock screen's line; and a bookmark of the moment. Each on the main thread, where
    /// they're sent.
    private func listenToRemoteCommands() {
        let commands = MPRemoteCommandCenter.shared()
        let act = { [weak self] (action: @MainActor (Listening) -> Void) -> MPRemoteCommandHandlerStatus in
            MainActor.assumeIsolated {
                Remote.used()
                if let self { action(self) }
            }
            return .success
        }
        // Each plays or pauses only when that changes something.
        commands.togglePlayPauseCommand.addTarget { _ in act { $0.playPause() } }
        commands.playCommand.addTarget { _ in act { if !$0.playing { $0.playPause() } } }
        commands.pauseCommand.addTarget { _ in act { if $0.playing { $0.playPause() } } }
        commands.skipBackwardCommand.preferredIntervals = [NSNumber(value: Self.skipMs / 1000)]
        commands.skipForwardCommand.preferredIntervals = [NSNumber(value: Self.skipMs / 1000)]
        commands.skipBackwardCommand.addTarget { _ in act { $0.skip(by: -Self.skipMs) } }
        commands.skipForwardCommand.addTarget { _ in act { $0.skip(by: Self.skipMs) } }
        commands.previousTrackCommand.addTarget { _ in act { $0.chapter(by: -1) } }
        commands.nextTrackCommand.addTarget { _ in act { $0.chapter(by: 1) } }
        commands.bookmarkCommand.localizedTitle = "Bookmark"
        commands.bookmarkCommand.addTarget { _ in act { listening in Task { await listening.bookmarkHere() } } }
        commands.changePlaybackPositionCommand.addTarget { event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let ms = Int(event.positionTime * 1000)
            return act { $0.move(to: ms) }
        }
    }

    /// Speed is kept per book, as the desktop keeps it, for each person, with when it was chosen.
    private static func speedKey(_ account: Account, _ book: ServerBook) -> String {
        "ribbon.speed.\(account.id).\(book.id)"
    }

    private static func speedAtKey(_ account: Account, _ book: ServerBook) -> String {
        "ribbon.speedAt.\(account.id).\(book.id)"
    }
}
