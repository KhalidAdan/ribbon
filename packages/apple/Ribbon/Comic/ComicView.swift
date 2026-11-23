#if os(iOS)
import SwiftUI
import UIKit

/// The comic reader on the iPad and the iPhone (docs/COMICS.md, section 7): a page, whole, as large as the screen
/// allows. A swipe or a touch on either side turns it; two fingers zoom into it and one moves about it; a touch in
/// the middle shows or hides what is around it.
struct ComicView: View {
    let session: ComicSession
    let onClose: () -> Void
    @Environment(\.narrow) private var narrow
    /// The way back and the page number, shown until the page is touched in the middle.
    @State private var around = true

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            if let picture = session.pictures[session.page] {
                ZoomablePage(picture: picture, page: session.page) { x in
                    switch ComicPaging.turn(at: x, rightToLeft: session.rightToLeft) {
                    case 1: session.next()
                    case -1: session.previous()
                    default: withAnimation(.easeOut(duration: 0.2)) { around.toggle() }
                    }
                } swiped: { toTheLeft in
                    // A page dragged off to the left brings the next one, unless the comic reads the other way.
                    if toTheLeft != session.rightToLeft { session.next() } else { session.previous() }
                }
                .ignoresSafeArea()
                .accessibilityLabel("Page \(session.page + 1) of \(session.count)")
            } else if let problem = session.problem {
                Text(problem).font(.ui(24)).foregroundStyle(Color.ink2).multilineTextAlignment(.center).padding(40)
            }
            if around {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        BackButton(title: "", action: onClose)
                        Text(session.book.title).font(.ui(24)).foregroundStyle(Color.ink2).lineLimit(1).allowsHitTesting(false)
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
