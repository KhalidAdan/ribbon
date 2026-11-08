import Foundation
import Observation

/// One person's library on the server, as the desktop's shelf shows it
/// (packages/desktop/src/ui/LibraryPane.tsx): what they're in the middle of, then each series,
/// then every book outside one. The series are the server's (`GET
/// /api/series`), the same on every device. Progress comes from their places
/// on the server (`GET /api/progress`), never with the library list, which
/// stays the same while people listen.
@MainActor
@Observable
final class Library {
    /// A series: its books in order, each with its number in it and its title as the list shows it where the series gives them.
    struct Series: Identifiable {
        let id: String
        let name: String
        let books: [ServerBook]
        var numbers: [String: Double] = [:]
        var titles: [String: String] = [:]
        /// Grouped here by the books' series tags, from a server from before series were its own.
        var fromTags = false

        /// A book's number: the series' ("2", "2.5"), else its place in the list. A series grouped by tags goes
        /// by its files' numbers; a server's series doesn't, as the number in a book's files is its number in
        /// one series only, not in a reading list it's also in.
        func number(of book: ServerBook, at index: Int) -> String {
            guard let n = numbers[book.id] ?? (fromTags ? book.seriesIndex : nil) else { return String(index + 1) }
            return n == n.rounded() ? String(Int(n)) : String(n)
        }

        /// A book's title in the list, without the series' name: "The Solar War", not "The Solar War: Siege of Terra: …, Book 1".
        func title(of book: ServerBook) -> String {
            titles[book.id] ?? book.title
        }
    }

    private(set) var books: [ServerBook] = []
    /// The library's series; nil from a server older than them, whose books are grouped by their series tags instead.
    private(set) var serverSeries: [ServerSeries]?
    private(set) var progress: [String: BookProgress] = [:]
    /// The books' details, fetched as cards need their chapters.
    private(set) var details: [String: ServerBookDetail] = [:]
    private(set) var loaded = false
    private(set) var problem: String?

    let server: RibbonServer

    init(server: RibbonServer) {
        self.server = server
    }

    /// The list and the progress, from the server; a sign-in that has run out says so with a 401.
    func load() async throws {
        do {
            async let list = server.books()
            async let groups = server.series()
            async let places = server.progress()
            books = try await list
            serverSeries = try? await groups
            // A server from before it said how far people are shows its books without it.
            progress = (try? await places) ?? [:]
            loaded = true
            problem = nil
        } catch let error as ServerError where error.status == 401 {
            throw error
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Just the progress again: a book was listened to.
    func refreshProgress() async {
        if let places = try? await server.progress() { progress = places }
    }

    func detail(of book: ServerBook) async -> ServerBookDetail? {
        if let kept = details[book.id] { return kept }
        guard let found = try? await server.book(book.id) else { return nil }
        details[book.id] = found
        return found
    }

    // The shelf --------------------------------------------------------------

    func progress(of book: ServerBook) -> BookProgress? {
        progress[book.id]
    }

    /// Started and not finished, most recently listened first: at most six, as the desktop shows.
    var inProgress: [ServerBook] {
        Array(books.filter { progress[$0.id].map { $0.started && !$0.finished } ?? false }.sorted { lastListened($0) > lastListened($1) }.prefix(6))
    }

    /// The series with books on the shelf, each in its order; the series heard most recently first.
    var series: [Series] {
        let found: [Series]
        if let serverSeries {
            let byId = Dictionary(books.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            found = serverSeries.compactMap { series in
                let shelved = series.books.filter(\.shelved)
                let members = shelved.compactMap { byId[$0.id] }
                guard !members.isEmpty else { return nil }
                return Series(
                    id: series.id,
                    name: series.name,
                    books: members,
                    numbers: Dictionary(shelved.compactMap { b in b.number.map { (b.id, $0) } }, uniquingKeysWith: { first, _ in first }),
                    titles: Dictionary(shelved.compactMap { b in b.title.map { (b.id, $0) } }, uniquingKeysWith: { first, _ in first })
                )
            }
        } else {
            // A server from before series were its own: books that share a series tag, two or more, by their number in it.
            found = Dictionary(grouping: books.filter { !$0.series.isEmpty }, by: \.series).filter { $0.value.count > 1 }
                .map { Series(id: $0.key, name: $0.key, books: $0.value.sorted { ($0.seriesIndex ?? .infinity, $0.title) < ($1.seriesIndex ?? .infinity, $1.title) }, fromTags: true) }
        }
        return found.sorted { (lastListened(in: $0), $1.name) > (lastListened(in: $1), $0.name) }
    }

    /// Every book on the shelf, for the bookcase: all but those a series leaves off it.
    var shelved: [ServerBook] {
        let offShelf = Set(serverSeries?.flatMap { $0.books.filter { !$0.shelved }.map(\.id) } ?? [])
        return books.filter { !offShelf.contains($0.id) }
    }

    /// Every series a book is in that the library groups, the one heard most recently first: a book can be in
    /// several (The Horus Heresy, and a White Scars reading list made by hand).
    func series(of book: ServerBook) -> [Series] {
        series.filter { group in group.books.contains { $0.id == book.id } }
    }

    /// How far through a book, 0 to 1: through its recording, or, for a book that is only its text, through its text.
    func fraction(of book: ServerBook) -> Double {
        guard let p = progress[book.id] else { return 0 }
        if p.finished { return 1 }
        if !book.audio { return min(1, p.fraction ?? 0) }
        return book.durationMs > 0 ? min(1, Double(p.ms) / Double(book.durationMs)) : 0
    }

    /// What a book's card says under its author: finished, how far and how long is left, or how long it is
    /// (packages/desktop/src/ui/LibraryPane.tsx, `standing`); "42% read" for a book that is only its text.
    func standing(of book: ServerBook) -> String {
        guard let p = progress[book.id] else { return length(of: book) }
        if p.finished { return "Finished" }
        guard p.started else { return length(of: book) }
        let percent = max(1, Int((fraction(of: book) * 100).rounded()))
        return book.audio ? "\(percent)% · \(Format.left(book.durationMs - p.ms)) left" : "\(percent)% read"
    }

    /// What a book comes to before it's started: how long it is, or that it's an EPUB to read
    /// (packages/desktop/src/ui/progress.ts, `lengthOf`).
    func length(of book: ServerBook) -> String {
        book.audio ? Format.left(book.durationMs) : "EPUB"
    }

    private func lastListened(_ book: ServerBook) -> String {
        progress[book.id]?.at ?? ""
    }

    private func lastListened(in series: Series) -> String {
        series.books.map(lastListened).max() ?? ""
    }
}
