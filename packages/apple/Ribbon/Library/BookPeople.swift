import Foundation

/// Someone whose name is on a book: who wrote it, or who reads it aloud. Their name on a book's page leads to
/// everything of theirs in the library (Library/BooksView.swift).
enum BookPerson: Hashable {
    case author(String)
    case narrator(String)

    var name: String {
        switch self {
        case .author(let name), .narrator(let name): return name
        }
    }

    /// "by Frank Herbert", "read by Scott Brick".
    var said: String {
        switch self {
        case .author(let name): return "by \(name)"
        case .narrator(let name): return "read by \(name)"
        }
    }
}

/// The people in one field of a book: "A; B", "A & B", "A and B", "A, B, C". A single "Last, First" stays one person:
/// a comma splits only when every piece has a space in it, or there are three or more pieces. The same rule as the
/// desktop's (packages/core/src/scan/sidefiles.ts, `splitPeople`), so a name leads to the same books on every device.
func splitPeople(_ value: String) -> [String] {
    let v = value.trimmingCharacters(in: .whitespaces)
    guard !v.isEmpty else { return [] }
    let joined = v.split(separator: /\s*[;\/]\s*|\s+&\s+|\s+and\s+/.ignoresCase()).map(String.init).filter { !$0.isEmpty }
    if joined.count > 1 { return unique(joined.flatMap(splitPeople)) }
    let byComma = v.split(separator: /\s*,\s*/).map(String.init).filter { !$0.isEmpty }
    if byComma.count >= 3 || (byComma.count == 2 && byComma.allSatisfy { $0.contains(" ") }) { return unique(byComma) }
    return [v]
}

/// Each name once, in the order it came.
private func unique(_ names: [String]) -> [String] {
    var seen = Set<String>()
    return names.filter { seen.insert($0).inserted }
}

/// The orders the list of books can be in.
enum BookOrder: String, CaseIterable, Identifiable {
    case title, author, newest

    var id: String { rawValue }

    var name: String {
        switch self {
        case .title: return "Title"
        case .author: return "Author"
        case .newest: return "Newest"
        }
    }

    /// "by title", for the line under the heading.
    var said: String {
        switch self {
        case .title: return "by title"
        case .author: return "by author"
        case .newest: return "newest first"
        }
    }
}

/// What a title is filed under: without a leading "The", "A" or "An", so The Hobbit stands among the Hs.
func filedUnder(_ title: String) -> String {
    for article in ["The ", "A ", "An "] where title.count > article.count && title.lowercased().hasPrefix(article.lowercased()) {
        return String(title.dropFirst(article.count))
    }
    return title
}

/// What an author is filed under: the first one's surname first, "Herbert Frank", as a shelf of books is.
func filedUnderAuthor(_ author: String) -> String {
    guard let first = splitPeople(author).first else { return "\u{FFFF}" }
    if first.contains(",") { return first }
    let parts = first.split(separator: " ")
    return parts.count > 1 ? "\(parts[parts.count - 1]) \(parts.dropLast().joined(separator: " "))" : first
}

extension Array where Element == ServerBook {
    /// The books with this person's name on them.
    func by(_ person: BookPerson) -> [ServerBook] {
        filter { book in
            switch person {
            case .author(let name): return splitPeople(book.author).contains(name)
            case .narrator(let name): return splitPeople(book.narrator).contains(name)
            }
        }
    }

    /// In an order of the list: titles and authors as a shelf files them, numbers within a title by their value.
    func inOrder(_ order: BookOrder) -> [ServerBook] {
        let byTitle = { (a: ServerBook, b: ServerBook) in filedUnder(a.title).localizedStandardCompare(filedUnder(b.title)) == .orderedAscending }
        switch order {
        case .title: return sorted(by: byTitle)
        case .author:
            return sorted { a, b in
                let order = filedUnderAuthor(a.author).localizedStandardCompare(filedUnderAuthor(b.author))
                return order == .orderedSame ? byTitle(a, b) : order == .orderedAscending
            }
        case .newest:
            // The server's dates are ISO 8601, which sort as text; a book with no date came longest ago.
            return sorted { a, b in (a.addedAt ?? "") == (b.addedAt ?? "") ? byTitle(a, b) : (a.addedAt ?? "") > (b.addedAt ?? "") }
        }
    }
}
