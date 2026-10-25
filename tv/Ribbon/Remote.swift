import SwiftUI
import UIKit

/// Every press and every touch of the remote, seen before any screen gets
/// it: when the person last did anything. That's how the TV knows they're
/// awake, since the Siri Remote has no motion sensors to say it was picked
/// up. While something on screen only waits to be woken from (Still
/// listening?, the passages that drift by while a book is paused), the
/// press or touch that wakes it goes no further, so it doesn't also act on
/// the screen beneath. On the iPad it's every touch of the screen, and the
/// keyboard's presses, seen the same way.
@MainActor
enum Remote {
    /// When the person last pressed or touched anything, or used the TV's own play and pause.
    private(set) static var lastInput = Date()

    /// What the next press or touch only wakes, and who's waiting for it.
    private static var waiting: (who: String, wake: () -> Void)?
    fileprivate static var isWaiting: Bool { waiting != nil }

    /// Watching from the window, which every press and touch passes through.
    fileprivate static let watcher = Watcher()

    /// The next press or touch wakes this, and goes no further.
    static func wait(_ who: String, onWake wake: @escaping () -> Void) {
        guard waiting?.who != who else { return }
        waiting = (who, wake)
        watcher.takesNext(true)
    }

    /// No longer waiting to be woken: the press or touch goes to the screen again.
    static func stopWaiting(_ who: String) {
        guard waiting?.who == who else { return }
        waiting = nil
        watcher.takesNext(false)
    }

    /// Something the person did that isn't a press or a touch: the TV's own play and pause, from Control Center or a phone.
    static func used() {
        lastInput = Date()
    }

    /// An event on its way to the screens. True when it wakes something, and is taken.
    fileprivate static func heard(_ event: UIEvent) -> Bool {
        lastInput = Date()
        let begins = (event as? UIPressesEvent)?.allPresses.contains { $0.phase == .began } ?? event.allTouches?.contains { $0.phase == .began } ?? false
        guard begins, let waiting else { return false }
        // The watcher lets the screens have presses again once it's done with this one.
        self.waiting = nil
        waiting.wake()
        return true
    }
}

/// How the Remote sees: a gesture recognizer on the window, asked about
/// every event on its way to the screens, that takes none of them, except,
/// while something waits to be woken, the press or touch that wakes it.
/// Then the screens wait for it first, and never see that one.
private final class Watcher: UIGestureRecognizer, UIGestureRecognizerDelegate {
    init() {
        super.init(target: nil, action: nil)
        delegate = self
        allowedTouchTypes = [UITouch.TouchType.direct, .indirect].map { NSNumber(value: $0.rawValue) }
        var presses: [UIPress.PressType] = [.upArrow, .downArrow, .leftArrow, .rightArrow, .select, .menu, .playPause]
        #if os(tvOS)
        presses += [.pageUp, .pageDown]
        #endif
        allowedPressTypes = presses.map { NSNumber(value: $0.rawValue) }
        takesNext(false)
    }

    /// Whether the next press or touch is this one's to take, so the screens wait for it.
    func takesNext(_ on: Bool) {
        delaysTouchesBegan = on
        cancelsTouchesInView = on
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive event: UIEvent) -> Bool {
        guard event.type == .presses || event.type == .touches else { return false }
        return Remote.heard(event)
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent) {
        state = .ended
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        state = .ended
    }

    /// While it takes the next one, the focus engine's own recognizers wait for it too, so the focus doesn't move.
    override func shouldBeRequiredToFail(by otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        delaysTouchesBegan
    }

    /// Done with the press or touch it took: the screens have the next one, unless something waits again.
    override func reset() {
        super.reset()
        takesNext(Remote.isWaiting)
    }
}

/// Puts the Remote's watcher on the window the app is drawn in, once it has one.
struct WatchTheRemote: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView { Hook() }
    func updateUIView(_ view: UIView, context: Context) {}

    private final class Hook: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window, Remote.watcher.view !== window { window.addGestureRecognizer(Remote.watcher) }
        }
    }
}

/// How long the waits measured in minutes are. In a debug build,
/// `RIBBON_QUICK_WAITS` makes them seconds, so the simulator can show Still
/// listening? and the passages without a book playing for an hour
/// (tv/README.md).
enum Waits {
    #if DEBUG
    static let quick = ProcessInfo.processInfo.environment["RIBBON_QUICK_WAITS"] != nil
    #else
    static let quick = false
    #endif

    static func of(_ real: TimeInterval, quick seconds: TimeInterval) -> TimeInterval {
        quick ? seconds : real
    }
}

/// The screen kept on for as long as anything wants it: the narration while
/// it plays, the wait for the passages, and the passages while they drift
/// by. tvOS's own screen saver and sleep come back when nothing does.
@MainActor
enum KeepAwake {
    private static var holders: Set<String> = []

    static func set(_ holder: String, _ on: Bool) {
        if on { holders.insert(holder) } else { holders.remove(holder) }
        UIApplication.shared.isIdleTimerDisabled = !holders.isEmpty
    }
}
