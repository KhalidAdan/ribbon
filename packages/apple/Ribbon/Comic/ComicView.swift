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
struct ComicView: View {
    let session: ComicSession
    let onClose: () -> Void
    @Environment(\.narrow) private var narrow
    /// The way back and the page number, shown until the page is touched in the middle.
    @State private var around = true
    /// Whether the comic is read a panel at a time, where its pages have panels.
    @State private var byPanel = false
    /// The panel being read, among the page's, counted from 0.
    @State private var panel = 0
    /// A page come back to from the one after it comes in at its last panel, since that is where the reader left off.
    @State private var arrivesAtEnd = false

    /// The panels of the page being read; none when nobody has marked them.
    private var panels: [ComicPanel] { session.panels[session.page] ?? [] }

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            if let picture = session.pictures[session.page] {
                if byPanel, panels.indices.contains(panel) {
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
                        // Only in a comic someone has marked the panels of: by its panels, or its pages whole.
                        if !session.panels.isEmpty {
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
                    HStack {
                        Spacer()
                        Text("Page \(session.page + 1) of \(session.count)").font(.ui(24)).foregroundStyle(Color.ink2).monospacedDigit()
                    }
                    .padding(.bottom, 10)
                    .allowsHitTesting(false)
                    PageHairline(fraction: session.fraction).allowsHitTesting(false)
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
                        LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom).frame(height: 96)
                    }
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                }
                .transition(.opacity)
            }
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
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
        if byPanel, !panels.isEmpty, let to = ComicPaging.step(from: panel, by: by, of: panels.count) {
            panel = to
        } else if by > 0 {
            session.next()
        } else if session.hasPrevious {
            arrivesAtEnd = byPanel
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

/// How far through the comic, as the reader's own hairline shows it.
private struct PageHairline: View {
    let fraction: Double

    var body: some View {
        GeometryReader { space in
            ZStack(alignment: .leading) {
                Rectangle().fill(Color.white.opacity(0.08))
                Rectangle().fill(Color.place).frame(width: space.size.width * min(1, max(0, fraction)))
            }
        }
        .frame(height: 2)
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
#endif
