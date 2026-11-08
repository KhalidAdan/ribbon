import XCTest
@testable import Ribbon

/// A book's number in a series: a reading list doesn't take the number its files give it in another series.
final class SeriesTests: XCTestCase {
    private func book(_ id: String, _ index: Double?) -> ServerBook {
        ServerBook(id: id, title: id, author: "", narrator: "", series: "The Horus Heresy", seriesIndex: index, durationMs: 1000, audio: true, ebook: false, ebookBytes: nil, words: nil, cover: nil, addedAt: nil)
    }

    func testAReadingListCountsByPlaceNotByTheFilesNumber() {
        let galaxy = book("Galaxy in Flames", 3)
        let horus = book("Horus Rising", 1)
        // White Scars, made by hand: the server has no number for either.
        let list = Library.Series(id: "white-scars", name: "White Scars", books: [galaxy, horus])
        XCTAssertEqual(list.number(of: galaxy, at: 0), "1")
        XCTAssertEqual(list.number(of: horus, at: 1), "2")
        // A number the server keeps for it is its own.
        let numbered = Library.Series(id: "white-scars", name: "White Scars", books: [galaxy], numbers: [galaxy.id: 2.5])
        XCTAssertEqual(numbered.number(of: galaxy, at: 0), "2.5")
    }

    func testASeriesGroupedByTagsGoesByTheFilesNumbers() {
        let galaxy = book("Galaxy in Flames", 3)
        let tagged = Library.Series(id: "The Horus Heresy", name: "The Horus Heresy", books: [galaxy], fromTags: true)
        XCTAssertEqual(tagged.number(of: galaxy, at: 0), "3")
    }
}
