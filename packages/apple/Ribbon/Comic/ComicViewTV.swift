#if os(tvOS)
import SwiftUI

/// The comic reader on the Apple TV (docs/COMICS.md, sections 7 and 14), where the remote does all of it.
///
/// A page is shown **whole**, as tall as the screen, or **close**, which is how it is read from across a room.
/// **Select** goes from one to the other. What close is depends on the page:
///
/// - **A page whose panels are marked** is read a panel at a time: one panel fills the screen and the rest of the
///   page is out of sight. Right and Down go on to the next panel, Left and Up back to the one before (in a comic
///   that reads right to left, Left goes on and Right goes back). Past a page's last panel is the next page's first.
/// - **A page with no panels** is brought to the screen's width, and Up and Down move along it; Down past its foot
///   goes on to the next page, and Up past its head back to the one before. Left and Right turn the page.
///
/// A comic with panels opens close, since that is what marking them was for. **Menu** leaves, with the page kept.
///
/// A whole page leaves the screen's sides empty, and the comic's title and the page's number sit there.
struct ComicView: View {
    let session: ComicSession
    let onClose: () -> Void
    /// Whether the page is shown close: a panel at a time, or as wide as the screen where it has no panels.
    @State private var close = false
    /// The panel being read, among the page's, counted from 0.
    @State private var panel = 0
    /// How far down a page as wide as the screen has been moved, in points.
    @State private var down: CGFloat = 0
    /// A page come back to from the one after it comes in at its end, since that is where the reader left off: its last panel, or its foot.
    @State private var arrivesAtEnd = false
    @FocusState private var focused: Bool

    /// The panels of the page being read; none when nobody has marked them.
    private var panels: [ComicPanel] { session.panels[session.page] ?? [] }

    var body: some View {
        GeometryReader { space in
            ZStack {
                Color.canvas
                if let picture = session.pictures[session.page] {
                    page(picture, in: space.size)
                        .accessibilityLabel(close && !panels.isEmpty ? "Page \(session.page + 1) of \(session.count), panel \(panel + 1) of \(panels.count)" : "Page \(session.page + 1) of \(session.count)")
                } else if let problem = session.problem {
                    Text(problem).font(.ui(24)).foregroundStyle(Color.ink2).multilineTextAlignment(.center).padding(120)
                }
                if !close { around.transition(.opacity) }
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
            close = !session.panels.isEmpty
            Reading.stay()
        }
        .onDisappear { Reading.leave() }
    }

    /// Where the page's picture goes now: whole, on one of its panels, or as wide as the screen.
    private func placing(of page: CGSize, on screen: CGSize) -> ComicPaging.Placing {
        guard close else { return ComicPaging.whole(page: page, screen: screen) }
        if panels.indices.contains(panel) { return ComicPaging.close(on: panels[panel], page: page, screen: screen) }
        return ComicPaging.wide(page: page, screen: screen, down: down)
    }

    /// The page, drawn once and moved: from whole to a panel, and panel to panel, it glides. Only the part of it in
    /// the window shows, which is all of it but when a panel is being read.
    private func page(_ picture: UIImage, in screen: CGSize) -> some View {
        let at = placing(of: picture.size, on: screen)
        return Image(uiImage: picture).resizable().interpolation(.high)
            .frame(width: picture.size.width * at.scale, height: picture.size.height * at.scale)
            .offset(at.offset)
            .frame(width: screen.width, height: screen.height)
            .mask { Rectangle().frame(width: at.window.width, height: at.window.height) }
            .animation(.easeInOut(duration: 0.3), value: at)
            // Another page is another picture: it is simply there, not flown in from where the last one was.
            .id(session.page)
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
        // Which way the press goes through the comic: Down is always on, and Right is unless the comic reads right to left.
        let onward: Int
        switch direction {
        case .down: onward = 1
        case .up: onward = -1
        case .right: onward = ComicPaging.turn(by: 1, rightToLeft: session.rightToLeft)
        case .left: onward = ComicPaging.turn(by: -1, rightToLeft: session.rightToLeft)
        @unknown default: return
        }
        let sideways = direction == .left || direction == .right

        // A panel at a time: every press is the next panel or the one before, and past the page's last is another page.
        if close, !panels.isEmpty {
            if let to = ComicPaging.step(from: panel, by: onward, of: panels.count) { panel = to } else { turn(onward) }
            return
        }
        // A whole page has nowhere to move to, and a page as wide as the screen moves up and down: sideways turns it.
        if sideways { return turn(onward, toItsEnd: false) }
        guard close, let picture = session.pictures[session.page] else { return }
        let height = ComicPaging.height(of: picture.size, atWidth: screen.width)
        if let to = ComicPaging.move(from: down, by: onward, page: height, screen: screen.height) { down = to } else { turn(onward) }
    }

    /// Forward a page or back one. Going back, the page comes in at its end, unless it was turned to, not read back into.
    private func turn(_ by: Int, toItsEnd: Bool = true) {
        if by > 0, session.hasNext {
            session.next()
        } else if by < 0, session.hasPrevious {
            arrivesAtEnd = toItsEnd
            session.previous()
        }
    }

    /// Select: the page close, from its first panel or its head; or whole again.
    private func select() {
        Reading.stay()
        withAnimation(.easeInOut(duration: 0.3)) {
            close.toggle()
            panel = 0
            down = 0
        }
    }

    /// Another page: read from its first panel or its head, or from its last panel or its foot when the reader came back into it.
    private func arrived(on screen: CGSize) {
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) {
            down = 0
            panel = arrivesAtEnd ? max(0, panels.count - 1) : 0
        }
        settle(on: screen)
    }

    /// Once the page's picture is here, and so its height is known: at its foot, if that is where it comes in. A page
    /// read by its panels needs no picture to know its last one.
    private func settle(on screen: CGSize) {
        guard arrivesAtEnd else { return }
        if !panels.isEmpty || !close {
            arrivesAtEnd = false
            return
        }
        guard let picture = session.pictures[session.page] else { return }
        arrivesAtEnd = false
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) { down = ComicPaging.foot(page: ComicPaging.height(of: picture.size, atWidth: screen.width), screen: screen.height) }
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
