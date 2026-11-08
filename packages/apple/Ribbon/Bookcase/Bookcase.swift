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

    /// Every book on the shelves, in order.
    var everything: [ShelfItem] { shelf?.items ?? rows.flatMap(\.items) }

    /// The best matches for what's typed.
    var results: [ShelfItem] {
        query.trimmingCharacters(in: .whitespaces).isEmpty ? [] : ShelfSearch.find(query, in: everything)
    }

    /// Lay the books out for a screen and build the shelves: stacked in a case `width` wide, or, with `long`, one long
    /// shelf. The cloths come from the covers first, so every spine is drawn once, in its own colour. The laying out and
    /// the making are done off the main thread, so the page answers meanwhile.
    func build(width: CGFloat, k: CGFloat, scale: CGFloat, long: Bool) async {
        // The long shelf is as long as its books, whatever the screen's width, so a phone held upright can make it for its side.
        let key = long ? "long \(k)" : "\(Int(width)) \(k)"
        guard width > 100, key != builtFor else { return }
        builtFor = key; self.k = k; self.scale = scale
        let books = self.books
        let cloths = await CoverCloths.cloths(for: books.map(\.book), server: library.server)
        guard builtFor == key else { return }
        measured("cloths from the covers")
        if long {
            let line = await Task.detached(priority: .userInitiated) { layoutLine(books, k: k, cloths: cloths) }.value
            guard builtFor == key else { return }
            rows = []
            shelf = LongShelf(items: line.items, width: line.width, k: k, scale: scale)
        } else {
            let made = await Task.detached(priority: .userInitiated) {
                let shelves = layoutCase(books, width: width, k: k, cloths: cloths)
                let sheets = SpineSheets(shelves.flatMap { $0 }, scale: scale)
                return shelves.enumerated().map { ShelfRow(id: $0.offset, items: $0.element, width: width, k: k, scale: scale, sheets: sheets) }
            }.value
            guard builtFor == key else { return }
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

/// Each cover's cloth, worked out once from the server's smallest copy of the cover and kept, on this device, from one
/// launch to the next: the bookcase draws every spine in its own colour from the start, and the pictures themselves aren't
/// kept. A cover's hash names its picture, so a new cover is a new hash and is worked out again.
@MainActor
enum CoverCloths {
    /// Each cover's own colour, by its hash; its cloth is the swatch nearest that.
    private static var colours: [String: RGB] = load()
    private static var known: [String: Cloth] = colours.mapValues(Cloth.nearest)
    /// Covers being sampled now: a second ask waits for these rather than asking the server again.
    private static var sampling: Task<Void, Never>?

    /// The cloths of these books' covers, fetching those not yet known, six at a time.
    static func cloths(for books: [ServerBook], server: RibbonServer) async -> [String: Cloth] {
        while let running = sampling { await running.value }
        let wanted = Set(books.compactMap { $0.cover?.hash }).subtracting(known.keys)
        guard !wanted.isEmpty else { return known }
        let task = Task { await sample(wanted, server: server) }
        sampling = task
        await task.value
        sampling = nil
        save()
        return known
    }

    private static func sample(_ hashes: Set<String>, server: RibbonServer) async {
        var wanted = hashes.makeIterator()
        await withTaskGroup(of: (String, RGB?).self) { group in
            func next() {
                guard let hash = wanted.next() else { return }
                group.addTask { (hash, await colour(hash, server: server)) }
            }
            for _ in 0 ..< 6 { next() }
            for await (hash, colour) in group {
                if let colour { colours[hash] = colour; known[hash] = Cloth.nearest(colour) }
                next()
            }
        }
    }

    /// A cover's colour, from a 24 by 24 sample of it, as the desktop samples a cover for its colour.
    private nonisolated static func colour(_ hash: String, server: RibbonServer) async -> RGB? {
        guard let cover = try? await server.cover(hash, width: 200).cgImage else { return nil }
        let n = 24
        var px = [UInt8](repeating: 0, count: n * n * 4)
        guard let ctx = CGContext(data: &px, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.draw(cover, in: CGRect(x: 0, y: 0, width: n, height: n))
        return Cloth.coverColour(pixels: px)
    }

    /// Kept with the app's caches, which the system may clear: then the covers are sampled again.
    private static let file = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("cover-colours.json")

    private static func load() -> [String: RGB] {
        guard let file, let data = try? Data(contentsOf: file), let hex = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return hex.compactMapValues { UInt32($0, radix: 16).map(RGB.init) }
    }

    private static func save() {
        guard let file else { return }
        let hex = colours.mapValues { String(format: "%02x%02x%02x", $0.r, $0.g, $0.b) }
        try? JSONEncoder().encode(hex).write(to: file, options: .atomic)
    }
}
