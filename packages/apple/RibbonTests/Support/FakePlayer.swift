import UIKit
@testable import Ribbon

/// BookPlayer without its audio, for driving Listening in the tests: where
/// it is, by BookPlayer's own table (`BookPlayer.next`), and what it tells,
/// as BookPlayer tells it; only the sound is pretend. BookPlayerTests checks
/// on real audio that Apple's player does what the table expects. The tests
/// say what happens: the narration plays on, the headphones go, a call comes.
@MainActor
final class FakePlayer: Player, StandIn {
    var onTime: ((Int) -> Void)?
    var onEnd: (() -> Void)?
    var onSystemPause: (() -> Void)?
    var onSystemResume: (() -> Void)?
    var speed = 1.0
    var volume: Float = 1
    var nowPlayingTitle = ""
    var nowPlayingAuthor = ""
    var nowPlayingChapter = ""
    var nowPlayingCover: UIImage?

    private(set) var state = BookPlayer.State.resting(at: 0)
    /// Where the queued audio is.
    private var at = 0
    private var interruptedWhilePlaying = false
    private let durationMs: Int

    init(durationMs: Int) {
        self.durationMs = durationMs
    }

    var loaded: Bool {
        if case .resting = state { return false }
        return true
    }

    var positionMs: Int {
        if case .resting(let ms) = state { return ms }
        return at
    }

    var sounding: Bool { state == .playing }

    @discardableResult
    private func on(_ event: BookPlayer.Event) -> Bool {
        guard let next = BookPlayer.next(state, on: event) else { return false }
        state = next
        return true
    }

    func play(from ms: Int) {
        at = max(0, ms)
        on(.play)
        interruptedWhilePlaying = false
    }

    func resume() {
        if case .resting(let ms) = state { return play(from: ms) }
        on(.resume)
        interruptedWhilePlaying = false
    }

    func pause() {
        on(.pause)
        if loaded { onTime?(positionMs) }
    }

    func hold() {
        guard on(.hold) else { return }
        onTime?(positionMs)
    }

    func unload(at ms: Int) {
        on(.unload(at: ms))
    }

    func stop() {
        on(.unload(at: positionMs))
    }

    func updateNowPlaying() {}

    // What happens to it --------------------------------------------------------

    func plays(for ms: Int) {
        var left = ms
        while left > 0 && sounding {
            let step = min(1_000, left)
            left -= step
            at = min(durationMs, at + step)
            onTime?(at)
            if at >= durationMs { return lastFileEnds() }
        }
    }

    func playsToTheEnd() {
        plays(for: durationMs)
    }

    private func lastFileEnds() {
        on(.ended(at: durationMs))
        onEnd?()
    }

    func systemStops() {
        guard on(.systemStop) else { return }
        onSystemPause?()
    }

    func callBegins() {
        interruptedWhilePlaying = state.plays
        systemStops()
    }

    func callEnds() {
        if interruptedWhilePlaying && state != .playing { onSystemResume?() }
        interruptedWhilePlaying = false
    }
}

/// A player the tests drive: what they make happen to it, and whether the narration can be heard.
@MainActor
protocol StandIn: Player {
    /// Whether the narration can be heard.
    var sounding: Bool { get }
    /// The narration plays on this long, if it can be heard, told once a second; into the end, the last file ends.
    func plays(for ms: Int)
    func playsToTheEnd()
    /// The headphones go, or a Bluetooth speaker: the system pauses it, and it tells, if it was playing.
    func systemStops()
    func callBegins()
    /// The call ends, and asks for the narration to go on, as a phone call does.
    func callEnds()
}
