import Foundation
import UIKit

/// A book on the server, as its library lists it (server/src/library/books.ts, `ListedBook`).
struct ServerBook: Decodable, Identifiable, Hashable {
    struct Cover: Decodable, Hashable {
        let hash: String
        /// Width over height.
        let aspect: Double
        let colour: String
    }

    let id: String
    let title: String
    let author: String
    let narrator: String
    let series: String
    let seriesIndex: Double?
    let durationMs: Int
    let audio: Bool
    let ebook: Bool
    let cover: Cover?
}

/// A series of the library, as the server keeps it (server/src/library/series.ts, `ServerSeries`): its books in order.
struct ServerSeries: Decodable {
    struct Book: Decodable {
        let id: String
        /// Its number in the series where one is known: 8 for "Book 8, Part 2".
        let number: Double?
        /// Its title as a list of the series shows it, without the series' name; nil to show its own.
        let title: String?
        /// False leaves it off the shelf.
        let shelved: Bool
    }

    let id: String
    let name: String
    let books: [Book]
}

/// A book in full: its audio files in order, each as long as the server measured, its chapters, and what it says about itself.
struct ServerBookDetail: Decodable {
    struct File: Decodable {
        let path: String
        let durationMs: Int
    }

    /// A chapter, on the book's timeline.
    struct Chapter: Decodable, Hashable {
        let startMs: Int
        let endMs: Int
        let title: String
    }

    struct About: Decodable {
        let description: String?
        let year: Int?
        let publisher: String?
    }

    let files: [File]
    let chapters: [Chapter]
    let book: About
}

/// How far someone is through a book (server/src/readalong-routes.ts, `GET /api/progress`).
struct BookProgress: Decodable {
    let ms: Int
    /// When, as the position log writes it: ISO 8601, so it sorts as written.
    let at: String
    let started: Bool
    let finished: Bool
}

/// Where the person is in a book (server/src/readalong-routes.ts, `BookPlace`).
struct BookPlace: Decodable {
    /// The sentence, counted across the book's read-along.
    let sentence: Int
    /// The moment of the recording.
    let ms: Int
    /// "listening" or "reading": what they last did, on any device.
    let from: String
    /// When, as the position log writes it; nil from a server from before it said.
    let at: String?
}

/// How one listen-through of a book went (src/core/stats.ts, `ListenThrough`): the end of the book tells it.
struct ListenThrough: Decodable, Equatable {
    let started: String
    let finished: String?
    /// Wall-clock time spent listening in it, on every device.
    let listenedMs: Int
}

/// A bookmarked passage from any of the person's books (server/src/readalong-routes.ts, `GET /api/bookmarks`), for
/// the screen they drift by on while a book is paused.
struct Passage: Decodable, Identifiable {
    struct Book: Decodable {
        let id: String
        let title: String
        let author: String
    }

    let id: String
    let note: String
    /// The words, for a bookmark made of words in the text.
    let quote: String?
    let book: Book
}

/// A bookmark, as the server shows one to a device that only draws and plays
/// (server/src/readalong-routes.ts, `ShownBookmark`): the same bookmarks the
/// desktop and the phone keep, by time or by words.
struct ServerBookmark: Decodable, Identifiable, Hashable {
    let id: String
    /// The moment it marks; nil for words in a book with no audio.
    let ms: Int?
    let note: String
    let created: String
    /// The words, for a bookmark made of words in the text.
    let quote: String?
    /// The sentences the words are in, counted across the read-along.
    let first: Int?
    let last: Int?

    /// The sentences it underlines, when it's made of words.
    var sentences: ClosedRange<Int>? {
        guard let first, let last else { return nil }
        return first...max(first, last)
    }
}

/// A sentence found by a search (server/src/library/search.ts, `Found`): its book, where it is, and its words with the
/// ones searched for marked.
struct SearchResult: Decodable, Hashable {
    let book: String
    /// The sentence, counted across the book's read-along, as the reader counts them.
    let sentence: Int
    let ms: Int
    let chapter: String?
    let text: String
    /// The words that matched, as [start, length] in `text`, in UTF-16.
    let matches: [[Int]]
}

/// Why the TV says where it is, as the position log names it.
enum Why: String {
    case pause, seek, periodic, end, close
}

/// Something the server said no to, or couldn't be asked, in words to show.
struct ServerError: LocalizedError {
    let message: String
    var status = 0

    var errorDescription: String? { message }
}

/// A Ribbon server, as the TV talks to it (docs/SERVER.md, section 10, and
/// server/src/readalong-routes.ts): JSON over HTTP, signed in with a token
/// in a header. Answers that rarely change (the library, a book, its
/// read-along) carry ETags, which URLSession's cache revalidates on its own.
struct RibbonServer {
    let account: Account

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        // Signed in by the header alone; the cookie is only for the player, and only when asked.
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        return URLSession(configuration: config)
    }()

    /// Sign in with a name and a password, as the apps do (src/app/server/client.ts).
    static func signIn(address: String, name: String, password: String) async throws -> Account {
        guard let url = serverURL(address) else { throw ServerError(message: "That doesn't look like a server's address.") }
        var request = URLRequest(url: url.appending(path: "api/auth/sign-in/username"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["username": name, "password": password])
        let (data, response) = try await reach(request)
        if response.statusCode == 401 { throw ServerError(message: "That name and password don't match an account on this server.", status: 401) }
        guard (200..<300).contains(response.statusCode) else { throw ServerError(message: said(data) ?? "The server didn't take that sign-in.", status: response.statusCode) }
        let headers = response.allHeaderFields as? [String: String] ?? [:]
        let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).first { $0.name.hasSuffix("session_token") }
        guard let token = response.value(forHTTPHeaderField: "set-auth-token"), let cookie else { throw ServerError(message: "The server didn't hand back a sign-in. Is it a Ribbon server?") }
        return Account(url: url, name: name, token: token, cookieName: cookie.name, cookieValue: cookie.value)
    }

    /// The books with a narration: the ones there are to listen to, and, with their text, to read along with.
    func books() async throws -> [ServerBook] {
        struct Answer: Decodable { let books: [ServerBook] }
        return try await get(Answer.self, "api/books").books.filter(\.audio)
    }

    /// The library's series, each with its books in order.
    func series() async throws -> [ServerSeries] {
        struct Answer: Decodable { let series: [ServerSeries] }
        return try await get(Answer.self, "api/series").series
    }

    /// How far this person is through each book they've started, by book id.
    func progress() async throws -> [String: BookProgress] {
        struct Answer: Decodable { let books: [String: BookProgress] }
        return try await get(Answer.self, "api/progress").books
    }

    func book(_ id: String) async throws -> ServerBookDetail {
        try await get(ServerBookDetail.self, "api/books/\(id)")
    }

    func readAlong(_ id: String) async throws -> ReadAlong {
        try await get(ReadAlong.self, "api/books/\(id)/readalong")
    }

    func place(in id: String) async throws -> BookPlace? {
        struct Answer: Decodable { let place: BookPlace? }
        return try await get(Answer.self, "api/books/\(id)/place").place
    }

    /// Say where this TV is in a book: the server keeps it in the TV's position log, for every other device.
    func tell(_ ms: Int, why: Why, in id: String) async throws {
        struct Answer: Decodable { let added: Int }
        _ = try await send("POST", "api/books/\(id)/place", ["ms": ms, "why": why.rawValue], answer: Answer.self)
    }

    /// A stretch of listening that just ended: a session for the person's history unless they keep none (`keep`), and
    /// the listen-through it's part of, opened by the first; a new one when the book was finished and is heard `again`.
    func listened(from start: Date, to end: Date, fromMs: Int, toMs: Int, speed: Double, again: Bool, keep: Bool, in id: String) async throws {
        struct Answer: Decodable { let added: Int }
        let body: [String: Any] = ["start": Moment.write(start), "end": Moment.write(end), "fromMs": fromMs, "toMs": toMs, "speed": speed, "again": again, "keep": keep]
        _ = try await send("POST", "api/books/\(id)/listened", body, answer: Answer.self)
    }

    /// The book played to its end: the listen-through closes, and the server says how it went.
    func finished(_ id: String) async throws -> ListenThrough {
        struct Answer: Decodable { let read: ListenThrough }
        return try await send("POST", "api/books/\(id)/finished", [:], answer: Answer.self).read
    }

    /// Every passage the person has bookmarked, in every book, newest first.
    func passages() async throws -> [Passage] {
        struct Answer: Decodable { let bookmarks: [Passage] }
        return try await get(Answer.self, "api/bookmarks").bookmarks
    }

    /// The sentences that best match words someone remembers, or says: in every book, or in one.
    func search(_ words: String, in book: String? = nil) async throws -> [SearchResult] {
        struct Answer: Decodable { let results: [SearchResult] }
        var query = [URLQueryItem(name: "q", value: words)]
        if let book { query.append(URLQueryItem(name: "book", value: book)) }
        return try await get(Answer.self, "api/search", query: query).results
    }

    /// The person's bookmarks in a book, from every device.
    func bookmarks(in id: String) async throws -> [ServerBookmark] {
        struct Answer: Decodable { let bookmarks: [ServerBookmark] }
        return try await get(Answer.self, "api/books/\(id)/bookmarks").bookmarks
    }

    /// Bookmark whole sentences, the first to the last, as the desktop bookmarks words selected in its reader.
    func bookmark(sentences first: Int, to last: Int, in id: String) async throws -> ServerBookmark {
        struct Answer: Decodable { let bookmark: ServerBookmark }
        return try await send("POST", "api/books/\(id)/bookmarks", ["first": first, "last": last], answer: Answer.self).bookmark
    }

    /// Take a bookmark back, on every device.
    func deleteBookmark(_ mark: String, in id: String) async throws {
        struct Answer: Decodable { let deleted: String }
        _ = try await send("DELETE", "api/books/\(id)/bookmarks/\(mark)", [:], answer: Answer.self)
    }

    /// A cover at one of the widths the server makes (200, 400 or 800).
    func cover(_ hash: String, width: Int) async throws -> UIImage {
        let (data, response) = try await Self.reach(authorized("covers/\(hash)-\(width).jpg"))
        guard response.statusCode == 200, let image = UIImage(data: data) else { throw ServerError(message: "No cover.", status: response.statusCode) }
        return image
    }

    /// Where a file of a book streams from.
    func fileURL(book id: String, path: String) -> URL {
        path.split(separator: "/").reduce(account.url.appending(path: "api/books/\(id)/files")) { $0.appending(path: String($1)) }
    }

    private func get<T: Decodable>(_ type: T.Type, _ path: String, query: [URLQueryItem] = []) async throws -> T {
        let (data, response) = try await Self.reach(authorized(path, query: query))
        if response.statusCode == 401 { throw ServerError(message: "This \(ThisDevice.kind)'s sign-in has run out. Sign in again.", status: 401) }
        guard (200..<300).contains(response.statusCode) else { throw ServerError(message: Self.said(data) ?? "The server couldn't answer (\(response.statusCode)).", status: response.statusCode) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Send something this TV did, signed by who it is, as the position log needs (docs/POSITION-FORMAT.md).
    private func send<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any], answer: T.Type) async throws -> T {
        var request = authorized(path)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let device = ["id": ThisDevice.id, "name": ThisDevice.name, "app": ThisDevice.app]
        request.httpBody = try JSONSerialization.data(withJSONObject: body.merging(["device": device]) { mine, _ in mine })
        let (data, response) = try await Self.reach(request)
        if response.statusCode == 401 { throw ServerError(message: "This \(ThisDevice.kind)'s sign-in has run out. Sign in again.", status: 401) }
        guard (200..<300).contains(response.statusCode) else { throw ServerError(message: Self.said(data) ?? "The server couldn't do that (\(response.statusCode)).", status: response.statusCode) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func authorized(_ path: String, query: [URLQueryItem] = []) -> URLRequest {
        var url = account.url.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(account.token)", forHTTPHeaderField: "authorization")
        return request
    }

    private static func reach(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            return (data, response as! HTTPURLResponse)
        } catch {
            throw ServerError(message: "Couldn't reach \(request.url?.host() ?? "the server"). Is it on, and is this \(ThisDevice.kind) on its network?")
        }
    }

    /// What the server said was wrong, from its `{ "error": … }`.
    private static func said(_ data: Data) -> String? {
        (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
    }

    /// An address as people type it: the scheme is HTTPS unless given, and trailing slashes go.
    private static func serverURL(_ address: String) -> URL? {
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        if !text.contains("://") { text = "https://\(text)" }
        guard let url = URL(string: text), url.host() != nil else { return nil }
        return url
    }
}

/// A moment as the position log writes one: ISO 8601 in UTC, to the millisecond.
enum Moment {
    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain = ISO8601DateFormatter()

    static func write(_ date: Date) -> String {
        withFraction.string(from: date)
    }

    static func read(_ text: String?) -> Date? {
        guard let text else { return nil }
        return withFraction.date(from: text) ?? plain.date(from: text)
    }
}
