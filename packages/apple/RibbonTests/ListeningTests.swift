import XCTest
@testable import Ribbon

/// The rules of the book being listened to that need no server answering:
/// where a paused book goes when another device moved on, the sleep
/// timer's clock while it's paused, the transport while it's paused, and,
/// on a stand-in for the player (FakePlayer), what happens as it plays: its
/// end, a chapter's card, the system stopping it, and dozing off. The server
/// here is one nothing answers at, so every place told fails.
@MainActor
final class ListeningTests: XCTestCase {
    private static let account = Account(url: URL(string: "http://127.0.0.1:9")!, name: "test", token: "", cookieName: "", cookieValue: "")
    private var made: [Listening] = []

    /// Half an hour in two chapters, paused a minute in.
    private func listening(at ms: Int = 60_000) -> Listening {
        let book = ServerBook(id: "book", title: "A Book", author: "", narrator: "", series: "", seriesIndex: nil, durationMs: 1_800_000, audio: true, ebook: false, ebookBytes: nil, words: nil, cover: nil, addedAt: nil)
        let detail = ServerBookDetail(
            files: [.init(path: "01.mp3", durationMs: 1_800_000)],
            chapters: [.init(startMs: 0, endMs: 900_000, title: "One"), .init(startMs: 900_000, endMs: 1_800_000, title: "Two")],
            book: .init(description: nil, year: nil, publisher: nil)
        )
        return Listening(book: book, detail: detail, startMs: ms, placedAt: Date(), server: RibbonServer(account: Self.account))
    }

    /// Forty seconds in four chapters of ten, paused at its start, played on a stand-in the test drives.
    private func played() -> (Listening, FakePlayer) {
        let book = ServerBook(id: "played", title: "A Book", author: "", narrator: "", series: "", seriesIndex: nil, durationMs: 40_000, audio: true, ebook: false, ebookBytes: nil, words: nil, cover: nil, addedAt: nil)
        let detail = ServerBookDetail(
            files: [.init(path: "01.mp3", durationMs: 40_000)],
            chapters: (0..<4).map { .init(startMs: $0 * 10_000, endMs: ($0 + 1) * 10_000, title: "Chapter \($0 + 1)") },
            book: .init(description: nil, year: nil, publisher: nil)
        )
        let player = FakePlayer(durationMs: 40_000)
        let listening = Listening(book: book, detail: detail, startMs: 0, placedAt: nil, server: RibbonServer(account: Self.account), player: player)
        made.append(listening)
        return (listening, player)
    }

    /// What a press of Play, or a call's end, starts runs on its own: let it.
    private func settle() async {
        for _ in 0..<10 { await Task.yield() }
    }

    override func tearDown() async throws {
        for listening in made {
            listening.dozing.forget()
            listening.stop()
        }
        made = []
        Remote.stopWaiting("dozing")
    }

    func testAPausedBookGoesWhereAnotherDeviceLeftIt() {
        let book = listening()
        let anHourAgo = Date().addingTimeInterval(-3600)
        book.catchUp(to: 600_000, at: anHourAgo)
        XCTAssertEqual(book.positionMs, 600_000)
        // Resuming goes back by how long ago the other device stopped.
        XCTAssertEqual(book.pausedAt, anHourAgo)
        XCTAssertFalse(book.playing)
    }

    func testTheSamePlaceIsNoMove() {
        let book = listening()
        let kept = book.pausedAt
        book.catchUp(to: 60_400, at: Date().addingTimeInterval(-3600))
        XCTAssertEqual(book.positionMs, 60_000)
        XCTAssertEqual(book.pausedAt, kept)
    }

    func testAPlaceToldHereThatHasntLandedIsNotUndone() {
        let book = listening()
        // Told as it moves; the server hasn't answered yet, so what it says is newest may be older than this.
        book.move(to: 120_000)
        book.catchUp(to: 600_000, at: Date())
        XCTAssertEqual(book.positionMs, 120_000)
    }

    func testAPlaceThatCouldntBeToldIsNotUndone() async throws {
        let book = listening()
        book.move(to: 120_000)
        // Nothing answers at this server: the place told here is still the newest, only the server doesn't know it.
        try await Task.sleep(for: .seconds(1))
        book.catchUp(to: 600_000, at: Date())
        XCTAssertEqual(book.positionMs, 120_000)
    }

    func testTheSleepTimersClockWaitsWhilePaused() async throws {
        let book = listening()
        book.sleep(after: 30)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(Double(book.sleepLeftMs ?? 0), 1_800_000, accuracy: 5)
    }

    func testMoreMinutesTurnAChaptersEndIntoMinutes() {
        let book = listening()
        book.sleepAtChapterEnd()
        book.extendSleep(by: 15)
        XCTAssertEqual(Double(book.sleepLeftMs ?? 0), 900_000, accuracy: 5)
    }

    func testTheTransportLeavesAPausedBookPaused() {
        let book = listening()
        book.skip(by: -Listening.skipMs)
        XCTAssertEqual(book.positionMs, 30_000)
        book.chapter(by: 1)
        XCTAssertEqual(book.positionMs, 900_000)
        XCTAssertFalse(book.playing)
        // A place chosen is exact: nothing to go back by.
        XCTAssertNil(book.pausedAt)
    }

    // As it plays ---------------------------------------------------------------

    func testPlayAfterTheEndIsHeard() async {
        let (book, player) = played()
        book.play(from: 35_000)
        player.playsToTheEnd()
        XCTAssertFalse(book.playing)
        XCTAssertEqual(book.positionMs, 40_000)
        // Play, a moment after the end, from the lock screen or the player.
        book.playPause()
        await settle()
        XCTAssertEqual(book.playing, player.sounding, "it says it plays: something must be heard")
    }

    func testPlayAfterTheEndStartsTheBookAgain() async {
        let (book, player) = played()
        book.play(from: 35_000)
        player.playsToTheEnd()
        book.playPause()
        await settle()
        // As Listen does for a finished book: from its start, as a new listen-through.
        XCTAssertTrue(book.playing)
        XCTAssertEqual(book.positionMs, 0)
        player.plays(for: 2_000)
        XCTAssertEqual(book.positionMs, 2_000)
    }

    func testTheHeadphonesGoingDuringAChaptersCardPauseIt() {
        let (book, player) = played()
        book.showsCards = { true }
        book.play(from: 8_000)
        player.plays(for: 2_000)
        XCTAssertEqual(book.card, 1, "into chapter two, with the book on screen: its card shows")
        player.systemStops()
        XCTAssertFalse(book.playing)
        // The card's moment passes: the narration mustn't go on aloud, from the phone's speaker.
        book.cardPassed(1)
        XCTAssertFalse(player.sounding)
    }

    func testACallDuringAChaptersCardPausesItUntilTheCallEnds() async {
        let (book, player) = played()
        book.showsCards = { true }
        book.play(from: 8_000)
        player.plays(for: 2_000)
        XCTAssertEqual(book.card, 1)
        player.callBegins()
        XCTAssertFalse(book.playing)
        book.cardPassed(1)
        XCTAssertFalse(player.sounding, "nothing plays over the call")
        // The call ends, and asks for the narration to go on, as it does after one that came while it played.
        player.callEnds()
        await settle()
        XCTAssertTrue(book.playing)
        XCTAssertTrue(player.sounding)
    }

    /// Asked whether they're still listening, and a minute later, no answer: it fades out, with no sentences to stop at.
    private func dozingOff(_ book: Listening, _ player: FakePlayer) {
        book.dozing.askAfter = 0
        player.plays(for: 1_000)
        XCTAssertNotNil(book.dozing.asked)
        book.dozing.answerWithin = 0
        player.plays(for: 5_000)
        XCTAssertLessThan(player.volume, 1, "fading out")
    }

    func testASeekFromTheLockScreenWhileItFadesOutPlaysOnInFull() {
        let (book, player) = played()
        book.play(from: 0)
        dozingOff(book, player)
        // Awake after all: back thirty seconds, from the lock screen.
        Remote.used()
        book.dozing.askAfter = 40 * 60
        book.dozing.answerWithin = 60
        book.skip(by: -Listening.skipMs)
        player.plays(for: 1_000)
        XCTAssertTrue(player.sounding)
        XCTAssertNil(book.dozing.asked)
        XCTAssertEqual(player.volume, 1)
    }

    func testAfterEndingWhileItFadesOutTheBookPlaysAgainInFull() async {
        let (book, player) = played()
        book.play(from: 30_000)
        dozingOff(book, player)
        player.playsToTheEnd()
        // Started again, from the bookcase.
        Remote.used()
        book.dozing.askAfter = 40 * 60
        book.dozing.answerWithin = 60
        book.startingAgain = true
        book.play(from: 0)
        player.plays(for: 1_000)
        XCTAssertEqual(player.volume, 1)
    }

    func testASeekBackWhileTheSleepTimerFadesOutPlaysOnInFull() {
        let (book, player) = played()
        book.play(from: 15_000)
        book.sleepAtChapterEnd()
        player.plays(for: 3_000)
        XCTAssertLessThan(player.volume, 1, "two seconds from the chapter's end, fading out")
        // Back to the start: chapter two's end is twenty seconds away again.
        book.play(from: 0)
        player.plays(for: 1_000)
        XCTAssertEqual(player.volume, 1)
    }

    func testStillListeningIsPutAwayAtTheEnd() {
        let (book, player) = played()
        book.play(from: 30_000)
        book.dozing.askAfter = 0
        player.plays(for: 1_000)
        XCTAssertNotNil(book.dozing.asked)
        XCTAssertEqual(Remote.whoWaits, ["dozing"], "the next press only answers it")
        player.playsToTheEnd()
        XCTAssertNil(book.dozing.asked, "nothing plays: there's nothing to ask")
        XCTAssertEqual(Remote.whoWaits, [], "the next press goes to the screen")
    }

    func testTheSleepTimersClockWaitsAfterTheEnd() async throws {
        let (book, player) = played()
        book.play(from: 35_000)
        book.sleep(after: 30)
        player.playsToTheEnd()
        let left = try XCTUnwrap(book.sleepLeftMs)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(Double(book.sleepLeftMs ?? 0), Double(left), accuracy: 5, "nothing plays, so the clock waits, as it does while paused")
    }
}

/// The remote's presses and touches, and what waits for the next one.
@MainActor
final class RemoteTests: XCTestCase {
    override func tearDown() async throws {
        Remote.stopWaiting("passages")
        Remote.stopWaiting("dozing")
    }

    func testTwoWaitingAtOnceAreBothWoken() {
        var woken: [String] = []
        Remote.wait("passages") { woken.append("passages") }
        Remote.wait("dozing") { woken.append("dozing") }
        XCTAssertEqual(Remote.whoWaits.sorted(), ["dozing", "passages"])
        XCTAssertTrue(Remote.pressed())
        XCTAssertEqual(woken.sorted(), ["dozing", "passages"])
        XCTAssertEqual(Remote.whoWaits, [])
    }

    func testOneStoppingLeavesTheOtherWaiting() {
        var woken: [String] = []
        Remote.wait("passages") { woken.append("passages") }
        Remote.wait("dozing") { woken.append("dozing") }
        Remote.stopWaiting("dozing")
        XCTAssertEqual(Remote.whoWaits, ["passages"])
        XCTAssertTrue(Remote.pressed(), "the press wakes the passages, and goes no further")
        XCTAssertEqual(woken, ["passages"])
    }
}

/// The speed a book opens at, as the desktop chooses it (packages/core/src/settings.ts, `speedToPlay`).
final class SpeedTests: XCTestCase {
    private let now = Date()

    func testTheSpeedLastHeardAnywhereWhenItsNewer() {
        XCTAssertEqual(Listening.speedToPlay(chosen: 1, at: now.addingTimeInterval(-3600), heard: (1.5, now)), 1.5)
    }

    func testAChoiceMadeHereSinceHolds() {
        XCTAssertEqual(Listening.speedToPlay(chosen: 1.25, at: now, heard: (1.5, now.addingTimeInterval(-3600))), 1.25)
    }

    func testAChoiceFromBeforeTimesWereKeptGivesWay() {
        XCTAssertEqual(Listening.speedToPlay(chosen: 1.25, at: nil, heard: (1.5, now.addingTimeInterval(-86_400))), 1.5)
        XCTAssertEqual(Listening.speedToPlay(chosen: 1.25, at: nil, heard: nil), 1.25)
    }
}
