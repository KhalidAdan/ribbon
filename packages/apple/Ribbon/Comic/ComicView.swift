#if os(iOS)
import SwiftUI
import UIKit

/// The comic reader on the iPad and the iPhone (docs/COMICS.md, sections 7 and 14): a page, whole, as large as the
/// screen allows. A swipe or a touch on either side turns it; two fingers zoom into it and one moves about it; a
/// touch in the middle shows or hides what is around it.
///
/// A comic whose panels are marked is read a panel at a time instead: one panel fills the screen, a swipe or a
/// touch on either side goes to the next panel or the one before, and past a page's last panel is the next page's
/// first. Two touches, or the button beside the title, show the whole page; the button goes back to its panels.
/// A page nobody has marked is shown whole, as ever.
///
/// With the title come the comic's ways about it (docs/COMICS.md, section 15): along the foot, a strip of small pages
/// to touch, and a slider that runs the way the comic reads; a touch on the page number opens a box to type one.
/// The comic can be read as one long scroll instead of a page at a time, a choice kept on this device, and the
/// ground behind the page is the one chosen in Settings.
struct ComicView: View {
    let session: ComicSession
    let onClose: () -> Void
    @Environment(\.narrow) private var narrow
    @AppStorage(ComicGround.key) private var ground = ComicGround.ribbon
    @AppStorage(ComicReading.longScrollKey) private var longScroll = false
    /// The way back and the page number, shown until the page is touched in the middle.
    @State private var around = true
    /// The page the slider's finger is on, while it is down: the number follows it, and the page comes when it lets go.
    @State private var sliding: Int?
    /// "Go to page", and what has been typed into it.
    @State private var jumping = false
    @State private var typed = ""
    /// Whether the comic is read a panel at a time, where its pages have panels.
    @State private var byPanel = false
    /// The panel being read, among the page's, counted from 0.
    @State private var panel = 0
    /// A page come back to from the one after it comes in at its last panel, since that is where the reader left off.
    @State private var arrivesAtEnd = false

    /// The panels of the page being read; none when nobody has marked them.
    private var panels: [ComicPanel] { session.panels[session.page] ?? [] }

    /// Read a panel at a time: where the comic has panels, and not in the long scroll, where they don't apply.
    private var readingByPanel: Bool { byPanel && !longScroll }

    /// The page the number and the strip show: where the slider's finger is, else the page being read.
    private var shown: Int { sliding ?? session.page }

    var body: some View {
        ZStack {
            ground.color.ignoresSafeArea()
            if longScroll {
                LongScroll(
                    pages: session.pages.map { CGSize(width: $0.width, height: $0.height) },
                    pictures: session.pictures,
                    page: session.page,
                    reading: { session.turn(to: $0) },
                    touched: { withAnimation(.easeOut(duration: 0.2)) { around.toggle() } }
                )
                .ignoresSafeArea()
                .accessibilityLabel("Page \(session.page + 1) of \(session.count), in one long scroll")
            } else if let picture = session.pictures[session.page] {
                if readingByPanel, panels.indices.contains(panel) {
                    PanelPage(picture: picture, panel: panels[panel], page: session.page, touched: touched, swiped: swiped) {
                        withAnimation(.easeInOut(duration: 0.3)) { byPanel = false }
                    }
                    .ignoresSafeArea()
                    .accessibilityLabel("Page \(session.page + 1) of \(session.count), panel \(panel + 1) of \(panels.count)")
                } else {
                    ZoomablePage(picture: picture, page: session.page, touched: touched, swiped: swiped)
                        .ignoresSafeArea()
                        .accessibilityLabel("Page \(session.page + 1) of \(session.count)")
                }
            } else if let problem = session.problem {
                Text(problem).font(.ui(24)).foregroundStyle(Color.ink2).multilineTextAlignment(.center).padding(40)
            }
            if around {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        BackButton(title: "", action: onClose)
                        Text(session.book.title).font(.ui(24)).foregroundStyle(Color.ink2).lineLimit(1).allowsHitTesting(false)
                        Spacer()
                        // A page at a time, or one long scroll: kept on this device, for every comic.
                        Button {
                            withAnimation(.easeInOut(duration: 0.3)) { longScroll.toggle() }
                        } label: {
                            Image(systemName: longScroll ? "book.pages" : "scroll")
                                .font(.system(size: 20, weight: .medium))
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.ink2)
                        .accessibilityLabel(longScroll ? "Read a page at a time" : "Read as one long scroll")
                        // Only in a comic someone has marked the panels of: by its panels, or its pages whole. Not in the long scroll.
                        if !session.panels.isEmpty, !longScroll {
                            Button {
                                withAnimation(.easeInOut(duration: 0.3)) {
                                    byPanel.toggle()
                                    panel = 0
                                }
                            } label: {
                                Image(systemName: byPanel ? "rectangle.portrait" : "rectangle.split.2x2")
                                    .font(.system(size: 20, weight: .medium))
                                    .frame(minWidth: 44, minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.ink2)
                            .accessibilityLabel(byPanel ? "Show whole pages" : "Read by panels")
                        }
                    }
                    .padding(.leading, -12)
                    Spacer()
                    // Every page small, the one being read outlined: a touch goes to one. Across the whole screen.
                    PageStrip(session: session, chosen: shown, tall: narrow ? 80 : 100) { session.turn(to: $0, why: .seek) }
                        .padding(.horizontal, narrow ? -16 : -32)
                        .padding(.bottom, 6)
                    HStack {
                        Spacer()
                        // A touch on the number opens a box to type one.
                        Button {
                            typed = ""
                            jumping = true
                        } label: {
                            Text("Page \(shown + 1) of \(session.count)").font(.ui(24)).foregroundStyle(Color.ink2).monospacedDigit()
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Go to a page")
                    }
                    PageSlider(page: session.page, count: session.count, rightToLeft: session.rightToLeft, sliding: $sliding) { session.turn(to: $0, why: .seek) }
                }
                .padding(.horizontal, narrow ? 16 : 32)
                .padding(.top, 4)
                .padding(.bottom, 12)
                // Over the page's own edges, so it reads on any page: a little shade under the words, to the screen's edges.
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background {
                    VStack(spacing: 0) {
                        LinearGradient(colors: [.black.opacity(0.55), .clear], startPoint: .top, endPoint: .bottom).frame(height: 96)
                        Spacer()
                        // Taller at the foot, under the strip and the slider too.
                        LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .top, endPoint: .bottom).frame(height: narrow ? 220 : 250)
                    }
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                }
                .transition(.opacity)
            }
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .alert("Go to page", isPresented: $jumping) {
            TextField("\(session.page + 1)", text: $typed).keyboardType(.numberPad)
            Button("Go") {
                if let to = ComicPaging.page(typed: typed, of: session.count) { session.turn(to: to, why: .seek) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A page from 1 to \(session.count).")
        }
        .onAppear { byPanel = !session.panels.isEmpty }
        .onChange(of: session.page) { _, _ in
            // Another page: from its first panel, or its last when the reader came back into it.
            panel = arrivesAtEnd ? max(0, panels.count - 1) : 0
            arrivesAtEnd = false
        }
    }

    /// A touch, by how far across the screen it was: on the side the comic goes on to, onward; on the other, back; in the middle, what is around the page.
    private func touched(_ x: Double) {
        switch ComicPaging.turn(at: x, rightToLeft: session.rightToLeft) {
        case 1: step(1)
        case -1: step(-1)
        default: withAnimation(.easeOut(duration: 0.2)) { around.toggle() }
        }
    }

    /// A swipe: what is dragged off to the left brings what comes next, unless the comic reads the other way.
    private func swiped(toTheLeft: Bool) {
        step(toTheLeft != session.rightToLeft ? 1 : -1)
    }

    /// Onward (`1`) or back (`-1`): to the next panel or the one before where the page is read by its panels, and to another page past its last or its first.
    private func step(_ by: Int) {
        if readingByPanel, !panels.isEmpty, let to = ComicPaging.step(from: panel, by: by, of: panels.count) {
            panel = to
        } else if by > 0 {
            session.next()
        } else if session.hasPrevious {
            arrivesAtEnd = readingByPanel
            session.previous()
        }
    }
}

/// One panel of a page, filling the screen with nothing else of the page showing, as the Apple TV shows one
/// (ComicViewTV.swift): the page is drawn once and glides from panel to panel. A touch says how far across the
/// screen it was; a swipe says which way; two touches ask for the whole page.
private struct PanelPage: View {
    let picture: UIImage
    let panel: ComicPanel
    let page: Int
    let touched: (Double) -> Void
    let swiped: (Bool) -> Void
    let twice: () -> Void

    var body: some View {
        GeometryReader { space in
            let at = ComicPaging.close(on: panel, page: picture.size, screen: space.size)
            Image(uiImage: picture).resizable().interpolation(.high)
                .frame(width: picture.size.width * at.scale, height: picture.size.height * at.scale)
                .offset(at.offset)
                .frame(width: space.size.width, height: space.size.height)
                .mask { Rectangle().frame(width: at.window.width, height: at.window.height) }
                .animation(.easeInOut(duration: 0.3), value: at)
                // Another page is another picture: it is simply there, not flown in from where the last one was.
                .id(page)
                .contentShape(Rectangle())
                .gesture(
                    SpatialTapGesture(count: 2).onEnded { _ in twice() }
                        .exclusively(before: SpatialTapGesture().onEnded { tap in touched(space.size.width > 0 ? tap.location.x / space.size.width : 0.5) })
                )
                .simultaneousGesture(
                    DragGesture(minimumDistance: 30).onEnded { drag in
                        // Sideways, and far enough to be meant.
                        guard abs(drag.translation.width) > abs(drag.translation.height), abs(drag.translation.width) > 50 else { return }
                        swiped(drag.translation.width < 0)
                    }
                )
        }
    }
}

/// The page slider in the bar at the foot (docs/COMICS.md, section 15): as far along as the page is through the
/// comic, running the way the comic reads. The page number follows the finger (`sliding`), and the page itself is
/// fetched when the finger lets go, not for every page it passes.
private struct PageSlider: View {
    let page: Int
    let count: Int
    let rightToLeft: Bool
    @Binding var sliding: Int?
    let go: (Int) -> Void
    /// Whether a finger is on the slider. The slider sets its value at other times too (dimmed under a box, it sets the
    /// one it has), and only a finger's is followed; any other that is another page, as VoiceOver's, turns to it.
    @State private var held = false

    var body: some View {
        if count > 1 {
            Slider(
                value: Binding(get: { Double(sliding ?? page) }, set: { value in
                    let to = Int(value.rounded())
                    if held { sliding = to } else if to != page { go(to) }
                }),
                in: 0...Double(count - 1),
                step: 1
            ) { editing in
                held = editing
                guard !editing, let to = sliding else { return }
                sliding = nil
                if to != page { go(to) }
            }
            .tint(Color.place)
            // A comic read right to left starts at the right, and the slider fills from there.
            .environment(\.layoutDirection, rightToLeft ? .rightToLeft : .leftToRight)
            .accessibilityLabel("Page")
            .accessibilityValue("\((sliding ?? page) + 1) of \(count)")
        }
    }
}

/// One page in a scroll view, for what a scroll view does well: two fingers zoom, one moves about a zoomed page,
/// a double tap zooms in and out. While the page is whole, a swipe sideways and a tap are the reader's.
private struct ZoomablePage: UIViewRepresentable {
    let picture: UIImage
    let page: Int
    /// A touch, by how far across the screen it was, 0 to 1.
    let touched: (Double) -> Void
    /// A swipe: to the left, or to the right.
    let swiped: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 4
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.backgroundColor = .clear
        let image = UIImageView()
        image.contentMode = .scaleAspectFit
        image.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.addSubview(image)
        context.coordinator.image = image
        context.coordinator.scroll = scroll

        let twice = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tappedTwice(_:)))
        twice.numberOfTapsRequired = 2
        let once = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        once.require(toFail: twice)
        scroll.addGestureRecognizer(twice)
        scroll.addGestureRecognizer(once)
        for direction in [UISwipeGestureRecognizer.Direction.left, .right] {
            let swipe = UISwipeGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.swiped(_:)))
            swipe.direction = direction
            swipe.delegate = context.coordinator
            scroll.addGestureRecognizer(swipe)
        }
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        let c = context.coordinator
        c.touched = touched
        c.swipedTo = swiped
        guard c.page != page || c.image?.image !== picture else { return }
        // Another page: whole again, however far into the last one the reader was.
        c.page = page
        scroll.setZoomScale(1, animated: false)
        c.image?.frame = scroll.bounds
        c.image?.image = picture
    }

    final class Coordinator: NSObject, UIScrollViewDelegate, UIGestureRecognizerDelegate {
        weak var scroll: UIScrollView?
        weak var image: UIImageView?
        var page = -1
        var touched: (Double) -> Void = { _ in }
        var swipedTo: (Bool) -> Void = { _ in }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { image }

        @objc func tapped(_ tap: UITapGestureRecognizer) {
            guard let scroll, scroll.zoomScale <= 1.01, scroll.bounds.width > 0 else { return }
            touched(tap.location(in: scroll).x / scroll.bounds.width)
        }

        @objc func tappedTwice(_ tap: UITapGestureRecognizer) {
            guard let scroll, let image else { return }
            if scroll.zoomScale > 1.01 {
                scroll.setZoomScale(1, animated: true)
            } else {
                // Into where the fingers were, to two and a half times.
                let at = tap.location(in: image)
                let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
                scroll.zoom(to: CGRect(x: at.x - size.width / 2, y: at.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }

        @objc func swiped(_ swipe: UISwipeGestureRecognizer) {
            swipedTo(swipe.direction == .left)
        }

        /// A swipe turns the page only while the page is whole; zoomed, a finger moves about it.
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            (scroll?.zoomScale ?? 1) <= 1.01
        }
    }
}

/// One long scroll (docs/COMICS.md, section 15): the comic's pages one under another, each as wide as the screen, read
/// by scrolling. Every page has its place from the start, from the size the server measured, so the scroll is the
/// whole comic's length at once and jumping lands where it should; a page's picture is drawn only near the screen,
/// and only the pages the session keeps decoded have one. The page being read is the one filling the screen's top
/// third. Scrolled to, it tells the reader (`reading`); turned to some other way (the slider, the strip, a page
/// typed), the scroll goes to its top.
private struct LongScroll: UIViewRepresentable {
    /// Each page's size, as the server measured it.
    let pages: [CGSize]
    /// The pictures the session has decoded, by page.
    let pictures: [Int: UIImage]
    /// The page being read.
    let page: Int
    let reading: (Int) -> Void
    /// A touch anywhere: what is around the page shows or hides.
    let touched: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> Column {
        let scroll = Column()
        scroll.delegate = context.coordinator
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.backgroundColor = .clear
        scroll.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped)))
        scroll.laidOut = { [weak coordinator = context.coordinator] in coordinator?.lay() }
        context.coordinator.scroll = scroll
        return scroll
    }

    func updateUIView(_ scroll: Column, context: Context) {
        let c = context.coordinator
        c.reading = reading
        c.touched = touched
        c.pages = pages
        c.pictures = pictures
        c.ask(page)
        scroll.setNeedsLayout()
    }

    /// A scroll view that says when it lays out, which it does on every move too.
    final class Column: UIScrollView {
        var laidOut: () -> Void = {}

        override func layoutSubviews() {
            super.layoutSubviews()
            laidOut()
        }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var scroll: UIScrollView?
        var pages: [CGSize] = []
        var pictures: [Int: UIImage] = [:]
        var reading: (Int) -> Void = { _ in }
        var touched: () -> Void = {}
        /// The page the scroll is on, as it last said or was sent to.
        private var at: Int?
        /// The page being read when the reader last said, and one it said that the scroll hasn't gone to yet.
        private var asked: Int?
        private var goTo: Int?
        /// Sent to a page, the scroll stays on it until the reader moves it, even where the page can't reach the top.
        private var jumped = true
        /// The width the column was laid out for, and where each page starts down it (the column's foot last).
        private var width: CGFloat = 0
        private var tops: [CGFloat] = [0]
        /// The pages drawn now, near the screen.
        private var drawn: [Int: UIImageView] = [:]

        /// The page being read, from the reader: one the scroll didn't say itself was turned to some other way, and
        /// the scroll goes there.
        func ask(_ page: Int) {
            guard page != asked else { return }
            asked = page
            if page != at { goTo = page }
        }

        /// Lay the column out for the screen's width, go to a page asked for, and draw the pages near the screen.
        func lay() {
            guard let scroll, scroll.bounds.width > 0, !pages.isEmpty else { return }
            let screen = scroll.bounds.size
            if screen.width != width {
                // The first time, or turned on its side: every page's height again, and the same page at the top.
                width = screen.width
                tops = ComicPaging.tops(of: pages.map { ComicPaging.height(of: $0.width > 0 ? $0 : CGSize(width: 2, height: 3), atWidth: width) })
                scroll.contentSize = CGSize(width: width, height: tops.last!)
                for view in drawn.values { view.removeFromSuperview() }
                drawn = [:]
                go(to: goTo ?? at ?? asked ?? 0)
            } else if let goTo {
                go(to: goTo)
            }
            draw(in: scroll.contentOffset.y, screen: screen.height)
        }

        private func go(to page: Int) {
            guard let scroll else { return }
            let index = ComicPaging.clamp(page, of: pages.count)
            goTo = nil
            at = index
            jumped = true
            let furthest = max(0, tops.last! - scroll.bounds.height)
            scroll.contentOffset = CGPoint(x: 0, y: min(furthest, tops[index]))
        }

        /// Moved by the reader: the page filling the screen's top third is the one being read.
        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard !jumped, tops.count == pages.count + 1 else { return }
            let now = ComicPaging.reading(at: scrollView.contentOffset.y, screen: scrollView.bounds.height, tops: tops)
            guard now != at else { return }
            at = now
            reading(now)
        }

        /// The pages within half a screen of it drawn, each with its picture where the session has decoded one; the rest let go.
        private func draw(in offset: CGFloat, screen: CGFloat) {
            guard let scroll else { return }
            let near = (offset - screen / 2)...(offset + screen * 1.5)
            let first = max(0, (tops.lastIndex { $0 <= near.lowerBound } ?? 0))
            let last = min(pages.count - 1, (tops.firstIndex { $0 >= near.upperBound } ?? pages.count) - 1)
            let wanted = first <= last ? Set(first...last) : []
            for (index, view) in drawn where !wanted.contains(index) {
                view.removeFromSuperview()
                drawn[index] = nil
            }
            for index in wanted {
                let view = drawn[index] ?? {
                    let made = UIImageView()
                    made.contentMode = .scaleAspectFit
                    // Where a picture hasn't come, a faint shape of the page, so the column never looks empty.
                    made.backgroundColor = UIColor(white: 0.5, alpha: 0.08)
                    scroll.addSubview(made)
                    drawn[index] = made
                    return made
                }()
                view.frame = CGRect(x: 0, y: tops[index], width: width, height: tops[index + 1] - tops[index])
                let picture = pictures[index]
                if view.image !== picture { view.image = picture }
                view.backgroundColor = picture == nil ? UIColor(white: 0.5, alpha: 0.08) : .clear
            }
        }

        /// The reader moves the scroll: from here on, where it is says which page is being read.
        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            jumped = false
        }

        @objc func tapped() {
            touched()
        }
    }
}
#endif
