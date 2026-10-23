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
                HStack(alignment: .firstTextBaseline) {
                    Text(session.chapter ?? "").font(.ui(24)).foregroundStyle(Color.ink3).lineLimit(1)
                    Spacer()
                    Text(status).font(.ui(24)).foregroundStyle(Color.ink3).monospacedDigit()
                }
                ProgressHairline(fraction: Double(session.listening.positionMs) / Double(max(1, session.listening.durationMs)))
            }
            // At the screen's edges, in the room the column's fade leaves them.
            .padding(.horizontal, 120)
            .padding(.vertical, 56)
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }

    /// "2h 41m left", or "Paused · 2h 41m left", at the narrator's speed.
    private var status: String {
        let listening = session.listening
        let time = "\(Format.left(Format.atSpeed(listening.durationMs - listening.positionMs, listening.speed))) left"
        return listening.playing ? time : "Paused · \(time)"
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
