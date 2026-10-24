import SwiftUI

/// The end of a book: a quiet card that says when it was started and
/// finished, and the time spent with it on every device, then what's next in
/// its series, for the person to start when they choose: there's no
/// countdown. Menu, or Done, goes back to where it ended.
struct FinishedView: View {
    @Environment(AppModel.self) private var model
    let listening: Listening
    @FocusState private var focused: Focus?

    private enum Focus: Hashable {
        case next, done
    }

    var body: some View {
        let book = listening.book
        let next = model.upNext(after: book)
        ZStack {
            Color.canvas.ignoresSafeArea()
            HStack(alignment: .center, spacing: 96) {
                CoverView(book: book, size: 420)
                VStack(alignment: .leading, spacing: 0) {
                    Text("The end").font(.ui(24, weight: 500)).foregroundStyle(Color.ink3)
                    Text(book.title).font(.book(64, weight: 500)).foregroundStyle(Color.ink).lineLimit(3).padding(.top, 10)
                    Text(book.author.isEmpty ? "Author unknown" : book.author).font(.ui(26)).foregroundStyle(Color.ink2).padding(.top, 12)
                    // Once the server has closed the listen-through, which takes a moment.
                    Text(howItWent ?? " ")
                        .font(.ui(26)).foregroundStyle(Color.ink).lineSpacing(6).monospacedDigit()
                        .padding(.leading, 18)
                        .overlay(alignment: .leading) { Rectangle().fill(Color.lineStrong).frame(width: 2) }
                        .padding(.top, 40)
                        .opacity(howItWent == nil ? 0 : 1)
                        .animation(.easeOut(duration: 0.3), value: howItWent)

                    if let next, let series = model.library?.series(of: next) {
                        UpNext(book: next, series: series).padding(.top, 64)
                    }
                    HStack(spacing: 24) {
                        if let next {
                            Button { Task { await model.listenToNext(next) } } label: {
                                Label(model.opening == next.id ? "Opening…" : "Start listening", systemImage: "play.fill")
                            }
                            .buttonStyle(RibbonButtonStyle(kind: .primary))
                            .focused($focused, equals: .next)
                        }
                        Button("Done") { model.closeFinished() }
                            .buttonStyle(RibbonButtonStyle())
                            .focused($focused, equals: .done)
                    }
                    .padding(.top, next == nil ? 56 : 32)
                }
                .frame(maxWidth: 1000, alignment: .leading)
            }
            .padding(.horizontal, 120)
        }
        .defaultFocus($focused, next == nil ? .done : .next)
        .onExitCommand { model.closeFinished() }
    }

    /// "Started on 3 October, finished today. 11h 20m of listening, over 9 days."
    private var howItWent: String? {
        guard let read = listening.finishedRead, let started = Moment.read(read.started) else { return nil }
        let finished = Moment.read(read.finished) ?? Date()
        let calendar = Calendar.current
        let days = (calendar.dateComponents([.day], from: calendar.startOfDay(for: started), to: calendar.startOfDay(for: finished)).day ?? 0) + 1
        var words = days == 1 ? "Started and finished \(Self.day(finished))." : "Started \(Self.day(started)), finished \(Self.day(finished))."
        if read.listenedMs > 0 {
            words += " \(Format.left(read.listenedMs)) of listening\(days > 1 ? ", over \(days) days" : "")."
        }
        return words
    }

    /// A day as a sentence says it: "today", "yesterday", "on 3 October", with the year when it isn't this one.
    private static func day(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "today" }
        if calendar.isDateInYesterday(date) { return "yesterday" }
        let thisYear = calendar.isDate(date, equalTo: Date(), toGranularity: .year)
        return "on \(date.formatted(thisYear ? .dateTime.day().month(.wide) : .dateTime.day().month(.wide).year()))"
    }
}

/// The next book in the series, under a hairline: its number in the series, cover, title and length.
private struct UpNext: View {
    let book: ServerBook
    let series: Library.Series

    var body: some View {
        let index = series.books.firstIndex { $0.id == book.id } ?? 0
        VStack(alignment: .leading, spacing: 22) {
            Rectangle().fill(Color.line).frame(height: 1)
            Text("Up next in \(series.name)").font(.ui(24, weight: 500)).foregroundStyle(Color.ink3)
            HStack(spacing: 28) {
                CoverView(book: book, size: 150)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Book \(BookView.number(of: book, at: index)) of \(series.books.count)").font(.ui(22)).foregroundStyle(Color.ink2)
                    Text(book.title).font(.book(40, weight: 500)).foregroundStyle(Color.ink).lineLimit(2)
                    Text("\(book.author.isEmpty ? "" : "\(book.author) · ")\(Format.left(book.durationMs))").font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit()
                }
            }
        }
    }
}
