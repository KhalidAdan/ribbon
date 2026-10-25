import SwiftUI

/// The person's bookmarked passages, from every book, drifting by one at a
/// time while a book has been paused a while: each set large in the reader's
/// face over its book's title, slowly rising as it fades in and out, and
/// each in another part of the screen from the last, so nothing stays long
/// enough to mark it. Any press brings back the screen beneath (Remote).
struct PassagesView: View {
    let passages: [Passage]
    @State private var shown = 0

    /// How long each passage stays.
    fileprivate static let each: TimeInterval = 16

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            PassageView(passage: passages[shown % passages.count], place: shown % 4)
                .id(shown)
                .transition(.opacity)
        }
        .allowsHitTesting(false)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.each))
                withAnimation(.easeInOut(duration: 2.4)) { shown += 1 }
            }
        }
    }
}

private struct PassageView: View {
    let passage: Passage
    /// Which of four parts of the screen it sits in.
    let place: Int
    @State private var risen = false

    var body: some View {
        let words = (passage.quote ?? "").replacingOccurrences(of: "\n\n", with: " ")
        // Words that open with a quotation mark, someone speaking, are quoted already.
        let quoted = words.first.map { "\u{201C}\"\u{2018}'".contains($0) } == true ? words : "\u{201C}\(words)\u{201D}"
        // Short passages larger, long ones smaller, so each fills about the same room.
        let size: CGFloat = words.count <= 140 ? 64 : words.count <= 320 ? 52 : 44
        VStack(alignment: .leading, spacing: 32.scaled) {
            Text(quoted)
                .font(.book(size)).foregroundStyle(Color.ink)
                .lineSpacing((size * 0.28).scaled).lineLimit(10).minimumScaleFactor(0.7)
            Text(passage.book.author.isEmpty ? passage.book.title : "\(passage.book.title), \(passage.book.author)")
                .font(.ui(24)).foregroundStyle(Color.ink3).lineLimit(1)
        }
        .frame(maxWidth: 1080.scaled, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: place.isMultiple(of: 2) ? .leading : .trailing)
        .offset(y: ([-90, 70, 100, -60][place] + (risen ? -36 : 36)).scaled)
        .padding(.horizontal, 160.scaled)
        .padding(.vertical, 140.scaled)
        .onAppear {
            withAnimation(.linear(duration: PassagesView.each + 2.4)) { risen = true }
        }
    }
}
