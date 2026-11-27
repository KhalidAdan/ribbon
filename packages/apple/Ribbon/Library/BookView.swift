import SwiftUI

/// One book's page, as the desktop's (packages/desktop/src/ui/ReaderPage.tsx): the cover, the
/// title in the book's own serif, where you are as a sentence, listening and
/// reading along, and More (finished or not, starting again), the facts, the
/// description, your history with it, and the rest of its series as a list.
/// A faint wash of the cover's colour sits behind the top. The focus starts
/// on listening; Menu goes back to the library.
///
/// The TV and the iPad set the cover beside the words, or above them when upright. The iPhone has a top of its
/// own (`phoneTop`): everything down the middle, and the buttons as wide as the screen.
///
/// A comic's page says what a comic has of its own (docs/BOOK-DETAILS.md, section 4), as the desktop's does: in its
/// own series it is "#7 of 19" or "Vol. 1 of 19"; its cover date, the day it went on sale, its imprint beside its
/// publisher and the issues a collection holds are among the facts; its people by what they did and its story arcs
/// are under them (ComicDetails); and a comic whose details came from ComicVine says so, linking back.
struct BookView: View {
    @Environment(AppModel.self) private var model
    let book: ServerBook
    /// The id of the series the page was opened from, the one it lists; nil when it wasn't opened from a series.
    let openedFrom: String?
    @State private var detail: ServerBookDetail?
    /// Every listen-through of the book, oldest first.
    @State private var listens: [Listen] = []
    /// Whether the details came after the page was drawn, rather than with it.
    @State private var arrivedLate = false
    @State private var moreAbout = false
    /// Asking the admin whether to delete the book from the server.
    @State private var confirmingDelete = false
    @FocusState private var focused: Focus?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.upright) private var upright
    @Environment(\.narrow) private var narrow

    private enum Focus: Hashable {
        case listen, readAlong
    }

    /// `kept` is the book's details when the library has them already, so a page opened again draws them
    /// from the first frame instead of a moment later.
    init(book: ServerBook, openedFrom: String? = nil, kept: ServerBookDetail?) {
        self.book = book
        self.openedFrom = openedFrom
        _detail = State(initialValue: kept)
    }

    var body: some View {
        let library = model.library
        let progress = library?.progress(of: book)
        // A book can be in several series: each is named, and the one listed is the one you came from, else the one
        // heard most recently.
        let inSeries = library?.series(of: book, openedFrom: openedFrom) ?? []
        let series = inSeries.first
        ZStack(alignment: .top) {
            // The ground and the wash reach every edge of the screen, under the safe area, or the system's own backdrop shows at the sides.
            Color.canvas.ignoresSafeArea()
            // Behind the cover: to the left, or in the middle on the iPhone.
            let behindCover = UnitPoint(x: Look.phone ? 0.5 : 0.2, y: 0)
            RadialGradient(colors: [tone.opacity(0.16), .clear], center: behindCover, startRadius: 0, endRadius: 640.scaled)
                // An ellipse twice as wide as it is tall, as the desktop's wash is, that has faded out before its frame ends.
                .scaleEffect(x: 2, y: 1, anchor: behindCover)
                .frame(height: 720.scaled)
                .ignoresSafeArea()
                .allowsHitTesting(false)
            ScrollView {
                VStack(alignment: .leading, spacing: 80.scaled) {
                    if Look.phone {
                        VStack(alignment: .leading, spacing: 0) {
                            phoneTop(progress, inSeries)
                            about
                        }
                    } else {
                        // Upright, the iPad has the cover above the rest.
                        let side = upright ? AnyLayout(VStackLayout(alignment: .leading, spacing: 48.scaled)) : AnyLayout(HStackLayout(alignment: .top, spacing: 72.scaled))
                        side {
                            CoverView(book: book, size: 440)
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(seriesLines(inSeries), id: \.self) { line in
                                    Text(line).font(.ui(24)).foregroundStyle(Color.ink2)
                                }
                                Text(book.title).font(.book(60, weight: 600)).foregroundStyle(Color.ink).lineLimit(3).padding(.top, 6.scaled)
                                bylineText(26).padding(.top, 12.scaled)

                                Text(sentence(progress))
                                    .font(.ui(26)).foregroundStyle(Color.ink).monospacedDigit()
                                    .frame(maxWidth: 900.scaled, alignment: .leading)
                                    .padding(.leading, 18.scaled)
                                    .overlay(alignment: .leading) { Rectangle().fill(Color.lineStrong).frame(width: 2) }
                                    .padding(.top, 36.scaled)
                                if isUnderway(progress) {
                                    ProgressLine(fraction: library?.fraction(of: book) ?? 0).frame(maxWidth: 480.scaled).padding(.top, 22.scaled)
                                }

                                // One above the other on an iPad sharing its screen.
                                let buttons = narrow ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12.scaled)) : AnyLayout(HStackLayout(spacing: 24.scaled))
                                buttons {
                                    startButton(progress)
                                    if book.audio && book.ebook {
                                        readAlongButton()
                                    }
                                    moreMenu(progress)
                                }
                                .padding(.top, 36.scaled)
                                if let problem = model.problem {
                                    Text(problem).font(.ui(24)).foregroundStyle(Color.ink2).padding(.top, 16.scaled)
                                }

                                about
                            }
                        }
                    }

                    if !listens.isEmpty {
                        History(listens: listens)
                    }

                    if let series {
                        SeriesList(series: series, current: book)
                    }
                }
                .screenEdges(horizontal: 96, vertical: 72)
            }
        }
        .defaultFocus($focused, .listen)
        #if os(iOS)
        .alert("Delete \(book.title) from the server?", isPresented: $confirmingDelete) {
            Button("Delete", role: .destructive) { Task { await model.deleteFromServer(book) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It goes from the server and from every device that downloaded it. Everyone’s places in it are kept, and the folder it came from isn’t touched.")
        }
        #endif
        .task(id: book.id) { await loadListens() }
        .task(id: book.id) {
            if let kept = model.library?.details[book.id] {
                detail = kept
                return
            }
            let found = await model.library?.detail(of: book)
            // Fetched after the page was drawn, the chapters, the year and the description push what's under
            // them down: the page settles into place rather than jumping. With Reduce Motion nothing glides;
            // the details land at once, and the description fades in where it lands.
            arrivedLate = true
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { detail = found }
        }
    }

    /// The top of the page on the iPhone, down the middle: the cover, the series, the title and who wrote and
    /// reads it, where you are, and the buttons. They fill the width of the screen, a thumb's height each: the
    /// one to start on alone across the top, and More a square at the end of the last row, so every edge lines
    /// up with the screen's however many there are.
    @ViewBuilder
    private func phoneTop(_ progress: BookProgress?, _ inSeries: [Library.Series]) -> some View {
        // Lengths here are the iPhone's own points, as its edges are (Look.swift, `screenEdges`); faces are the TV's sizes.
        VStack(spacing: 0) {
            CoverView(book: book, size: 360)
            VStack(spacing: 6) {
                ForEach(seriesLines(inSeries), id: \.self) { line in
                    Text(line).font(.ui(24)).foregroundStyle(Color.ink2)
                }
                Text(book.title).font(.book(46, weight: 600)).foregroundStyle(Color.ink).lineLimit(3)
                bylineText(24)
            }
            .padding(.top, 24)

            VStack(spacing: 10) {
                Text(sentence(progress)).font(.ui(24)).foregroundStyle(Color.ink).monospacedDigit()
                if isUnderway(progress) {
                    ProgressLine(fraction: model.library?.fraction(of: book) ?? 0)
                }
            }
            .padding(.top, 24)

            VStack(spacing: 10) {
                if book.audio && book.ebook {
                    startButton(progress, fit: .row)
                    HStack(spacing: 10) {
                        readAlongButton(fit: .row)
                        moreMenu(progress, fit: .glyph)
                    }
                } else {
                    HStack(spacing: 10) {
                        startButton(progress, fit: .row)
                        moreMenu(progress, fit: .glyph)
                    }
                }
            }
            .padding(.top, 20)

            if let problem = model.problem {
                Text(problem).font(.ui(24)).foregroundStyle(Color.ink2).padding(.top, 12)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }

    /// The facts and the description, under the top of the page on every screen. A comic's people by what they
    /// did and its story arcs come between them, and a comic matched on ComicVine says so after them.
    private var about: some View {
        Group {
            Facts(items: facts)
                .padding(.top, 48.scaled)

            if book.isComic, let about = detail?.book {
                let lines = ComicDetails.madeBy(about)
                if !lines.isEmpty {
                    MadeBy(lines: lines).padding(.top, 30.scaled)
                }
            }

            if let description = detail?.book.description, !description.isEmpty {
                // Focusable, so the remote reaches it and can open the rest.
                Button { withAnimation(.easeOut(duration: 0.2)) { moreAbout.toggle() } } label: {
                    VStack(alignment: .leading, spacing: 10.scaled) {
                        Text(description).font(.ui(24)).foregroundStyle(Color.ink2).lineSpacing(8.scaled).lineLimit(moreAbout ? nil : 5).multilineTextAlignment(.leading)
                        Text(moreAbout ? "Less" : "More").font(.ui(22, weight: 500)).foregroundStyle(Color.ink3)
                    }
                    .frame(maxWidth: 1000.scaled, alignment: .leading)
                    .padding(18.scaled)
                }
                .buttonStyle(LiftStyle.row(radius: 14))
                .padding(.horizontal, -18.scaled)
                .padding(.top, 30.scaled)
                .modifier(FadesInPlace(fades: arrivedLate && reduceMotion))
            }

            if book.isComic, let page = ComicDetails.comicVinePage(detail?.matched) {
                FromComicVine(page: page).padding(.top, 30.scaled)
            }
        }
    }

    /// Listen, or Read for a book that's only its text: the page's one primary button, where the focus starts.
    @ViewBuilder
    private func startButton(_ progress: BookProgress?, fit: RibbonButtonStyle.Fit = .words) -> some View {
        if book.audio {
            Button { Task { await model.listen(to: book) } } label: {
                Label(listenLabel(progress), systemImage: "play.fill")
            }
            .buttonStyle(RibbonButtonStyle(kind: .primary, fit: fit))
            .focused($focused, equals: .listen)
        } else {
            // Only its text: reading is the book, as the desktop's page has it.
            Button { Task { await model.read(book) } } label: {
                Label(model.opening == book.id ? "Opening…" : isUnderway(progress) ? "Continue reading" : "Read", systemImage: "book.fill")
            }
            .buttonStyle(RibbonButtonStyle(kind: .primary, fit: fit))
            .focused($focused, equals: .listen)
        }
    }

    private func readAlongButton(fit: RibbonButtonStyle.Fit = .words) -> some View {
        Button { Task { await model.readAlong(book) } } label: {
            Label(model.opening == book.id ? "Opening…" : "Read along", systemImage: "book.fill")
        }
        .buttonStyle(RibbonButtonStyle(fit: fit))
        .focused($focused, equals: .readAlong)
    }

    /// What the desktop's book page has under its own More. As a glyph alone, it's still called More aloud.
    private func moreMenu(_ progress: BookProgress?, fit: RibbonButtonStyle.Fit = .words) -> some View {
        Menu {
            if progress?.finished == true {
                Button("Mark as not finished") { Task { await mark(finished: false) } }
            } else {
                Button("Mark as finished") { Task { await mark(finished: true) } }
            }
            if book.audio && isUnderway(progress) {
                Button("Start again from the beginning") { Task { await model.startAgain(book) } }
            }
            // Everything else by the people on its byline: by touch their names lead there too.
            let people = splitPeople(book.author).map(BookPerson.author) + splitPeople(book.narrator).map(BookPerson.narrator)
            if !people.isEmpty {
                Divider()
                ForEach(people, id: \.self) { person in
                    Button("Everything \(person.said)") { model.showBooks(by: person) }
                }
            }
            #if os(iOS)
            // For the server's admin, as on the desktop's book page. The TV has no way to delete a book.
            if model.isAdmin {
                Divider()
                Button("Delete from the server…", role: .destructive) { confirmingDelete = true }
            }
            #endif
        } label: {
            if fit == .glyph {
                Label("More", systemImage: "ellipsis").labelStyle(.iconOnly)
            } else {
                Label("More", systemImage: "ellipsis")
            }
        }
        .menuStyle(.button)
        .buttonStyle(RibbonButtonStyle(fit: fit))
    }

    /// "The Expanse · Book 2 of 9", or a comic's "Transformers (2023) · #7 of 19", for each series the book is in.
    private func seriesLines(_ inSeries: [Library.Series]) -> [String] {
        inSeries.compactMap { series in
            guard let index = series.books.firstIndex(where: { $0.id == book.id }) else { return nil }
            return "\(series.name) · \(series.place(of: book, at: index))"
        }
    }

    /// The byline as the page draws it. By touch each name is a link to everything of theirs in the library
    /// (BooksView.swift); on the TV, where text can't take the remote's focus, More has the same ways there.
    @ViewBuilder private func bylineText(_ size: CGFloat) -> some View {
        #if os(iOS)
        Text(linkedByline).font(.ui(size)).foregroundStyle(Color.ink2).tint(Color.ink2)
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == Self.personScheme, let name = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value else { return .systemAction }
                model.showBooks(by: url.host() == "narrator" ? .narrator(name) : .author(name))
                return .handled
            })
        #else
        Text(byline).font(.ui(size)).foregroundStyle(Color.ink2)
        #endif
    }

    private static let personScheme = "ribbon-person"

    /// The byline with each author and each narrator underlined, as a link the page answers itself.
    private var linkedByline: AttributedString {
        func names(_ people: [String], as kind: String) -> AttributedString {
            var out = AttributedString()
            for (i, name) in people.enumerated() {
                if i > 0 { out += AttributedString(i == people.count - 1 ? " and " : ", ") }
                var link = AttributedString(name)
                var address = URLComponents()
                address.scheme = Self.personScheme
                address.host = kind
                address.queryItems = [URLQueryItem(name: "name", value: name)]
                link.link = address.url
                link.underlineStyle = .single
                out += link
            }
            return out
        }
        var out = book.author.isEmpty ? AttributedString("Author unknown") : names(splitPeople(book.author), as: "author")
        if !book.narrator.isEmpty { out += AttributedString(", read by ") + names(splitPeople(book.narrator), as: "narrator") }
        return out
    }

    /// Who wrote it and who reads it: "Frank Herbert, read by Scott Brick".
    private var byline: String {
        "\(book.author.isEmpty ? "Author unknown" : book.author)\(book.narrator.isEmpty ? "" : ", read by \(book.narrator)")"
    }

    /// Started and not yet finished.
    private func isUnderway(_ progress: BookProgress?) -> Bool {
        progress?.started == true && progress?.finished != true
    }

    /// Finished, or not after all, on every device; the history then says so.
    private func mark(finished: Bool) async {
        await model.mark(book, finished: finished)
        await loadListens()
    }

    private func loadListens() async {
        guard let found = try? await model.server?.listens(in: book.id) else { return }
        listens = found
    }

    /// The cover's own colour, for the wash behind the top.
    private var tone: Color {
        UIColor(hex: book.cover?.colour).map { Color(uiColor: $0) } ?? .clear
    }

    private func listenLabel(_ progress: BookProgress?) -> String {
        if progress?.finished == true { return "Listen again" }
        return progress?.started == true ? "Continue listening" : "Start listening"
    }

    /// Where you are in the book, as a sentence, as the desktop says it.
    private func sentence(_ progress: BookProgress?) -> String {
        if !book.audio {
            let pages = book.pages ?? 0
            guard let progress, progress.started else {
                return book.isComic ? "Not started. A comic\(pages > 0 ? ", \(Format.pages(pages))" : "")." : "Not started. An EPUB to read; there is no audio for it."
            }
            if progress.finished { return "Finished. Read it again any time." }
            // A comic says its page, as the desktop does.
            if book.isComic, pages > 1 { return "You are on page \(Int(((model.library?.fraction(of: book) ?? 0) * Double(pages - 1)).rounded()) + 1) of \(pages)." }
            return "You are \(max(1, Int((model.library?.fraction(of: book) ?? 0) * 100)))% through."
        }
        let chapters = detail?.chapters ?? []
        guard let progress, progress.started else {
            return "Not started. \(Format.left(book.durationMs))\(chapters.count > 1 ? " in \(chapters.count) chapters" : "")."
        }
        if progress.finished { return "Finished. Listen again any time; your place starts over." }
        let percent = max(1, Int((model.library?.fraction(of: book) ?? 0) * 100))
        let index = chapters.lastIndex { $0.startMs <= progress.ms } ?? 0
        // The chapter by its own name: counting the markers counts the credits and the epigraph too.
        let where_ = chapters.count > 1 ? ", in \(chapters[index].title)" : ""
        return "You are \(percent)% through\(where_). \(Format.left(book.durationMs - progress.ms)) left."
    }

    private var facts: [(term: String, value: String)] {
        var facts: [(String, String)] = book.audio ? [("Length", Format.left(book.durationMs))] : []
        if let detail, !detail.chapters.isEmpty { facts.append(("Chapters", String(detail.chapters.count))) }
        // Its year and publisher; a comic's cover date, day on sale, imprint and the issues it collects.
        if let about = detail?.book { facts += ComicDetails.published(about).map { ($0.term, $0.value) } }
        if book.ebook { facts.append(("Ebook", "EPUB")) }
        if book.isComic {
            if let pages = book.pages { facts.append(("Pages", String(pages))) }
            facts.append(("Comic", "CBZ"))
        }
        return facts
    }
}

/// Something that fades in where it lands, without moving: how a late description arrives with Reduce Motion
/// on. When `fades` is false it's simply there.
private struct FadesInPlace: ViewModifier {
    let fades: Bool
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(fades && !shown ? 0 : 1)
            .onAppear { withAnimation(.easeOut(duration: 0.2)) { shown = true } }
    }
}

/// Every listen-through of the book, newest first, as the desktop's book page lists them
/// (packages/desktop/src/ui/ReadHistory.tsx): when it started, how it ended, how many days it took, and the time spent
/// listening in it on every device. Dates are corrected on the desktop.
private struct History: View {
    let listens: [Listen]

    var body: some View {
        let listened = listens.reduce(0) { $0 + $1.listenedMs }
        VStack(alignment: .leading, spacing: 18.scaled) {
            SectionHeader(title: "Your history with it", description: listened > 0 ? "\(Format.left(listened)) listened\(listens.count > 1 ? ", over \(listens.count) listen-throughs" : "")." : nil)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(listens.enumerated()).reversed(), id: \.offset) { index, listen in
                    HStack(alignment: .firstTextBaseline, spacing: 20.scaled) {
                        Text(String(index + 1)).font(.ui(22)).foregroundStyle(Color.ink3).monospacedDigit().frame(width: 44.scaled, alignment: .trailing)
                        Text(line(listen)).font(.ui(24)).foregroundStyle(Color.ink).monospacedDigit()
                    }
                    // On the iPhone each line's rule runs the width of the screen, as the facts' does above it.
                    .frame(maxWidth: Look.phone ? .infinity : nil, alignment: .leading)
                    .padding(.vertical, 12.scaled)
                    .overlay(alignment: .top) { Rectangle().fill(Color.line).frame(height: 1) }
                }
            }
        }
        .frame(maxWidth: 1000.scaled, alignment: .leading)
    }

    /// "3 Oct 2026 to 12 Oct 2026 · 9 days · 11h 20m", "1 Nov 2026 to now", or "… · not finished".
    private func line(_ listen: Listen) -> String {
        let started = Moment.read(listen.started)
        let ended = Moment.read(listen.ended.at)
        var words = "\(Self.day(started)) to \(listen.ended.how == "going" ? "now" : Self.day(ended))"
        if listen.ended.how == "left" { words += " · not finished" }
        if listen.ended.how == "finished", let started, let ended {
            let days = max(1, Int((ended.timeIntervalSince(started) / 86_400).rounded()))
            words += days == 1 ? " · a day" : " · \(days) days"
        }
        if listen.listenedMs > 0 { words += " · \(Format.left(listen.listenedMs))" }
        return words
    }

    private static func day(_ date: Date?) -> String {
        date?.formatted(date: .abbreviated, time: .omitted) ?? "?"
    }
}

/// The facts under a hairline: four across, two on a phone, a small muted term over each value.
private struct Facts: View {
    let items: [(term: String, value: String)]
    @Environment(\.narrow) private var narrow

    var body: some View {
        VStack(alignment: .leading, spacing: 22.scaled) {
            Rectangle().fill(Color.line).frame(height: 1)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 32.scaled, alignment: .leading), count: narrow ? 2 : 4), alignment: .leading, spacing: 22.scaled) {
                ForEach(items, id: \.term) { fact in
                    VStack(alignment: .leading, spacing: 4.scaled) {
                        Text(fact.term).font(.ui(22)).foregroundStyle(Color.ink3)
                        Text(fact.value).font(.ui(24, weight: 500)).foregroundStyle(Color.ink).monospacedDigit().lineLimit(1)
                    }
                }
            }
        }
        .frame(maxWidth: 1000.scaled)
    }
}

/// A comic's people by what they did, and its story arcs, under the facts: a line each, what they did in the facts'
/// first column and who across the rest, so the names line up under the facts' second column, as the desktop's page
/// sets them.
private struct MadeBy: View {
    let lines: [ComicDetails.Line]
    @Environment(\.narrow) private var narrow
    /// How wide the facts are here, which their columns are made from.
    @State private var width: CGFloat = 0

    var body: some View {
        // The facts' own columns: four across, two on a phone.
        let columns: CGFloat = narrow ? 2 : 4
        let spacing = 32.scaled
        // Until the width is known, each term is as wide as its words.
        let firstColumn = width > 0 ? max(0, (width - (columns - 1) * spacing) / columns) : nil
        VStack(alignment: .leading, spacing: 14.scaled) {
            ForEach(lines, id: \.term) { line in
                HStack(alignment: .firstTextBaseline, spacing: spacing) {
                    Text(line.term).font(.ui(22)).foregroundStyle(Color.ink3)
                        .frame(width: firstColumn, alignment: .leading)
                    Text(line.value).font(.ui(24)).foregroundStyle(Color.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: 1000.scaled, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

/// "Details from ComicVine", for a comic whose details came from there: ComicVine asks for a link back wherever its
/// data shows (docs/BOOK-DETAILS.md, section 7). The iPad and the iPhone open the comic's page there; the TV can't
/// open a page, so it says where ComicVine is.
private struct FromComicVine: View {
    let page: URL

    var body: some View {
        #if os(tvOS)
        Text("Details from ComicVine, \(page.host() ?? "comicvine.gamespot.com")")
            .font(.ui(22)).foregroundStyle(Color.ink3)
        #else
        Link(destination: page) {
            HStack(spacing: 6.scaled) {
                Text("Details from ComicVine")
                Image(systemName: "arrow.up.right").font(.system(size: 16.scaled, weight: .semibold))
            }
            .font(.ui(22, weight: 500)).foregroundStyle(Color.ink2)
            .padding(.vertical, 10.scaled)
        }
        .buttonStyle(LiftStyle.row(radius: 10))
        #endif
    }
}

/// The book's series, every book in order: its number, cover, title, and how it stands; the book open marked in amber.
private struct SeriesList: View {
    @Environment(AppModel.self) private var model
    let series: Library.Series
    let current: ServerBook

    var body: some View {
        let library = model.library
        let finished = series.books.filter { library?.progress(of: $0)?.finished == true }.count
        let left = series.books.reduce(0) { sum, book in
            let p = library?.progress(of: book)
            return sum + (p?.finished == true ? 0 : book.durationMs - (p?.ms ?? 0))
        }
        let hours = Format.left(left).replacingOccurrences(of: #" \d+m$"#, with: "", options: .regularExpression)
        VStack(alignment: .leading, spacing: 24.scaled) {
            SectionHeader(title: series.name, description: "\(finished) of \(series.books.count) finished\(left > 0 ? ", \(hours) still to hear" : "").")
            VStack(spacing: 4.scaled) {
                ForEach(Array(series.books.enumerated()), id: \.element.id) { index, book in
                    let now = book.id == current.id
                    let progress = library?.progress(of: book)
                    // Its page lists this series too, so moving along it stays in it.
                    Button { model.open(book, in: series) } label: {
                        HStack(spacing: 24.scaled) {
                            Text(series.number(of: book, at: index)).font(.ui(22)).foregroundStyle(Color.ink3).monospacedDigit().frame(width: 44.scaled, alignment: .trailing)
                            CoverView(book: book, size: 72)
                            VStack(alignment: .leading, spacing: 4.scaled) {
                                // Two lines on the iPhone, where one leaves little of a title.
                                Text(series.title(of: book)).font(.ui(26, weight: now ? 500 : 400)).foregroundStyle(Color.ink).lineLimit(Look.phone ? 2 : 1)
                                Text(book.author).font(.ui(22)).foregroundStyle(Color.ink3).lineLimit(1)
                            }
                            Spacer(minLength: 24.scaled)
                            HStack(spacing: 10.scaled) {
                                if progress?.finished == true { Image(systemName: "checkmark").font(.system(size: 20.scaled, weight: .semibold)).foregroundStyle(Color.ink3) }
                                Text(library?.standing(of: book) ?? "").font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit()
                            }
                        }
                        .padding(.vertical, 12.scaled)
                        .padding(.leading, 20.scaled)
                        .padding(.trailing, 24.scaled)
                        .background(RoundedRectangle(cornerRadius: 12.scaled).fill(now ? Color.raised : Color.clear))
                        .overlay(alignment: .leading) {
                            if now { Capsule().fill(Color.place).frame(width: 4.scaled).padding(.vertical, 14.scaled) }
                        }
                    }
                    .buttonStyle(LiftStyle.row(radius: 12))
                }
            }
        }
    }
}
