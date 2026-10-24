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
/// Crossing into a new chapter, where the book is on screen, the narration
/// waits a moment while the chapter's card shows. Played on for forty
/// minutes with nothing pressed, it asks whether you're still listening
/// (Dozing).
@MainActor
@Observable
final class Listening {
    let book: ServerBook
    let detail: ServerBookDetail
    /// Its bookmarks, which the reader and the player share.
    let bookmarks: Bookmarks
    let dozing: Dozing

    /// The moment of the recording, a few times a second while it plays.
    private(set) var positionMs: Int
    private(set) var playing = false
    private(set) var speed: Double
    /// When the sleep timer stops the narration, if it's set.
    private(set) var sleep: Sleep?
    /// When it was last paused or stopped, and whether it stopped on its own: resuming goes back by how long, and
    /// a book the sleep timer, dozing off or its end stopped doesn't bring up the passages (AppModel).
    private(set) var pausedAt: Date?
    private(set) var stoppedOnItsOwn = false
    /// After a day away: the start of the chapter, offered until it's taken or something else is chosen.
    private(set) var resumeOffer: ResumeOffer?
    /// The chapter whose card shows while the narration waits for it, by its place in the list.
    private(set) var card: Int?
    /// How the listen-through went, once the book has ended and the server has closed it.
    private(set) var finishedRead: ListenThrough?

    enum Sleep: Equatable {
        /// At a time, a few minutes from when it was set.
        case at(Date)
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

    @ObservationIgnored private let player: BookPlayer
    @ObservationIgnored private let server: RibbonServer
    @ObservationIgnored private var toldAt = Date.distantPast
    /// The stretch of listening playing now: from when, and from which moment.
    @ObservationIgnored private var stretch: (start: Date, fromMs: Int, speed: Double)?
    /// The moment heard last while playing on; nil after a move, so a chapter is crossed only by playing into it.
    @ObservationIgnored private var lastHeard: Int?
    /// The next moment to stop or wait at, met by a timer set as it nears.
    @ObservationIgnored private var mark: (ms: Int, kind: Mark, timer: Timer)?
    /// Where the narration stops for someone who has dozed off, and whether it fades there, with no sentence to end at.
    @ObservationIgnored private var dozeStop: (ms: Int, fades: Bool)?
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
    /// The sleep timer fades the narrator out over this long before it stops.
    private static let fadeMs = 10_000
    /// How long the narration waits on a chapter's card, which wipes in and out either side.
    static let cardHold: Duration = .seconds(2.6)
    /// The speeds there are, and the step between them, as the desktop's (src/core/speed.ts).
    static let slowest = 0.5
    static let fastest = 3.0
    static let speedStep = 0.05

    /// `placedAt` is when the place started from was kept: resuming from it goes back by how long ago that was.
    init(book: ServerBook, detail: ServerBookDetail, startMs: Int, placedAt: Date?, server: RibbonServer) {
        self.book = book
        self.detail = detail
        self.server = server
        bookmarks = Bookmarks(server: server, bookId: book.id)
        dozing = Dozing(account: server.account, book: book, at: startMs)
        positionMs = startMs
        pausedAt = placedAt
        speed = UserDefaults.standard.object(forKey: Self.speedKey(server.account, book)) as? Double ?? 1
        var fileStart = 0
        player = BookPlayer(files: detail.files.map { file in
            defer { fileStart += file.durationMs }
            return .init(url: server.fileURL(book: book.id, path: file.path), startMs: fileStart, durationMs: file.durationMs)
        }, cookie: server.account.cookie)
        player.speed = speed
        player.nowPlayingTitle = book.title
        player.nowPlayingAuthor = book.author
        player.onTime = { [weak self] ms in self?.heard(ms) }
        player.onEnd = { [weak self] in self?.ended() }
        listenToRemoteCommands()
    }

    // What there is to show ------------------------------------------------

    var durationMs: Int { book.durationMs }

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

    /// Play from a moment of the book: a place chosen, so it plays from there exactly.
    func play(from ms: Int) {
        positionMs = min(max(0, ms), durationMs)
        moved()
        // A place chosen is exact: no rewind on the next resume, and nothing to offer.
        pausedAt = nil
        resumeOffer = nil
        player.play(from: positionMs)
        started()
        tell(.seek)
    }

    /// Play from where it is, or from the place kept when nothing has played yet: back a little first, by as much
    /// as the time away asks (Resume), never into the chapter before, and from a sentence's first word where the
    /// read-along places it. The moment it plays from, before any lead-in.
    @discardableResult
    func resume() -> Int {
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
        pausedAt = nil
        if player.loaded && target == positionMs {
            player.resume()
        } else {
            positionMs = target
            lastHeard = nil
            player.play(from: max(chapterStart, target - leadIn))
        }
        started()
        return target
    }

    func pause() {
        stopPlaying(byHand: true)
    }

    func playPause() {
        if playing { pause() } else { resume() }
    }

    /// Back or on, by thirty seconds, as the desktop's buttons go.
    func skip(by ms: Int) {
        play(from: positionMs + ms)
    }

    /// The previous chapter, or the start of this one when it's been playing a while; or the next.
    func chapter(by step: Int) {
        guard let chapter else { return }
        if step < 0 && positionMs - chapter.startMs > 3_000 { return play(from: chapter.startMs) }
        let target = min(max(0, chapterIndex + step), chapters.count - 1)
        play(from: chapters[target].startMs)
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
        player.updateNowPlaying()
    }

    /// Stop after so many minutes, fading out; nil turns the timer off.
    func sleep(after minutes: Int?) {
        sleep = minutes.map { .at(Date().addingTimeInterval(TimeInterval($0 * 60))) }
        player.volume = 1
    }

    /// A timer that's counting down, given more minutes.
    func extendSleep(by minutes: Int) {
        guard case .at(let date) = sleep else { return }
        sleep = .at(max(date, Date()).addingTimeInterval(TimeInterval(minutes * 60)))
        player.volume = 1
    }

    /// Stop at the end of the chapter playing.
    func sleepAtChapterEnd() {
        sleep = chapter.map { .endOfChapter(endMs: $0.endMs) }
        player.volume = 1
    }

    /// Out of the book: the narration stops, and the place is kept.
    func stop() {
        endStretch()
        if player.loaded { tell(.close) }
        moved()
        player.stop()
        playing = false
        KeepAwake.set("narration", false)
        Remote.stopWaiting("dozing")
        for command in [MPRemoteCommandCenter.shared().playCommand, MPRemoteCommandCenter.shared().pauseCommand, MPRemoteCommandCenter.shared().togglePlayPauseCommand] {
            command.removeTarget(nil)
        }
    }

    // Inside -----------------------------------------------------------------

    private func started() {
        playing = true
        stoppedOnItsOwn = false
        if stretch == nil { beginStretch() }
        player.nowPlayingChapter = chapter?.title ?? ""
        player.updateNowPlaying()
        // The screen stays on while the book is read along to.
        KeepAwake.set("narration", true)
    }

    /// Paused, by the person or on its own.
    private func stopPlaying(byHand: Bool) {
        moved()
        // Not playing before the player stops, so the moment it gives as it stops is only a moment.
        playing = false
        player.pause()
        pausedAt = Date()
        stoppedOnItsOwn = !byHand
        player.volume = 1
        dozing.stopped()
        Remote.stopWaiting("dozing")
        KeepAwake.set("narration", false)
        endStretch()
        tell(.pause)
    }

    /// The narration moves or stops: what it was about to stop or wait at no longer stands.
    private func moved() {
        lastHeard = nil
        mark?.timer.invalidate()
        mark = nil
        dozeStop = nil
        cardShown?.cancel()
        cardShown = nil
        card = nil
    }

    private func heard(_ ms: Int) {
        let chapterBefore = chapterIndex
        positionMs = ms
        if chapterIndex != chapterBefore {
            player.nowPlayingChapter = chapter?.title ?? ""
            player.updateNowPlaying()
        }
        onTime?(ms)
        guard playing, card == nil else { return }
        sleepIfDue()
        dozeIfDue(ms)
        guard playing else { return }
        meetNextMark(ms)
        lastHeard = ms
        if Date().timeIntervalSince(toldAt) > Self.tellEvery { tell(.periodic) }
    }

    /// The sleep timer: the narrator fades over its last ten seconds, then stops.
    private func sleepIfDue() {
        guard let sleep, playing else { return }
        let left: Int
        switch sleep {
        case .at(let date): left = Int(date.timeIntervalSinceNow * 1000)
        case .endOfChapter(let endMs): left = Int(Double(endMs - positionMs) / speed)
        }
        if left <= 0 {
            self.sleep = nil
            stopPlaying(byHand: false)
            onStop?()
        } else if left < Self.fadeMs {
            player.volume = Float(left) / Float(Self.fadeMs)
        }
    }

    /// Forty minutes with nothing pressed: ask, quietly, and a minute later stop at the end of the sentence.
    private func dozeIfDue(_ ms: Int) {
        let due = dozing.heard(ms, quiet: sleep != nil || !inFront())
        if dozing.asked != nil {
            // Any press answers, and goes no further.
            Remote.wait("dozing") {}
            learnSentences()
        } else {
            Remote.stopWaiting("dozing")
            if dozeStop != nil {
                dozeStop = nil
                player.volume = 1
            }
        }
        if due && dozeStop == nil {
            if let sentences, sentences.count > 0, case let sentence = sentences[sentences.read(at: ms)], sentence.exact, sentence.endMs > ms {
                dozeStop = (sentence.endMs, false)
            } else {
                // A book without its sentences timed fades out instead, as the sleep timer does.
                dozeStop = (ms + Int(Double(Self.fadeMs) * speed), true)
            }
        }
        if let dozeStop, dozeStop.fades {
            player.volume = max(0, Float(Double(dozeStop.ms - ms) / speed) / Float(Self.fadeMs))
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
                if self.playing && self.card == nil { self.reach(kind) }
            }
        }
        mark = (at, kind, timer)
    }

    /// What's ahead: where a dozing listener stops, and the next chapter's start, for its card. A card waits on
    /// nothing that would stop the narration soon: the sleep timer's last stretch, an end-of-chapter timer, a question.
    private func nextMark(after ms: Int) -> (Int, Mark)? {
        if let dozeStop { return (dozeStop.ms, .dozed) }
        let sleepsSoon: Bool
        switch sleep {
        case .at(let date): sleepsSoon = date.timeIntervalSinceNow < 15
        case .endOfChapter: sleepsSoon = true
        case nil: sleepsSoon = false
        }
        guard !sleepsSoon, dozing.asked == nil, let next = chapters.firstIndex(where: { $0.startMs > ms }), next != carded else { return nil }
        return (chapters[next].startMs, .chapter(next))
    }

    private func reach(_ kind: Mark) {
        switch kind {
        case .dozed:
            let at = positionMs
            stopPlaying(byHand: false)
            dozing.dozed(stoppedAt: at)
            onStop?()
        case .chapter(let index):
            carded = index
            guard showsCards() else { return }
            showCard(index)
        }
    }

    /// Kurosawa's beat between scenes: the narration waits while the chapter's card shows, then goes on from the
    /// chapter's first moment. Still playing all the while, as far as anyone asks: Play pauses it, and a place
    /// chosen goes there, and either takes the card away.
    private func showCard(_ index: Int) {
        card = index
        player.pause()
        cardShown = Task { [weak self] in
            try? await Task.sleep(for: Self.cardHold)
            guard let self, !Task.isCancelled, self.card == index, self.playing else { return }
            self.card = nil
            self.cardShown = nil
            // A timer a little late has played into the chapter: from its start again, so its first word isn't clipped.
            let start = self.chapters[index].startMs
            if abs(self.player.positionMs - start) > 150 { self.player.play(from: start) } else { self.player.resume() }
        }
    }

    private func ended() {
        moved()
        playing = false
        pausedAt = Date()
        stoppedOnItsOwn = true
        KeepAwake.set("narration", false)
        positionMs = durationMs
        tell(.end)
        // The last stretch counts before the listen-through closes.
        let last = endStretch()
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
        let (ms, server, id) = (positionMs, server, book.id)
        Task { try? await server.tell(ms, why: why, in: id) }
    }

    /// The TV's own play and pause, from Control Center and other remotes.
    private func listenToRemoteCommands() {
        let commands = MPRemoteCommandCenter.shared()
        // Each plays or pauses only when that changes something, on the main thread, where they're sent.
        let command = { [weak self] (wanted: Bool?) -> MPRemoteCommandHandlerStatus in
            MainActor.assumeIsolated {
                Remote.used()
                guard let self, wanted == nil || wanted != self.playing else { return }
                self.playPause()
            }
            return .success
        }
        commands.togglePlayPauseCommand.addTarget { _ in command(nil) }
        commands.playCommand.addTarget { _ in command(true) }
        commands.pauseCommand.addTarget { _ in command(false) }
    }

    /// Speed is kept per book, as the desktop keeps it, for each person.
    private static func speedKey(_ account: Account, _ book: ServerBook) -> String {
        "ribbon.speed.\(account.id).\(book.id)"
    }
}
