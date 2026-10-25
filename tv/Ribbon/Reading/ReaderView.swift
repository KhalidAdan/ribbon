import SwiftUI

/// A book open to read along: the column of its text, its title quietly at
/// the top, and at the bottom the chapter, the time left and a hairline of
/// amber for how far through it is (docs/DESIGN.md: amber is your place).
/// The iPad, with no remote, has the way back beside the title, and what the
/// remote does as buttons over the chapter: Listen from here, play and pause,
/// Return to narrator, and keeping or leaving a bookmark.
struct ReaderView: View {
    let session: ReadingSession
    let layout: BookLayout
    let onClose: () -> Void

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            ReaderColumn(session: session, layout: layout, onClose: onClose).ignoresSafeArea()
            #if os(tvOS)
            VStack(alignment: .leading) {
                Text(session.book.title).font(.ui(24)).foregroundStyle(Color.ink3)
                Spacer()
                // A bookmark's banner takes the chapter's place for a moment, below the words rather than over them.
                ZStack(alignment: .bottom) {
                    StatusLine(session: session)
                        .opacity(banner == nil ? 1 : 0)
                    if let banner {
                        BannerView(symbol: banner.symbol, title: banner.title, hint: banner.hint)
                            .frame(maxWidth: .infinity)
                            .offset(y: 12)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                }
                ProgressHairline(fraction: Double(session.listening.positionMs) / Double(max(1, session.listening.durationMs)))
            }
            // At the screen's edges, in the room the column's fade leaves them.
            .padding(.horizontal, 120)
            .padding(.vertical, 56)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .animation(.easeOut(duration: 0.2), value: banner?.title)
            #else
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    BackButton(title: "", action: onClose)
                    Text(session.book.title).font(.ui(24)).foregroundStyle(Color.ink3).lineLimit(1).allowsHitTesting(false)
                }
                .padding(.leading, -12)
                Spacer()
                // Over the words, above the buttons, for a moment.
                if let banner {
                    BannerView(symbol: banner.symbol, title: banner.title, hint: banner.hint)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 20)
                        .allowsHitTesting(false)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                ReaderButtons(session: session)
                StatusLine(session: session)
                    .padding(.top, 20)
                    .padding(.bottom, 10)
                    .allowsHitTesting(false)
                ProgressHairline(fraction: Double(session.listening.positionMs) / Double(max(1, session.listening.durationMs)))
                    .allowsHitTesting(false)
            }
            .padding(.horizontal, 32)
            .padding(.top, 4)
            .padding(.bottom, 12)
            .animation(.easeOut(duration: 0.2), value: banner?.title)
            #endif
        }
        #if os(iOS)
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        #endif
    }

    /// What's happening to a bookmark, and what the remote does about it; or that the remote is where the person dozed
    /// off; or, as the book opens, that its read-along is by chapter.
    private var banner: (symbol: String, title: String, hint: String?)? {
        if let range = session.markingRange {
            return ("bookmark.fill", range.count == 1 ? "Bookmarking this sentence" : "Bookmarking \(range.count) sentences", Hints.marking)
        }
        if session.deleting != nil {
            return ("bookmark.fill", "Delete this bookmark?", Hints.deleting)
        }
        if let notice = session.notice { return ("bookmark.fill", notice, nil) }
        if session.atDozed { return ("moon.fill", "Where you dozed off", Hints.dozed) }
        if let caveat = session.caveat { return ("waveform", caveat.title, caveat.hint) }
        return nil
    }

    /// What the banner says to do, with the remote, or on the iPad with the finger and the buttons under it.
    private enum Hints {
        #if os(tvOS)
        static let marking = "Up and down take in more  ·  Select keeps it  ·  Menu cancels"
        static let deleting = "Select deletes it  ·  Menu keeps it"
        static let dozed = "Left listens from here  ·  Right goes on from where it stopped"
        #else
        static let marking = "Tap or scroll to take in more"
        static let deleting = "It's on every device, and goes from all of them"
        static let dozed = "Listen from here, or return to the narrator where it stopped"
        #endif
    }
}

/// The chapter you're in, and how long is left.
private struct StatusLine: View {
    let session: ReadingSession

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(session.chapter ?? "").font(.ui(24)).foregroundStyle(Color.ink3).lineLimit(1)
            Spacer()
            Text(status).font(.ui(24)).foregroundStyle(Color.ink3).monospacedDigit()
        }
    }

    /// "2h 41m left", or "Paused · 2h 41m left", at the narrator's speed.
    private var status: String {
        let listening = session.listening
        let time = "\(Format.left(Format.atSpeed(listening.durationMs - listening.positionMs, listening.speed))) left"
        return listening.playing ? time : "Paused · \(time)"
    }
}

/// What the remote's buttons do, under the iPad's column: Listen from here and Return to narrator either side of
/// play, as they sit either side of your sentence on the TV, when you're away from the narrator; following it, the
/// left one listens from the start of the sentence being read, and again a sentence further back. While a
/// bookmark is made or offered for deleting, its own two buttons instead.
private struct ReaderButtons: View {
    let session: ReadingSession

    var body: some View {
        HStack(spacing: 20) {
            if session.marking != nil {
                Spacer()
                Button("Cancel") { _ = session.back() }.buttonStyle(RibbonButtonStyle())
                Button { session.keepBookmark() } label: { Label("Keep bookmark", systemImage: "bookmark.fill") }
                    .buttonStyle(RibbonButtonStyle(kind: .primary))
                Spacer()
            } else if session.deleting != nil {
                Spacer()
                Button("Keep it") { _ = session.back() }.buttonStyle(RibbonButtonStyle())
                Button(role: .destructive) { session.deleteBookmark() } label: { Label("Delete bookmark", systemImage: "trash") }
                    .buttonStyle(RibbonButtonStyle(kind: .primary))
                Spacer()
            } else {
                let away = !session.following
                HStack {
                    Spacer(minLength: 0)
                    if away {
                        Button { session.left() } label: { Label("Listen from here", systemImage: "chevron.left") }
                            .buttonStyle(RibbonButtonStyle())
                    } else if session.readAlong.readsAlong {
                        Button { session.left() } label: { Image(systemName: "gobackward") }
                            .buttonStyle(RoundButtonStyle(size: 80))
                            .accessibilityLabel("Again, from the start of this sentence")
                    }
                }
                .frame(maxWidth: .infinity)
                Button { session.playPause() } label: { Image(systemName: session.listening.playing ? "pause.fill" : "play.fill") }
                    .buttonStyle(RoundButtonStyle(size: 104, primary: true))
                    .accessibilityLabel(session.listening.playing ? "Pause" : "Play")
                HStack {
                    if away {
                        Button { session.returnToNarrator() } label: {
                            HStack(spacing: 8) {
                                Text("Return to narrator")
                                Image(systemName: "chevron.right")
                            }
                        }
                        .buttonStyle(RibbonButtonStyle())
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .animation(.easeOut(duration: 0.15), value: session.following)
    }
}

/// A line over the reader: what's happening, and what the remote does about it.
private struct BannerView: View {
    let symbol: String
    let title: String
    let hint: String?

    var body: some View {
        VStack(spacing: 6.scaled) {
            HStack(spacing: 12.scaled) {
                Image(systemName: symbol).font(.system(size: 22.scaled)).foregroundStyle(Color.place)
                Text(title).font(.ui(26, weight: 500)).foregroundStyle(Color.ink)
            }
            if let hint { Text(hint).font(.ui(22)).foregroundStyle(Color.ink2) }
        }
        .padding(.horizontal, 32.scaled)
        .padding(.vertical, 18.scaled)
        .background(RoundedRectangle(cornerRadius: 16.scaled).fill(Color.raised))
        .overlay(RoundedRectangle(cornerRadius: 16.scaled).stroke(Color.line))
        .shadow(color: .black.opacity(0.5), radius: 24.scaled, y: 12.scaled)
    }
}

/// How far through the book: the played part of a line, in amber.
private struct ProgressHairline: View {
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

/// The column, which is UIKit's: TextKit sets the type, and the remote's presses come to it.
private struct ReaderColumn: UIViewControllerRepresentable {
    let session: ReadingSession
    let layout: BookLayout
    let onClose: () -> Void

    func makeUIViewController(context: Context) -> ReaderViewController {
        ReaderViewController(session: session, layout: layout, onClose: onClose)
    }

    func updateUIViewController(_ controller: ReaderViewController, context: Context) {}
}
