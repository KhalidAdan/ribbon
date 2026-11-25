#if os(tvOS)
import SwiftUI

/// The comic reader on the Apple TV (docs/COMICS.md, section 7), where the remote does all of it:
///
/// - **Left and right turn the page**; in a comic that reads right to left, they swap.
/// - **A page is shown whole** to start with, as tall as the screen. **Select** brings it to the screen's width,
///   which is when its words can be read from across a room, and then **up and down** move along it; down past
///   its foot goes on to the next page, and up past its head goes back to the one before. Select again shows it
///   whole.
/// - **Menu** leaves the comic, with the page kept.
///
/// A whole page leaves the screen's sides empty, and the comic's title and the page's number sit there. Brought
/// to the screen's width a page has the screen to itself.
struct ComicView: View {
    let session: ComicSession
    let onClose: () -> Void
    /// Whether the page is shown whole, or as wide as the screen.
    @State private var fit = ComicPaging.Fit.whole
    /// How far down a page as wide as the screen has been moved, in points.
    @State private var down: CGFloat = 0
    /// Where a page comes in after a turn back by Up: at its foot, since that is where the reader left off.
    @State private var arrivesAtFoot = false
    @FocusState private var focused: Bool

    var body: some View {
        GeometryReader { space in
            ZStack {
                Color.canvas
                if let picture = session.pictures[session.page] {
                    page(picture, in: space.size)
                        .accessibilityLabel("Page \(session.page + 1) of \(session.count)")
                } else if let problem = session.problem {
                    Text(problem).font(.ui(24)).foregroundStyle(Color.ink2).multilineTextAlignment(.center).padding(120)
                }
                if fit == .whole { around.transition(.opacity) }
            }
            // The whole screen is the one thing to press: the remote's presses come here, and nothing is drawn for the focus.
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onMoveCommand { direction in moved(direction, on: space.size) }
            .onTapGesture { select() }
            .onExitCommand(perform: onClose)
            .onChange(of: session.page) { _, _ in arrived(on: space.size) }
            .onChange(of: session.pictures[session.page]?.size) { _, _ in settle(on: space.size) }
        }
        .ignoresSafeArea()
        .onAppear {
            focused = true
            Reading.stay()
        }
        .onDisappear { Reading.leave() }
    }

    /// The page: whole, in the middle of the screen; or as wide as the screen, moved up by how far down it has been read.
    @ViewBuilder
    private func page(_ picture: UIImage, in screen: CGSize) -> some View {
        switch fit {
        case .whole:
            Image(uiImage: picture).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                .frame(width: screen.width, height: screen.height)
        case .wide:
            let height = ComicPaging.height(of: picture.size, atWidth: screen.width)
            Image(uiImage: picture).resizable().interpolation(.high)
                .frame(width: screen.width, height: height)
                // Hung from the screen's top, so `down` is how much of the page is above it.
                .frame(width: screen.width, height: screen.height, alignment: .top)
                .offset(y: -down)
                .animation(.easeOut(duration: 0.22), value: down)
        }
    }

    /// The comic's title at the top and the page's number at the foot, over a hairline of how far through it is:
    /// in the room the TV keeps clear at its edges, beside a whole page rather than over it.
    private var around: some View {
        VStack(alignment: .leading) {
            Text(session.book.title).font(.ui(24)).foregroundStyle(Color.ink3).lineLimit(1)
                .frame(maxWidth: 420, alignment: .leading)
            Spacer()
            Text("Page \(session.page + 1) of \(session.count)").font(.ui(24)).foregroundStyle(Color.ink3).monospacedDigit()
                .padding(.bottom, 10)
            // As wide as the room beside the page, and no wider: across the screen it would be drawn over the page.
            ComicHairline(fraction: session.fraction).frame(width: 420)
        }
        // At the screen's left edge, whatever the widest of them is.
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 120)
        .padding(.vertical, 56)
        .allowsHitTesting(false)
    }

    // What the remote does ---------------------------------------------------

    private func moved(_ direction: MoveCommandDirection, on screen: CGSize) {
        Reading.stay()
        switch direction {
        case .left: turn(ComicPaging.turn(by: -1, rightToLeft: session.rightToLeft))
        case .right: turn(ComicPaging.turn(by: 1, rightToLeft: session.rightToLeft))
        case .up, .down:
            // A whole page has nowhere to move to: up and down are for a page as wide as the screen.
            guard fit == .wide, let picture = session.pictures[session.page] else { return }
            let height = ComicPaging.height(of: picture.size, atWidth: screen.width)
            if let to = ComicPaging.move(from: down, by: direction == .down ? 1 : -1, page: height, screen: screen.height) {
                down = to
            } else if direction == .down {
                turn(1)
            } else if session.hasPrevious {
                arrivesAtFoot = true
                turn(-1)
            }
        @unknown default: break
        }
    }

    /// Forward a page or back one, as the comic counts them.
    private func turn(_ by: Int) {
        if by > 0 { session.next() } else if by < 0 { session.previous() }
    }

    /// Select: the page as wide as the screen, from its head; or whole again.
    private func select() {
        Reading.stay()
        withAnimation(.easeOut(duration: 0.2)) {
            fit = fit == .whole ? .wide : .whole
            down = 0
        }
    }

    /// Another page: read from its head, or from its foot when Up brought the reader back to it.
    private func arrived(on screen: CGSize) {
        var move = Transaction()
        move.disablesAnimations = true
        withTransaction(move) { down = 0 }
        settle(on: screen)
    }

    /// Once the page's picture is here, and so its height is known: at its foot, if that is where it comes in.
    private func settle(on screen: CGSize) {
        guard arrivesAtFoot, fit == .wide, let picture = session.pictures[session.page] else { return }
        arrivesAtFoot = false
        var move = Transaction()
        move.disablesAnimations = true
        withTransaction(move) { down = ComicPaging.foot(page: ComicPaging.height(of: picture.size, atWidth: screen.width), screen: screen.height) }
    }

    /// The screen kept on while a comic is being read, and for a while after the last press: a page can take
    /// minutes, and the TV's screen saver would come up over it. Left alone long enough, the TV sleeps as it does.
    @MainActor
    private enum Reading {
        private static var letGo: Task<Void, Never>?
        private static let stayFor: Duration = .seconds(20 * 60)

        static func stay() {
            KeepAwake.set("comic", true)
            letGo?.cancel()
            letGo = Task {
                try? await Task.sleep(for: stayFor)
                guard !Task.isCancelled else { return }
                KeepAwake.set("comic", false)
            }
        }

        static func leave() {
            letGo?.cancel()
            KeepAwake.set("comic", false)
        }
    }
}

/// How far through the comic, as the reader's own hairline shows it.
private struct ComicHairline: View {
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
#endif
