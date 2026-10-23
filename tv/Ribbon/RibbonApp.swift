import Observation
import OSLog
import SwiftUI

/// Ribbon on the Apple TV: a book from your Ribbon server, its text on the
/// screen and its narration playing, the sentence being read marked as it
/// goes. Everything the TV shows comes from the server (docs/SERVER.md,
/// section 8): it keeps only who has signed in on it.
@main
struct RibbonApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            Group {
                if let reading = model.reading {
                    ReaderView(session: reading.session, layout: reading.layout) { model.close() }
                } else if model.server != nil {
                    ShelfView()
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

/// What the app is showing: who's reading, everyone who can, and the book
/// open, if any. One person goes straight to their shelf; with more, the TV
/// asks who's reading first, as Jellyfin does. Each person's shelf and place
/// are their own, from their own sign-in.
@MainActor
@Observable
final class AppModel {
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
    /// Signing someone else in, from Who's reading.
    private(set) var adding = false
    private(set) var signInHint = SignInHint()
    private(set) var reading: Reading?
    /// The book being opened, and what went wrong opening one.
    private(set) var opening: String?
    private(set) var problem: String?
    /// Who read last on this TV, where Who's reading starts.
    private(set) var lastPerson = UserDefaults.standard.string(forKey: "ribbon.lastPerson")
    /// The book they read last here, where their shelf starts.
    private(set) var lastRead: String?

    init() {
        if people.count == 1 { choose(people[0]) }
    }

    func signedIn(_ account: Account) {
        people.removeAll { $0.id == account.id }
        people.append(account)
        People.save(people)
        adding = false
        signInHint = SignInHint()
        choose(account)
    }

    func choose(_ account: Account) {
        server = RibbonServer(account: account)
        problem = nil
        lastPerson = account.id
        UserDefaults.standard.set(account.id, forKey: "ribbon.lastPerson")
        lastRead = UserDefaults.standard.string(forKey: Self.lastReadKey(account))
    }

    /// Back to Who's reading.
    func switchReader() {
        server = nil
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
        if server?.account.id == account.id { server = nil }
    }

    /// Their sign-in ran out on the server: they sign in again, their server and name already filled in.
    func signInAgain(_ account: Account) {
        remove(account)
        signInHint = SignInHint(address: account.url.absoluteString, name: account.name)
        adding = true
    }

    /// Open a book: its files, its read-along and your place in it, from the server, and its text set in type.
    func open(_ book: ServerBook) async {
        guard let server, opening == nil else { return }
        opening = book.id
        problem = nil
        defer { opening = nil }
        do {
            let asked = ContinuousClock.now
            async let detail = server.book(book.id)
            async let readAlong = server.readAlong(book.id)
            async let place = server.place(in: book.id)
            let (files, text, at) = try await (detail, readAlong, place)
            let typeset = ContinuousClock.now
            let layout = await Task.detached(priority: .userInitiated) { BookLayout(text) }.value
            log.info("opened \(book.title, privacy: .public): the server answered in \(typeset - asked, privacy: .public), \(layout.paragraphs.count) paragraphs set in \(ContinuousClock.now - typeset, privacy: .public)")
            reading = Reading(session: ReadingSession(book: book, detail: files, readAlong: text, place: at, server: server), layout: layout)
            lastRead = book.id
            UserDefaults.standard.set(book.id, forKey: Self.lastReadKey(server.account))
        } catch {
            problem = error.localizedDescription
        }
    }

    func close() {
        reading?.session.close()
        reading = nil
    }

    private static func lastReadKey(_ account: Account) -> String {
        "ribbon.lastRead.\(account.id)"
    }
}

/// What the app says about itself, in the system log: `log show --predicate 'subsystem == "app.ribbon.tv"'`.
let log = Logger(subsystem: "app.ribbon.tv", category: "app")
