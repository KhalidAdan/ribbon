import XCTest
@testable import Ribbon

/// The bookcase without its pictures: the cloths the server lists, and where the remote's left and right lead from a
/// shelf's end.
final class BookcaseTests: XCTestCase {
    private func book(_ id: String, cover: ServerBook.Cover? = nil) -> ServerBook {
        ServerBook(id: id, title: "Book \(id)", author: "Ada Verne", narrator: "", series: "", seriesIndex: nil, durationMs: 36_000_000, audio: true, ebook: false,
                   ebookBytes: nil, words: nil, cover: cover, addedAt: nil)
    }

    func testACoverIsBoundInTheClothTheServerLists() {
        let red = book("red", cover: .init(hash: "aaaa", aspect: 1, colour: "#cc2222", cloth: "#6b1f24"))
        let older = book("older", cover: .init(hash: "bbbb", aspect: 1, colour: "#2222cc"))
        let odd = book("odd", cover: .init(hash: "cccc", aspect: 1, colour: "#2222cc", cloth: "navy"))
        let cloths = CoverCloths.cloths(for: [red, older, odd, book("bare")])
        // Oxblood is a swatch itself, so the nearest cloth to it is oxblood.
        XCTAssertEqual(cloths["aaaa"]?.ground, RGB(0x6b1f24))
        // A server that lists no cloth, or one that can't be read, leaves the book to its own quiet cloth.
        XCTAssertNil(cloths["bbbb"])
        XCTAssertNil(cloths["cccc"])
        XCTAssertEqual(cloths.count, 1)
    }

    func testLeftAndRightCarryOnPastAShelfsEnd() {
        let books = (0 ..< 40).map { ShelfBook(book: book("\($0)"), fraction: 0, finished: false) }
        let shelves = layoutCase(books, width: 600, k: 1, cloths: [:])
        XCTAssertGreaterThan(shelves.count, 1)
        let first = shelves[0], second = shelves[1]
        // From a shelf's last book, right is the next shelf's first; from its first, left is the last of the shelf before.
        XCTAssertEqual(acrossShelves(shelves, from: first.last!.id, right: true)?.id, second.first!.id)
        XCTAssertEqual(acrossShelves(shelves, from: second.first!.id, right: false)?.id, first.last!.id)
        // Anywhere else the shelf has its own next book, and the case stops at its two ends.
        XCTAssertNil(acrossShelves(shelves, from: first[1].id, right: true))
        XCTAssertNil(acrossShelves(shelves, from: first.last!.id, right: false))
        XCTAssertNil(acrossShelves(shelves, from: first.first!.id, right: false))
        XCTAssertNil(acrossShelves(shelves, from: shelves.last!.last!.id, right: true))
        XCTAssertNil(acrossShelves(shelves, from: "no such book", right: true))
    }
}

/// The list of books: whose name is on what, and the orders it can be in.
final class BooksListTests: XCTestCase {
    private func book(_ title: String, author: String = "", narrator: String = "", added: String? = nil) -> ServerBook {
        ServerBook(id: title, title: title, author: author, narrator: narrator, series: "", seriesIndex: nil, durationMs: 0, audio: true, ebook: false,
                   ebookBytes: nil, words: nil, cover: nil, addedAt: added)
    }

    func testPeopleInAFieldAreSplitAsTheDesktopSplitsThem() {
        XCTAssertEqual(splitPeople("Terry Pratchett & Neil Gaiman"), ["Terry Pratchett", "Neil Gaiman"])
        XCTAssertEqual(splitPeople("A One; B Two"), ["A One", "B Two"])
        XCTAssertEqual(splitPeople("Ann Lee and Bo Ray"), ["Ann Lee", "Bo Ray"])
        XCTAssertEqual(splitPeople("Ann Lee, Bo Ray"), ["Ann Lee", "Bo Ray"])
        XCTAssertEqual(splitPeople("Ann, Bo, Cy"), ["Ann", "Bo", "Cy"])
        // A single "Last, First" stays one person, and a name with "and" inside a word isn't cut.
        XCTAssertEqual(splitPeople("Herbert, Frank"), ["Herbert, Frank"])
        XCTAssertEqual(splitPeople("Brandon Sanderson"), ["Brandon Sanderson"])
        XCTAssertEqual(splitPeople("  "), [])
    }

    func testAPersonsBooksAreTheOnesWithTheirNameOnThem() {
        let books = [book("Good Omens", author: "Terry Pratchett & Neil Gaiman", narrator: "Martin Jarvis"), book("Mort", author: "Terry Pratchett"), book("Coraline", author: "Neil Gaiman", narrator: "Neil Gaiman")]
        XCTAssertEqual(books.by(.author("Terry Pratchett")).map(\.title), ["Good Omens", "Mort"])
        XCTAssertEqual(books.by(.narrator("Neil Gaiman")).map(\.title), ["Coraline"])
        XCTAssertEqual(books.by(.author("Nobody")).map(\.title), [])
    }

    func testTheOrdersFileBooksAsAShelfDoes() {
        let books = [
            book("The Hobbit", author: "J. R. R. Tolkien", added: "2026-01-03T00:00:00.000Z"),
            book("Book 10", author: "Ann Able", added: "2026-01-01T00:00:00.000Z"),
            book("Book 2", author: "Ann Able", added: "2026-01-02T00:00:00.000Z"),
            book("A Wizard of Earthsea", author: "Ursula K. Le Guin"),
        ]
        XCTAssertEqual(books.inOrder(.title).map(\.title), ["Book 2", "Book 10", "The Hobbit", "A Wizard of Earthsea"])
        XCTAssertEqual(books.inOrder(.author).map(\.title), ["Book 2", "Book 10", "A Wizard of Earthsea", "The Hobbit"])
        XCTAssertEqual(books.inOrder(.newest).map(\.title), ["The Hobbit", "Book 2", "Book 10", "A Wizard of Earthsea"])
    }
}

/// What a screen reader is told, and how far the type grows.
final class AccessibilityTests: XCTestCase {
    func testLengthsOfTimeAreSaidInWords() {
        XCTAssertEqual(Format.spoken(3_843_000), "1 hour 4 minutes")
        XCTAssertEqual(Format.spoken(3_600_000), "1 hour")
        XCTAssertEqual(Format.spoken(750_000), "12 minutes 30 seconds")
        XCTAssertEqual(Format.spoken(60_000), "1 minute")
        XCTAssertEqual(Format.spoken(8_000), "8 seconds")
        XCTAssertEqual(Format.spoken(1_000), "1 second")
    }

    func testTheTypeGrowsWithTheDevicesTextSizeAndNoFurtherThanTheScreensHold() {
        XCTAssertGreaterThan(Look.typeScale, 0.7)
        XCTAssertLessThanOrEqual(Look.typeScale, Look.typeScaleMost)
    }
}
