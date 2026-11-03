import SwiftUI

/// Find a book, or a line you remember in any book, by saying it: the field
/// has the focus when the screen opens, so holding the remote's microphone
/// button dictates straight into it (typing works too). On the iPad, the
/// keyboard is up when the screen opens, with its own microphone.
///
/// The server answers both. The books whose title, author, narrator or series
/// have every word come first, as the desktop's search finds them
/// (packages/core/src/search.ts); choosing one opens its page. Then the
/// sentences that best match, in every book's text
/// (packages/server/src/library/search.ts), as the book's own words with the
/// ones that matched lit; choosing one opens Read along on that sentence, the
/// narrator where it was: left listens from it, right goes back.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var words = ""
    @State private var books: [ServerBook] = []
    @State private var results: [SearchResult] = []
    /// What the results are for, so they don't say "nothing found" for words still being typed.
    @State private var searched = ""
    @State private var problem: String?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ZStack(alignment: .top) {
            Color.canvas.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 40.scaled) {
                SectionHeader(title: "Search", description: Self.howTo)
                TextField("Say or type a title, an author, or words you remember", text: $words)
                    .font(.ui(30))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($fieldFocused)
                    .ribbonField()
                    .frame(maxWidth: 1100.scaled)
                ScrollView {
                    VStack(alignment: .leading, spacing: 6.scaled) {
                        if let problem {
                            Text(problem).font(.ui(24)).foregroundStyle(Color.ink2)
                        } else if !searched.isEmpty && results.isEmpty && books.isEmpty {
                            Text("Nothing in your books matches “\(searched)”.").font(.ui(24)).foregroundStyle(Color.ink2)
                        }
                        if !books.isEmpty {
                            Label(words: "Books")
                            ForEach(books) { book in BookRow(book: book) }
                        }
                        if !books.isEmpty && !results.isEmpty {
                            Label(words: "Lines").padding(.top, 24.scaled)
                        }
                        ForEach(results, id: \.self) { result in
                            if let book = model.library?.books.first(where: { $0.id == result.book }) {
                                ResultRow(result: result, book: book)
                            }
                        }
                    }
                    .padding(24.scaled)
                }
                .padding(-24.scaled)
                .scrollClipDisabled()
            }
            .screenEdges(horizontal: 96, vertical: 72)
        }
        .defaultFocus($fieldFocused, true)
        #if os(iOS)
        .onAppear { fieldFocused = true }
        #endif
        // Searched a moment after the words stop changing, so dictation and typing ask once, not at every letter.
        .task(id: words) {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await search()
        }
    }

    #if os(tvOS)
    private static let howTo = "Hold the remote's microphone button and say a book's title or author, or a line you remember. Ribbon finds the book, or the sentence in any of your books."
    #else
    private static let howTo = "Type a book's title or author, or a line you remember, or say it with the keyboard's microphone. Ribbon finds the book, or the sentence in any of your books."
    #endif

    private func search() async {
        let asked = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !asked.isEmpty, let server = model.server else {
            books = []
            results = []
            searched = ""
            return
        }
        do {
            let found = try await server.search(asked)
            // The library's own books, in the server's order: the ones there are to listen to.
            let shelf = Dictionary(model.library?.books.map { ($0.id, $0) } ?? [], uniquingKeysWith: { first, _ in first })
            books = found.books.compactMap { shelf[$0] }
            results = found.lines
            searched = asked
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// What a group of what was found is: "Books", "Lines".
private struct Label: View {
    let words: String

    var body: some View {
        Text(words).font(.ui(22, weight: 500)).foregroundStyle(Color.ink3).padding(.horizontal, 20.scaled).padding(.bottom, 4.scaled)
    }
}

/// A book found: its cover, its title in the book's face, who wrote and reads it, and how far through it you are.
private struct BookRow: View {
    @Environment(AppModel.self) private var model
    let book: ServerBook

    var body: some View {
        Button { model.open(book) } label: {
            HStack(alignment: .center, spacing: 24.scaled) {
                CoverView(book: book, size: 72)
                VStack(alignment: .leading, spacing: 6.scaled) {
                    Text(book.title).font(.book(28, weight: 500)).foregroundStyle(Color.ink).lineLimit(2).multilineTextAlignment(.leading)
                    Text(byline).font(.ui(20)).foregroundStyle(Color.ink3).lineLimit(1)
                }
                Spacer(minLength: 24.scaled)
                Text(model.library?.standing(of: book) ?? "").font(.ui(20)).foregroundStyle(Color.ink2).monospacedDigit().lineLimit(1)
            }
            .padding(.vertical, 16.scaled)
            .padding(.horizontal, 20.scaled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(LiftStyle.row(radius: 12))
    }

    private var byline: String {
        let author = book.author.isEmpty ? "Author unknown" : book.author
        return book.narrator.isEmpty ? author : "\(author), read by \(book.narrator)"
    }
}

/// A sentence found: its words in the book's face, the matched ones lit, and where it is.
private struct ResultRow: View {
    @Environment(AppModel.self) private var model
    let result: SearchResult
    let book: ServerBook

    var body: some View {
        Button { Task { await model.readAlong(book, at: result.sentence) } } label: {
            HStack(alignment: .top, spacing: 24.scaled) {
                CoverView(book: book, size: 72)
                VStack(alignment: .leading, spacing: 10.scaled) {
                    Text(words).lineLimit(3).multilineTextAlignment(.leading)
                    Text(model.opening == book.id ? "Opening…" : place)
                        .font(.ui(20)).foregroundStyle(Color.ink3).monospacedDigit().lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 16.scaled)
            .padding(.horizontal, 20.scaled)
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

    /// "The Wonderful Wizard of Oz · Chapter XVI The Magic Art of the Great Humbug · 3:12:40"; no time in a book that is
    /// only its text.
    private var place: String {
        [book.title, result.chapter, book.audio ? Format.duration(result.ms) : nil].compactMap { $0 }.joined(separator: " · ")
    }
}
