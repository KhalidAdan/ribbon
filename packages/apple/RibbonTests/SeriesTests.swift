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

    /// The owner's White Scars list starts at Scars, which The Horus Heresy has too, and The Horus Heresy was heard
    /// last. Chosen from White Scars, Scars's page lists White Scars.
    func testABooksPageListsTheSeriesItWasOpenedFrom() {
        let (scars, horusRising, whiteScars, all) = twoSeries()
        XCTAssertEqual(Library.series(of: scars, among: all, openedFrom: whiteScars.id).map(\.name), ["White Scars", "The Horus Heresy"])
        // Opened from no series, from Continue or the bookcase: the one heard last, as before.
        XCTAssertEqual(Library.series(of: scars, among: all, openedFrom: nil).map(\.name), ["The Horus Heresy", "White Scars"])
        // Opened from a series the book isn't in any more: the one heard last.
        XCTAssertEqual(Library.series(of: horusRising, among: all, openedFrom: whiteScars.id).map(\.name), ["The Horus Heresy"])
    }

    /// The series card opens its next book's page with the series on it, a book chosen from that page's list keeps
    /// it, and the end of the book finds it for Up next.
    @MainActor
    func testTheSeriesGoesWithThePageItOpens() {
        let (scars, _, whiteScars, _) = twoSeries()
        let brotherhood = whiteScars.books[0]
        let model = AppModel()
        model.open(scars, in: whiteScars)
        XCTAssertEqual(model.path, [.book(scars, series: "white-scars")])
        XCTAssertEqual(model.seriesOpened(for: scars), "white-scars")
        model.open(brotherhood, in: whiteScars)
        XCTAssertEqual(model.path, [.book(brotherhood, series: "white-scars")])
        // From search or the bookcase: no series.
        model.open(scars)
        XCTAssertEqual(model.path, [.book(scars, series: nil)])
        XCTAssertNil(model.seriesOpened(for: scars))
    }

    /// Scars in The Horus Heresy, heard last, and in White Scars, made by hand.
    private func twoSeries() -> (scars: ServerBook, horusRising: ServerBook, whiteScars: Library.Series, all: [Library.Series]) {
        let scars = book("Scars", 28)
        let horusRising = book("Horus Rising", 1)
        let brotherhood = book("Brotherhood of the Storm", nil)
        let heresy = Library.Series(id: "the-horus-heresy", name: "The Horus Heresy", books: [horusRising, scars])
        let whiteScars = Library.Series(id: "white-scars", name: "White Scars", books: [brotherhood, scars])
        // The library's order: the series heard most recently first.
        return (scars, horusRising, whiteScars, [heresy, whiteScars])
    }
}
