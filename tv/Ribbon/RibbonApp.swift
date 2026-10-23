import Observation
import OSLog
import SwiftUI

/// Ribbon on the Apple TV: a book from your Ribbon server, its text on the
/// screen and its narration playing, the sentence being read marked as it
/// goes. Everything the TV shows comes from the server (docs/SERVER.md,
/// section 8): it keeps only its sign-in.
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
                } else {
                    SignInView()
                }
            }
            .environment(model)
            .preferredColorScheme(.dark)
        }
    }
}

/// What the app is showing: who it's signed in as, and the book open, if any.
@MainActor
@Observable
final class AppModel {
    struct Reading {
        let session: ReadingSession
        let layout: BookLayout
    }

    private(set) var server: RibbonServer? = Account.saved.map(RibbonServer.init)
    private(set) var reading: Reading?
    /// The book being opened, and what went wrong opening one.
    private(set) var opening: String?
    private(set) var problem: String?
    /// The book read last on this TV, where the shelf's focus starts.
    private(set) var lastRead: String? = UserDefaults.standard.string(forKey: "ribbon.lastRead")

    func signedIn(_ account: Account) {
        account.save()
        server = RibbonServer(account: account)
    }

    func signOut() {
        Account.forget()
        server = nil
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
            UserDefaults.standard.set(book.id, forKey: "ribbon.lastRead")
        } catch {
            problem = error.localizedDescription
        }
    }

    func close() {
        reading?.session.close()
        reading = nil
    }
}

/// What the app says about itself, in the system log: `log show --predicate 'subsystem == "app.ribbon.tv"'`.
let log = Logger(subsystem: "app.ribbon.tv", category: "app")
