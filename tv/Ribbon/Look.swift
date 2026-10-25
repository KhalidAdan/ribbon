import CoreText
import SwiftUI
import UIKit

/// Ribbon's look on the TV (docs/DESIGN.md), seen from a sofa: the dark
/// tokens, the reader's own face for the book, and Inter for the rest. The
/// iPad has the same look, nearer.
enum Look {
    /// How large the TV's sizes are drawn on this screen. Every size in the screens is the TV's, for a sofa three
    /// metres away; the iPad, held at arm's length, draws them at seven tenths, so the TV's 24-point text is the
    /// iPad's 17. The faces scale themselves (`Font.ui`, `Font.book`); a length says `.scaled`.
    #if os(tvOS)
    static let scale: CGFloat = 1
    #else
    static let scale: CGFloat = 0.7
    #endif

    static let canvas = UIColor(rgb: 0x0a0a0a)
    static let surface = UIColor(rgb: 0x141414)
    static let raised = UIColor(rgb: 0x1c1c1c)
    static let ink = UIColor(rgb: 0xededed)
    static let ink2 = UIColor(rgb: 0xa1a1a1)
    static let ink3 = UIColor(rgb: 0x6e6e6e)
    /// Amber is your place: the sentence being read, progress, nothing else.
    static let place = UIColor(rgb: 0xf5a524)
    /// How strongly the sentence being read is washed in amber, as in the web reader (ReadingView.tsx, `marked`).
    static let placeWash = place.withAlphaComponent(0.24)
    /// The sentence the remote is on, when it isn't the one being read: lifted, the way tvOS lifts what has focus.
    static let focusWash = UIColor(white: 1, alpha: 0.1)
    /// How much of the words not being read shows while the narration plays: the sentence being read stands out
    /// by everything else stepping back, and nothing moves.
    static let dimmedWords: CGFloat = 0.4
}

extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
    }
}

extension Color {
    static let canvas = Color(uiColor: Look.canvas)
    static let raised = Color(uiColor: Look.raised)
    static let ink = Color(uiColor: Look.ink)
    static let ink2 = Color(uiColor: Look.ink2)
    static let ink3 = Color(uiColor: Look.ink3)
    static let place = Color(uiColor: Look.place)
}

/// The faces Ribbon brings, from the same WOFF2 files the web reader loads
/// (src/reader/faces.ts): each a variable font with a weight axis. Core Text
/// reads WOFF2 itself, so they are bundled as they are.
enum Faces {
    /// The book's text: Newsreader, with its Latin Extended half behind it for letters the Latin half lacks.
    static func text(size: CGFloat, weight: CGFloat = 400, italic: Bool = false) -> UIFont {
        italic ? font(newsreaderItalic, then: newsreaderItalicExt, size: size, weight: weight) : font(newsreader, then: newsreaderExt, size: size, weight: weight)
    }

    /// Everything that isn't the book: Inter.
    static func ui(size: CGFloat, weight: CGFloat = 400) -> UIFont {
        font(inter, then: nil, size: size, weight: weight)
    }

    private static let newsreader = descriptor("newsreader-latin-wght-normal")
    private static let newsreaderExt = descriptor("newsreader-latin-ext-wght-normal")
    private static let newsreaderItalic = descriptor("newsreader-latin-wght-italic")
    private static let newsreaderItalicExt = descriptor("newsreader-latin-ext-wght-italic")
    private static let inter = descriptor("inter-latin-wght-normal")

    /// The weight axis, by its tag.
    private static let weightAxis = NSNumber(value: 0x7767_6874) // 'wght'

    private static func descriptor(_ name: String) -> CTFontDescriptor? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "woff2"), let data = try? Data(contentsOf: url) else { return nil }
        return (CTFontManagerCreateFontDescriptorsFromData(data as CFData) as? [CTFontDescriptor])?.first
    }

    private static func font(_ main: CTFontDescriptor?, then fallback: CTFontDescriptor?, size: CGFloat, weight: CGFloat) -> UIFont {
        guard let main else { return .systemFont(ofSize: size, weight: weight >= 600 ? .semibold : .regular) }
        let weighted = { (d: CTFontDescriptor) in CTFontDescriptorCreateCopyWithAttributes(d, [kCTFontVariationAttribute: [weightAxis: weight]] as CFDictionary) }
        var attributes: [CFString: Any] = [kCTFontVariationAttribute: [weightAxis: weight]]
        if let fallback { attributes[kCTFontCascadeListAttribute] = [weighted(fallback)] }
        return CTFontCreateWithFontDescriptor(CTFontDescriptorCreateCopyWithAttributes(main, attributes as CFDictionary), size, nil) as UIFont
    }
}

extension Font {
    /// Inter, for SwiftUI, at a TV size.
    static func ui(_ size: CGFloat, weight: CGFloat = 400) -> Font {
        Font(Faces.ui(size: size.scaled, weight: weight) as CTFont)
    }

    /// Newsreader, for a book's title on its own, where it is the book speaking, at a TV size.
    static func book(_ size: CGFloat, weight: CGFloat = 400) -> Font {
        Font(Faces.text(size: size.scaled, weight: weight) as CTFont)
    }
}

extension BinaryInteger {
    /// A length at the TV's size, as this screen draws it (Look.scale).
    var scaled: CGFloat { CGFloat(self) * Look.scale }
}

extension BinaryFloatingPoint {
    /// A length at the TV's size, as this screen draws it (Look.scale).
    var scaled: CGFloat { CGFloat(self) * Look.scale }
}

extension EnvironmentValues {
    /// Whether the screen is taller than it is wide: an iPad held upright, where what the TV sets side by side is
    /// stacked. Never on a TV.
    @Entry var upright = false
}
