import Observation
import UIKit

/// A book open to read along: the sentence the remote is on, and the
/// sentence being read in the narration (Listening). The remote steps from
/// sentence to sentence; Play reads from the one it's on. While the narration
/// plays, the remote's sentence follows the narrator's, until the remote
/// moves away; moving back to the narrator follows it again (docs/READING.md,
/// section 6, "Read-along"). Leaving the book leaves the narration playing,
/// as closing the desktop's reader does.
///
/// Left listens from the remote's sentence; pressed again within a moment,
/// it goes back a sentence more each time, for "what did they just say?".
/// Where the person dozed off, the remote's sentence waits there when the
/// book opens, so Left goes back to it and Right goes on from where it stopped.
///
/// Bookmarks are whole sentences: holding Select starts one at the remote's
/// sentence, up and down take in more, and Select keeps it. Held on words
/// already bookmarked, Select offers to delete the bookmark instead.
///
/// Once the narration has played a few seconds with the remote following it,
/// the words not being read step back (the river); the remote moving away, or
/// the narration pausing, brings them back at once.
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

    /// Bookmarking: the sentence the remote was on when Select was held. The bookmark runs from it to the remote's sentence.
    private(set) var marking: Int?
    /// The bookmark Select was held on, waiting to be deleted or kept.
    private(set) var deleting: ServerBookmark?
    /// What just happened to a bookmark, shown for a moment.
    private(set) var notice: String?
    /// The remote's sentence is where the person dozed off, offered to go back to.
    private(set) var atDozed = false
    /// How closely the read-along follows the voice, said for a few seconds as the book opens when it's by chapter.
    private(set) var caveat: (title: String, hint: String)?

    /// Called when the sentences marked on the page change, so the column can draw them and bring them into view.
    @ObservationIgnored var onMarks: (() -> Void)?
    @ObservationIgnored private var noticeShown: Task<Void, Never>?

    /// Read from here once the narration starts: the sentence asked for, after its lead-in.
    @ObservationIgnored private var listenedFrom: Int?
    /// The last Left: when, and the sentence it listened from.
    @ObservationIgnored private var lastLeft: (at: Date, sentence: Int)?
    /// How long the narration has played with the remote following it, since it started or the remote came back.
    @ObservationIgnored private var followedMs = 0
    /// The last moment heard, and when.
    @ObservationIgnored private var lastHeard: (at: Date, ms: Int)?

    /// Listening from a sentence starts this long before it, so its first word isn't clipped (src/core/reading/align.ts, `LEAD_IN_MS`).
    static let leadInMs = 250
    /// Left again within this long goes back another sentence.
    private static let againWithin: TimeInterval = 0.6
    /// The river comes in once the narration has played this long with the remote following it.
    static let riverAfterMs = 5_000

    /// Opened at the narrator's sentence when the book is playing and reads along, else at the place the server gave.
    init(listening: Listening, readAlong: ReadAlong, place: BookPlace?) {
        self.listening = listening
        self.readAlong = readAlong
        sentences = Sentences(readAlong)
        let last = max(0, sentences.count - 1)
        let narrated = readAlong.readsAlong && listening.playing
        let start = min(narrated ? sentences.read(at: listening.positionMs) : place?.sentence ?? sentences.read(at: listening.positionMs), last)
        cursor = start
        narrator = start
        // The sentences time the narration's resuming and its stopping for someone who dozed off, in the player too.
        listening.sentences = sentences
        listening.onTime = { [weak self] ms in self?.heard(ms) }
        listening.onStop = { [weak self] in self?.stopped() }
        if !listening.playing { offerDozed() }
        caveat = readAlong.notReady ?? readAlong.check?.caveat
        if caveat != nil {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(6))
                self?.caveat = nil
            }
        }
        // Bookmarks made on other devices since the book was last open.
        Task { [weak self] in
            await listening.bookmarks.load()
            self?.onMarks?()
        }
    }

    var book: ServerBook { listening.book }
    var bookmarks: Bookmarks { listening.bookmarks }

    // The remote --------------------------------------------------------

    /// Up and down: a sentence at a time.
    func step(by n: Int) {
        moveCursor(to: cursor + n)
    }

    /// Play and pause, or Select: on the narrator's sentence, pause or go on, back a little after a while away; on
    /// any other, read from it. A book that reads only plays on from where it was, wherever the remote is.
    func playPause() {
        if !readAlong.readsAlong {
            if listening.playing { listening.pause() } else { resumePlace() }
        } else if cursor != narrator {
            listenFromHere()
        } else if listening.playing {
            listening.pause()
            calm()
        } else {
            resumePlace()
        }
        onMarks?()
    }

    /// Left: listen from the sentence the remote is on. Again within a moment, from the sentence before the one
    /// listened from, and again, a sentence further back each time. Nothing, in a book that reads only: when its
    /// sentences are read isn't known yet.
    func left() {
        guard readAlong.readsAlong else { return }
        if let last = lastLeft, Date().timeIntervalSince(last.at) < Self.againWithin {
            var back = last.sentence - 1
            while back > 0 && !sentences[back].narrated { back -= 1 }
            cursor = max(0, back)
        }
        listenFromHere()
        lastLeft = (Date(), cursor)
    }

    /// Listen from the sentence the remote is on.
    func listenFromHere() {
        let sentence = sentences[cursor]
        if atDozed { listening.dozing.forget() }
        atDozed = false
        // A listening place not moved from is resumed where it stopped, a little before; anywhere else, from the sentence.
        if !listening.loaded && cursor == narrator && !sentence.exact && listening.positionMs > 0 { return resumePlace() }
        listenedFrom = sentence.ms
        narrator = cursor
        following = true
        listening.play(from: max(0, sentence.ms - Self.leadInMs))
        onMarks?()
    }

    /// Back to the narrator's sentence, following it again. From where the person dozed off, that turns it down.
    func returnToNarrator() {
        if atDozed { listening.dozing.forget() }
        atDozed = false
        moveCursor(to: narrator)
    }

    /// Go to a sentence found elsewhere, by a search: the remote is on it, away from the narrator, so left listens from it
    /// and right goes back.
    func show(_ sentence: Int) {
        moveCursor(to: sentence)
    }

    /// Menu: a bookmark being made or deleted is left alone; else back to the narrator when the remote has wandered off,
    /// else out of the book. True when it stays in the book.
    func back() -> Bool {
        if marking != nil || deleting != nil {
            marking = nil
            deleting = nil
            onMarks?()
            return true
        }
        guard !following else { return false }
        returnToNarrator()
        return true
    }

    /// The narration resumed at the narrator's sentence, gone back by as much as the time away asks; the page waits at
    /// the sentence it goes back to while the lead-in plays.
    private func resumePlace() {
        if atDozed { listening.dozing.forget() }
        atDozed = false
        let from = listening.resume()
        listenedFrom = from
        narrator = sentences.read(at: from)
        cursor = narrator
        following = true
        onMarks?()
    }

    /// The narration stopped on its own; for someone who dozed off, the remote goes to where they were last awake.
    private func stopped() {
        calm()
        offerDozed()
        onMarks?()
    }

    /// Where the person dozed off, as the remote's sentence, away from the narrator: Left listens from it.
    private func offerDozed() {
        guard let ms = listening.dozedOffer else { return }
        // The moment kept may be in the lead-in before a sentence listened from: that sentence is the one.
        let sentence = sentences.read(at: ms + Self.leadInMs)
        guard sentence < narrator else { return }
        cursor = sentence
        following = false
        calm()
        atDozed = true
    }

    // Bookmarks ----------------------------------------------------------

    /// Select held: start a bookmark at the remote's sentence, or, on words already bookmarked, offer to delete them.
    func holdSelect() {
        guard marking == nil, deleting == nil else { return }
        if let found = bookmarks.containing(cursor) {
            deleting = found
        } else {
            marking = cursor
            // The remote's sentence stays where it is while the bookmark takes in more, wherever the narrator goes.
            following = false
            calm()
        }
        onMarks?()
    }

    /// The sentences being bookmarked, in the order of the book.
    var markingRange: ClosedRange<Int>? {
        marking.map { min($0, cursor)...max($0, cursor) }
    }

    /// Select, while bookmarking: keep it, on every device.
    func keepBookmark() {
        guard let sentences = markingRange else { return }
        marking = nil
        onMarks?()
        Task {
            do {
                _ = try await bookmarks.add(sentences: sentences)
                show(sentences.count == 1 ? "Bookmarked" : "Bookmarked \(sentences.count) sentences")
            } catch {
                show(error.localizedDescription)
            }
            onMarks?()
        }
    }

    /// Select, on a bookmark held: delete it, on every device.
    func deleteBookmark() {
        guard let bookmark = deleting else { return }
        deleting = nil
        onMarks?()
        Task {
            do {
                try await bookmarks.remove(bookmark)
                show("Bookmark deleted")
            } catch {
                show(error.localizedDescription)
            }
            onMarks?()
        }
    }

    /// A line about a bookmark, for a few seconds.
    private func show(_ words: String) {
        notice = words
        noticeShown?.cancel()
        noticeShown = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
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

    /// The river: every word but the ones being read stepped back, once the narration has played a few seconds with
    /// the remote following it.
    var river: Bool { listening.playing && following && followedMs >= Self.riverAfterMs }

    // Inside -------------------------------------------------------------

    private func moveCursor(to index: Int) {
        let target = min(max(0, index), sentences.count - 1)
        // Moving on from a bookmark offered for deleting keeps it.
        if deleting != nil {
            deleting = nil
            onMarks?()
        }
        guard target != cursor || !following else { return }
        atDozed = false
        cursor = target
        // Back on the narrator's sentence, the remote follows it again; never while a bookmark takes in more.
        following = cursor == narrator && marking == nil
        if !following { calm() }
        onMarks?()
    }

    /// The narration reached a moment: the sentence it's in is the narrator's, and the remote's while it follows. In a
    /// book that reads only, the text stays where the person is reading.
    private func heard(_ ms: Int) {
        guard readAlong.readsAlong else { return }
        let before = river
        flow(ms)
        let now = sentences.read(at: followed(ms))
        guard now != narrator || river != before else { return }
        narrator = now
        if following { cursor = now }
        onMarks?()
    }

    /// The narration playing on while the remote follows it, toward the river: from the moment heard just before, but
    /// not across a jump (a sentence listened from), and from nothing again after a pause.
    private func flow(_ ms: Int) {
        guard listening.playing && following else { return calm() }
        let at = Date()
        defer { lastHeard = (at, ms) }
        // The player says where it is five times a second while it plays.
        guard let last = lastHeard, at.timeIntervalSince(last.at) < 1 else {
            followedMs = 0
            return
        }
        let played = ms - last.ms
        if played > 0 && played < 1_000 { followedMs += played }
    }

    /// Every word back at full ink, and the few seconds before the river comes in again start over.
    private func calm() {
        followedMs = 0
        lastHeard = nil
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
