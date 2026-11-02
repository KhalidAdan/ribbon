#if os(iOS)
import UIKit

/// How big the reader sets the words on this iPhone or iPad, and how much room
/// it leaves between their lines: the Aa sheet's two choices, as Apple Books
/// has them. Kept on the device rather than with the person, since each screen
/// wants its own: a small phone reads bigger than an iPad. The TV reads from
/// across the room, at one size.
struct TextSettings: Equatable {
    /// The sizes, smallest to biggest, as a share of the device's own (BookLayout.Measure); the third is that size.
    static let sizes: [CGFloat] = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.7]

    enum Spacing: String, CaseIterable {
        case snug, normal, roomy

        /// A line's height, as a share of its letters' size.
        var lineHeight: CGFloat {
            switch self {
            case .snug: 1.45
            case .normal: 1.63
            case .roomy: 1.85
            }
        }

        var name: String { rawValue.capitalized }
    }

    var size = 2
    var spacing = Spacing.normal

    /// What the device's own size of letters is multiplied by.
    var scale: CGFloat { Self.sizes[size] }
    var canShrink: Bool { size > 0 }
    var canGrow: Bool { size < Self.sizes.count - 1 }

    /// What this device keeps, or the device's own size and spacing.
    static var onThisDevice: TextSettings {
        let defaults = UserDefaults.standard
        var settings = TextSettings()
        if let size = defaults.object(forKey: sizeKey) as? Int, sizes.indices.contains(size) { settings.size = size }
        if let spacing = defaults.string(forKey: spacingKey).flatMap(Spacing.init(rawValue:)) { settings.spacing = spacing }
        return settings
    }

    func keep() {
        UserDefaults.standard.set(size, forKey: Self.sizeKey)
        UserDefaults.standard.set(spacing.rawValue, forKey: Self.spacingKey)
    }

    private static let sizeKey = "ribbon.textSize"
    private static let spacingKey = "ribbon.lineSpacing"
}
#endif
