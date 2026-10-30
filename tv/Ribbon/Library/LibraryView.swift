import SwiftUI

/// The library, as the desktop's (src/ui/LibraryPane.tsx): what you're in
/// the middle of, then each series as a card that knows where you are in it,
/// then every book outside a series. Each card is one button, which opens the
/// book's page, where play is. The focus starts on the book you were in the
/// middle of.
struct LibraryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.narrow) private var narrow
    @FocusState private var focused: String?

    var body: some View {
        let library = model.library
        ScrollView {
            VStack(alignment: .leading, spacing: 72.scaled) {
                TopBar()
                if let library, library.loaded {
                    if library.books.isEmpty {
                        Text("No books on \(model.host) yet. The server's admin adds them from a folder.").font(.ui(28)).foregroundStyle(Color.ink2)
                    }
                    let continuing = library.inProgress
                    if !continuing.isEmpty {
                        VStack(alignment: .leading, spacing: 28.scaled) {
                            SectionHeader(title: "Continue", description: continuing.count == 1 ? "One book in progress." : "\(continuing.count) books in progress, most recent first.")
                            ScrollView(.horizontal) {
                                HStack(spacing: 28.scaled) {
                                    ForEach(continuing) { book in ContinueCard(book: book).focused($focused, equals: "continue-\(book.id)") }
                                }
                                .padding(24.scaled)
                            }
                            .padding(-24.scaled)
                            .scrollClipDisabled()
                        }
                    }
                    let series = library.series
                    if !series.isEmpty {
                        VStack(alignment: .leading, spacing: 28.scaled) {
                            SectionHeader(title: "Series", description: "\(series.count) series, in the order you listen.")
                            ScrollView(.horizontal) {
                                HStack(spacing: 28.scaled) {
                                    ForEach(series) { group in SeriesCard(series: group) }
                                }
                                .padding(24.scaled)
                            }
                            .padding(-24.scaled)
                            .scrollClipDisabled()
                        }
                    }
                    let standalone = library.standalone
                    if !standalone.isEmpty {
                        VStack(alignment: .leading, spacing: 32.scaled) {
                            SectionHeader(
                                title: series.isEmpty ? "All books" : "Books",
                                description: series.isEmpty ? "\(standalone.count) \(standalone.count == 1 ? "book" : "books"), most recently listened first." : "\(standalone.count) \(standalone.count == 1 ? "book" : "books") outside a series."
                            )
                            // Two to a row on a phone.
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: BookCard.width(narrow).scaled, maximum: (BookCard.width(narrow) + 20).scaled), spacing: narrow ? 20 : 48.scaled, alignment: .top)], alignment: .leading, spacing: 64.scaled) {
                                ForEach(standalone) { book in BookCard(book: book) }
                            }
                        }
                    }
                } else {
                    Text(library?.problem ?? "Asking \(model.host) for its books…").font(.ui(28)).foregroundStyle(Color.ink2)
                }
            }
            .screenEdges(horizontal: 96, vertical: 56)
        }
        .background(Color.canvas.ignoresSafeArea())
        #if os(tvOS)
        .onExitCommand(perform: model.people.count > 1 ? { model.switchReader() } : nil)
        #else
        // Scrolled, the shelf goes under the status bar, which stays on the canvas.
        .overlay(alignment: .top) {
            Color.canvas.ignoresSafeArea(edges: .top).frame(height: 0).allowsHitTesting(false)
        }
        #endif
        .task { await model.loadLibrary() }
        .onChange(of: model.library?.loaded) { _, loaded in
            // The cards arrive after the screen is up: the focus goes to the book you were in the middle of.
            if loaded == true, let first = model.library?.inProgress.first { focused = "continue-\(first.id)" }
        }
    }
}

/// Ribbon's mark, and where you are: the server, and who's reading, which opens the settings; and the book playing, which
/// opens the player. A phone's bar is short: the server's name goes, Search and the settings are their glyphs, and the
/// book playing has a row of its own under them.
private struct TopBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.upright) private var upright
    @Environment(\.narrow) private var narrow

    var body: some View {
        if narrow {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14.scaled) {
                    mark
                    Spacer()
                    search.labelStyle(.iconOnly)
                    settings.labelStyle(.iconOnly)
                }
                if let listening = model.listening { playing(listening) }
            }
        } else {
            HStack(spacing: 14.scaled) {
                mark
                Image(systemName: "chevron.right").font(.system(size: 18.scaled, weight: .semibold)).foregroundStyle(Color.ink3)
                Text(model.host).font(.ui(28)).foregroundStyle(Color.ink2).lineLimit(1)
                Spacer()
                // Each button's words whole: where the bar is short, as on an iPad held upright, the book playing gives way.
                search
                    .padding(.trailing, 16.scaled)
                if let listening = model.listening {
                    playing(listening)
                        .padding(.trailing, 16.scaled)
                }
                settings
            }
            #if os(tvOS)
            // One place for the focus to go up to from anywhere below: its buttons sit at the far right, outside what's
            // straight above the cards.
            .focusSection()
            #endif
        }
    }

    private var mark: some View {
        HStack(spacing: 14.scaled) {
            Image(systemName: "bookmark.fill").font(.system(size: 26.scaled)).foregroundStyle(Color.place)
            Text("Ribbon").font(.ui(30, weight: 600)).foregroundStyle(Color.ink)
        }
    }

    private var search: some View {
        Button { model.showSearch() } label: {
            Label("Search", systemImage: "magnifyingglass").fixedSize()
        }
        .buttonStyle(RibbonButtonStyle())
    }

    /// The book playing, and how long is left of it, which opens the player. Upright, an iPad's bar is short: the book
    /// keeps its title, and the time left goes. A phone gives it the width of the screen.
    private func playing(_ listening: Listening) -> some View {
        Button { model.showPlayer() } label: {
            HStack(spacing: 14.scaled) {
                Image(systemName: listening.playing ? "speaker.wave.2.fill" : "pause.fill").font(.system(size: 20.scaled))
                Text(listening.book.title).lineLimit(1)
                if narrow { Spacer(minLength: 8) }
                if narrow || !upright {
                    Text("\(Format.left(Format.atSpeed(listening.durationMs - listening.positionMs, listening.speed))) left").opacity(0.7).monospacedDigit()
                }
            }
            .frame(maxWidth: narrow ? .infinity : 640.scaled)
        }
        .buttonStyle(RibbonButtonStyle())
    }

    /// Who's reading, which is where their settings are.
    private var settings: some View {
        Button { model.showSettings() } label: {
            Label(model.server?.account.name ?? "Settings", systemImage: "gearshape").fixedSize()
        }
        .buttonStyle(RibbonButtonStyle())
        .accessibilityLabel("Settings")
    }
}

/// A book you're in the middle of: where, and how long is left. It opens the book's page.
private struct ContinueCard: View {
    @Environment(AppModel.self) private var model
    let book: ServerBook
    @State private var detail: ServerBookDetail?

    var body: some View {
        let library = model.library
        Button { model.open(book) } label: {
            HStack(spacing: 22.scaled) {
                CoverView(book: book, size: 120)
                VStack(alignment: .leading, spacing: 8.scaled) {
                    Text(book.title).font(.ui(26, weight: 500)).foregroundStyle(Color.ink).lineLimit(1)
                    Text(where_).font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit().lineLimit(1)
                    ProgressLine(fraction: library?.fraction(of: book) ?? 0).padding(.top, 8.scaled)
                }
                .widthUnlessNarrow(400)
            }
            .padding(22.scaled)
            .background(RoundedRectangle(cornerRadius: 20.scaled).fill(Color.surface))
            .overlay(RoundedRectangle(cornerRadius: 20.scaled).stroke(Color.line))
        }
        .buttonStyle(LiftStyle(radius: 20))
        .fillsNarrowRow(room: 24)
        .task { detail = await model.library?.detail(of: book) }
    }

    /// "Chapter 4 · 9h 40m left", the chapter by its own name, or how far in when the book is one chapter.
    private var where_: String {
        let ms = model.library?.progress(of: book)?.ms ?? 0
        let left = "\(Format.left(book.durationMs - ms)) left"
        guard let chapters = detail?.chapters, chapters.count > 1 else {
            return "\(Int(((model.library?.fraction(of: book) ?? 0) * 100).rounded()))% in · \(left)"
        }
        let index = max(0, chapters.lastIndex { $0.startMs <= ms } ?? 0)
        return "\(chapters[index].title) · \(left)"
    }
}

/// A series: the next book's cover on a small stack, how much is left, what's up next, and a mark per book. It opens
/// the next book's page.
private struct SeriesCard: View {
    @Environment(AppModel.self) private var model
    let series: Library.Series

    var body: some View {
        let library = model.library
        let finished = series.books.filter { library?.progress(of: $0)?.finished == true }.count
        let next = series.books.first { library?.progress(of: $0)?.finished != true } ?? series.books[0]
        let started = library?.progress(of: next)?.started == true
        let left = series.books.reduce(0) { sum, book in
            let p = library?.progress(of: book)
            return sum + (p?.finished == true ? 0 : book.durationMs - (p?.ms ?? 0))
        }
        let allDone = finished == series.books.count
        let hours = Format.left(left).replacingOccurrences(of: #" \d+m$"#, with: "", options: .regularExpression)
        Button { model.open(next) } label: {
            HStack(alignment: .top, spacing: 24.scaled) {
                ZStack(alignment: .leading) {
                    if series.books.count > 2 { RoundedRectangle(cornerRadius: 6.scaled).fill(Color.raised).overlay(RoundedRectangle(cornerRadius: 6.scaled).stroke(Color.line)).frame(width: 128.scaled, height: 112.scaled).offset(x: 20.scaled) }
                    if series.books.count > 1 { RoundedRectangle(cornerRadius: 6.scaled).fill(Color.raised).overlay(RoundedRectangle(cornerRadius: 6.scaled).stroke(Color.line)).frame(width: 132.scaled, height: 124.scaled).offset(x: 10.scaled) }
                    CoverView(book: next, size: 136)
                }
                .frame(width: 160.scaled, alignment: .leading)
                VStack(alignment: .leading, spacing: 8.scaled) {
                    Text(series.name).font(.ui(26, weight: 500)).foregroundStyle(Color.ink).lineLimit(1)
                    Text("\(series.books.count) books · \(allDone ? "all finished" : finished > 0 ? "\(finished) finished · \(hours) to go" : hours)").font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit()
                    Text(allDone ? "Every book finished" : started ? "Listening to \(next.title)" : "Up next: \(next.title)").font(.ui(22)).foregroundStyle(Color.ink3).lineLimit(1).padding(.top, 6.scaled)
                    SegmentedProgress(parts: series.books.map { library?.fraction(of: $0) ?? 0 }).padding(.top, 16.scaled)
                }
                .widthUnlessNarrow(450)
            }
            .padding(24.scaled)
            .background(RoundedRectangle(cornerRadius: 20.scaled).fill(Color.surface))
            .overlay(RoundedRectangle(cornerRadius: 20.scaled).stroke(Color.line))
        }
        .buttonStyle(LiftStyle(radius: 20))
        .fillsNarrowRow(room: 24)
    }
}

/// A book on the shelf: the cover, the title, the author, and how far along.
private struct BookCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.narrow) private var narrow
    let book: ServerBook

    /// How wide a card is, at the TV's size: a little narrower on a phone, so two fit side by side.
    static func width(_ narrow: Bool) -> CGFloat {
        narrow ? 230 : 250
    }

    var body: some View {
        let library = model.library
        let progress = library?.progress(of: book)
        VStack(alignment: .leading, spacing: 6.scaled) {
            Button { model.open(book) } label: {
                CoverView(book: book, size: Self.width(narrow))
                    .overlay(alignment: .topTrailing) {
                        if progress?.finished == true {
                            Image(systemName: "checkmark").font(.system(size: 18.scaled, weight: .bold)).foregroundStyle(Color.ink)
                                .frame(width: 36.scaled, height: 36.scaled).background(Circle().fill(Color.canvas.opacity(0.8))).padding(10.scaled)
                        }
                    }
            }
            #if os(tvOS)
            .buttonStyle(.card)
            #else
            .buttonStyle(LiftStyle(radius: 6))
            #endif
            .padding(.bottom, 18.scaled)
            Text(book.title).font(.ui(24, weight: 500)).foregroundStyle(Color.ink).lineLimit(1)
            Text(book.author.isEmpty ? "Unknown author" : book.author).font(.ui(22)).foregroundStyle(Color.ink2).lineLimit(1)
            Text(library?.standing(of: book) ?? "").font(.ui(22)).foregroundStyle(Color.ink3).monospacedDigit().lineLimit(1)
            if progress?.started == true && progress?.finished != true {
                ProgressLine(fraction: library?.fraction(of: book) ?? 0).padding(.top, 8.scaled)
            }
        }
        .frame(width: Self.width(narrow).scaled)
    }
}

/// A book's cover, square as the desktop draws covers, cropped to fill, in
/// its own colour before the picture arrives so nothing moves when it does;
/// the title's initials when there's no picture. Its size is the TV's.
struct CoverView: View {
    @Environment(AppModel.self) private var model
    let book: ServerBook
    let size: CGFloat
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color(uiColor: UIColor(hex: book.cover?.colour) ?? Look.raised)
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fill).transition(.opacity)
            } else if book.cover == nil {
                Text(initials).font(.ui(size * 0.2, weight: 500)).foregroundStyle(Color.ink3)
            }
        }
        .frame(width: size.scaled, height: size.scaled)
        .clipShape(RoundedRectangle(cornerRadius: max(4, size * 0.025).scaled))
        .overlay(RoundedRectangle(cornerRadius: max(4, size * 0.025).scaled).stroke(Color.line))
        .task(id: book.cover?.hash) {
            guard let hash = book.cover?.hash, let server = model.server else { return }
            let found = try? await server.cover(hash, width: size > 200 ? 800 : 400)
            withAnimation(.easeOut(duration: 0.2)) { image = found }
        }
    }

    /// The first letters of the title's first two words, as the desktop's cover does when it has no picture
    /// (src/ui/Cover.tsx): words that start with a letter, so "07. Legion" reads L, not 0L.
    private var initials: String {
        let words = book.title.split(whereSeparator: \.isWhitespace)
        let lettered = words.filter { $0.first?.isLetter == true }
        let initials = (lettered.isEmpty ? words : lettered).prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased()
        return initials.isEmpty ? "?" : initials
    }
}

extension UIColor {
    /// A colour as the server writes one: `#7c7251`.
    convenience init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(rgb: value)
    }
}
