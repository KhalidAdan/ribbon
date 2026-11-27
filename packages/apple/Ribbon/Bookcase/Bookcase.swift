import Observation
import SwiftUI
import UIKit

/// The bookcase: every book in the library standing spine-out on shelves, the newest first, each in a cloth matched
/// to its cover, under lamplight. The book you're on comes off the shelf into your hand at the left, with what it is
/// and how far you are; by touch it plays right there, and choosing it again opens its page. On the TV and the iPad the
/// shelves stack in a case; on the iPhone, turned on its side, they make one long shelf. A search finds a book and brings
/// it into view.
@MainActor
@Observable
final class Bookcase {
    /// The shelves stacked in a case, on the TV and the iPad.
    private(set) var rows: [ShelfRow] = []
    /// The phone's one long shelf, in place of the rows.
    private(set) var shelf: LongShelf?
    private(set) var selected: ShelfItem?
    var query = ""
    /// A book chosen from the search, for the stacked shelves to bring into view.
    private(set) var target: Target?
    let hand: BookInHand
    private let library: Library
    @ObservationIgnored private var builtFor = ""
    @ObservationIgnored private var k: CGFloat = 1
    @ObservationIgnored private var scale: CGFloat = 2

    /// A book chosen from the search. The token makes choosing the same book twice scroll to it again.
    struct Target: Equatable {
        let row: Int
        let item: String
        let token: Int
    }

    init(library: Library) {
        self.library = library
        let server = library.server
        #if os(tvOS)
        let width = 800
        #else
        let width = 400
        #endif
        hand = BookInHand { hash in try? await server.cover(hash, width: width).cgImage }
        #if MEASURE
        SpeedPass.shared.watch(self)
        #endif
    }

    /// Every book on the library's shelf, with how far you are in it.
    var books: [ShelfBook] { library.shelfBooks }

    /// How many books are on the shelf, without making each one: the page asks every time it's drawn.
    var count: Int { library.shelved.count }

    /// Every book on the shelves, in order.
    var everything: [ShelfItem] { shelf?.items ?? rows.flatMap(\.items) }

    /// The best matches for what's typed.
    var results: [ShelfItem] {
        query.trimmingCharacters(in: .whitespaces).isEmpty ? [] : ShelfSearch.find(query, in: everything)
    }

    /// Lay the books out for a screen and build the shelves: stacked in a case `width` wide, or, with `long`, one long
    /// shelf. The cloths come with the library's list, so every spine is drawn once, in its own colour, and no cover is fetched. The laying out and
    /// the making are done off the main thread, so the page answers meanwhile; a build for a size the page has since left
    /// (the TV's page changes size once as it opens) stops between shelves, rather than taking the cores from the next.
    func build(width: CGFloat, k: CGFloat, scale: CGFloat, long: Bool) async {
        // The long shelf is as long as its books, whatever the screen's width, so a phone held upright can make it for its side.
        let key = long ? "long \(k)" : "\(Int(width)) \(k)"
        guard width > 100, key != builtFor else { return }
        builtFor = key; self.k = k; self.scale = scale
        let books = self.books
        let cloths = CoverCloths.cloths(for: books.map(\.book))
        if long {
            let line = await Task.detached(priority: .userInitiated) { layoutLine(books, k: k, cloths: cloths) }.value
            guard builtFor == key else { return }
            rows = []
            shelf = LongShelf(items: line.items, width: line.width, k: k, scale: scale)
        } else {
            let making = Task.detached(priority: .userInitiated) { () -> [ShelfRow]? in
                let shelves = layoutCase(books, width: width, k: k, cloths: cloths)
                let sheets = measured("planning the sheets") { SpineSheets(shelves.flatMap { $0 }, scale: scale) }
                var made: [ShelfRow] = []
                for (i, items) in shelves.enumerated() {
                    if Task.isCancelled { return nil }
                    made.append(ShelfRow(id: i, items: items, width: width, k: k, scale: scale, sheets: sheets))
                }
                return made
            }
            let built = await withTaskCancellationHandler { await making.value } onCancel: { making.cancel() }
            guard let made = built, builtFor == key else { return }
            shelf = nil
            rows = made
        }
        measured("laid out")
        let keep = selected.flatMap { s in everything.first { $0.id == s.id } }
        selected = nil
        // The shelf opens at its start, on the newest book.
        if let first = keep ?? everything.first { select(first) }
    }

    var firstBook: String? { everything.first?.id }

    func item(_ id: String) -> ShelfItem? { everything.first { $0.id == id } }

    /// Take a book down: off its shelf and into your hand. The books either side are made ready for your hand too,
    /// without their covers: the only cover fetched is the one of the book you have landed on (BookInHand.swift).
    func select(_ it: ShelfItem) {
        guard selected?.id != it.id else { return }
        selected = it
        for r in rows {
            let here = r.items.contains { $0.id == it.id }
            if here != r.active { r.use(here) }
            r.lift(here ? it.id : nil)
        }
        shelf?.lift(it.id)
        hand.show(it, k: k, scale: scale)
        let line = shelf?.items ?? rows.first { $0.items.contains { $0.id == it.id } }?.items ?? []
        if let i = line.firstIndex(where: { $0.id == it.id }) {
            hand.prefetch([i + 1, i - 1, i + 2].compactMap { line.indices.contains($0) ? line[$0] : nil }, k: k, scale: scale)
        }
    }

    /// A book picked from the search: put the search away, take the book down, and bring it into view.
    func choose(_ it: ShelfItem) {
        query = ""
        select(it)
        if let shelf {
            shelf.bringIntoView(it)
        } else if let row = rows.first(where: { $0.items.contains { $0.id == it.id } }) {
            target = Target(row: row.id, item: it.id, token: (target?.token ?? 0) + 1)
        }
    }
}

/// Each cover's cloth, by the cover's hash, as the server lists it with the library: the bookcase draws every spine in
/// its own colour from the start without fetching a single cover. A book whose cover the server lists no cloth for (a
/// server older than 0.53) stands in a quiet cloth of its own (`Cloth.forBook`).
enum CoverCloths {
    static func cloths(for books: [ServerBook]) -> [String: Cloth] {
        var cloths: [String: Cloth] = [:]
        for cover in books.compactMap(\.cover) {
            guard let listed = cover.cloth, listed.hasPrefix("#"), listed.count == 7, let hex = UInt32(listed.dropFirst(), radix: 16) else { continue }
            cloths[cover.hash] = Cloth.nearest(RGB(hex))
        }
        return cloths
    }
}
