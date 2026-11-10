import UIKit

// The bookcase's rules, as the desktop's bookcase has them (packages/core/src/bookcase/case.ts): every book
// spine-out, newest first under a label on the shelf's edge where each month begins, spines as thick as the books
// are long, titles fitted and never cut.
// Sizes are in points at k = 1, the desktop's size; k scales them for each screen.

/// A shelf's height, from the board to the shelf above.
let shelfHeight: CGFloat = 190

/// A book on a shelf, where the layout puts it: its spine laid out, its cloth, and its place.
struct ShelfItem: Identifiable {
    let book: ShelfBook
    let spine: SpineLayout
    /// The label on the shelf's edge under it, where a month (or the last two weeks) begins.
    let label: String?
    var cloth: Cloth
    var x: CGFloat = 0
    /// Leaning on the book before it, at the end of a shelf with room to spare.
    var lean = false
    var id: String { book.id }
    var w: CGFloat { spine.width }
    var h: CGFloat { spine.height }
}

/// A book's thickness, made the way a binder makes one, then drawn a little bolder than life. Pages hold 500 words
/// (the owner's choice: a denser page, a slimmer book). A hardback's paper is 0.065 mm a page and its two boards
/// 2.75 mm each; a paperback's paper is thinner, 0.055 mm, under a card cover. A shelf is a 234 mm hardback's height,
/// nine tenths full. Drawn true to life a novel's spine looks impossibly thin on a screen, so hardbacks are drawn
/// 2.4 times as thick and paperbacks 1.8, and hardbacks read as solid objects, with paperbacks standing apart.
func thickness(_ b: ShelfBook, _ k: CGFloat) -> CGFloat {
    let pages = b.words / 500
    let mm = b.paperback ? pages * 0.055 + 0.6 : pages * 0.065 + 5.5
    let pointsPerMm = shelfHeight * 0.88 / 234
    return min(84, max(16, CGFloat(mm) * pointsPerMm * (b.paperback ? 1.8 : 2.4))) * k
}

/// A spine's starting width and its height: books stand between three quarters of the shelf's height and nearly all of it.
func spineSize(_ b: ShelfBook, _ k: CGFloat) -> (CGFloat, CGFloat) {
    let height = 0.76 + CGFloat(stableHash(b.id + "h") % 22) / 100
    return (thickness(b, k).rounded(), (shelfHeight * k * height).rounded())
}

/// Newest first; books that came together by their authors' surnames. Each book's day and surname found once.
func shelfOrder(_ books: [ShelfBook]) -> [ShelfBook] {
    books.map { (book: $0, days: $0.days, surname: surnameOf($0.author)) }
        .sorted { a, b in a.days != b.days ? a.days < b.days : a.surname < b.surname }
        .map(\.book)
}

private let month: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_GB")
    f.dateFormat = "MMM yyyy"
    return f
}()

/// The label on the shelf's edge for when a book came: the last two weeks, then its month.
private func shelfLabel(_ b: ShelfBook) -> String? {
    guard let added = b.added else { return nil }
    return b.days < 14 ? "Last two weeks" : month.string(from: added)
}

/// Every book spine-out, in the shelf's order, packed into shelves of a width. Made on any thread; in a task that's been
/// cancelled, for a size the page has left, it stops early, as what it has will be thrown away.
func layoutCase(_ books: [ShelfBook], width caseWidth: CGFloat, k: CGFloat, cloths: [String: Cloth]) -> [[ShelfItem]] {
    let gap = max(1, (1.5 * k).rounded()), side = (12 * k).rounded(), room = caseWidth - 2 * side
    let ordered = shelfOrder(books)
    var shelves: [[ShelfItem]] = [[]]
    var x: CGFloat = 0
    for (i, b) in ordered.enumerated() {
        if Task.isCancelled { break }
        let label = shelfLabel(b)
        var item = ShelfItem(book: b, spine: SpineLayout(b, k: k), label: i == 0 || label != shelfLabel(ordered[i - 1]) ? label : nil,
                             cloth: (b.coverHash.flatMap { cloths[$0] }) ?? Cloth.forBook(b.id))
        if x + item.w > room, !shelves[shelves.count - 1].isEmpty { shelves.append([]); x = 0 }
        item.x = side + x
        shelves[shelves.count - 1].append(item)
        x += item.w + gap
    }
    // A shelf with room at its end lets its last book lean on the one before.
    for i in shelves.indices {
        guard var last = shelves[i].last, shelves[i].count > 1 else { continue }
        if side + room - (last.x + last.w) > last.h * 0.16 + 4 {
            last.lean = true
            last.x += (last.h * 0.139).rounded()
            shelves[i][shelves[i].count - 1] = last
        }
    }
    spreadCloths(&shelves)
    return shelves
}

/// The phone's bookcase: every book on one long shelf, and how long the shelf is from the case's left side to its right.
func layoutLine(_ books: [ShelfBook], k: CGFloat, cloths: [String: Cloth]) -> (items: [ShelfItem], width: CGFloat) {
    let line = layoutCase(books, width: .greatestFiniteMagnitude, k: k, cloths: cloths).first ?? []
    return (line, (line.last.map { $0.x + $0.w } ?? 0) + (12 * k).rounded())
}

/// Books of one series often have covers in one colour, and side by side their spines would run together:
/// a spine never wears the same cloth as either of the two before it, but its next-nearest instead.
private func spreadCloths(_ shelves: inout [[ShelfItem]]) {
    var recent: [RGB] = []
    for s in shelves.indices {
        for i in shelves[s].indices {
            let nearest = shelves[s][i].cloth
            let cloth = ([nearest] + nearest.alternatives).first { !recent.contains($0.ground) } ?? nearest
            shelves[s][i].cloth = cloth
            recent = Array((recent + [cloth.ground]).suffix(2))
        }
    }
}
