import Observation
import UIKit

/// A book open to read along: the sentence the remote is on, and the
/// sentence being read in the narration (Listening). The remote steps from
/// sentence to sentence; Play reads from the one it's on. While the narration
/// plays, the remote's sentence follows the narrator's, until the remote
/// moves away; moving back to the narrator follows it again (docs/READING.md,
/// section 6, "Read-along"). Leaving the book leaves the narration playing,
/// as closing the desktop's reader does.
@MainActor
@Observable
final class ReadingSession {
    let listening: Listening
    let readAlong: ReadAlong
    let sentences: Sentences

    /// The sentence the remote is on.
    private(set) var cursor: Int
    /// The sentence being read, or where the narration stopped: your place.
    private(set) var narrator: Int
    /// The remote's sentence goes where the narrator goes.
    private(set) var following = true

    /// Called when the sentences marked on the page change, so the column can draw them and bring them into view.
    @ObservationIgnored var onMarks: (() -> Void)?

    /// Read from here once the narration starts: the sentence asked for, after its lead-in.
    @ObservationIgnored private var listenedFrom: Int?

    /// Listening from a sentence starts this long before it, so its first word isn't clipped (src/core/reading/align.ts, `LEAD_IN_MS`).
    private static let leadInMs = 250

    /// Opened at the narrator's sentence when the book is playing, else at the place the server gave.
    init(listening: Listening, readAlong: ReadAlong, place: BookPlace?) {
        self.listening = listening
        self.readAlong = readAlong
        sentences = Sentences(readAlong)
        let last = max(0, sentences.count - 1)
        let start = min(listening.playing ? sentences.read(at: listening.positionMs) : place?.sentence ?? sentences.read(at: listening.positionMs), last)
        cursor = start
        narrator = start
        listening.onTime = { [weak self] ms in self?.heard(ms) }
        listening.onStop = { [weak self] in self?.onMarks?() }
    }

    var book: ServerBook { listening.book }

    // The remote --------------------------------------------------------

    /// Up and down: a sentence at a time.
    func step(by n: Int) {
        moveCursor(to: cursor + n)
    }

    /// Left and right, while the remote follows the narrator: a paragraph at a time.
    func stepParagraph(by n: Int) {
        moveCursor(to: sentences.paragraph(from: cursor, by: n))
    }

    /// Play and pause, or Select: on the narrator's sentence, pause or go on; on any other, read from it.
    func playPause() {
        if cursor != narrator || !listening.loaded {
            listenFromHere()
        } else {
            listening.playPause()
        }
        onMarks?()
    }

    /// Listen from the sentence the remote is on.
    func listenFromHere() {
        let sentence = sentences[cursor]
        // A listening place not moved from is resumed where it stopped; anywhere else, from the sentence.
        let fromPlace = !listening.loaded && cursor == narrator && !sentence.exact && listening.positionMs > 0
        let ms = fromPlace ? listening.positionMs : sentence.ms
        listenedFrom = ms
        narrator = cursor
        following = true
        listening.play(from: max(0, ms - Self.leadInMs))
        onMarks?()
    }

    /// Back to the narrator's sentence, following it again.
    func returnToNarrator() {
        moveCursor(to: narrator)
    }

    /// Menu: back to the narrator when the remote has wandered off, else out of the book. True when it stays in the book.
    func back() -> Bool {
        guard !following else { return false }
        returnToNarrator()
        return true
    }

    /// Out of the book: the reader lets go of the narration, which plays on.
    func close() {
        listening.onTime = nil
        listening.onStop = nil
    }

    // What's on the page ------------------------------------------------

    /// The contents entry the remote's sentence is under.
    var chapter: String? {
        let block = sentences[cursor].block
        return readAlong.contents.last { $0.block <= block }?.title
    }

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

    /// The narration reached a moment: the sentence it's in is the narrator's, and the remote's while it follows.
    private func heard(_ ms: Int) {
        let now = sentences.read(at: followed(ms))
        guard now != narrator else { return }
        narrator = now
        if following { cursor = now }
        onMarks?()
    }

    /// The moment the text follows: the player's, except in the lead-in before a sentence listened from,
    /// when the page waits at that sentence (src/core/reading/align.ts, `followedMs`).
    private func followed(_ ms: Int) -> Int {
        guard let from = listenedFrom else { return ms }
        if ms >= from - 2 * Self.leadInMs && ms < from { return from }
        if ms >= from { listenedFrom = nil }
        return ms
    }
}
