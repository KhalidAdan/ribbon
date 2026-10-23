import Foundation
import Observation

/// One person's library on the server, as the desktop's shelf shows it
/// (src/ui/LibraryPane.tsx): what they're in the middle of, then each series,
/// then every book outside one. Progress comes from their places on the
/// server (`GET /api/progress`), never with the library list, which stays the
/// same while people listen.
@MainActor
@Observable
final class Library {
    /// A series: its books in order, by their number in it.
    struct Series: Identifiable {
        let name: String
        let books: [ServerBook]
        var id: String { name }
    }

    private(set) var books: [ServerBook] = []
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
            async let places = server.progress()
            (books, progress) = try await (list, places)
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

    /// Books that share a series name, two or more, in order by their number in it; the series heard most recently first.
    var series: [Series] {
        let grouped = Dictionary(grouping: books.filter { !$0.series.isEmpty }, by: \.series).filter { $0.value.count > 1 }
        return grouped
            .map { Series(name: $0.key, books: $0.value.sorted { ($0.seriesIndex ?? .infinity, $0.title) < ($1.seriesIndex ?? .infinity, $1.title) }) }
            .sorted { (lastListened(in: $0), $1.name) > (lastListened(in: $1), $0.name) }
    }

    /// Every book outside a series, most recently listened first, then by title.
    var standalone: [ServerBook] {
        let inSeries = Set(series.flatMap { $0.books.map(\.id) })
        return books.filter { !inSeries.contains($0.id) }.sorted { (lastListened($0), $1.title) > (lastListened($1), $0.title) }
    }

    /// The series a book is in, when it's one the library groups.
    func series(of book: ServerBook) -> Series? {
        series.first { group in group.books.contains { $0.id == book.id } }
    }

    /// How far through a book, 0 to 1.
    func fraction(of book: ServerBook) -> Double {
        guard let p = progress[book.id], book.durationMs > 0 else { return 0 }
        return p.finished ? 1 : min(1, Double(p.ms) / Double(book.durationMs))
    }

    /// What a book's card says under its author: finished, how far and how long is left, or how long it is (src/ui/LibraryPane.tsx, `standing`).
    func standing(of book: ServerBook) -> String {
        guard let p = progress[book.id] else { return Format.left(book.durationMs) }
        if p.finished { return "Finished" }
        if p.started { return "\(max(1, Int((fraction(of: book) * 100).rounded())))% · \(Format.left(book.durationMs - p.ms)) left" }
        return Format.left(book.durationMs)
    }

    private func lastListened(_ book: ServerBook) -> String {
        progress[book.id]?.at ?? ""
    }

    private func lastListened(in series: Series) -> String {
        series.books.map(lastListened).max() ?? ""
    }
}
