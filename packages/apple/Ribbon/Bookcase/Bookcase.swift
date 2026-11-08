import Observation
import SwiftUI
import UIKit

/// The bookcase: every book in the library standing spine-out on shelves, the newest first, each in a cloth matched
/// to its cover, under lamplight. The book you're on comes off the shelf into your hand at the left, with what it is
/// and how far you are; choosing it again opens its page, where play is. On the TV and the iPad the shelves stack in a
/// case; on the iPhone, turned on its side, they make one long shelf. A search finds a book and brings it into view.
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
    }

    /// Every book on the library's shelf, with how far you are in it.
    var books: [ShelfBook] { library.shelfBooks }

    /// Every book on the shelves, in order.
    var everything: [ShelfItem] { shelf?.items ?? rows.flatMap(\.items) }

    /// The best matches for what's typed.
    var results: [ShelfItem] {
        query.trimmingCharacters(in: .whitespaces).isEmpty ? [] : ShelfSearch.find(query, in: everything)
    }

    /// Lay the books out for a screen and build the shelves: stacked in a case `width` wide, or, with `long`, one long
    /// shelf. The cloths come from the covers first, so every spine is drawn once, in its own colour.
    func build(width: CGFloat, k: CGFloat, scale: CGFloat, long: Bool) async {
        let key = "\(Int(width)) \(k) \(long)"
        guard width > 100, key != builtFor else { return }
        builtFor = key; self.k = k; self.scale = scale
        let books = self.books
        let cloths = await CoverCloths.cloths(for: books.map(\.book), server: library.server)
        guard builtFor == key else { return }
        if long {
            let line = layoutLine(books, k: k, cloths: cloths)
            rows = []
            shelf = LongShelf(items: line.items, width: line.width, k: k, scale: scale)
        } else {
            let shelves = layoutCase(books, width: width, k: k, cloths: cloths)
            shelf = nil
            rows = shelves.enumerated().map { ShelfRow(id: $0.offset, items: $0.element, width: width, k: k, scale: scale) }
        }
        let keep = selected.flatMap { s in everything.first { $0.id == s.id } }
        selected = nil
        // The shelf opens at its start, on the newest book.
        if let first = keep ?? everything.first { select(first) }
    }

    var firstBook: String? { everything.first?.id }

    func item(_ id: String) -> ShelfItem? { everything.first { $0.id == id } }

    /// Take a book down: off its shelf and into your hand. The books either side are made ready for your hand too.
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

/// Each cover's cloth, worked out once from the server's smallest copy of the cover and kept while the app runs:
/// the bookcase draws every spine in its own colour from the start, and the pictures themselves aren't kept.
@MainActor
enum CoverCloths {
    private static var known: [String: Cloth] = [:]

    /// The cloths of these books' covers, fetching those not yet known, six at a time.
    static func cloths(for books: [ServerBook], server: RibbonServer) async -> [String: Cloth] {
        var wanted = Set(books.compactMap { $0.cover?.hash }).subtracting(known.keys).makeIterator()
        await withTaskGroup(of: (String, Cloth?).self) { group in
            func next() {
                guard let hash = wanted.next() else { return }
                group.addTask { (hash, await sample(hash, server: server)) }
            }
            for _ in 0 ..< 6 { next() }
            for await (hash, cloth) in group {
                if let cloth { known[hash] = cloth }
                next()
            }
        }
        return known
    }

    /// A cover's cloth, from a 24 by 24 sample of it, as the desktop samples a cover for its colour.
    private nonisolated static func sample(_ hash: String, server: RibbonServer) async -> Cloth? {
        guard let cover = try? await server.cover(hash, width: 200).cgImage else { return nil }
        let n = 24
        var px = [UInt8](repeating: 0, count: n * n * 4)
        guard let ctx = CGContext(data: &px, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.draw(cover, in: CGRect(x: 0, y: 0, width: n, height: n))
        return Cloth.forCover(pixels: px)
    }
}
