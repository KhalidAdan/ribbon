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
