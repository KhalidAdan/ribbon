import UIKit
@testable import Ribbon

/// BookPlayer as it was before its state was written down (RibbonTests/Before,
/// for ListeningBeforeAfterTests), without its audio: the stand-in the old
/// Listening is driven on. Its rules are the old BookPlayer's, as it was seen
/// to do on real audio (2026-11-10): after its last file it stayed loaded
/// with nothing queued, so playing on played nothing, and its place fell back
/// to where it last rested; and while it was paused, for a chapter's card or
/// by hand, it didn't say the system had stopped it.
@MainActor
final class FakePlayerBefore: Player, StandIn {
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

    private(set) var playing = false
    private(set) var loaded = false
    /// Whether a file is queued: none after the last one ends, and playing on then plays nothing.
    private var queued = false
    /// Where the queued audio is.
    private var at = 0
    /// Where it is with no file queued: the start, or where it was let go at.
    private var restingMs = 0
    private var interruptedWhilePlaying = false
    private let durationMs: Int

    init(durationMs: Int) {
        self.durationMs = durationMs
    }

    var positionMs: Int { queued ? at : restingMs }

    /// Whether the narration can be heard.
    var sounding: Bool { playing && queued }

    func play(from ms: Int) {
        at = max(0, ms)
        queued = true
        loaded = true
        resume()
    }

    func resume() {
        playing = true
    }

    func pause() {
        playing = false
        if loaded { onTime?(positionMs) }
    }

    /// The old BookPlayer had no hold, and the old Listening never asks for one.
    func hold() {
        pause()
    }

    func unload(at ms: Int) {
        restingMs = ms
        queued = false
        playing = false
        loaded = false
    }

    func stop() {
        queued = false
        playing = false
    }

    func updateNowPlaying() {}

    // What happens to it --------------------------------------------------------

    /// The narration plays on this long, if it can be heard, told once a second; into the end, the last file ends.
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
        queued = false
        playing = false
        onEnd?()
    }

    /// The headphones go, or a Bluetooth speaker: the system pauses it, and it tells, if it was playing.
    func systemStops() {
        guard playing else { return }
        playing = false
        onSystemPause?()
    }

    func callBegins() {
        interruptedWhilePlaying = playing
        systemStops()
    }

    /// The call ends, and asks for the narration to go on, as a phone call does.
    func callEnds() {
        if interruptedWhilePlaying && !playing { onSystemResume?() }
        interruptedWhilePlaying = false
    }
}
