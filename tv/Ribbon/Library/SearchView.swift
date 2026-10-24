import SwiftUI

/// Find a line you remember, in any book, by saying it: the field has the
/// focus when the screen opens, so holding the remote's microphone button
/// dictates straight into it (typing works too). The server searches every
/// book's sentences (server/src/library/search.ts) and the best matches come
/// back as the book's own words, the ones that matched lit. Choosing one opens
/// Read along on that sentence, the narrator where it was: left listens from
/// it, right goes back.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var words = ""
    @State private var results: [SearchResult] = []
    /// What the results are for, so they don't say "nothing found" for words still being typed.
    @State private var searched = ""
    @State private var problem: String?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ZStack(alignment: .top) {
            Color.canvas.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 40) {
                SectionHeader(title: "Find a line", description: "Hold the remote's microphone button and say what you remember. Ribbon finds the sentence, in any of your books.")
                TextField("Say or type the words you remember", text: $words)
                    .font(.ui(30))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($fieldFocused)
                    .frame(maxWidth: 1100)
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        if let problem {
                            Text(problem).font(.ui(24)).foregroundStyle(Color.ink2)
                        } else if !searched.isEmpty && results.isEmpty {
                            Text("Nothing in your books matches “\(searched)”.").font(.ui(24)).foregroundStyle(Color.ink2)
                        }
                        ForEach(results, id: \.self) { result in
                            if let book = model.library?.books.first(where: { $0.id == result.book }) {
                                ResultRow(result: result, book: book)
                            }
                        }
                    }
                    .padding(24)
                }
                .padding(-24)
                .scrollClipDisabled()
            }
            .padding(.horizontal, 96)
            .padding(.vertical, 72)
        }
        .defaultFocus($fieldFocused, true)
        // Searched a moment after the words stop changing, so dictation and typing ask once, not at every letter.
        .task(id: words) {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await search()
        }
    }

    private func search() async {
        let asked = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !asked.isEmpty, let server = model.server else {
            results = []
            searched = ""
            return
        }
        do {
            results = try await server.search(asked)
            searched = asked
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// A sentence found: its words in the book's face, the matched ones lit, and where it is.
private struct ResultRow: View {
    @Environment(AppModel.self) private var model
    let result: SearchResult
    let book: ServerBook

    var body: some View {
        Button { Task { await model.readAlong(book, at: result.sentence) } } label: {
            HStack(alignment: .top, spacing: 24) {
                CoverView(book: book, size: 72)
                VStack(alignment: .leading, spacing: 10) {
                    Text(words).lineLimit(3).multilineTextAlignment(.leading)
                    Text(model.opening == book.id ? "Opening…" : place)
                        .font(.ui(20)).foregroundStyle(Color.ink3).monospacedDigit().lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 16)
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(LiftStyle.row(radius: 12))
    }

    /// The sentence, in Newsreader, the words that matched in full ink and the rest a step back.
    private var words: AttributedString {
        let text = result.text
        let utf16 = text.utf16
        var out = AttributedString()
        var at = 0
        func piece(_ from: Int, _ to: Int, matched: Bool) {
            guard to > from, let start = utf16.index(utf16.startIndex, offsetBy: from, limitedBy: utf16.endIndex),
                  let end = utf16.index(utf16.startIndex, offsetBy: to, limitedBy: utf16.endIndex) else { return }
            var part = AttributedString(String(text[start..<end]))
            part.font = .book(28, weight: matched ? 600 : 400)
            part.foregroundColor = matched ? .ink : .ink2
            out += part
        }
        for match in result.matches where match.count == 2 && match[0] >= at {
            piece(at, match[0], matched: false)
            piece(match[0], match[0] + match[1], matched: true)
            at = match[0] + match[1]
        }
        piece(at, utf16.count, matched: false)
        return out
    }

    /// "The Wonderful Wizard of Oz · Chapter XVI The Magic Art of the Great Humbug · 3:12:40".
    private var place: String {
        [book.title, result.chapter, Format.duration(result.ms)].compactMap { $0 }.joined(separator: " · ")
    }
}
