import SwiftUI

/// One book's page, as the desktop's (src/ui/ReaderPage.tsx): the cover, the
/// title in the book's own serif, where you are as a sentence, listening and
/// reading along, the facts, the description, and the rest of its series as
/// a list. A faint wash of the cover's colour sits behind the top. The focus
/// starts on listening; Menu goes back to the library.
struct BookView: View {
    @Environment(AppModel.self) private var model
    let book: ServerBook
    @State private var detail: ServerBookDetail?
    @State private var moreAbout = false
    @FocusState private var focused: Focus?

    private enum Focus: Hashable {
        case listen, readAlong
    }

    var body: some View {
        let library = model.library
        let progress = library?.progress(of: book)
        let series = library?.series(of: book)
        ScrollView {
            VStack(alignment: .leading, spacing: 80) {
                HStack(alignment: .top, spacing: 72) {
                    CoverView(book: book, size: 440)
                    VStack(alignment: .leading, spacing: 0) {
                        if let series, let index = series.books.firstIndex(where: { $0.id == book.id }) {
                            Text("\(series.name) · Book \(Self.number(of: book, at: index)) of \(series.books.count)").font(.ui(24)).foregroundStyle(Color.ink2)
                        }
                        Text(book.title).font(.book(60, weight: 600)).foregroundStyle(Color.ink).lineLimit(3).padding(.top, 6)
                        Text("\(book.author.isEmpty ? "Author unknown" : book.author)\(book.narrator.isEmpty ? "" : ", read by \(book.narrator)")").font(.ui(26)).foregroundStyle(Color.ink2).padding(.top, 12)

                        Text(sentence(progress))
                            .font(.ui(26)).foregroundStyle(Color.ink).monospacedDigit()
                            .frame(maxWidth: 900, alignment: .leading)
                            .padding(.leading, 18)
                            .overlay(alignment: .leading) { Rectangle().fill(Color.lineStrong).frame(width: 2) }
                            .padding(.top, 36)
                        if progress?.started == true && progress?.finished != true {
                            ProgressLine(fraction: library?.fraction(of: book) ?? 0).frame(maxWidth: 480).padding(.top, 22)
                        }

                        HStack(spacing: 24) {
                            Button { Task { await model.listen(to: book) } } label: {
                                Label(listenLabel(progress), systemImage: "play.fill")
                            }
                            .buttonStyle(RibbonButtonStyle(kind: .primary))
                            .focused($focused, equals: .listen)
                            if book.ebook {
                                Button { Task { await model.readAlong(book) } } label: {
                                    Label(model.opening == book.id ? "Opening…" : "Read along", systemImage: "book.fill")
                                }
                                .buttonStyle(RibbonButtonStyle())
                                .focused($focused, equals: .readAlong)
                            }
                        }
                        .padding(.top, 36)
                        if let problem = model.problem {
                            Text(problem).font(.ui(24)).foregroundStyle(Color.ink2).padding(.top, 16)
                        }

                        Facts(items: facts)
                            .padding(.top, 48)

                        if let description = detail?.book.description, !description.isEmpty {
                            // Focusable, so the remote reaches it and can open the rest.
                            Button { withAnimation(.easeOut(duration: 0.2)) { moreAbout.toggle() } } label: {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(description).font(.ui(24)).foregroundStyle(Color.ink2).lineSpacing(8).lineLimit(moreAbout ? nil : 5).multilineTextAlignment(.leading)
                                    Text(moreAbout ? "Less" : "More").font(.ui(22, weight: 500)).foregroundStyle(Color.ink3)
                                }
                                .frame(maxWidth: 1000, alignment: .leading)
                                .padding(18)
                            }
                            .buttonStyle(LiftStyle(radius: 14))
                            .padding(.horizontal, -18)
                            .padding(.top, 30)
                        }
                    }
                }

                if let series {
                    SeriesList(series: series, current: book)
                }
            }
            .padding(.horizontal, 96)
            .padding(.vertical, 72)
        }
        .background(alignment: .top) {
            ZStack(alignment: .top) {
                Color.canvas
                RadialGradient(colors: [tone.opacity(0.16), .clear], center: UnitPoint(x: 0.2, y: 0), startRadius: 0, endRadius: 1100)
                    .frame(height: 760)
            }
            .ignoresSafeArea()
        }
        .defaultFocus($focused, .listen)
        .task(id: book.id) {
            detail = await model.library?.detail(of: book)
        }
    }

    /// The cover's own colour, for the wash behind the top.
    private var tone: Color {
        UIColor(hex: book.cover?.colour).map { Color(uiColor: $0) } ?? .clear
    }

    private func listenLabel(_ progress: BookProgress?) -> String {
        if progress?.finished == true { return "Listen again" }
        return progress?.started == true ? "Continue listening" : "Start listening"
    }

    /// Where you are in the book, as a sentence, as the desktop says it.
    private func sentence(_ progress: BookProgress?) -> String {
        let chapters = detail?.chapters ?? []
        guard let progress, progress.started else {
            return "Not started. \(Format.left(book.durationMs))\(chapters.count > 1 ? " in \(chapters.count) chapters" : "")."
        }
        if progress.finished { return "Finished. Listen again any time; your place starts over." }
        let percent = max(1, Int((model.library?.fraction(of: book) ?? 0) * 100))
        let index = chapters.lastIndex { $0.startMs <= progress.ms } ?? 0
        let where_ = chapters.count > 1 ? ", in chapter \(index + 1) of \(chapters.count)" : ""
        return "You are \(percent)% through\(where_). \(Format.left(book.durationMs - progress.ms)) left."
    }

    private var facts: [(term: String, value: String)] {
        var facts: [(String, String)] = [("Length", Format.left(book.durationMs))]
        if let detail, !detail.chapters.isEmpty { facts.append(("Chapters", String(detail.chapters.count))) }
        if let year = detail?.book.year { facts.append(("Year", String(year))) }
        if let publisher = detail?.book.publisher, !publisher.isEmpty { facts.append(("Publisher", publisher)) }
        if book.ebook { facts.append(("Ebook", "EPUB")) }
        return facts
    }

    /// A book's number in its series: its own when the files give one ("2", "2.5"), else its place in the list.
    static func number(of book: ServerBook, at index: Int) -> String {
        guard let n = book.seriesIndex else { return String(index + 1) }
        return n == n.rounded() ? String(Int(n)) : String(n)
    }
}

/// The facts under a hairline: four across, a small muted term over each value.
private struct Facts: View {
    let items: [(term: String, value: String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Rectangle().fill(Color.line).frame(height: 1)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 32, alignment: .leading), count: 4), alignment: .leading, spacing: 22) {
                ForEach(items, id: \.term) { fact in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(fact.term).font(.ui(22)).foregroundStyle(Color.ink3)
                        Text(fact.value).font(.ui(24, weight: 500)).foregroundStyle(Color.ink).monospacedDigit().lineLimit(1)
                    }
                }
            }
        }
        .frame(maxWidth: 1000)
    }
}

/// The book's series, every book in order: its number, cover, title, and how it stands; the book open marked in amber.
private struct SeriesList: View {
    @Environment(AppModel.self) private var model
    let series: Library.Series
    let current: ServerBook

    var body: some View {
        let library = model.library
        let finished = series.books.filter { library?.progress(of: $0)?.finished == true }.count
        let left = series.books.reduce(0) { sum, book in
            let p = library?.progress(of: book)
            return sum + (p?.finished == true ? 0 : book.durationMs - (p?.ms ?? 0))
        }
        let hours = Format.left(left).replacingOccurrences(of: #" \d+m$"#, with: "", options: .regularExpression)
        VStack(alignment: .leading, spacing: 24) {
            SectionHeader(title: series.name, description: "\(finished) of \(series.books.count) finished\(left > 0 ? ", \(hours) still to hear" : "").")
            VStack(spacing: 4) {
                ForEach(Array(series.books.enumerated()), id: \.element.id) { index, book in
                    let now = book.id == current.id
                    let progress = library?.progress(of: book)
                    Button { model.open(book) } label: {
                        HStack(spacing: 24) {
                            Text(BookView.number(of: book, at: index)).font(.ui(22)).foregroundStyle(Color.ink3).monospacedDigit().frame(width: 44, alignment: .trailing)
                            CoverView(book: book, size: 72)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(book.title).font(.ui(26, weight: now ? 500 : 400)).foregroundStyle(Color.ink).lineLimit(1)
                                Text(book.author).font(.ui(22)).foregroundStyle(Color.ink3).lineLimit(1)
                            }
                            Spacer(minLength: 24)
                            HStack(spacing: 10) {
                                if progress?.finished == true { Image(systemName: "checkmark").font(.system(size: 20, weight: .semibold)).foregroundStyle(Color.ink3) }
                                Text(library?.standing(of: book) ?? "").font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit()
                            }
                        }
                        .padding(.vertical, 12)
                        .padding(.leading, 20)
                        .padding(.trailing, 24)
                        .background(RoundedRectangle(cornerRadius: 12).fill(now ? Color.raised : Color.clear))
                        .overlay(alignment: .leading) {
                            if now { Capsule().fill(Color.place).frame(width: 4).padding(.vertical, 14) }
                        }
                    }
                    .buttonStyle(LiftStyle(radius: 12))
                }
            }
        }
    }
}
