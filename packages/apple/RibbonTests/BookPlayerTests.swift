import AVFoundation
import XCTest
@testable import Ribbon

/// BookPlayer on real audio: short files of silence, made for each test and
/// played by Apple's own player, so the rules the stand-in keeps
/// (Support/FakePlayer.swift) are the real player's.
@MainActor
final class BookPlayerTests: XCTestCase {
    private var made: [BookPlayer] = []

    override func tearDown() async throws {
        for player in made { player.stop() }
        made = []
    }

    /// A book of one file of silence this long, and what its player tells.
    private func book(ms: Int) throws -> (BookPlayer, Told) {
        let url = FileManager.default.temporaryDirectory.appending(path: "silence-\(UUID().uuidString).caf")
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 8_000, channels: 1))
        let file = try AVAudioFile(forWriting: url, settings: format.settings)
        let frames = AVAudioFrameCount(8 * ms)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        try file.write(from: buffer)
        let player = BookPlayer(files: [.init(url: url, startMs: 0, durationMs: ms)], cookie: nil)
        made.append(player)
        let told = Told()
        player.onTime = { told.times.append($0) }
        player.onEnd = { told.ends += 1 }
        player.onSystemPause = { told.systemPauses += 1 }
        return (player, told)
    }

    private final class Told {
        var times: [Int] = []
        var ends = 0
        var systemPauses = 0
    }

    /// Plays it until it ends, or gives up: a machine with no audio plays nothing, and says nothing about these rules.
    private func playToTheEnd(_ player: BookPlayer, _ told: Told) async throws {
        player.play(from: 0)
        for _ in 0..<40 where told.ends == 0 {
            try await Task.sleep(for: .milliseconds(100))
        }
        try XCTSkipIf(told.times.isEmpty, "Nothing played here: no audio to play it on.")
        XCTAssertEqual(told.ends, 1)
    }

    func testAfterItsLastFileItRestsAtTheEnd() async throws {
        let (player, told) = try book(ms: 600)
        try await playToTheEnd(player, told)
        // Nothing queued: playing on asks for the book again, rather than resuming nothing.
        XCTAssertFalse(player.loaded)
        XCTAssertFalse(player.playing)
        XCTAssertEqual(player.positionMs, 600, "where it ended, not the start")
        told.times = []
        player.pause()
        XCTAssertEqual(told.times, [], "paused at the end, it tells no other place")
    }

    func testPlayedOnFromRestItPlaysFromThere() async throws {
        let (player, told) = try book(ms: 900)
        try await playToTheEnd(player, told)
        player.unload(at: 300)
        told.times = []
        // Nothing queued: playing on asks for the book again, rather than playing nothing.
        player.resume()
        XCTAssertTrue(player.playing)
        for _ in 0..<40 where told.ends < 2 {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(told.ends, 2, "it played, to the end again")
    }

    /// The system takes the headphones away: what Apple's audio session says when they're pulled out.
    private func headphonesGo() async throws {
        let reason = AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
        NotificationCenter.default.post(name: AVAudioSession.routeChangeNotification, object: nil, userInfo: [AVAudioSessionRouteChangeReasonKey: reason])
        try await Task.sleep(for: .milliseconds(100))
    }

    func testHeldForAChaptersCardTheSystemStoppingItIsSaid() async throws {
        let (player, told) = try book(ms: 3_000)
        player.play(from: 0)
        try await Task.sleep(for: .milliseconds(300))
        player.hold()
        XCTAssertEqual(player.state, .held)
        XCTAssertFalse(player.playing, "nothing plays while the card shows")
        try await headphonesGo()
        XCTAssertEqual(told.systemPauses, 1)
        XCTAssertEqual(player.state, .paused)
    }

    /// A call: what Apple's audio session says as one begins, and as it ends asking for the narration back.
    private func call(_ kind: AVAudioSession.InterruptionType) async throws {
        var info: [AnyHashable: Any] = [AVAudioSessionInterruptionTypeKey: kind.rawValue]
        if kind == .ended { info[AVAudioSessionInterruptionOptionKey] = AVAudioSession.InterruptionOptions.shouldResume.rawValue }
        NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil, userInfo: info)
        try await Task.sleep(for: .milliseconds(100))
    }

    func testACallsEndAsksForTheNarrationBackUnlessItWasPlayedSince() async throws {
        let (player, _) = try book(ms: 3_000)
        var resumes = 0
        player.onSystemResume = { resumes += 1 }
        player.play(from: 0)
        try await Task.sleep(for: .milliseconds(200))
        try await call(.began)
        try await call(.ended)
        XCTAssertEqual(resumes, 1, "stopped by the call, and asked back at its end")
        player.resume()
        try await call(.began)
        // Played again during the call, and paused again by hand.
        player.resume()
        player.pause()
        try await call(.ended)
        XCTAssertEqual(resumes, 1, "the person's since: the call's end asks nothing")
    }

    func testPausedTheSystemStoppingItIsNotSaid() async throws {
        let (player, told) = try book(ms: 3_000)
        player.play(from: 0)
        try await Task.sleep(for: .milliseconds(300))
        player.pause()
        try await headphonesGo()
        XCTAssertEqual(told.systemPauses, 0, "already paused: nothing for the system to stop")
        player.resume()
        try await headphonesGo()
        XCTAssertEqual(told.systemPauses, 1)
    }
}
