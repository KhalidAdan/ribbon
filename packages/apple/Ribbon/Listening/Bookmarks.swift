import Observation

/// A book's bookmarks, the ones the person keeps on every device: the
/// desktop's, the phone's and the TV's, from the server, which keeps them in
/// the position log as the apps do (docs/POSITION-FORMAT.md, section 3.4).
/// The reader underlines the words they mark and bookmarks whole sentences;
/// the player bookmarks the moment playing, as the desktop's does, and lists
/// them, each with its note. One per book, made with its narration.
@MainActor
@Observable
final class Bookmarks {
    /// In the order of the book: words by where they are, then bookmarks by time.
    private(set) var all: [ServerBookmark] = []
    private(set) var loaded = false

    @ObservationIgnored private let server: RibbonServer
    @ObservationIgnored private let bookId: String

    init(server: RibbonServer, bookId: String) {
        self.server = server
        self.bookId = bookId
    }

    /// From the server again, for bookmarks made on other devices since.
    func load() async {
        guard let found = try? await server.bookmarks(in: bookId) else { return }
        all = found
        loaded = true
    }

    /// Bookmark whole sentences; what the server said when it couldn't.
    func add(sentences: ClosedRange<Int>) async throws -> ServerBookmark {
        keep(try await server.bookmark(sentences: sentences.lowerBound, to: sentences.upperBound, in: bookId))
    }

    /// Bookmark a moment of the narration.
    func add(at ms: Int) async throws -> ServerBookmark {
        keep(try await server.bookmark(at: ms, in: bookId))
    }

    /// Write, change or take away a bookmark's note.
    func setNote(_ note: String, on bookmark: ServerBookmark) async throws {
        keep(try await server.note(note, on: bookmark.id, in: bookId))
    }

    /// A bookmark as the server now has it. The same words, or the same moment, bookmarked again are the same bookmark.
    @discardableResult
    private func keep(_ bookmark: ServerBookmark) -> ServerBookmark {
        all.removeAll { $0.id == bookmark.id }
        all.append(bookmark)
        all.sort { ($0.first ?? .max, $0.ms ?? 0) < ($1.first ?? .max, $1.ms ?? 0) }
        return bookmark
    }

    func remove(_ bookmark: ServerBookmark) async throws {
        try await server.deleteBookmark(bookmark.id, in: bookId)
        all.removeAll { $0.id == bookmark.id }
    }

    /// The bookmark whose words take in a sentence, if one does.
    func containing(_ sentence: Int) -> ServerBookmark? {
        all.first { $0.sentences?.contains(sentence) == true }
    }
}
