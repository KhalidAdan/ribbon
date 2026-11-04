import SwiftUI

/// What you've been listening to and reading, as the desktop's Stats has it
/// (packages/desktop/src/ui/StatsPane.tsx), counted by the server from every
/// device's sessions and readings (`GET /api/stats`): this week as a sentence, the numbers
/// that matter, a year of days, the books, authors and narrators listened to
/// most, and what you finished lately. Reached from Stats at the top of the
/// library; Menu goes back.
struct StatsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.narrow) private var narrow
    @State private var stats: ListeningStats?
    @State private var problem: String?

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 64.scaled) {
                    Text("Stats").font(.book(56, weight: 500)).foregroundStyle(Color.ink)
                    if let stats {
                        if stats.totals.sessions == 0 && stats.finished.isEmpty {
                            Text("Nothing to count yet. Listen or read for a while, and your time, your streaks and what you finished show up here.")
                                .font(.ui(26)).foregroundStyle(Color.ink2).frame(maxWidth: 1000.scaled, alignment: .leading)
                        } else {
                            Summary(totals: stats.totals)
                            Year(days: stats.days, totals: stats.totals)
                            if !stats.books.isEmpty { MostListened(rows: stats.books) }
                            if !stats.finished.isEmpty { FinishedLately(rows: stats.finished, inAll: stats.finishedInAll) }
                            if !stats.authors.isEmpty { ListenedTo(title: "Authors", rows: stats.authors) }
                            if !stats.narrators.isEmpty { ListenedTo(title: "Narrators", rows: stats.narrators) }
                        }
                    } else {
                        Text(problem ?? "Counting…").font(.ui(26)).foregroundStyle(Color.ink2)
                    }
                }
                .frame(maxWidth: 1400.scaled, alignment: .leading)
                .screenEdges(horizontal: 96, vertical: 72)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task {
            do {
                stats = try await model.server?.stats()
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

/// This week as a sentence beside a rule, then four numbers under a hairline: two to a row on a phone.
private struct Summary: View {
    let totals: ListeningStats.Totals
    @Environment(\.narrow) private var narrow

    var body: some View {
        VStack(alignment: .leading, spacing: 32.scaled) {
            Text(sentence)
                .font(.ui(30, weight: 500)).foregroundStyle(Color.ink).monospacedDigit()
                .padding(.leading, 18.scaled)
                .overlay(alignment: .leading) { Rectangle().fill(Color.lineStrong).frame(width: 2) }
            VStack(alignment: .leading, spacing: 22.scaled) {
                Rectangle().fill(Color.line).frame(height: 1)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 32.scaled, alignment: .leading), count: narrow ? 2 : 4), alignment: .leading, spacing: 22.scaled) {
                    tile("This week", Format.left(totals.weekMs))
                    tile("A day, lately", Format.left(Int(totals.dailyAverageMs.rounded())))
                    tile("Streak", "\(totals.streakDays) \(totals.streakDays == 1 ? "day" : "days")", note: totals.longestStreakDays > totals.streakDays ? "Longest \(totals.longestStreakDays)" : nil)
                    tile("Finished in \(Calendar.current.component(.year, from: Date()))", String(totals.finishedThisYear))
                }
            }
        }
    }

    /// "You spent 3h 20m with your books this week, 40 min of it today."
    private var sentence: String {
        guard totals.weekMs > 0 else { return "Nothing this week yet. \(Format.left(totals.totalMs)) in all." }
        return "You spent \(Format.left(totals.weekMs)) with your books this week\(totals.todayMs > 0 ? ", \(Format.left(totals.todayMs)) of it today" : "")."
    }

    private func tile(_ term: String, _ value: String, note: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4.scaled) {
            Text(term).font(.ui(22)).foregroundStyle(Color.ink3).lineLimit(1)
            Text(value).font(.ui(36, weight: 600)).foregroundStyle(Color.ink).monospacedDigit().lineLimit(1)
            if let note { Text(note).font(.ui(20)).foregroundStyle(Color.ink3) }
        }
    }
}

/// The last year, a square a day, the more listened the deeper the amber: a week a column, as the desktop draws it.
private struct Year: View {
    let days: [[Int]]
    let totals: ListeningStats.Totals

    var body: some View {
        VStack(alignment: .leading, spacing: 24.scaled) {
            SectionHeader(title: "The last year", description: "\(Format.left(totals.totalMs)) over \(totals.sessions) \(totals.sessions == 1 ? "session" : "sessions"). Each square is a day.")
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 4.scaled) {
                    ForEach(Array(days.enumerated()), id: \.offset) { _, week in
                        VStack(spacing: 4.scaled) {
                            ForEach(Array(week.enumerated()), id: \.offset) { _, level in
                                RoundedRectangle(cornerRadius: 3.scaled)
                                    .fill(level == 0 ? Color.raised : Color.place.opacity(Double(level) / 4))
                                    .frame(width: 16.scaled, height: 16.scaled)
                            }
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)
            // Where it's too narrow for the whole year, this week shows first.
            .defaultScrollAnchor(.trailing)
            .accessibilityLabel("Listening time per day over the last year")
        }
    }
}

/// The books you've spent most time with, listening and reading, all time: each with its cover and a line of amber for its share.
private struct MostListened: View {
    @Environment(AppModel.self) private var model
    let rows: [ListeningStats.BookTime]

    var body: some View {
        let most = max(1, rows.first?.ms ?? 1)
        VStack(alignment: .leading, spacing: 20.scaled) {
            SectionHeader(title: "Most time spent", description: "Listening and reading, all time.")
            VStack(spacing: 4.scaled) {
                ForEach(rows, id: \.book) { row in
                    if let book = model.library?.books.first(where: { $0.id == row.book }) {
                        Button { model.open(book) } label: {
                            HStack(spacing: 24.scaled) {
                                CoverView(book: book, size: 72)
                                VStack(alignment: .leading, spacing: 10.scaled) {
                                    Text(book.title).font(.ui(26, weight: 500)).foregroundStyle(Color.ink).lineLimit(1)
                                    ProgressLine(fraction: Double(row.ms) / Double(most))
                                }
                                Text(Format.left(row.ms)).font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit().frame(minWidth: 120.scaled, alignment: .trailing)
                            }
                            .padding(.vertical, 12.scaled)
                            .padding(.horizontal, 20.scaled)
                        }
                        .buttonStyle(LiftStyle.row(radius: 12))
                    }
                }
            }
        }
    }
}

/// The books finished lately, newest first, with the day each was finished.
private struct FinishedLately: View {
    @Environment(AppModel.self) private var model
    let rows: [ListeningStats.Finished]
    let inAll: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 20.scaled) {
            SectionHeader(title: "Finished lately", description: "\(inAll) \(inAll == 1 ? "listen-through" : "listen-throughs") finished in all.")
            VStack(spacing: 4.scaled) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    if let book = model.library?.books.first(where: { $0.id == row.book }) {
                        Button { model.open(book) } label: {
                            HStack(spacing: 24.scaled) {
                                CoverView(book: book, size: 72)
                                VStack(alignment: .leading, spacing: 4.scaled) {
                                    Text(book.title).font(.ui(26, weight: 500)).foregroundStyle(Color.ink).lineLimit(1)
                                    Text(book.author).font(.ui(22)).foregroundStyle(Color.ink3).lineLimit(1)
                                }
                                Spacer(minLength: 24.scaled)
                                Text(Moment.read(row.finished)?.formatted(date: .abbreviated, time: .omitted) ?? "").font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit()
                            }
                            .padding(.vertical, 12.scaled)
                            .padding(.horizontal, 20.scaled)
                        }
                        .buttonStyle(LiftStyle.row(radius: 12))
                    }
                }
            }
        }
    }
}

/// Authors or narrators, by time spent listening to them.
private struct ListenedTo: View {
    let title: String
    let rows: [ListeningStats.PersonTime]

    var body: some View {
        VStack(alignment: .leading, spacing: 20.scaled) {
            SectionHeader(title: title)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows, id: \.name) { row in
                    HStack(alignment: .firstTextBaseline) {
                        Text(row.name).font(.ui(24)).foregroundStyle(Color.ink).lineLimit(1)
                        Spacer(minLength: 24.scaled)
                        Text(Format.left(row.ms)).font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit()
                    }
                    .padding(.vertical, 12.scaled)
                    .overlay(alignment: .top) { Rectangle().fill(Color.line).frame(height: 1) }
                }
            }
        }
        .frame(maxWidth: 1000.scaled, alignment: .leading)
    }
}
