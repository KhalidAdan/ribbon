import SwiftUI

/// A book open to read along: the column of its text, its title quietly at
/// the top, and at the bottom the chapter, the time left and a hairline of
/// amber for how far through it is (docs/DESIGN.md: amber is your place).
struct ReaderView: View {
    let session: ReadingSession
    let layout: BookLayout
    let onClose: () -> Void

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            ReaderColumn(session: session, layout: layout, onClose: onClose).ignoresSafeArea()
            VStack(alignment: .leading) {
                Text(session.book.title).font(.ui(24)).foregroundStyle(Color.ink3)
                Spacer()
                // A bookmark's banner takes the chapter's place for a moment, below the words rather than over them.
                ZStack(alignment: .bottom) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(session.chapter ?? "").font(.ui(24)).foregroundStyle(Color.ink3).lineLimit(1)
                        Spacer()
                        Text(status).font(.ui(24)).foregroundStyle(Color.ink3).monospacedDigit()
                    }
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
        }
    }

    /// What's happening to a bookmark, and what the remote does about it; or that the remote is where the person dozed off.
    private var banner: (symbol: String, title: String, hint: String?)? {
        if let range = session.markingRange {
            return ("bookmark.fill", range.count == 1 ? "Bookmarking this sentence" : "Bookmarking \(range.count) sentences", "Up and down take in more  ·  Select keeps it  ·  Menu cancels")
        }
        if session.deleting != nil {
            return ("bookmark.fill", "Delete this bookmark?", "Select deletes it  ·  Menu keeps it")
        }
        if let notice = session.notice { return ("bookmark.fill", notice, nil) }
        if session.atDozed { return ("moon.fill", "Where you dozed off", "Left listens from here  ·  Right goes on from where it stopped") }
        return nil
    }

    /// "2h 41m left", or "Paused · 2h 41m left", at the narrator's speed.
    private var status: String {
        let listening = session.listening
        let time = "\(Format.left(Format.atSpeed(listening.durationMs - listening.positionMs, listening.speed))) left"
        return listening.playing ? time : "Paused · \(time)"
    }
}

/// A line over the reader about a bookmark: what's happening, and what the remote does about it.
private struct BannerView: View {
    let symbol: String
    let title: String
    let hint: String?

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.system(size: 22)).foregroundStyle(Color.place)
                Text(title).font(.ui(26, weight: 500)).foregroundStyle(Color.ink)
            }
            if let hint { Text(hint).font(.ui(22)).foregroundStyle(Color.ink2) }
        }
        .padding(.horizontal, 32)
        .padding(.vertical, 18)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.raised))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.line))
        .shadow(color: .black.opacity(0.5), radius: 24, y: 12)
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
