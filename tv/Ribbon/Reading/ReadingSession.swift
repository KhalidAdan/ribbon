import MediaPlayer
import Observation
import UIKit

/// A book open to read along: the sentence the remote is on, the sentence
/// being read, and the narration. The remote steps from sentence to
/// sentence; Play reads from the one it's on. While the narration plays,
/// the remote's sentence follows the narrator's, until the remote moves
/// away; moving back to the narrator follows it again (docs/READING.md,
/// section 6, "Read-along").
///
/// The place goes to the server as it moves, the way the apps write theirs
/// (docs/POSITION-FORMAT.md, `why`), so the phone and the desktop open where
/// the TV left off.
@MainActor
@Observable
final class ReadingSession {
    let book: ServerBook
    let readAlong: ReadAlong
    let sentences: Sentences

    /// The sentence the remote is on.
    private(set) var cursor: Int
    /// The sentence being read, or where the narration stopped: your place.
    private(set) var narrator: Int
    /// The remote's sentence goes where the narrator goes.
    private(set) var following = true
    private(set) var playing = false
    /// The moment of the recording the narrator is at.
    private(set) var positionMs: Int

    /// Called when the sentences marked on the page change, so the column can draw them and bring them into view.
    @ObservationIgnored var onMarks: (() -> Void)?

    @ObservationIgnored private let player: BookPlayer
    @ObservationIgnored private let server: RibbonServer
    /// Read from here once the narration starts: the sentence asked for, its lead-in, and where the place was.
    @ObservationIgnored private var listenedFrom: Int?
    @ObservationIgnored private var toldAt = Date.distantPast

    /// Listening from a sentence starts this long before it, so its first word isn't clipped (src/core/reading/align.ts, `LEAD_IN_MS`).
    private static let leadInMs = 250
    /// While the narration plays, the place goes to the server this often.
    private static let tellEvery: TimeInterval = 15

    init(book: ServerBook, detail: ServerBookDetail, readAlong: ReadAlong, place: BookPlace?, server: RibbonServer) {
        self.book = book
        self.readAlong = readAlong
        sentences = Sentences(readAlong)
        self.server = server
        let last = max(0, sentences.count - 1)
        let start = min(place?.sentence ?? sentences.read(at: 0), last)
        cursor = start
        narrator = start
        // A listening place is resumed where it stopped; a reading place, at its sentence.
        positionMs = place?.ms ?? 0
        var startMs = 0
        player = BookPlayer(files: detail.files.map { file in
            defer { startMs += file.durationMs }
            return .init(url: server.fileURL(book: book.id, path: file.path), startMs: startMs, durationMs: file.durationMs)
        }, cookie: server.account.cookie)
        player.nowPlayingTitle = book.title
        player.nowPlayingAuthor = book.author
        player.onTime = { [weak self] ms in self?.heard(ms) }
        player.onEnd = { [weak self] in self?.ended() }
        listenToRemoteCommands()
    }

    // The remote --------------------------------------------------------

    /// Up and down: a sentence at a time.
    func step(by n: Int) {
        moveCursor(to: cursor + n)
    }

    /// Left and right: a paragraph at a time.
    func stepParagraph(by n: Int) {
        moveCursor(to: sentences.paragraph(from: cursor, by: n))
    }

    /// Play and pause, or Select: on the narrator's sentence, pause or go on; on any other, read from it.
    func playPause() {
        if cursor != narrator || !player.loaded {
            listen(from: cursor)
        } else if playing {
            player.pause()
            playing = false
            tell(.pause)
        } else {
            player.resume()
            playing = true
        }
        UIApplication.shared.isIdleTimerDisabled = playing
        onMarks?()
    }

    /// Menu: back to the narrator when the remote has wandered off, else out of the book. True when it stays in the book.
    func back() -> Bool {
        guard !following else { return false }
        moveCursor(to: narrator)
        return true
    }

    /// Out of the book: the narration stops, and the place is kept.
    func close() {
        if player.loaded { tell(.close) }
        player.stop()
        UIApplication.shared.isIdleTimerDisabled = false
        MPRemoteCommandCenter.shared().playCommand.removeTarget(nil)
        MPRemoteCommandCenter.shared().pauseCommand.removeTarget(nil)
        MPRemoteCommandCenter.shared().togglePlayPauseCommand.removeTarget(nil)
    }

    // What's on the page ------------------------------------------------

    /// The contents entry the remote's sentence is under.
    var chapter: String? {
        let block = sentences[cursor].block
        return readAlong.contents.last { $0.block <= block }?.title
    }

    var durationMs: Int { book.durationMs }

    /// Whether the narrator's sentence is placed to the sentence, so it's marked as read.
    var narratorExact: Bool { sentences[narrator].exact }

    // Inside -------------------------------------------------------------

    private func moveCursor(to index: Int) {
        let target = min(max(0, index), sentences.count - 1)
        guard target != cursor || !following else { return }
        cursor = target
        // Back on the narrator's sentence, the remote follows it again.
        following = cursor == narrator
        onMarks?()
    }

    private func listen(from index: Int) {
        let sentence = sentences[index]
        // A listening place not moved from is resumed where it stopped; anywhere else, from the sentence.
        let fromPlace = !player.loaded && index == narrator && !sentence.exact && positionMs > 0
        let ms = fromPlace ? positionMs : sentence.ms
        listenedFrom = ms
        narrator = index
        cursor = index
        following = true
        positionMs = ms
        player.play(from: max(0, ms - Self.leadInMs))
        playing = true
        tell(.seek)
    }

    /// The narration reached a moment: the sentence it's in is the narrator's, and the remote's while it follows.
    private func heard(_ ms: Int) {
        positionMs = followed(ms)
        let now = sentences.read(at: positionMs)
        if now != narrator {
            narrator = now
            if following { cursor = now }
            onMarks?()
        }
        if playing, Date().timeIntervalSince(toldAt) > Self.tellEvery { tell(.periodic) }
    }

    /// The moment the text follows: the player's, except in the lead-in before a sentence listened from,
    /// when the page waits at that sentence (src/core/reading/align.ts, `followedMs`).
    private func followed(_ ms: Int) -> Int {
        guard let from = listenedFrom else { return ms }
        if ms >= from - 2 * Self.leadInMs && ms < from { return from }
        if ms >= from { listenedFrom = nil }
        return ms
    }

    private func ended() {
        playing = false
        UIApplication.shared.isIdleTimerDisabled = false
        tell(.end)
        onMarks?()
    }

    private func tell(_ why: Why) {
        toldAt = Date()
        let ms = positionMs
        let server = server
        let id = book.id
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
}
