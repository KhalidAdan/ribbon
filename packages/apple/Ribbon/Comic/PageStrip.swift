import SwiftUI
import UIKit

/// The small pictures of a comic's pages, from the server (docs/COMICS.md, section 15), for the strip of pages. Only
/// those near what is on screen are fetched: a page of the strip asks for its picture as it comes into sight and lets
/// the request go if it leaves before the picture comes, and no more than a few dozen are kept decoded, so a 600-page
/// book costs what an issue does.
@MainActor
@Observable
final class SmallPages {
    /// The pictures here, by page counted from 0.
    private(set) var pictures: [Int: UIImage] = [:]

    @ObservationIgnored private var fetching: [Int: Task<Void, Never>] = [:]
    @ObservationIgnored private let server: RibbonServer
    @ObservationIgnored private let book: String

    /// The most kept decoded at once: a strip across a TV shows about a dozen, and a picture is a quarter of a megabyte.
    static let most = 48

    init(server: RibbonServer, book: String) {
        self.server = server
        self.book = book
    }

    /// How long a page stays in sight before its picture is asked for: pages the strip only scrolls past are never fetched.
    static let settle: Duration = .milliseconds(150)

    /// A page has come into sight in the strip: its picture is fetched once it has stayed a moment, unless it is here
    /// or on its way.
    func want(_ page: Int) {
        guard pictures[page] == nil, fetching[page] == nil else { return }
        let (server, book) = (server, book)
        fetching[page] = Task { [weak self] in
            try? await Task.sleep(for: Self.settle)
            guard !Task.isCancelled else { return }
            let data = try? await server.smallPage(page + 1, of: book)
            // Decoded away from the screen's thread, at the size it came: 300 pixels tall.
            let picture = await Task.detached(priority: .utility) { data.flatMap { ComicPaging.picture(from: $0, longest: 600) } }.value
            guard !Task.isCancelled, let self else { return }
            self.fetching[page] = nil
            guard let picture else { return }
            self.pictures[page] = picture
            for gone in ComicPaging.forget(kept: Array(self.pictures.keys), near: page, most: Self.most) { self.pictures[gone] = nil }
        }
    }

    /// A page has gone out of sight: not fetched, if its picture hasn't come yet. One that has stays, among the most kept.
    func letGo(_ page: Int) {
        fetching[page]?.cancel()
        fetching[page] = nil
    }

    /// Out of the comic.
    func close() {
        for task in fetching.values { task.cancel() }
        fetching = [:]
        pictures = [:]
    }
}

/// The strip of small pages (docs/COMICS.md, section 15): every page of the comic small, in a row that runs the way
/// the comic reads, with the one `chosen` outlined in amber and kept in the middle. On the iPad and the iPhone it sits
/// above the slider and a touch goes to a page; on the TV the remote moves along it, and the page it is on is lifted.
struct PageStrip: View {
    let session: ComicSession
    /// The page outlined: the one being read, or the one the finger or the remote is on.
    let chosen: Int
    /// How tall a page is drawn, in points.
    let tall: CGFloat
    /// What a touch on a page does; nil on the TV, where Select goes to the chosen one.
    var go: ((Int) -> Void)?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: (tall * 0.12).rounded()) {
                    ForEach(0..<session.count, id: \.self) { page in
                        small(page)
                    }
                }
                // Room for the outline, and on the TV for the page lifted.
                .padding(.vertical, (tall * 0.1).rounded())
                .padding(.horizontal, (tall * 0.3).rounded())
            }
            // A comic read right to left has its first page at the right.
            .environment(\.layoutDirection, session.rightToLeft ? .rightToLeft : .leftToRight)
            // Once it has been laid out: asked as it appears, the scroll has no size yet and stays at its start.
            .onAppear { DispatchQueue.main.async { proxy.scrollTo(chosen, anchor: .center) } }
            .onChange(of: chosen) { was, page in
                // A step glides; a jump is simply there, rather than running past every page between.
                withAnimation(abs(page - was) <= 6 ? .easeOut(duration: 0.2) : nil) { proxy.scrollTo(page, anchor: .center) }
            }
        }
        .frame(height: (tall * 1.2).rounded())
    }

    private func small(_ page: Int) -> some View {
        let size = session.pages[page]
        let aspect = ComicPaging.aspect(of: CGSize(width: size.width, height: size.height))
        let isChosen = page == chosen
        let corner = (tall * 0.03).rounded()
        return ZStack {
            if let picture = session.small.pictures[page] {
                Image(uiImage: picture).resizable().interpolation(.medium)
            } else {
                // Its place, the size it will be, while its picture comes.
                Color.white.opacity(0.06)
            }
        }
        .frame(width: (tall * aspect).rounded(), height: tall)
        .clipShape(RoundedRectangle(cornerRadius: corner))
        .overlay {
            if isChosen { RoundedRectangle(cornerRadius: corner).stroke(Color.place, lineWidth: go == nil ? 4 : 2.5) }
        }
        // On the TV, the page the remote is on is lifted, as tvOS lifts what has the focus.
        .scaleEffect(go == nil && isChosen ? 1.08 : 1)
        .animation(.easeOut(duration: 0.15), value: isChosen)
        .id(page)
        .onAppear { session.small.want(page) }
        .onDisappear { session.small.letGo(page) }
        .contentShape(Rectangle())
        .onTapGesture { go?(page) }
        .accessibilityElement()
        .accessibilityLabel("Page \(page + 1)")
        .accessibilityAddTraits(isChosen ? [.isButton, .isSelected] : .isButton)
    }
}
