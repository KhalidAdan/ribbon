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
}
