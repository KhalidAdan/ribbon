import Foundation

/// Finding a book on the shelf by what you remember of it: a few letters of the title or the author, in any order,
/// forgiving a slip of the thumb. Every word typed must match something; the closer the matches, the higher the book.
enum ShelfSearch {
    /// Lower case, accents folded, punctuation to spaces: "The High Kâhl's Oath" becomes "the high kahl s oath".
    static func fold(_ s: String) -> String {
        let plain = s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return String(plain.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " })
    }

    static func words(_ s: String) -> [String] { fold(s).split(separator: " ").map(String.init) }

    /// How well one word typed matches one word of the book: the start of it best, then inside it, then its letters in order,
    /// then one letter off.
    static func match(_ q: String, _ w: String) -> Int {
        if w.hasPrefix(q) { return q.count == w.count ? 12 : 10 }
        if q.count >= 3, w.contains(q) { return 6 }
        if q.count >= 3, inOrder(q, w) { return 3 }
        if q.count >= 4, oneOff(q, w) { return 4 }
        return 0
    }

    private static func inOrder(_ q: String, _ w: String) -> Bool {
        var it = w.makeIterator()
        for c in q { var found = false; while let d = it.next() { if d == c { found = true; break } }; if !found { return false } }
        return true
    }

    /// One letter added, dropped or changed, or two neighbours swapped: the slips a thumb makes. Compared with the
    /// start of the word, since people type the beginnings of words.
    private static func oneOff(_ a: String, _ b: String) -> Bool {
        let x = Array(a), y = Array(b)
        // The word's start one letter shorter, the same length, or one letter longer than what was typed.
        return [x.count - 1, x.count, x.count + 1].contains { n in
            let start = Array(y.prefix(n))
            return atMostOneEdit(x, start) || swapped(x, start)
        }
    }

    private static func atMostOneEdit(_ x: [Character], _ y: [Character]) -> Bool {
        guard abs(x.count - y.count) <= 1 else { return false }
        var i = 0, j = 0, edits = 0
        while i < x.count, j < y.count {
            if x[i] == y[j] { i += 1; j += 1; continue }
            edits += 1
            if edits > 1 { return false }
            if x.count > y.count { i += 1 } else if x.count < y.count { j += 1 } else { i += 1; j += 1 }
        }
        return edits + (x.count - i) + (y.count - j) <= 1
    }

    private static func swapped(_ x: [Character], _ y: [Character]) -> Bool {
        guard x.count == y.count else { return false }
        let diff = x.indices.filter { x[$0] != y[$0] }
        return diff.count == 2 && diff[1] == diff[0] + 1 && x[diff[0]] == y[diff[1]] && x[diff[1]] == y[diff[0]]
    }

    /// A book's score for what was typed, or nil when some word matches nothing. The title counts more than the author.
    static func score(_ query: String, _ b: ShelfBook) -> Int? {
        let qs = words(query)
        guard !qs.isEmpty else { return nil }
        let title = words(b.title), author = words(b.author)
        var total = 0
        for q in qs {
            let t = title.map { match(q, $0) }.max() ?? 0, a = author.map { match(q, $0) }.max() ?? 0
            let best = max(t + 2, a)
            if t == 0 && a == 0 { return nil }
            total += best
        }
        // A title that starts with what was typed goes first.
        if fold(b.title).trimmingCharacters(in: .whitespaces).hasPrefix(fold(query).trimmingCharacters(in: .whitespaces)) { total += 8 }
        return total
    }

    /// The best few books for what was typed.
    static func find(_ query: String, in items: [ShelfItem], limit: Int = 6) -> [ShelfItem] {
        var scored: [(item: ShelfItem, score: Int)] = []
        for it in items {
            guard let n = score(query, it.book) else { continue }
            scored.append((it, n))
        }
        scored.sort { a, b in a.score != b.score ? a.score > b.score : a.item.book.title < b.item.book.title }
        return scored.prefix(limit).map { $0.item }
    }
}
