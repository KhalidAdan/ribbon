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
        var request = authorized("api/books/\(id)/place")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let device = ["id": ThisDevice.id, "name": ThisDevice.name, "app": ThisDevice.app]
        request.httpBody = try JSONSerialization.data(withJSONObject: ["device": device, "ms": ms, "why": why.rawValue])
        let (data, response) = try await Self.reach(request)
        guard (200..<300).contains(response.statusCode) else { throw ServerError(message: Self.said(data) ?? "The server didn't keep the place.", status: response.statusCode) }
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

    private func get<T: Decodable>(_ type: T.Type, _ path: String) async throws -> T {
        let (data, response) = try await Self.reach(authorized(path))
        if response.statusCode == 401 { throw ServerError(message: "This TV's sign-in has run out. Sign in again.", status: 401) }
        guard (200..<300).contains(response.statusCode) else { throw ServerError(message: Self.said(data) ?? "The server couldn't answer (\(response.statusCode)).", status: response.statusCode) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func authorized(_ path: String) -> URLRequest {
        var request = URLRequest(url: account.url.appending(path: path))
        request.setValue("Bearer \(account.token)", forHTTPHeaderField: "authorization")
        return request
    }

    private static func reach(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            return (data, response as! HTTPURLResponse)
        } catch {
            throw ServerError(message: "Couldn't reach \(request.url?.host() ?? "the server"). Is it on, and is this TV on its network?")
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
