import Foundation

/// Times and speeds written as the desktop writes them (src/core/speed.ts),
/// so the TV and the desktop say the same thing the same way.
enum Format {
    /// A moment or a length on a clock: "4:05", "1:02:03".
    static func duration(_ ms: Int) -> String {
        let total = max(0, ms / 1000)
        let (h, m, s) = (total / 3600, total % 3600 / 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// How long is left, in words: "9h 40m", "12 min", "40 sec".
    static func left(_ ms: Int) -> String {
        let total = Int((Double(max(0, ms)) / 1000).rounded())
        let (h, m) = (total / 3600, total % 3600 / 60)
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m) min" }
        return "\(total) sec"
    }

    /// A speed: "1×", "1.25×", "1.5×".
    static func speed(_ speed: Double) -> String {
        let snapped = (speed * 20).rounded() / 20
        if snapped == snapped.rounded() { return "\(Int(snapped))×" }
        var text = String(format: "%.2f", snapped)
        if text.hasSuffix("0") { text.removeLast() }
        return "\(text)×"
    }

    /// How long is left of a stretch at a speed: what the narrator will take.
    static func atSpeed(_ ms: Int, _ speed: Double) -> Int {
        Int((Double(max(0, ms)) / max(0.5, speed)).rounded())
    }
}
