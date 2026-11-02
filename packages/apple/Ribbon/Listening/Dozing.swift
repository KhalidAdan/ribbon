import Foundation
import Observation

/// Falling asleep to a book. After forty minutes of narration with nothing
/// pressed or touched and no sleep timer set, the TV asks, quietly, whether
/// you're still listening. With no answer within a minute it stops at the
/// end of the sentence, and keeps where you dozed off: the moment of the
/// narration when you last pressed or touched anything. Next time, it
/// offers to go back there.
///
/// That moment is kept on this TV, for each person and book, as the speed
/// is: it's about this sofa and this night, of no use to the phone or the
/// desktop, and the position log every app shares has no record for it. The
/// place itself, where the narration stopped, goes to the server as always.
@MainActor
@Observable
final class Dozing {
    /// When "Still listening?" was asked, while it waits for an answer.
    private(set) var asked: Date?
    /// Where you dozed off: the moment of the narration when you were last awake. Offered until it's taken or
    /// turned down, or the book has played on well past where it stopped.
    private(set) var dozedAt: Int?

    @ObservationIgnored private var stoppedAt: Int?
    @ObservationIgnored private var awakeMs: Int
    @ObservationIgnored private var inputSeen = Remote.lastInput
    @ObservationIgnored private let key: String

    static let askAfter = Waits.of(40 * 60, quick: 20)
    static let answerWithin = Waits.of(60, quick: 10)
    /// Played on this far past where it stopped, they've chosen to go on from there.
    private static let forgottenAfterMs = 10 * 60_000

    init(account: Account, book: ServerBook, at ms: Int) {
        key = "ribbon.dozed.\(account.id).\(book.id)"
        awakeMs = ms
        if let kept = UserDefaults.standard.array(forKey: key) as? [Int], kept.count == 2 {
            dozedAt = kept[0]
            stoppedAt = kept[1]
        }
    }

    /// A moment heard while the narration plays. A press or a touch since the last is the person awake here, and
    /// their answer if they were asked. True when they were asked a minute ago and haven't answered: time to stop.
    /// Nothing is asked while `quiet`: a sleep timer is set, or the app is behind the home screen.
    func heard(_ ms: Int, quiet: Bool) -> Bool {
        if Remote.lastInput != inputSeen {
            inputSeen = Remote.lastInput
            awakeMs = ms
            asked = nil
        }
        if let stoppedAt, ms - stoppedAt > Self.forgottenAfterMs { forget() }
        // A sleep timer set will stop it anyway, as the person chose.
        guard !quiet else {
            asked = nil
            return false
        }
        if asked == nil && Date().timeIntervalSince(Remote.lastInput) > Self.askAfter { asked = Date() }
        return asked.map { Date().timeIntervalSince($0) > Self.answerWithin } ?? false
    }

    /// Stopped with no answer: where they were last awake is kept for next time.
    func dozed(stoppedAt ms: Int) {
        asked = nil
        dozedAt = awakeMs
        stoppedAt = ms
        UserDefaults.standard.set([awakeMs, ms], forKey: key)
    }

    /// Gone back there, or not wanted.
    func forget() {
        dozedAt = nil
        stoppedAt = nil
        UserDefaults.standard.removeObject(forKey: key)
    }

    /// The narration stopped some other way: there's nothing to ask.
    func stopped() {
        asked = nil
    }
}
