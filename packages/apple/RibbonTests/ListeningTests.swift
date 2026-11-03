import XCTest
@testable import Ribbon

/// The rules of the book being listened to that need no server answering:
/// where a paused book goes when another device moved on, the sleep
/// timer's clock while it's paused, and the transport while it's paused.
/// The server here is one nothing answers at, so every place told fails.
@MainActor
final class ListeningTests: XCTestCase {
    /// Half an hour in two chapters, paused a minute in.
    private func listening(at ms: Int = 60_000) -> Listening {
        let account = Account(url: URL(string: "http://127.0.0.1:9")!, name: "test", token: "", cookieName: "", cookieValue: "")
        let book = ServerBook(id: "book", title: "A Book", author: "", narrator: "", series: "", seriesIndex: nil, durationMs: 1_800_000, audio: true, ebook: false, cover: nil)
        let detail = ServerBookDetail(
            files: [.init(path: "01.mp3", durationMs: 1_800_000)],
            chapters: [.init(startMs: 0, endMs: 900_000, title: "One"), .init(startMs: 900_000, endMs: 1_800_000, title: "Two")],
            book: .init(description: nil, year: nil, publisher: nil)
        )
        return Listening(book: book, detail: detail, startMs: ms, placedAt: Date(), server: RibbonServer(account: account))
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
}
