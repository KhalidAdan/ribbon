import Observation
import OSLog
import SwiftUI

/// Ribbon on the Apple TV: the books on your Ribbon server, a page for each,
/// the player, and the reader, where the text is on the screen and the
/// sentence being read is marked as the narration goes. Everything the TV
/// shows comes from the server (docs/SERVER.md, section 8): it keeps only who
/// has signed in on it.
@main
struct RibbonApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            Group {
                if model.server != nil {
                    Screens()
                } else if model.adding || model.people.isEmpty {
                    SignInView()
                } else {
                    PeopleView()
                }
            }
            .environment(model)
            .preferredColorScheme(.dark)
        }
    }
}

/// The library, and the screens it leads to, one over the other: Menu goes
/// back a screen, and the focus comes back to what opened it.
private struct Screens: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.path) {
            LibraryView()
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: AppModel.Screen.self) { screen in
                    Group {
                        switch screen {
                        case .book(let book): BookView(book: book)
                        case .player: PlayerView()
                        case .search: SearchView()
                        case .reader:
                            if let reading = model.reading {
                                ReaderView(session: reading.session, layout: reading.layout) { model.closeReader() }
                            }
                        }
                    }
                    .toolbar(.hidden, for: .navigationBar)
                }
        }
    }
}

/// What the app is showing: who's reading, everyone who can, their library,
/// the book they're listening to, and the screens open over the library.
/// One person goes straight to their library; with more, the TV asks who's
/// reading first, as Jellyfin does. Each person's library and places are
/// their own, from their own sign-in.
@MainActor
@Observable
final class AppModel {
    /// A screen over the library.
    enum Screen: Hashable {
        case book(ServerBook)
        case player
        case search
        case reader
    }

    struct Reading {
        let session: ReadingSession
        let layout: BookLayout
    }

    /// What the sign-in starts with: the server people here use, and a name when someone's sign-in ran out.
    struct SignInHint {
        var address = ""
        var name = ""
    }

    /// Everyone signed in on this TV.
    private(set) var people = People.load()
    /// Who's reading: the server as they're signed in to it. Nil while choosing.
    private(set) var server: RibbonServer?
    /// Their books, and how far through each they are.
    private(set) var library: Library?
    /// Signing someone else in, from Who's reading.
    private(set) var adding = false
    private(set) var signInHint = SignInHint()
    /// The screens open over the library, the top one last.
    var path: [Screen] = []
    /// The book being listened to: one at a time, which the player and the reader share.
    private(set) var listening: Listening?
    private(set) var reading: Reading?
    /// The book being opened, and what went wrong opening one.
    private(set) var opening: String?
    private(set) var problem: String?
    /// Who read last on this TV, where Who's reading starts.
    private(set) var lastPerson = UserDefaults.standard.string(forKey: "ribbon.lastPerson")

    init() {
        if people.count == 1 { choose(people[0]) }
    }

    /// The server's name, as people know it.
    var host: String { server?.account.url.host() ?? "the server" }

    // Who's reading --------------------------------------------------------

    func signedIn(_ account: Account) {
        people.removeAll { $0.id == account.id }
        people.append(account)
        People.save(people)
        adding = false
        signInHint = SignInHint()
        choose(account)
    }

    func choose(_ account: Account) {
        let server = RibbonServer(account: account)
        self.server = server
        library = Library(server: server)
        path = []
        problem = nil
        lastPerson = account.id
        UserDefaults.standard.set(account.id, forKey: "ribbon.lastPerson")
    }

    /// Back to Who's reading. The narration is the person's, so it stops, and their place is kept.
    func switchReader() {
        reading?.session.close()
        reading = nil
        listening?.stop()
        listening = nil
        path = []
        server = nil
        library = nil
        problem = nil
    }

    /// Sign someone else in. Most people here use the same server, so its address is there already.
    func addSomeone() {
        signInHint = SignInHint(address: people.last?.url.absoluteString ?? "")
        adding = true
    }

    func cancelAdding() {
        adding = false
    }

    /// Take someone off this TV. Their places stay on the server, for their other devices and the next time.
    func remove(_ account: Account) {
        people.removeAll { $0.id == account.id }
        People.save(people)
        if server?.account.id == account.id { switchReader() }
    }

    /// Their sign-in ran out on the server: they sign in again, their server and name already filled in.
    func signInAgain(_ account: Account) {
        remove(account)
        signInHint = SignInHint(address: account.url.absoluteString, name: account.name)
        adding = true
    }

    // The library ----------------------------------------------------------

    /// The books and how far through each, again: the library is shown, or shown again.
    func loadLibrary() async {
        guard let library, let server else { return }
        do {
            try await library.load()
        } catch {
            signInAgain(server.account)
        }
    }

    /// A book's page. From another book's page, as from its series list, it takes that page's place.
    func open(_ book: ServerBook) {
        problem = nil
        if case .book = path.last {
            path[path.count - 1] = .book(book)
        } else {
            path.append(.book(book))
        }
    }

    // Listening ------------------------------------------------------------

    /// Listen to a book, in the player: from your place, or from the start when it's finished.
    func listen(to book: ServerBook) async {
        guard opening == nil else { return }
        opening = book.id
        problem = nil
        defer { opening = nil }
        do {
            let listening = try await listening(for: book)
            // A book finished and left at its end is listened to again from the start.
            if library?.progress(of: book)?.finished == true && listening.durationMs - listening.positionMs < FinishedWithin.ms {
                listening.play(from: 0)
            } else if !listening.playing {
                listening.resume()
            }
            if path.last != .player { path.append(.player) }
        } catch {
            problem = error.localizedDescription
        }
    }

    /// A card's play button: pause the book playing, or listen to another.
    func playOrPause(_ book: ServerBook) async {
        if let listening, listening.book.id == book.id, listening.playing {
            listening.pause()
        } else {
            await listen(to: book)
        }
    }

    /// The player, for the book playing.
    func showPlayer() {
        if listening != nil && path.last != .player { path.append(.player) }
    }

    // Reading along ----------------------------------------------------------

    /// Find a line, by voice or by typing, in any book.
    func showSearch() {
        if path.last != .search { path.append(.search) }
    }

    /// Read along with a book: its read-along and your place in it, from the server, and its text set in type. Opened at a
    /// sentence, as from a search, the remote is on that sentence and the narrator where it was.
    func readAlong(_ book: ServerBook, at sentence: Int? = nil) async {
        guard let server, opening == nil else { return }
        opening = book.id
        problem = nil
        defer { opening = nil }
        do {
            let asked = ContinuousClock.now
            async let readAlong = server.readAlong(book.id)
            let place = try await server.place(in: book.id)
            let listening = try await listening(for: book, at: place?.ms)
            let text = try await readAlong
            let typeset = ContinuousClock.now
            let layout = await Task.detached(priority: .userInitiated) { BookLayout(text) }.value
            log.info("opened \(book.title, privacy: .public): the server answered in \(typeset - asked, privacy: .public), \(layout.paragraphs.count) paragraphs set in \(ContinuousClock.now - typeset, privacy: .public)")
            let session = ReadingSession(listening: listening, readAlong: text, place: place)
            if let sentence { session.show(sentence) }
            reading = Reading(session: session, layout: layout)
            path.append(.reader)
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Out of the reader, back to the screen before. The narration plays on.
    func closeReader() {
        reading?.session.close()
        reading = nil
        if path.last == .reader { path.removeLast() }
    }

    // Inside -----------------------------------------------------------------

    /// The narration of a book: the one playing, when it's this book, else a new one from the person's place,
    /// or from the moment given. Starting another book stops the one before; its place is kept.
    private func listening(for book: ServerBook, at ms: Int? = nil) async throws -> Listening {
        if let listening, listening.book.id == book.id { return listening }
        guard let server, let library else { throw ServerError(message: "Choose who's reading first.") }
        listening?.stop()
        listening = nil
        let detail = try await server.book(book.id)
        await library.refreshProgress()
        let progress = library.progress(of: book)
        let start = ms ?? (progress?.finished == true ? 0 : progress?.ms ?? 0)
        let made = Listening(book: book, detail: detail, startMs: start, server: server)
        listening = made
        return made
    }
}

/// How near its end a book counts as finished, as the desktop counts it (src/core/progress.ts, `FINISHED_WITHIN_MS`).
enum FinishedWithin {
    static let ms = 60_000
}

/// What the app says about itself, in the system log: `log show --predicate 'subsystem == "app.ribbon.tv"'`.
let log = Logger(subsystem: "app.ribbon.tv", category: "app")
