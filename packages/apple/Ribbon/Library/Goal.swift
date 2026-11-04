import Observation
import SwiftUI

/// The daily goal on this device (packages/core/src/goal.ts): the person's
/// minutes a day with their books, listening or reading, which the server
/// keeps for every device, and today against it. The server counts what's
/// been kept; what's going on here now, a stretch of listening or reading
/// not sent yet, is added to it. Met here, after it was seen not met today,
/// by time spent here (going on now, or a stretch that just ended), it says
/// so for a moment, once a day, as the desktop does (`GoalWatch`): a goal
/// met by another device's time is that device's to say.
@MainActor
@Observable
final class DailyGoal {
    /// The goal just met, while its note shows.
    struct Met: Equatable {
        let minutes: Int
        let streakDays: Int
    }

    /// The goals there are to choose from, as the desktop has them; 0 is off.
    static let choices = [0, 5, 10, 15, 20, 30, 45, 60]
    /// How long the note shows.
    private static let shownFor: Duration = .seconds(6)

    private(set) var minutes = 0
    private(set) var met: Met?

    @ObservationIgnored private let server: RibbonServer
    @ObservationIgnored private let celebratedKey: String
    /// Today as the server last counted it, when, and on which day.
    @ObservationIgnored private var counted: (today: GoalToday.Today, at: Date, day: Int)?
    /// The last moment something was going on here: once it's stopped, and sent, the server is asked again.
    @ObservationIgnored private var liveAt: Date?
    /// The last moment time was spent here, kept apart from `liveAt`, which asking the server again forgets.
    @ObservationIgnored private var hereAt: Date?
    @ObservationIgnored private var belowOn: Int?
    /// Met while the app was behind: said when it comes back, the same day.
    @ObservationIgnored private var waiting: Met?
    @ObservationIgnored private var asking = false

    init(server: RibbonServer) {
        self.server = server
        celebratedKey = "ribbon.goalCelebrated.\(server.account.id)"
    }

    /// The goal, and today against it, from the server.
    func load() async {
        guard !asking, let found = try? await server.goal() else { return }
        minutes = found.goal.minutes
        counted = (found.today, Date(), Self.day(Date()))
    }

    /// Choose a goal, on every device.
    func choose(_ minutes: Int) async {
        self.minutes = minutes
        if let stands = try? await server.chooseGoal(minutes: minutes) { self.minutes = stands.minutes }
        await load()
    }

    /// The next of the choices after the one now, round again after the last: how the TV's remote chooses.
    var next: Int {
        let at = Self.choices.firstIndex(of: minutes) ?? 0
        return Self.choices[(at + 1) % Self.choices.count]
    }

    /// Today as it stands now, with `liveMs` going on here: met, after being seen not met today, it says so.
    func see(liveMs: Int, inFront: Bool) async {
        let now = Date()
        if liveMs > 0 {
            liveAt = now
            hereAt = now
        }
        // Asked again once what was going on has stopped and had a moment to reach the server, or a new day began.
        if counted == nil || counted!.day != Self.day(now) || (liveMs == 0 && liveAt.map { now.timeIntervalSince($0) > 3 && counted!.at < $0.addingTimeInterval(3) } == true) {
            asking = true
            defer { asking = false }
            guard let found = try? await server.goal() else { return }
            minutes = found.goal.minutes
            counted = (found.today, now, Self.day(now))
            liveAt = nil
        }
        guard minutes > 0, let counted else { return }
        let day = Self.day(now)
        if inFront, let waiting {
            self.waiting = nil
            show(waiting)
        }
        guard counted.today.todayMs + liveMs >= minutes * 60_000 else {
            belowOn = day
            return
        }
        // Met by another device's time: theirs to say.
        if liveMs == 0 && hereAt.map({ now.timeIntervalSince($0) > 60 }) != false { belowOn = nil }
        guard belowOn == day, UserDefaults.standard.integer(forKey: celebratedKey) != day else { return }
        UserDefaults.standard.set(day, forKey: celebratedKey)
        // The server counts a streak to yesterday while today isn't met yet: today is one more.
        let said = Met(minutes: minutes, streakDays: counted.today.met ? counted.today.streakDays : counted.today.streakDays + 1)
        if inFront { show(said) } else { waiting = said }
    }

    func dismiss() {
        met = nil
    }

    private func show(_ said: Met) {
        met = said
        Task { [weak self] in
            try? await Task.sleep(for: Self.shownFor)
            if self?.met == said { self?.met = nil }
        }
    }

    /// Today, as days since 1970 on this device's own clock: as the desktop and the server count days.
    private static func day(_ date: Date) -> Int {
        let local = date.timeIntervalSince1970 + Double(TimeZone.current.secondsFromGMT(for: date))
        return Int((local / 86_400).rounded(.down))
    }
}

/// The goal just met: a small note at the top for a few seconds, as Apple Books has one, never over the sentence being
/// read, and the book plays on. "Daily goal met. 20 minutes with your books today. 5 days in a row."
struct GoalNote: View {
    let met: DailyGoal.Met

    var body: some View {
        HStack(spacing: 16.scaled) {
            Circle().fill(Color.place).frame(width: 12.scaled, height: 12.scaled)
            VStack(alignment: .leading, spacing: 4.scaled) {
                Text("Daily goal met").font(.ui(24, weight: 600)).foregroundStyle(Color.ink)
                Text(line).font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit()
            }
        }
        .padding(.horizontal, 28.scaled)
        .padding(.vertical, 18.scaled)
        .background(RoundedRectangle(cornerRadius: 16.scaled).fill(Color.surface))
        .overlay(RoundedRectangle(cornerRadius: 16.scaled).stroke(Color.line))
        .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
        .accessibilityElement(children: .combine)
    }

    /// "20 minutes with your books today. 5 days in a row.", as the desktop says it.
    private var line: String {
        "\(met.minutes) \(met.minutes == 1 ? "minute" : "minutes") with your books today.\(met.streakDays > 1 ? " \(met.streakDays) days in a row." : "")"
    }
}
