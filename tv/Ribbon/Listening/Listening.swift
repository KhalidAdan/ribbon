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
/// where the TV left off.
@MainActor
@Observable
final class Listening {
    let book: ServerBook
    let detail: ServerBookDetail

    /// The moment of the recording, a few times a second while it plays.
    private(set) var positionMs: Int
    private(set) var playing = false
    private(set) var speed: Double
    /// When the sleep timer stops the narration, if it's set.
    private(set) var sleep: Sleep?

    enum Sleep: Equatable {
        /// At a time, a few minutes from when it was set.
        case at(Date)
        /// At the end of the chapter that was playing.
        case endOfChapter(endMs: Int)
    }

    /// Every moment heard, for the reader to follow.
    @ObservationIgnored var onTime: ((Int) -> Void)?
    /// The narration stopped on its own: at the book's end, or the sleep timer's.
    @ObservationIgnored var onStop: (() -> Void)?

    @ObservationIgnored private let player: BookPlayer
    @ObservationIgnored private let server: RibbonServer
    @ObservationIgnored private var toldAt = Date.distantPast

    /// While the narration plays, the place goes to the server this often.
    private static let tellEvery: TimeInterval = 15
    /// The sleep timer fades the narrator out over this long before it stops.
    private static let fadeMs = 10_000
    /// The speeds there are, and the step between them, as the desktop's (src/core/speed.ts).
    static let slowest = 0.5
    static let fastest = 3.0
    static let speedStep = 0.05

    init(book: ServerBook, detail: ServerBookDetail, startMs: Int, server: RibbonServer) {
        self.book = book
        self.detail = detail
        self.server = server
        positionMs = startMs
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

    // What the remote asks -------------------------------------------------

    /// Play from a moment of the book.
    func play(from ms: Int) {
        positionMs = min(max(0, ms), durationMs)
        player.play(from: positionMs)
        started()
        tell(.seek)
    }

    /// Play from where it is, or from the place kept when nothing has played yet.
    func resume() {
        if player.loaded { player.resume() } else { player.play(from: positionMs) }
        started()
    }

    func pause() {
        player.pause()
        playing = false
        player.volume = 1
        UIApplication.shared.isIdleTimerDisabled = false
        tell(.pause)
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
        if player.loaded { tell(.close) }
        player.stop()
        playing = false
        UIApplication.shared.isIdleTimerDisabled = false
        for command in [MPRemoteCommandCenter.shared().playCommand, MPRemoteCommandCenter.shared().pauseCommand, MPRemoteCommandCenter.shared().togglePlayPauseCommand] {
            command.removeTarget(nil)
        }
    }

    // Inside -----------------------------------------------------------------

    private func started() {
        playing = true
        player.nowPlayingChapter = chapter?.title ?? ""
        player.updateNowPlaying()
        // The screen stays on while the book is read along to.
        UIApplication.shared.isIdleTimerDisabled = true
    }

    private func heard(_ ms: Int) {
        let chapterBefore = chapterIndex
        positionMs = ms
        if chapterIndex != chapterBefore {
            player.nowPlayingChapter = chapter?.title ?? ""
            player.updateNowPlaying()
        }
        onTime?(ms)
        sleepIfDue()
        if playing, Date().timeIntervalSince(toldAt) > Self.tellEvery { tell(.periodic) }
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
            pause()
            onStop?()
        } else if left < Self.fadeMs {
            player.volume = Float(left) / Float(Self.fadeMs)
        }
    }

    private func ended() {
        playing = false
        UIApplication.shared.isIdleTimerDisabled = false
        tell(.end)
        onStop?()
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
