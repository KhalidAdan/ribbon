import SceneKit
import SwiftUI

/// The bookcase as a page of its own, reached from the invitation at the foot of the library. On the TV and the iPad,
/// the book you're on at the left and the shelves stacked in a case at the right; on an iPhone, one long shelf, seen with
/// the phone on its side.
struct BookcaseView: View {
    @Environment(AppModel.self) private var app
    @State private var bookcase: Bookcase?

    var body: some View {
        ZStack {
            if let bookcase {
                #if os(iOS)
                if Look.phone { PhoneBookcase(bookcase: bookcase) } else { StackedBookcase(bookcase: bookcase).wayBack() }
                #else
                StackedBookcase(bookcase: bookcase)
                #endif
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.canvas.ignoresSafeArea())
        .task { if bookcase == nil, let library = app.library { bookcase = Bookcase(library: library) } }
    }
}

/// What a press on a book does: the book you're on opens its page; any other comes off the shelf into your hand.
/// On the TV the remote's focus takes a book down, so a press always opens.
@MainActor
private func choose(_ it: ShelfItem, in bookcase: Bookcase, app: AppModel) {
    if bookcase.selected?.id == it.id { app.open(it.book.book) } else { bookcase.select(it) }
}

#if os(tvOS)
private let tv = true
#else
private let tv = false
#endif

private struct StackedBookcase: View {
    let bookcase: Bookcase
    @Environment(AppModel.self) private var app
    @Environment(\.displayScale) private var displayScale
    @FocusState private var focus: String?
    /// The TV shows whole shelves only: the first of the three in view.
    @State private var topRow = 0
    private let shelvesInView = 3

    /// On the TV, the largest size at which three whole shelves fill the screen's height (about 1.5 times the desktop's);
    /// the iPad's, a little larger than the desktop's.
    private func size(height: CGFloat) -> CGFloat {
        guard tv else { return 1.12 }
        var k: CGFloat = 1.8
        while k > 1, CGFloat(shelvesInView) * ShelfRow.height(k: k) > height { k -= 0.01 }
        return k
    }

    var body: some View {
        GeometryReader { geo in
            let lectern: CGFloat = tv ? 460 : 280, gap: CGFloat = tv ? 64 : 32
            let caseWidth = (geo.size.width - lectern - gap).rounded(.down)
            let k = size(height: geo.size.height)
            HStack(alignment: .top, spacing: gap) {
                VStack(alignment: .leading, spacing: tv ? 24 : 14) {
                    if tv { header } else { SearchField(bookcase: bookcase, compact: false) }
                    Lectern(bookcase: bookcase, width: lectern, height: tv ? 560 : 330, compact: false)
                    // On the TV the search sits below the book, so the shelf, not the search, has the first focus.
                    if tv { Spacer(minLength: 0); SearchField(bookcase: bookcase, compact: false) }
                }
                .frame(width: lectern, alignment: .leading)
                shelves
            }
            .task(id: "\(Int(caseWidth)) \(k)") { await bookcase.build(width: caseWidth, k: k, scale: displayScale, long: false) }
        }
        .padding(.horizontal, tv ? 0 : 32)
        .padding(.top, tv ? 0 : 8)
        // The keyboard covers the shelves rather than shrinking them: a smaller screen would rebuild every shelf.
        .ignoresSafeArea(.keyboard)
        .onChange(of: focus) { _, id in if let id, let it = bookcase.item(id) { bookcase.select(it) } }
        #if os(tvOS)
        .defaultFocus($focus, bookcase.firstBook)
        #endif
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4.scaled) {
            Text("Bookcase").font(.ui(30, weight: 600)).foregroundStyle(Color.ink)
            Text("All \(bookcase.books.count) books, newest first.").font(.ui(22)).foregroundStyle(Color.ink2)
        }
    }

    private var shelves: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The heading stays clear of the faded edges; only the bookcase dissolves into the page.
            if !tv { header.padding(.bottom, 14) }
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    // Lazy: only shelves near the screen are made at all.
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(bookcase.rows) { row in
                            ShelfRowView(row: row, focus: $focus, press: { tv ? app.open($0.book.book) : choose($0, in: bookcase, app: app) }, scrub: { bookcase.select($0) })
                                .id(row.id)
                        }
                    }
                    .padding(.bottom, tv ? 0 : 40)
                }
                #if os(tvOS)
                .frame(height: CGFloat(shelvesInView) * (bookcase.rows.first?.height ?? 0), alignment: .top)
                // tvOS lets a scroll view's contents spill past it, for focus effects; whole shelves only means clipping them.
                .clipped()
                .onChange(of: focus) { _, id in keepWhole(id, proxy) }
                // A book chosen from the search takes the remote's focus, and the shelves follow it.
                .onChange(of: bookcase.target) { _, t in if let t { focus = t.item } }
                #else
                .onChange(of: bookcase.target) { _, t in
                    guard let t else { return }
                    withAnimation(.easeInOut(duration: 0.45)) { proxy.scrollTo(t.row, anchor: .center) }
                }
                #endif
                // The shelves' edges dissolve into the page, so the bookcase reads as a pool of light, not a box pasted on.
                .mask(edgeFade(.horizontal))
                .mask(edgeFade(.vertical))
                .overlay(alignment: .topLeading) { SearchResults(bookcase: bookcase) }
            }
        }
    }

    /// Keep the focused shelf in view a whole shelf at a time, so no shelf is ever cut by the screen's edge.
    private func keepWhole(_ id: String?, _ proxy: ScrollViewProxy) {
        guard let id, let r = bookcase.rows.firstIndex(where: { $0.items.contains { $0.id == id } }) else { return }
        if r < topRow { topRow = r } else if r > topRow + shelvesInView - 1 { topRow = r - shelvesInView + 1 }
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bookcase.rows[topRow].id, anchor: .top) }
    }
}

#if os(iOS)
/// The bookcase on an iPhone. On its side, one long shelf to scroll along, with the way back, the search and the book
/// you're on at the left. Held upright, the page asks to be turned, and meanwhile makes the shelf, so it's ready when you do.
private struct PhoneBookcase: View {
    let bookcase: Bookcase
    @Environment(\.upright) private var upright

    var body: some View {
        if upright { TurnThePhone(bookcase: bookcase).wayBack() } else { PhoneShelf(bookcase: bookcase) }
    }
}

/// The page held upright: the bookcase's picture, and a word to turn the phone, or to turn the screen for a phone
/// whose screen is locked upright.
private struct TurnThePhone: View {
    let bookcase: Bookcase
    @Environment(AppModel.self) private var app
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turned = false

    var body: some View {
        GeometryReader { geo in
            VStack(alignment: .leading, spacing: 28) {
                if let library = app.library { BookcasePicture(library: library, aspect: BookcasePicture.narrow) }
                VStack(alignment: .leading, spacing: 6.scaled) {
                    // A phone turning on its side, now and then.
                    Image(systemName: "iphone")
                        .font(.system(size: 30, weight: .light))
                        .foregroundStyle(Color.ink2)
                        .rotationEffect(.degrees(turned ? -90 : 0))
                        .frame(width: 44, height: 44)
                        .padding(.bottom, 10)
                        .accessibilityHidden(true)
                    Text("Turn your phone on its side").font(.ui(30, weight: 600)).foregroundStyle(Color.ink)
                    Text("The bookcase is one long shelf: all \(bookcase.books.count) books, newest first.")
                        .font(.ui(24)).foregroundStyle(Color.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Turn the screen") { Turning.turnSideways() }
                        .buttonStyle(RibbonButtonStyle())
                        .padding(.top, 22.scaled)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            // The shelf is made for the phone on its side while this is read: as tall as the phone is wide, less the home bar.
            .task(id: Int(geo.size.width)) {
                await bookcase.build(width: geo.size.height, k: PhoneShelf.size(height: geo.size.width - 21), scale: displayScale, long: true)
            }
        }
        .task {
            guard !reduceMotion else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1.4))
                withAnimation(.easeInOut(duration: 0.6)) { turned.toggle() }
            }
        }
    }
}

/// The page on its side: the long shelf.
private struct PhoneShelf: View {
    let bookcase: Bookcase
    @Environment(AppModel.self) private var app
    @Environment(\.displayScale) private var displayScale
    @Environment(\.dismiss) private var dismiss

    /// The books' size: as large as the phone's height allows. A phone is held close, but a spine still needs room for its words.
    static func size(height: CGFloat) -> CGFloat {
        (min(1.5, (height - 8) / ShelfRow.height(k: 1)) * 100).rounded(.down) / 100
    }

    var body: some View {
        GeometryReader { geo in
            let left: CGFloat = 190, gap: CGFloat = 14
            let shelfWidth = (geo.size.width - left - gap).rounded(.down)
            let k = Self.size(height: geo.size.height)
            HStack(alignment: .top, spacing: gap) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Button { dismiss() } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Color.ink2)
                                .frame(width: 36, height: 36)
                                .background(Color.raised, in: RoundedRectangle(cornerRadius: 8))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Back")
                        SearchField(bookcase: bookcase, compact: true)
                    }
                    // The book takes what the search and the words and buttons about it leave.
                    Lectern(bookcase: bookcase, width: left, height: max(96, geo.size.height - 36 - 8 - Lectern.compactWords), compact: true)
                }
                .frame(width: left, alignment: .leading)
                ZStack(alignment: .topLeading) {
                    if let shelf = bookcase.shelf {
                        // A finger drawn along the shelf scrolls it; a tap takes a book down, and a tap on the book you're on opens it.
                        LongShelfView(shelf: shelf) { choose($0, in: bookcase, app: app) }
                            .id(ObjectIdentifier(shelf))
                            .frame(width: shelfWidth, height: shelf.height)
                            .mask(edgeFade(.horizontal))
                    }
                    SearchResults(bookcase: bookcase)
                }
                .frame(width: shelfWidth, alignment: .topLeading)
            }
            .task(id: "\(Int(shelfWidth)) \(k)") { await bookcase.build(width: shelfWidth, k: k, scale: displayScale, long: true) }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .ignoresSafeArea(.keyboard)
    }
}
#endif

/// The book you're on, in your hand, and what it is: its title, its author, how long it is and how far you are.
/// By touch, the book turns under a finger, and a press on it, or on Open, opens its page.
private struct Lectern: View {
    let bookcase: Bookcase
    let width: CGFloat
    let height: CGFloat
    let compact: Bool
    @Environment(AppModel.self) private var app

    /// The room the words and buttons under the book take on a phone on its side.
    static let compactWords: CGFloat = 196

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 8 : tv ? 24 : 14) {
            SceneHost(scene: bookcase.hand.scene, camera: bookcase.hand.camera, clear: true) { bookcase.hand.view = $0 }
                .frame(width: width, height: height)
                #if os(iOS)
                .overlay {
                    Rectangle().fill(Color.white.opacity(0.001))
                        .gesture(DragGesture(minimumDistance: 2)
                            .onChanged { bookcase.hand.drag($0.translation.width, ended: false) }
                            .onEnded { bookcase.hand.drag($0.translation.width, ended: true) })
                        .onTapGesture { if let b = bookcase.selected { app.open(b.book.book) } }
                }
                #endif
                .accessibilityHidden(true)
            if let b = bookcase.selected?.book { about(b) }
        }
    }

    private func about(_ b: ShelfBook) -> some View {
        let title: CGFloat = compact ? 25 : 30, body: CGFloat = compact ? 20 : 22, small: CGFloat = compact ? 18 : 19
        let bar: CGFloat = tv ? 300 : compact ? 170 : 240
        return VStack(alignment: .leading, spacing: tv ? 6 : 3) {
            #if os(iOS)
            // By touch, the title is the way to the book's page, as the book in your hand is.
            Button { app.open(b.book) } label: {
                (Text(b.title) + Text("  \(Image(systemName: "chevron.right"))").font(.system(size: compact ? 12 : 14, weight: .semibold)).foregroundColor(Color.ink3))
                    .font(.ui(title, weight: 600)).foregroundStyle(Color.ink).lineLimit(compact ? 2 : 3).fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens its page")
            #else
            Text(b.title).font(.ui(title, weight: 600)).foregroundStyle(Color.ink).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            #endif
            Text(b.author).font(.ui(body)).foregroundStyle(Color.ink2).lineLimit(1)
            Text(b.textOnly ? "EPUB" : "Audiobook · \(Format.left(b.book.durationMs))")
                .font(.ui(small)).foregroundStyle(Color.ink3).monospacedDigit().padding(.top, tv ? 8 : 4)
            Text(b.finished ? "Finished." : b.fraction > 0 ? "\(Int((b.fraction * 100).rounded()))% in." : b.days < 7 ? "Added this week." : "Not started.")
                .font(.ui(small)).foregroundStyle(Color.ink2).monospacedDigit()
            if b.fraction > 0, !b.finished {
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.14))
                    Capsule().fill(Color.place).frame(width: bar * b.fraction)
                }
                .frame(width: bar, height: tv ? 3 : 2)
                .padding(.top, tv ? 10 : 6)
            }
            #if os(iOS)
            InHand(book: b.book, compact: compact).padding(.top, compact ? 6 : 12)
            #endif
        }
    }
}

#if os(iOS)
/// What you can do with the book in your hand, there on the shelf: start it or carry on with it without leaving the
/// bookcase (on an iPhone, without turning the phone back upright), or read along with it. Its title, or the book
/// itself, opens its page. On the TV, Select opens the page, where listening has the focus.
private struct InHand: View {
    let book: ServerBook
    let compact: Bool
    @Environment(AppModel.self) private var app

    var body: some View {
        let progress = app.library?.progress(of: book)
        let started = progress?.started == true, finished = progress?.finished == true
        let here = app.listening?.book.id == book.id
        let playing = here && app.listening?.playing == true
        VStack(alignment: .leading, spacing: 8) {
            Group {
                if app.opening == book.id {
                    Button {} label: { Label("Opening…", systemImage: book.audio ? "play.fill" : "book.fill").frame(maxWidth: .infinity) }
                        .buttonStyle(RibbonButtonStyle(kind: .primary))
                        .disabled(true)
                } else if book.audio {
                    Button {
                        if playing { app.listening?.pause() } else { Task { await app.listen(to: book, showingPlayer: false) } }
                    } label: {
                        // Short on a phone, where the button is as wide as the book in your hand.
                        Label(playing ? "Pause" : finished ? "Listen again" : started ? (compact ? "Continue" : "Continue listening") : (compact ? "Listen" : "Start listening"),
                              systemImage: playing ? "pause.fill" : "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(RibbonButtonStyle(kind: .primary))
                } else {
                    Button { Task { await app.read(book) } } label: {
                        Label(started && !finished ? (compact ? "Continue" : "Continue reading") : "Read", systemImage: "book.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(RibbonButtonStyle(kind: .primary))
                }
            }
            if book.audio && book.ebook, app.opening != book.id {
                Button { Task { await app.readAlong(book) } } label: { Label("Read along", systemImage: "book").frame(maxWidth: .infinity) }
                    .buttonStyle(RibbonButtonStyle())
            }
            if let problem = app.problem {
                Text(problem).font(.ui(19)).foregroundStyle(Color.ink2).lineLimit(2)
            }
        }
        .lineLimit(1)
    }
}
#endif

/// Finding a book on the shelves by what you remember of it.
private struct SearchField: View {
    @Bindable var bookcase: Bookcase
    let compact: Bool

    var body: some View {
        #if os(tvOS)
        TextField("Find a book", text: $bookcase.query)
        #else
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Color.ink3)
            TextField("Find a book", text: $bookcase.query)
                .textFieldStyle(.plain)
                .font(.ui(23))
                .foregroundStyle(Color.ink)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                .onSubmit { if let first = bookcase.results.first { bookcase.choose(first) } }
            if !bookcase.query.isEmpty {
                Button { bookcase.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.ink3) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear the search")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 36)
        .background(Color.raised, in: RoundedRectangle(cornerRadius: 8))
        #endif
    }
}

/// What the search found, over the top of the shelf: it may cover a book or two until one is chosen.
private struct SearchResults: View {
    let bookcase: Bookcase

    var body: some View {
        let found = bookcase.results
        if !found.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(found.enumerated()), id: \.element.id) { i, it in
                    let b = it.book
                    Button { bookcase.choose(it) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(b.title).font(.ui(24, weight: 600)).foregroundStyle(Color.ink).lineLimit(1)
                            Text(b.textOnly ? "\(b.author) · EPUB" : "\(b.author) · \(Format.left(b.book.durationMs))")
                                .font(.ui(19)).foregroundStyle(Color.ink2).lineLimit(1).monospacedDigit()
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20.scaled)
                        .padding(.vertical, 12.scaled)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if i < found.count - 1 { Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1) }
                }
            }
            .frame(width: tv ? 640 : 380)
            .background(Color.raised, in: RoundedRectangle(cornerRadius: 18.scaled))
            .overlay(RoundedRectangle(cornerRadius: 18.scaled).stroke(Color.white.opacity(0.08)))
            .shadow(color: .black.opacity(0.55), radius: 24, y: 10)
            .padding(20.scaled)
        }
    }
}

/// One shelf: its picture, with an invisible button over every book for the remote, a touch, or VoiceOver.
/// By touch, a finger run along it takes down each book it passes, as on the desktop's bookcase.
private struct ShelfRowView: View {
    @ObservedObject var row: ShelfRow
    var focus: FocusState<String?>.Binding
    let press: (ShelfItem) -> Void
    let scrub: (ShelfItem) -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            // At once: the shelf drawn flat from the same spine art, until its 3D picture is ready.
            if row.still == nil { FlatShelf(row: row).transition(.opacity) }
            if let still = row.still {
                Image(uiImage: still).resizable().frame(width: row.width, height: row.height).accessibilityHidden(true).transition(.opacity)
            }
            if row.live {
                SceneHost(scene: row.scene, camera: row.camera, onDrawn: { row.drawn($0) }) { row.view = $0 }
                    .frame(width: row.width, height: row.height)
                    .accessibilityHidden(true)
            }
            ForEach(row.items) { it in
                let f = row.frame(of: it)
                Button { press(it) } label: {
                    Rectangle().fill(Color.white.opacity(0.001)).frame(width: f.width, height: f.height)
                }
                .buttonStyle(Bare())
                #if os(tvOS)
                // The remote's focus takes a book down on the TV; by touch a tap does, and keyboard focus stays out of it.
                .focused(focus, equals: it.id)
                #endif
                .accessibilityLabel("\(it.book.title), \(it.book.author)")
                .padding(.leading, f.minX)
                .padding(.top, f.minY)
            }
        }
        .frame(width: row.width, height: row.height, alignment: .topLeading)
        .animation(.easeOut(duration: 0.25), value: row.still == nil)
        #if os(iOS)
        .contentShape(Rectangle())
        .simultaneousGesture(DragGesture(minimumDistance: 6).onChanged { v in
            guard abs(v.translation.width) > abs(v.translation.height), let it = row.item(at: v.location.x) else { return }
            scrub(it)
        })
        #endif
    }
}

/// A button that draws nothing: the book itself shows focus, by coming off the shelf.
private struct Bare: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label }
}

/// The shelf drawn flat, straight away: its wood, its board, and every book's spine where the 3D shelf will put it.
private struct FlatShelf: View {
    let row: ShelfRow

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(uiColor: Lamplight.caseBack.ui)
            Color(uiColor: Lamplight.caseBoard.ui).frame(height: 12 * row.k).offset(y: row.top)
            ForEach(row.items) { it in
                if let face = row.flat[it.id] {
                    Image(uiImage: face).resizable().frame(width: it.w, height: it.h).offset(x: it.x, y: row.top - it.h)
                }
            }
        }
        .frame(width: row.width, height: row.height, alignment: .topLeading)
        .clipped()
        .accessibilityHidden(true)
    }
}

/// The edges of the shelves dissolving into the page.
private func edgeFade(_ axis: Axis) -> some View {
    let edge = axis == .horizontal ? 0.05 : 0.035
    return LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: edge), .init(color: .black, location: 1 - edge), .init(color: .clear, location: 1)],
                          startPoint: axis == .horizontal ? .leading : .top, endPoint: axis == .horizontal ? .trailing : .bottom)
}
