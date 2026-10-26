import Observation
import OSLog
import SwiftUI

/// Ribbon on the Apple TV: the books on your Ribbon server, a page for each,
/// the player, and the reader, where the text is on the screen and the
/// sentence being read is marked as the narration goes. Everything the TV
/// shows comes from the server (docs/SERVER.md, section 8): it keeps only who
/// has signed in on it. The iPad runs the same app, by touch (tv/README.md).
@main
struct RibbonApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var phase

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
            // Every press and touch, seen first: who's awake, and what wakes the passages.
            .background(WatchTheRemote())
            .environment(model)
            .preferredColorScheme(.dark)
            #if os(iOS)
            .modifier(SaysWhichWayUp())
            #endif
            .onChange(of: phase, initial: true) { _, phase in
                model.inFront = phase == .active
                // Coming back to the app took a press, which the home screen had.
                if phase == .active { Remote.used() }
            }
        }
    }
}

/// The library, and the screens it leads to, one over the other: Menu goes
/// back a screen, and the focus comes back to what opened it. Over them
/// all, what the narration brings up on its own: a chapter's card, Still
/// listening?, the end of the book, and the passages while it's paused.
private struct Screens: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        let listening = model.listening
        NavigationStack(path: $model.path) {
            LibraryView()
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: AppModel.Screen.self) { screen in
                    Group {
                        switch screen {
                        case .book(let book): BookView(book: book, kept: model.library?.details[book.id]).wayBack()
                        case .player: PlayerView().wayBack()
                        case .search: SearchView().wayBack()
                        case .settings: SettingsView().wayBack()
                        case .reader:
                            if let reading = model.reading {
                                ReaderView(session: reading.session, layout: reading.layout) { model.closeReader() }
                            }
                        }
                    }
                    .toolbar(.hidden, for: .navigationBar)
                }
        }
        .overlay(alignment: .bottom) {
            if let listening, listening.dozing.asked != nil {
                StillListening().padding(.bottom, 72.scaled).transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .overlay {
            if let listening, let index = listening.card {
                ChapterCard(listening: listening, index: index).transition(.wipe)
            }
        }
        .overlay {
            if let passages = model.passages {
                PassagesView(passages: passages).transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.5), value: listening?.card)
        .animation(.easeOut(duration: 0.4), value: listening?.dozing.asked)
        .animation(.easeInOut(duration: 1.2), value: model.passages == nil)
        .fullScreenCover(isPresented: Binding(get: { model.finished != nil }, set: { if !$0 { model.closeFinished() } })) {
            if let finished = model.finished { FinishedView(listening: finished) }
        }
    }
}

#if os(iOS)
/// Tells every screen whether it's held upright (`upright`) and whether it's as narrow as a phone (`narrow`), and
/// again as it turns or its window changes.
private struct SaysWhichWayUp: ViewModifier {
    @State private var upright = false
    @State private var narrow = false

    func body(content: Content) -> some View {
        content
            .environment(\.upright, upright)
            .environment(\.narrow, narrow)
            .background {
                GeometryReader { space in
                    Color.clear.onChange(of: space.size, initial: true) { _, size in
                        upright = size.height > size.width
                        narrow = size.width < 500
                    }
                }
            }
    }
}
#endif

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
        case settings
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
    /// A book that has just played to its end, while its card shows.
    private(set) var finished: Listening?
    /// The person's bookmarked passages, drifting by while a book is paused; nil when they aren't.
    private(set) var passages: [Passage]?
    /// Whether the app is in front, rather than behind the home screen or the screen saver.
    var inFront = true
    /// Whether this person keeps their stretches of listening as sessions, on this TV (docs/POSITION-FORMAT.md, section 3.3).
    private(set) var keepsSessions = true

    /// Paused this long in the player or the reader with nothing pressed, the passages drift by.
    private static let stillFor = Waits.of(5 * 60, quick: 15)
    /// After drifting by this long, they let the TV's own screen saver and sleep have it.
    private static let passagesFor: TimeInterval = 60 * 60
    @ObservationIgnored private var passagesSince: Date?
    @ObservationIgnored private var passagesKnown: (at: Date, passages: [Passage])?

    init() {
        if people.count == 1 { choose(people[0]) }
        Task { [weak self] in await self?.watchStillness() }
    }

    /// The server's name, as people know it.
    var host: String { server?.account.url.host() ?? "the server" }

    /// The screen under the one in front, which the iPad's way back names.
    var beneath: String {
        guard path.count > 1 else { return "Library" }
        switch path[path.count - 2] {
        case .book(let book): return book.title
        case .player: return "Player"
        case .search: return "Find a line"
        case .settings: return "Settings"
        case .reader: return "Read along"
        }
    }

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
        keepsSessions = UserDefaults.standard.object(forKey: Self.sessionsKey(account)) as? Bool ?? true
        passagesKnown = nil
    }

    /// Keep this person's stretches of listening as sessions, or stop: the end of a book can then say how long it took.
    func keepSessions(_ on: Bool) {
        guard let server else { return }
        keepsSessions = on
        listening?.keepsSessions = on
        UserDefaults.standard.set(on, forKey: Self.sessionsKey(server.account))
    }

    /// Back to Who's reading. The narration is the person's, so it stops, and their place is kept.
    func switchReader() {
        reading?.session.close()
        reading = nil
        listening?.stop()
        listening = nil
        finished = nil
        passagesKnown = nil
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
            // A book finished and left at its end is listened to again from the start: a new listen-through.
            if library?.progress(of: book)?.finished == true && listening.durationMs - listening.positionMs < FinishedWithin.ms {
                listening.startingAgain = true
                listening.play(from: 0)
            } else if !listening.playing {
                listening.resume()
            }
            if path.last != .player { path.append(.player) }
        } catch {
            problem = error.localizedDescription
        }
    }

    /// The player, for the book playing.
    func showPlayer() {
        if listening != nil && path.last != .player { path.append(.player) }
    }

    // Reading along ----------------------------------------------------------

    /// The TV's settings: listening sessions, and who's reading.
    func showSettings() {
        if path.last != .settings { path.append(.settings) }
    }

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
            let listening = try await listening(for: book, at: place?.ms, placedAt: Moment.read(place?.at))
            let text = try await readAlong
            let typeset = ContinuousClock.now
            let measure = BookLayout.Measure.forThisScreen
            let layout = await Task.detached(priority: .userInitiated) { BookLayout(text, measure: measure) }.value
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

    // The end of a book --------------------------------------------------------

    /// Away from the end of a book's card, back to where it ended.
    func closeFinished() {
        finished = nil
    }

    /// The next book in the series to hear: the first after this one not finished yet.
    func upNext(after book: ServerBook) -> ServerBook? {
        guard let library, let series = library.series(of: book), let index = series.books.firstIndex(where: { $0.id == book.id }) else { return nil }
        return series.books[(index + 1)...].first { library.progress(of: $0)?.finished != true }
    }

    /// Up next, chosen from the end of a book: its player, over its page where the book before's page was.
    func listenToNext(_ book: ServerBook) async {
        finished = nil
        if reading != nil {
            reading?.session.close()
            reading = nil
        }
        path.removeAll { $0 == .reader || $0 == .player }
        if case .book = path.last { path[path.count - 1] = .book(book) }
        await listen(to: book)
    }

    // While a book is paused -----------------------------------------------------

    /// Whether a chapter's card can show: the player or the reader is in front.
    private var bookOnScreen: Bool {
        inFront && (path.last == .player || path.last == .reader)
    }

    /// The passages drift by once a book has been paused for five minutes in the player or the reader with nothing
    /// pressed, unless it stopped on its own for someone asleep; any press brings back the screen. Until then the
    /// TV's own screen saver is held off, for a person with passages to show.
    private func watchStillness() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            let still = listening.map { !$0.playing && !$0.stoppedOnItsOwn } == true && bookOnScreen && finished == nil
            guard still else {
                if passages != nil { passages = nil }
                passagesSince = nil
                Remote.stopWaiting("passages")
                KeepAwake.set("passages", false)
                continue
            }
            let known = await knownPassages()
            let quiet = Date().timeIntervalSince(max(listening?.pausedAt ?? .distantPast, Remote.lastInput))
            if passages == nil && quiet >= Self.stillFor && !known.isEmpty {
                passages = known.shuffled()
                passagesSince = Date()
                Remote.wait("passages") { [weak self] in self?.passages = nil }
            } else if passages == nil && quiet < Self.stillFor {
                passagesSince = nil
            }
            // Held off while it waits for them, and while they drift by, for an hour at most.
            KeepAwake.set("passages", !known.isEmpty && Date().timeIntervalSince(passagesSince ?? Date()) < Self.passagesFor)
        }
    }

    /// The person's passages, from the server once every ten minutes at most: the words of their bookmarks.
    private func knownPassages() async -> [Passage] {
        if let passagesKnown, Date().timeIntervalSince(passagesKnown.at) < 600 { return passagesKnown.passages }
        guard let server else { return [] }
        let found = ((try? await server.passages()) ?? []).filter { $0.quote?.isEmpty == false }
        passagesKnown = (Date(), found)
        return found
    }

    // Inside -----------------------------------------------------------------

    /// The narration of a book: the one playing, when it's this book, else a new one from the person's place,
    /// or from the moment given, kept when given. Starting another book stops the one before; its place is kept.
    private func listening(for book: ServerBook, at ms: Int? = nil, placedAt: Date? = nil) async throws -> Listening {
        if let listening, listening.book.id == book.id { return listening }
        guard let server, let library else { throw ServerError(message: "Choose who's reading first.") }
        listening?.stop()
        listening = nil
        let detail = try await server.book(book.id)
        await library.refreshProgress()
        let progress = library.progress(of: book)
        let start = ms ?? (progress?.finished == true ? 0 : progress?.ms ?? 0)
        let made = Listening(book: book, detail: detail, startMs: start, placedAt: placedAt ?? Moment.read(progress?.at), server: server)
        made.keepsSessions = keepsSessions
        made.showsCards = { [weak self] in self?.bookOnScreen ?? false }
        made.inFront = { [weak self] in self?.inFront ?? true }
        made.onFinish = { [weak self, weak made] in
            guard let self, let made else { return }
            self.passages = nil
            self.finished = made
            Task { await self.library?.refreshProgress() }
        }
        listening = made
        return made
    }

    private static func sessionsKey(_ account: Account) -> String {
        "ribbon.sessions.\(account.id)"
    }
}

/// How near its end a book counts as finished, as the desktop counts it (src/core/progress.ts, `FINISHED_WITHIN_MS`).
enum FinishedWithin {
    static let ms = 60_000
}

/// What the app says about itself, in the system log: `log show --predicate 'subsystem == "app.ribbon.tv"'`.
let log = Logger(subsystem: "app.ribbon.tv", category: "app")
