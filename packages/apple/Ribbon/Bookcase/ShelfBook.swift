import Foundation

/// A book as the bookcase knows it: what its spine says, how thick it is, when it came, and how far you are in it.
struct ShelfBook: Hashable {
    /// The server's book, for its page.
    let book: ServerBook
    let fraction: Double
    let finished: Bool

    var id: String { book.id }
    var title: String { book.title }
    var author: String { book.author }
    var hours: Double { Double(book.durationMs) / 3_600_000 }
    var textOnly: Bool { !book.audio }
    var coverHash: String? { book.cover?.hash }

    /// When it came to the library, where the server says.
    var added: Date? {
        guard let at = book.addedAt else { return nil }
        return Self.withFraction.date(from: at) ?? Self.plain.date(from: at)
    }

    /// Whole days since it came, counted from now.
    var days: Int { added.map { max(0, Int(Date().timeIntervalSince($0) / 86_400)) } ?? .max }

    /// How long a book is in words, which is how thick it stands (`thickness`):
    /// - its EPUB's words, as the server counted them from its text;
    /// - for an audiobook with no EPUB, or one the server hasn't read yet, its narration's length at the pace narrators
    ///   read, which is right to about a fifth, as narrators' paces differ;
    /// - for an EPUB not counted yet (a server older than 0.32), its size at about five bytes a word;
    /// - and a novel's length when there's nothing to go by.
    var words: Double {
        if let counted = book.words, counted > 0 { return Double(counted) }
        if book.audio, book.durationMs > 0 { return hours * Self.wordsPerHour }
        if let bytes = book.ebookBytes { return min(400_000, max(20_000, Double(bytes) / 5)) }
        return 90_000
    }

    /// Narration runs about 9,350 words an hour: the median of 23 of the owner's books that have both editions (7,400 to 10,600).
    static let wordsPerHour: Double = 9_350

    /// About a third of the books are paperbacks, the same ones on every device.
    var paperback: Bool { stableHash(id + "paperback") % 10 < 3 }

    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()
}

extension Library {
    /// Every book on the shelf as the bookcase knows it, with how far you are in it.
    var shelfBooks: [ShelfBook] {
        shelved.map { ShelfBook(book: $0, fraction: fraction(of: $0), finished: progress[$0.id]?.finished ?? false) }
    }
}

/// FNV-1a over UTF-16, as the desktop's shelf hashes, so a book's height and binding are the same on every device.
func stableHash(_ s: String) -> UInt32 {
    var h: UInt32 = 2_166_136_261
    for c in s.utf16 { h = (h ^ UInt32(c)) &* 16_777_619 }
    return h
}
