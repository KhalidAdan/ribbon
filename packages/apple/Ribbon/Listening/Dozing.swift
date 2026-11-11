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
///
/// Whether it's asked is one status, changed in one place (`become`), and
/// the remote's next press follows it: while it's asked, that press only
/// answers (docs/STATE-MACHINES.md).
///
/// ```
///  awake ── forty minutes, nothing pressed ──▶ asked ── a minute, no answer ──▶ stopping ── reached ──▶ awake, dozed
///  asked, stopping ── a press or a touch, a sleep timer, the app sent behind, the narration stopped ──▶ awake
///  stopping ── the narration moved ──▶ asked
/// ```
@MainActor
@Observable
final class Dozing {
    enum Status: Equatable {
        /// Nothing asked.
        case awake
        /// "Still listening?" is up, since then.
        case asked(since: Date)
        /// Asked a minute ago and not answered: the narration stops at `atMs`, the end of the sentence, fading out to
        /// it when there's no sentence to end at.
        case stopping(asked: Date, atMs: Int, fades: Bool)
    }

    /// Changed only by `become`.
    private(set) var status = Status.awake
    /// Where you dozed off: the moment of the narration when you were last awake. Offered until it's taken or
    /// turned down, or the book has played on well past where it stopped.
    private(set) var dozedAt: Int?

    /// When "Still listening?" was asked, while it waits for an answer.
    var asked: Date? {
        switch status {
        case .awake: nil
        case .asked(let since), .stopping(let since, _, _): since
        }
    }

    /// Where the narration stops for someone who didn't answer, and whether it fades out to there.
    var stop: (ms: Int, fades: Bool)? {
        guard case .stopping(_, let ms, let fades) = status else { return nil }
        return (ms, fades)
    }

    /// Asked a minute ago, with no answer, and nowhere to stop chosen yet.
    var due: Bool {
        guard case .asked(let since) = status else { return false }
        return Date().timeIntervalSince(since) > answerWithin
    }

    /// How long with nothing pressed before it asks, and how long it waits for an answer: forty minutes and one, unless
    /// the tests say otherwise.
    @ObservationIgnored var askAfter = Waits.of(40 * 60, quick: 20)
    @ObservationIgnored var answerWithin = Waits.of(60, quick: 10)

    @ObservationIgnored private var stoppedAt: Int?
    @ObservationIgnored private var awakeMs: Int
    @ObservationIgnored private var inputSeen = Remote.lastInput
    @ObservationIgnored private let key: String

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

    /// The one place the status changes. From the moment it's asked, the next press or touch only answers it; once it
    /// isn't, the press goes to the screen again.
    private func become(_ next: Status) {
        let wasAsked = status != .awake
        if status != next { status = next }
        if next == .awake {
            Remote.stopWaiting("dozing")
        } else if !wasAsked {
            Remote.wait("dozing") {}
        }
    }

    /// A moment heard while the narration plays. A press or a touch since the last is the person awake here, and
    /// their answer if they were asked. Nothing is asked while `quiet`: a sleep timer is set, or the app is behind the
    /// home screen.
    func heard(_ ms: Int, quiet: Bool) {
        if Remote.lastInput != inputSeen {
            inputSeen = Remote.lastInput
            awakeMs = ms
            become(.awake)
        }
        if let stoppedAt, ms - stoppedAt > Self.forgottenAfterMs { forget() }
        // A sleep timer set will stop it anyway, as the person chose.
        if quiet {
            become(.awake)
        } else if status == .awake && Date().timeIntervalSince(Remote.lastInput) > askAfter {
            become(.asked(since: Date()))
        }
    }

    /// No answer: the narration stops at this moment, fading out to it or not.
    func stop(at ms: Int, fades: Bool) {
        guard case .asked(let since) = status else { return }
        become(.stopping(asked: since, atMs: ms, fades: fades))
    }

    /// The narration moved: where it was to stop no longer stands, though the question does.
    func moved() {
        guard case .stopping(let since, _, _) = status else { return }
        become(.asked(since: since))
    }

    /// Stopped with no answer: where they were last awake is kept for next time.
    func dozed(stoppedAt ms: Int) {
        become(.awake)
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
        become(.awake)
    }

    /// How loud the narration plays as it fades out to where it stops, over `fadeMs` heard at this speed: 1 when it
    /// isn't fading.
    func loudness(at ms: Int, speed: Double, fadeMs: Int) -> Float {
        guard let stop, stop.fades else { return 1 }
        return min(1, max(0, Float(Double(stop.ms - ms) / speed) / Float(fadeMs)))
    }
}
