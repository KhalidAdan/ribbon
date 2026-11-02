import XCTest
@testable import Ribbon

/// The server's real answers, decoded by the app's own types. The files in
/// Contract/ are written by server/test/api-contract.test.ts from a running
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
        XCTAssertEqual(try answer("series", as: Series.self).series.first?.name, "The Waygates")
    }

    func testABook() throws {
        XCTAssertFalse(try answer("book", as: ServerBookDetail.self).files.isEmpty)
        let reading = try answer("readalong", as: ReadAlong.self)
        XCTAssertFalse(reading.blocks.isEmpty)
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
    }

    func testListeningAndTheEndOfABook() throws {
        struct Told: Decodable { let added: Int }
        struct Finished: Decodable { let read: ListenThrough }
        _ = try answer("listened", as: Told.self)
        _ = try answer("finished", as: Finished.self)
    }

    func testALineFound() throws {
        struct Found: Decodable { let results: [SearchResult] }
        XCTAssertFalse(try answer("search", as: Found.self).results.isEmpty)
    }
}
