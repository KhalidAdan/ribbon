import SwiftUI

/// What the narration brings up on its own, over whichever screen is in
/// front: a chapter's card as the narration crosses into it, and Still
/// listening? after forty minutes with nothing pressed.

/// A chapter's card, the way a Kurosawa film puts up its intertitles: the
/// screen given over to the chapter's number and its title, set large in
/// the book's face, while the narration waits a moment, then wiped away as
/// it goes on.
struct ChapterCard: View {
    let listening: Listening
    let index: Int

    var body: some View {
        let heading = Self.heading(of: listening.chapters.indices.contains(index) ? listening.chapters[index].title : "")
        ZStack {
            Color.canvas
            VStack(spacing: 36) {
                if let kicker = heading.kicker ?? (heading.title == nil ? "Chapter \(index + 1)" : nil) {
                    Text(kicker.uppercased()).font(.ui(26, weight: 500)).tracking(6).foregroundStyle(Color.ink3)
                }
                if let title = heading.title {
                    Text(title)
                        .font(.book(92)).foregroundStyle(Color.ink)
                        .multilineTextAlignment(.center).lineLimit(3).lineSpacing(8)
                        .frame(maxWidth: 1400)
                }
            }
            .padding(120)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// A chapter's title as its card sets it: the number it starts with apart ("01 - The Cyclone", "Chapter IV
    /// The Road"), as "Chapter 1", and the rest. A title that's only a number is only the kicker; one with no
    /// number ("Prologue") is only the title.
    static func heading(of title: String) -> (kicker: String?, title: String?) {
        let numbered = #/^\s*(?:(?<word>chapter|ch\.?|part|book)\s+(?<named>\d+|[ivxlcdm]+)\b|(?<bare>\d+)(?=\s*[\-–—:.)]|\s*$))[\s\-–—:.)]*/#.ignoresCase()
        guard let match = title.prefixMatch(of: numbered) else {
            return (nil, title.isEmpty ? nil : title)
        }
        let number = match.named.map { Int($0).map(String.init) ?? $0.uppercased() } ?? match.bare.flatMap { Int($0) }.map(String.init) ?? ""
        let word = match.word.map { $0.lowercased().hasPrefix("ch") ? "Chapter" : $0.capitalized } ?? "Chapter"
        let rest = title[match.range.upperBound...].trimmingCharacters(in: .whitespaces)
        return ("\(word) \(number)", rest.isEmpty ? nil : rest)
    }
}

extension AnyTransition {
    /// Kurosawa's wipe: a hard edge crosses the screen from left to right, bringing the card in, and again, taking
    /// it away.
    static let wipe = AnyTransition.asymmetric(
        insertion: .modifier(active: Wiped(shown: 0, edge: .leading), identity: Wiped(shown: 1, edge: .leading)),
        removal: .modifier(active: Wiped(shown: 0, edge: .trailing), identity: Wiped(shown: 1, edge: .trailing))
    )
}

/// How much of a view shows through the wipe, 0 to 1, from one edge.
private struct Wiped: ViewModifier {
    let shown: CGFloat
    let edge: HorizontalEdge

    func body(content: Content) -> some View {
        content.mask {
            GeometryReader { space in
                Rectangle()
                    .frame(width: space.size.width * shown)
                    .frame(maxWidth: .infinity, alignment: edge == .leading ? .leading : .trailing)
            }
            .ignoresSafeArea()
        }
    }
}

/// Asked after forty minutes of narration with nothing pressed: any press
/// answers, and goes no further (Remote). Unanswered, the narration stops at
/// the end of the sentence a minute later (Dozing).
struct StillListening: View {
    var body: some View {
        HStack(spacing: 22) {
            Image(systemName: "moon.fill").font(.system(size: 30)).foregroundStyle(Color.place)
            VStack(alignment: .leading, spacing: 6) {
                Text("Still listening?").font(.ui(30, weight: 600)).foregroundStyle(Color.ink)
                Text("Press anything to keep going. If not, the book stops in a minute, and Ribbon keeps where you dozed off.")
                    .font(.ui(22)).foregroundStyle(Color.ink2)
            }
        }
        .frame(maxWidth: 1000, alignment: .leading)
        .padding(.horizontal, 36)
        .padding(.vertical, 26)
        .background(RoundedRectangle(cornerRadius: 20).fill(Color.raised))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.line))
        .shadow(color: .black.opacity(0.5), radius: 30, y: 14)
        .allowsHitTesting(false)
    }
}
