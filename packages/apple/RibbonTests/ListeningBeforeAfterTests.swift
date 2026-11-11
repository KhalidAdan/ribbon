import UIKit
import XCTest
@testable import Ribbon

/// Listening's status became a state machine written down (docs/STATE-MACHINES.md). This proves it does what it did
/// (docs/TEST-PLAN.md, "Before and after"): the old Listening (Before/ListeningBefore.swift, as it was, on the old
/// BookPlayer's rules, Before/FakePlayerBefore.swift) and the new one (on BookPlayer's own table, Support/FakePlayer.swift)
/// are put through the same events, every sequence of three and many longer ones, and after every step they must
/// show the same and have done the same: whether it plays and whether anything is heard, where, the chapter's card,
/// whether it was paused and whether on its own, the offer, the sleep timer, Still listening? and where they dozed
/// off, whether anything is loaded, the screen kept awake, what the remote's next press wakes, how often it said it
/// stopped and finished, and, once it has played on, how loud.
///
/// The differences meant are listed (`Meant`), and each must be reached, so the walk is known to get that far. A
/// sequence is compared up to the first difference meant that changes where it goes from there; the one that doesn't,
/// the player resting at the end, is let through. Any other difference fails it.
@MainActor
final class ListeningBeforeAfterTests: XCTestCase {
    /// Every sequence this long is tried; TEST_RUNNER_PROOF_DEPTH=4 tries every one of four (some minutes).
    private let depth = Int(ProcessInfo.processInfo.environment["PROOF_DEPTH"] ?? "") ?? 3
    /// Then this many longer ones, at random but the same each run.
    private let randomRuns = Int(ProcessInfo.processInfo.environment["PROOF_RANDOM"] ?? "") ?? 10_000
    private let randomLength = 12
    /// Sequences that went wrong, found before it stops looking: each a different way, perhaps.
    private let maxProblems = 5

    enum Meant: String, CaseIterable {
        case restsAtTheEnd = "after the end, the player rests there, nothing loaded"
        case playAfterTheEnd = "Play after the end does nothing, where it said it played and nothing was heard"
        case systemStopDuringACard = "the headphones going, or a call, during a chapter's card pause it"
        case askedAtTheEnd = "Still listening? is put away at the end, and the next press goes to the screen"
        case sleepHeldAtTheEnd = "the sleep timer's clock waits after the end, as it does while paused"
        case loudAfterAFade = "a fade stopped by a move or the end no longer leaves the narration quiet"
        case askedAsTheSleepTimerStops = "nothing is asked as the sleep timer stops it"
        case callsEndLeavesItAlone = "a call's end leaves alone a book played again since the call began"
        case sleepFadeKept = "the sleep timer's fade goes on as a doze's gives way to it, where the old one played a moment in full"

        /// Whether it changes nothing after: comparing goes on.
        var letThrough: Bool { self == .restsAtTheEnd || self == .sleepFadeKept }
    }

    /// What anyone could see or hear of it, said the same way for both.
    struct Seen: Equatable {
        var playing: Bool
        /// Where the audio is, while anything is heard.
        var heard: Int?
        var at: Int
        var card: Int?
        var paused: Bool
        var onItsOwn: Bool
        var offer: Bool
        var sleep: String
        var asked: Bool
        var dozedAt: Int?
        var loaded: Bool
        var awake: Bool
        var waiting: [String]
        var stops: Int
        var finishes: Int
        /// How loud, once it has played on: between moments heard, the old one set the volume only as it played.
        var volume: Float?

        var atTheEnd: Bool { !playing && onItsOwn && at == Self.durationMs }

        /// How loud the sleep timer's fade has it here, waiting for the chapter's end: in full until its last fifteen seconds.
        var sleepFade: Float? {
            guard sleep.hasPrefix("the chapter's end, at "), let endMs = Int(sleep.dropFirst("the chapter's end, at ".count)) else { return nil }
            return (min(1, max(0, Float(endMs - at) / 15_000)) * 1_000).rounded() / 1_000
        }
        static let durationMs = 40_000
    }

    private static let account = Account(url: URL(string: "nowhere:/")!, name: "walk", token: "", cookieName: "", cookieValue: "")

    private struct Step {
        let name: String
        /// Whether it plays the narration on, after which the volume is compared.
        var plays = false
        let act: @MainActor (any Walked, any StandIn) async -> Void
    }

    private let steps: [Step] = [
        Step(name: "play or pause") { book, _ in book.playPause(); await ListeningBeforeAfterTests.settle() },
        Step(name: "play from twelve seconds") { book, _ in book.play(from: 12_000) },
        Step(name: "back three seconds") { book, _ in book.move(to: book.positionMs - 3_000) },
        Step(name: "the next chapter") { book, _ in book.chapter(by: 1) },
        Step(name: "a second plays", plays: true) { _, player in player.plays(for: 1_000) },
        Step(name: "ten seconds play", plays: true) { _, player in player.plays(for: 10_000) },
        Step(name: "it plays to the end", plays: true) { _, player in player.playsToTheEnd() },
        Step(name: "the headphones go") { _, player in player.systemStops() },
        Step(name: "a call begins") { _, player in player.callBegins() },
        Step(name: "the call ends") { _, player in player.callEnds(); await ListeningBeforeAfterTests.settle() },
        Step(name: "the card's moment passes") { book, _ in if let card = book.card { book.cardPassed(card) } },
        Step(name: "sleep at the chapter's end") { book, _ in book.sleepAtChapterEnd() },
        Step(name: "sleep in half an hour, or not") { book, _ in book.sleep(after: book.sleepSeen == "off" ? 30 : nil) },
        // Less than no time, so each is past at once, however close together the clock is read.
        Step(name: "forty minutes with nothing pressed") { book, _ in book.askAfter = -1 },
        Step(name: "a minute with no answer") { book, _ in book.answerWithin = -1 },
        Step(name: "a press") { book, _ in
            _ = Remote.pressed()
            book.askAfter = 40 * 60
            book.answerWithin = 60
        },
        Step(name: "another device moved on") { book, _ in book.catchUp(to: 25_000, at: Date().addingTimeInterval(-60)) },
        Step(name: "the book goes off screen, or on") { book, _ in
            let shown = book.showsCards()
            book.showsCards = { !shown }
        },
    ]

    /// What a press of Play, or a call's end, starts runs on its own: let it.
    fileprivate static func settle() async {
        for _ in 0..<10 { await Task.yield() }
    }

    /// Everything one Listening showed after each step of a sequence.
    private func trace(old: Bool, _ sequence: [Int]) async -> [Seen] {
        Remote.stopWaiting("dozing")
        KeepAwake.set("narration", false)
        let book = ServerBook(id: "walked", title: "A Book", author: "", narrator: "", series: "", seriesIndex: nil, durationMs: Seen.durationMs, audio: true, ebook: false, ebookBytes: nil, words: nil, cover: nil, addedAt: nil)
        let detail = ServerBookDetail(
            files: [.init(path: "01.mp3", durationMs: Seen.durationMs)],
            chapters: (0..<4).map { .init(startMs: $0 * 10_000, endMs: ($0 + 1) * 10_000, title: "Chapter \($0 + 1)") },
            book: .init(description: nil, year: nil, publisher: nil)
        )
        let server = RibbonServer(account: Self.account)
        let player: any StandIn = old ? FakePlayerBefore(durationMs: Seen.durationMs) : FakePlayer(durationMs: Seen.durationMs)
        let listening: any Walked = old
            ? ListeningBefore(book: book, detail: detail, startMs: 0, placedAt: nil, server: server, player: player)
            : Listening(book: book, detail: detail, startMs: 0, placedAt: nil, server: server, player: player)
        listening.forgetDozed()
        listening.showsCards = { true }
        var stops = 0
        var finishes = 0
        listening.onStop = { stops += 1 }
        listening.onFinish = { finishes += 1 }
        var seen: [Seen] = []
        for index in sequence {
            let step = steps[index]
            await step.act(listening, player)
            seen.append(Seen(
                playing: listening.playing,
                heard: player.sounding ? player.positionMs : nil,
                at: listening.positionMs,
                card: listening.card,
                paused: listening.pausedAt != nil,
                onItsOwn: listening.stoppedOnItsOwn,
                offer: listening.hasResumeOffer,
                sleep: listening.sleepSeen,
                asked: listening.askedNow,
                dozedAt: listening.dozedAtNow,
                loaded: listening.loaded,
                awake: UIApplication.shared.isIdleTimerDisabled,
                waiting: Remote.whoWaits,
                stops: stops,
                finishes: finishes,
                volume: step.plays && player.sounding ? (player.volume * 1_000).rounded() / 1_000 : nil
            ))
        }
        listening.forgetDozed()
        listening.stop()
        return seen
    }

    /// Whether the new one differs from the old only as it's meant to: which ways, or nil for anything else.
    private func meant(old: Seen, new: Seen, before: Seen?, step: String) -> [Meant]? {
        let fields: [(String, Bool)] = [
            ("playing", old.playing == new.playing), ("heard", old.heard == new.heard), ("at", old.at == new.at),
            ("card", old.card == new.card), ("paused", old.paused == new.paused), ("onItsOwn", old.onItsOwn == new.onItsOwn),
            ("offer", old.offer == new.offer), ("sleep", old.sleep == new.sleep), ("asked", old.asked == new.asked),
            ("dozedAt", old.dozedAt == new.dozedAt), ("loaded", old.loaded == new.loaded), ("awake", old.awake == new.awake),
            ("waiting", old.waiting == new.waiting), ("stops", old.stops == new.stops), ("finishes", old.finishes == new.finishes),
            ("volume", old.volume == new.volume),
        ]
        var differ = Set(fields.filter { !$0.1 }.map(\.0))
        var kinds: [Meant] = []
        let justEnded = new.finishes > (before?.finishes ?? 0)
        if step == "play or pause", let before, before.atTheEnd {
            // The old one said it played, and nothing was heard; the new one is just as it was, at the end.
            var still = before
            still.volume = new.volume
            guard old.playing, old.heard == nil, new == still else { return nil }
            return [.playAfterTheEnd]
        }
        if step == "the call ends", before?.playing == false, old.playing, !new.playing, new.at == before?.at {
            // The old one played on, though the person had played it again during the call, and stopped it since.
            return [.callsEndLeavesItAlone]
        }
        if step == "the headphones go" || step == "a call begins", before?.card != nil {
            guard old.playing, old.card != nil, !new.playing, new.card == nil else { return nil }
            return [.systemStopDuringACard]
        }
        if differ.contains("loaded"), old.loaded, !new.loaded, new.atTheEnd {
            differ.remove("loaded")
            kinds.append(.restsAtTheEnd)
        }
        if justEnded || before?.atTheEnd == true || new.atTheEnd {
            if differ.contains("asked") || differ.contains("waiting"), old.asked, !new.asked, new.waiting.isEmpty {
                differ.subtract(["asked", "waiting"])
                kinds.append(.askedAtTheEnd)
            }
            if differ.contains("sleep"), old.sleep == "minutes, counting", new.sleep == "minutes, held" {
                differ.remove("sleep")
                kinds.append(.sleepHeldAtTheEnd)
            }
        }
        if differ.contains("asked") || differ.contains("waiting"), !new.playing, new.stops > (before?.stops ?? 0), new.sleep == "off", old.asked, !new.asked, new.waiting.isEmpty {
            differ.subtract(["asked", "waiting"])
            kinds.append(.askedAsTheSleepTimerStops)
        }
        if differ == ["volume"], old.volume == 1, let now = new.volume, now < 1, now == new.sleepFade {
            // The old one set it in full as the doze stopped fading, under the sleep timer's fade, until the next moment.
            differ.remove("volume")
            kinds.append(.sleepFadeKept)
        }
        if differ == ["volume"], let was = old.volume, let now = new.volume, now > was {
            differ.remove("volume")
            kinds.append(.loudAfterAFade)
        }
        return differ.isEmpty ? kinds : nil
    }

    private struct Tally {
        var sequences = 0
        var steps = 0
        var meant: [Meant: Int] = [:]
        var problems: [String] = []
    }

    private func compare(_ sequence: [Int], _ tally: inout Tally) async {
        let old = await trace(old: true, sequence)
        let new = await trace(old: false, sequence)
        tally.sequences += 1
        for (index, step) in sequence.enumerated() {
            tally.steps += 1
            guard old[index] != new[index] else { continue }
            let route = sequence[...index].map { steps[$0].name }.joined(separator: " → ")
            guard let kinds = meant(old: old[index], new: new[index], before: index > 0 ? new[index - 1] : nil, step: steps[step].name) else {
                tally.problems.append("\(route):\n  it showed \(old[index])\n  it shows  \(new[index])")
                return
            }
            for kind in kinds { tally.meant[kind, default: 0] += 1 }
            // A difference meant that changes where it goes from here: the rest of this sequence is another story.
            if !kinds.allSatisfy(\.letThrough) { return }
        }
    }

    /// Longer sequences that reach the rarer differences for certain, compared as every other is.
    private let picked: [[String]] = [
        // A fade for someone dozing off, cut short by a press and a move: the old one stayed quiet.
        ["forty minutes with nothing pressed", "a minute with no answer", "play or pause", "a second plays", "a second plays", "a press", "back three seconds", "a second plays"],
        // A sleep timer set as a doze fades out: the old one played a moment in full under the timer's fade.
        ["forty minutes with nothing pressed", "a minute with no answer", "play from twelve seconds", "a second plays", "sleep at the chapter's end", "a second plays"],
        // Played again and paused by hand during a call: the old one played it on at the call's end.
        ["play or pause", "a call begins", "play or pause", "play or pause", "the call ends"],
        // Play after the end, with no cards on the way.
        ["the book goes off screen, or on", "play or pause", "it plays to the end", "play or pause"],
    ]

    func testListeningDoesWhatItDidButForWhatWasMeant() async {
        var tally = Tally()
        for names in picked {
            await compare(names.map { name in steps.firstIndex { $0.name == name }! }, &tally)
        }
        let n = steps.count
        var total = 1
        for _ in 0..<depth { total *= n }
        for i in 0..<total where tally.problems.count < maxProblems {
            var sequence: [Int] = []
            var k = i
            for _ in 0..<depth {
                sequence.append(k % n)
                k /= n
            }
            await compare(sequence, &tally)
        }
        // A repeatable stream of numbers, so a failing sequence can be run again.
        var seed: UInt64 = 20_261_110
        for _ in 0..<randomRuns where tally.problems.count < maxProblems {
            let sequence = (0..<randomLength).map { _ in
                seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
                return Int((seed >> 33) % UInt64(n))
            }
            await compare(sequence, &tally)
        }
        XCTAssertEqual(tally.problems, [])
        // Each difference meant was reached, so the walk would have seen any other.
        XCTAssertEqual(Set(tally.meant.keys), Set(Meant.allCases), "never reached: \(Set(Meant.allCases).subtracting(tally.meant.keys).map(\.rawValue))")
        XCTAssertEqual(tally.sequences, picked.count + total + randomRuns)
        print("Before and after: \(tally.sequences) sequences, \(tally.steps) steps; meant: \(tally.meant.map { "\($0.key): \($0.value)" }.sorted())")
    }
}

/// The old Listening and the new, as the walk drives and reads them.
@MainActor
protocol Walked: AnyObject {
    var playing: Bool { get }
    var card: Int? { get }
    var pausedAt: Date? { get }
    var stoppedOnItsOwn: Bool { get }
    var positionMs: Int { get }
    var loaded: Bool { get }
    var showsCards: () -> Bool { get set }
    var onStop: (() -> Void)? { get set }
    var onFinish: (() -> Void)? { get set }
    var hasResumeOffer: Bool { get }
    var sleepSeen: String { get }
    var askedNow: Bool { get }
    var dozedAtNow: Int? { get }
    var askAfter: TimeInterval { get set }
    var answerWithin: TimeInterval { get set }
    func playPause()
    func play(from ms: Int)
    func move(to ms: Int)
    func chapter(by step: Int)
    func cardPassed(_ index: Int)
    func sleepAtChapterEnd()
    func sleep(after minutes: Int?)
    func catchUp(to ms: Int, at: Date?)
    func stop()
    func forgetDozed()
}

extension Listening: Walked {
    var hasResumeOffer: Bool { resumeOffer != nil }
    var askedNow: Bool { dozing.asked != nil }
    var dozedAtNow: Int? { dozing.dozedAt }
    var askAfter: TimeInterval {
        get { dozing.askAfter }
        set { dozing.askAfter = newValue }
    }
    var answerWithin: TimeInterval {
        get { dozing.answerWithin }
        set { dozing.answerWithin = newValue }
    }
    func forgetDozed() { dozing.forget() }

    var sleepSeen: String {
        switch sleep {
        case .at(_, let paused): paused == nil ? "minutes, counting" : "minutes, held"
        case .endOfChapter(let endMs): "the chapter's end, at \(endMs)"
        case nil: "off"
        }
    }
}

extension ListeningBefore: Walked {
    var hasResumeOffer: Bool { resumeOffer != nil }
    var askedNow: Bool { dozing.asked != nil }
    var dozedAtNow: Int? { dozing.dozedAt }
    var askAfter: TimeInterval {
        get { dozing.askAfter }
        set { dozing.askAfter = newValue }
    }
    var answerWithin: TimeInterval {
        get { dozing.answerWithin }
        set { dozing.answerWithin = newValue }
    }
    func forgetDozed() { dozing.forget() }

    var sleepSeen: String {
        switch sleep {
        case .at(_, let paused): paused == nil ? "minutes, counting" : "minutes, held"
        case .endOfChapter(let endMs): "the chapter's end, at \(endMs)"
        case nil: "off"
        }
    }
}
