import XCTest
@testable import Ribbon

/// The server's real answers, decoded by the app's own types. The files in
/// Contract/ are written by packages/server/test/api-contract.test.ts from a running
/// server, so if the server's answers change, that test says so and this one
/// says whether the app can still read them.
final class ContractTests: XCTestCase {
    private func answer<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json"), "\(name).json isn't in the test bundle")
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    func testTheLibrary() throws {
        struct Books: Decodable { let books: [ServerBook] }
        struct Series: Decodable { let series: [ServerSeries] }
        XCTAssertEqual(try answer("books", as: Books.self).books.first?.title, "The Waygate")
        // Its words, counted from its EPUB, which the bookcase stands it by.
        XCTAssertNotNil(try answer("books", as: Books.self).books.first?.words)
        XCTAssertEqual(try answer("series", as: Series.self).series.first?.name, "The Waygates")
    }

    /// Who is signed in: whether they are the server's admin, who may delete its books.
    func testWhoIsSignedIn() throws {
        struct Me: Decodable { let user: ServerPerson }
        XCTAssertTrue(try answer("me", as: Me.self).user.isAdmin)
    }

    func testABook() throws {
        XCTAssertFalse(try answer("book", as: ServerBookDetail.self).files.isEmpty)
        let reading = try answer("readalong", as: ReadAlong.self)
        XCTAssertFalse(reading.blocks.isEmpty)
    }

    /// A comic (docs/COMICS.md): its pages in order, each with its size, and its place as a page.
    func testAComic() throws {
        let comic = try answer("comic-book", as: ServerBookDetail.self)
        let pages = try XCTUnwrap(comic.pages)
        XCTAssertFalse(pages.isEmpty)
        XCTAssertFalse(pages[0].name.isEmpty)
        XCTAssertGreaterThan(pages[0].width, 0)
        XCTAssertEqual(comic.book.rightToLeft, true)
        // It has no audio and no chapters, and still decodes.
        XCTAssertTrue(comic.files.isEmpty)
        struct Place: Decodable { let place: ComicPlace? }
        let place = try XCTUnwrap(try answer("comic-place", as: Place.self).place)
        XCTAssertGreaterThan(place.page, 0)
        XCTAssertGreaterThan(place.pages, 0)
        // A book that isn't a comic says so in the library, and has no pages.
        struct Books: Decodable { let books: [ServerBook] }
        XCTAssertEqual(try answer("books", as: Books.self).books.first?.isComic, false)
        XCTAssertNil(try answer("book", as: ServerBookDetail.self).pages)
    }

    /// Read-along turned off for the book by the admin (packages/core/src/edits.ts, `readAlong`): the app opens it
    /// to read only, and says it's off rather than that it's waiting to be transcribed.
    func testABookWithReadAlongTurnedOff() throws {
        let reading = try answer("readalong-off", as: ReadAlong.self)
        XCTAssertEqual(reading.off, true)
        XCTAssertFalse(reading.readsAlong)
        XCTAssertEqual(reading.notReady?.title, "Reading only")
        XCTAssertFalse(reading.blocks.compactMap(\.sentences).joined().contains { $0.exact })
        // The book it's on for says nothing of the switch, and reads along.
        XCTAssertNil(try answer("readalong", as: ReadAlong.self).off)
        XCTAssertTrue(try answer("readalong", as: ReadAlong.self).readsAlong)
    }

    func testAPlaceAndHowFarThrough() throws {
        struct Told: Decodable { let added: Int }
        struct Place: Decodable { let place: BookPlace? }
        struct Progress: Decodable { let books: [String: BookProgress] }
        _ = try answer("place-told", as: Told.self)
        XCTAssertNotNil(try answer("place", as: Place.self).place)
        XCTAssertFalse(try answer("progress", as: Progress.self).books.isEmpty)
    }

    func testBookmarks() throws {
        struct Made: Decodable { let bookmark: ServerBookmark }
        struct InABook: Decodable { let bookmarks: [ServerBookmark] }
        struct InEveryBook: Decodable { let bookmarks: [Passage] }
        struct Deleted: Decodable { let deleted: String }
        _ = try answer("bookmark-made", as: Made.self)
        XCTAssertFalse(try answer("bookmarks", as: InABook.self).bookmarks.isEmpty)
        XCTAssertFalse(try answer("passages", as: InEveryBook.self).bookmarks.isEmpty)
        _ = try answer("bookmark-deleted", as: Deleted.self)
        // A moment, with a note, and the note changed.
        XCTAssertNotNil(try answer("bookmark-moment", as: Made.self).bookmark.ms)
        XCTAssertEqual(try answer("bookmark-noted", as: Made.self).bookmark.note, "where it opens")
    }

    func testListeningAndTheEndOfABook() throws {
        struct Told: Decodable { let added: Int }
        struct Finished: Decodable { let read: ListenThrough }
        _ = try answer("listened", as: Told.self)
        _ = try answer("finished", as: Finished.self)
        _ = try answer("reading", as: Told.self)
        struct Listens: Decodable { let listens: [Listen] }
        XCTAssertEqual(try answer("listens", as: Listens.self).listens.first?.ended.how, "finished")
        XCTAssertNil(try answer("unfinished", as: Finished.self).read.finished)
    }

    func testTheDailyGoal() throws {
        let today = try answer("goal", as: GoalToday.self)
        XCTAssertEqual(today.goal.minutes, 1000)
        struct Chosen: Decodable { let goal: GoalToday.Goal }
        _ = try answer("goal-chosen", as: Chosen.self)
    }

    func testStats() throws {
        let stats = try answer("stats", as: ListeningStats.self)
        XCTAssertEqual(stats.days.count, 2)
    }

    func testALineFound() throws {
        struct Found: Decodable { let results: [SearchResult] }
        XCTAssertFalse(try answer("search", as: Found.self).results.isEmpty)
    }

    func testABookFound() throws {
        struct Found: Decodable { let results: [SearchResult]; let books: [String] }
        XCTAssertFalse(try answer("search-book", as: Found.self).books.isEmpty)
    }
}
