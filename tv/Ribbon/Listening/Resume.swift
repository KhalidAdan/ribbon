/// The moment you press play after a pause, as the desktop takes it
/// (src/core/resume.ts, tested in test/resume.test.ts), so the TV and the
/// desktop go back by the same amount: the rewind scales with how long you
/// were gone, never crosses the chapter's start, and after a day away the
/// start of the chapter is offered.
enum Resume {
    struct Policy: Equatable {
        let rewindMs: Int
        let offersChapterRestart: Bool
    }

    private static let second = 1_000
    private static let minute = 60 * second
    private static let hour = 60 * minute
    private static let day = 24 * hour
    private static let week = 7 * day

    /// How far back, and whether to offer the chapter's start, after a gap of this long.
    static func rewind(after gapMs: Int) -> Policy {
        if gapMs < 10 * second { return Policy(rewindMs: 0, offersChapterRestart: false) }
        if gapMs < 2 * minute { return Policy(rewindMs: 2 * second, offersChapterRestart: false) }
        if gapMs < hour { return Policy(rewindMs: 10 * second, offersChapterRestart: false) }
        if gapMs < day { return Policy(rewindMs: 30 * second, offersChapterRestart: false) }
        if gapMs < week { return Policy(rewindMs: 30 * second, offersChapterRestart: true) }
        return Policy(rewindMs: 60 * second, offersChapterRestart: true)
    }

    /// Where to start playing. `chapterStartMs` is the start of the chapter the position is in; 0 when chapters are unknown.
    static func position(_ positionMs: Int, after gapMs: Int, chapterStartMs: Int = 0) -> Int {
        // A chapter start after the position is a caller's mistake; it's ignored.
        let floor = chapterStartMs > positionMs ? 0 : max(0, chapterStartMs)
        return max(floor, positionMs - rewind(after: gapMs).rewindMs)
    }
}
