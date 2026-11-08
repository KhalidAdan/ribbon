import UIKit

/// A colour as bytes, for drawing and for comparing colours.
struct RGB: Equatable {
    let r: Int, g: Int, b: Int
    init(_ hex: UInt32) { r = Int(hex >> 16 & 0xff); g = Int(hex >> 8 & 0xff); b = Int(hex & 0xff) }
    init(r: Int, g: Int, b: Int) { self.r = r; self.g = g; self.b = b }
    var ui: UIColor { UIColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1) }
    var cg: CGColor { ui.cgColor }

    /// Hue, saturation and lightness, each 0 to 1.
    var hsl: (h: Double, s: Double, l: Double) {
        let r = Double(r) / 255, g = Double(g) / 255, b = Double(b) / 255
        let hi = max(r, g, b), lo = min(r, g, b), l = (hi + lo) / 2, d = hi - lo
        if d < 1e-6 { return (0, 0, l) }
        let s = d / (1 - abs(2 * l - 1))
        var h = hi == r ? ((g - b) / d).truncatingRemainder(dividingBy: 6) : hi == g ? (b - r) / d + 2 : (r - g) / d + 4
        h /= 6
        if h < 0 { h += 1 }
        return (h, min(1, s), l)
    }

    init(h: Double, s: Double, l: Double) {
        let light = max(0, min(1, l))
        let c = (1 - abs(2 * light - 1)) * s, x = c * (1 - abs((h * 6).truncatingRemainder(dividingBy: 2) - 1)), m = light - c / 2
        let v: (Double, Double, Double) = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)][Int(floor(h * 6)) % 6]
        let byte = { (u: Double) in Int(((u + m) * 255).rounded()) }
        self.init(r: byte(v.0), g: byte(v.1), b: byte(v.2))
    }
}

/// A book cloth, as a binder's swatch book has one: its colour, the lettering that reads on it, and the foil for the
/// rules and the number. `alternatives` are the next-nearest cloths, for when a neighbour already wears this one.
struct Cloth {
    let ground: RGB
    let ink: RGB
    let foil: RGB
    var alternatives: [Cloth] = []

    static let cream = RGB(0xf2ebdd), darkInk = RGB(0x1d1b18)
    static let gold = RGB(0xcdb27a), silver = RGB(0xc9ccd1), copper = RGB(0xc48d62)

    /// Eighteen cloths, deep and matte. Every cover is bound in the cloth nearest its own colour, so the shelf stays
    /// in tune however wild the covers are.
    static let swatches: [Cloth] = [
        Cloth(ground: RGB(0x6b1f24), ink: cream, foil: gold),            // oxblood
        Cloth(ground: RGB(0x8c3b2a), ink: cream, foil: gold),            // brick
        Cloth(ground: RGB(0xa65a2c), ink: cream, foil: RGB(0xeedcb6)),   // burnt orange
        Cloth(ground: RGB(0x9c7428), ink: darkInk, foil: darkInk),       // mustard
        Cloth(ground: RGB(0x5f6234), ink: cream, foil: gold),            // olive
        Cloth(ground: RGB(0x2f4b36), ink: cream, foil: gold),            // forest
        Cloth(ground: RGB(0x1e3f39), ink: cream, foil: copper),          // bottle green
        Cloth(ground: RGB(0x22595d), ink: cream, foil: silver),          // teal
        Cloth(ground: RGB(0x1f4a60), ink: cream, foil: silver),          // petrol
        Cloth(ground: RGB(0x1d2c4c), ink: cream, foil: gold),            // navy
        Cloth(ground: RGB(0x31437a), ink: cream, foil: silver),          // ink blue
        Cloth(ground: RGB(0x3d2a52), ink: cream, foil: gold),            // aubergine
        Cloth(ground: RGB(0x5e2944), ink: cream, foil: gold),            // plum
        Cloth(ground: RGB(0x8a4a4a), ink: cream, foil: RGB(0xf0dccb)),   // dusty rose
        Cloth(ground: RGB(0x4b5b67), ink: cream, foil: silver),          // slate
        Cloth(ground: RGB(0x2c2a27), ink: cream, foil: gold),            // charcoal
        Cloth(ground: RGB(0xcfc1a0), ink: darkInk, foil: RGB(0x7a2c26)), // stone, with red
        Cloth(ground: RGB(0xe7ddc8), ink: darkInk, foil: RGB(0x1f2f4f)), // cream, with navy
    ]

    /// The cloth nearest a colour, with the next four behind it: hue counts most where both are coloured, lightness and strength after.
    static func nearest(_ c: RGB) -> Cloth {
        let (h1, s1, l1) = c.hsl
        func distance(_ cloth: Cloth) -> Double {
            let (h2, s2, l2) = cloth.ground.hsl
            let hue = min(abs(h1 - h2), 1 - abs(h1 - h2)) * 2 * min(s1, s2) * 3
            return hue * hue + (s1 - s2) * (s1 - s2) * 0.6 + (l1 - l2) * (l1 - l2) * 1.2
        }
        let ranked = swatches.sorted { distance($0) < distance($1) }
        var first = ranked[0]
        first.alternatives = Array(ranked.dropFirst().prefix(4))
        return first
    }

    /// The colour a cover is bound in, from its pixels (RGBA, a small sample of the picture): its most characteristic
    /// colour, not its commonest, which is the strongest hue that covers real area. Set a little deeper than print, as
    /// cloth is, unless the cover itself is pale. Its cloth is the swatch nearest this colour.
    static func coverColour(pixels px: [UInt8]) -> RGB {
        let buckets = 24, n = px.count / 4
        var weight = [Double](repeating: 0, count: buckets)
        var sums = [(Double, Double, Double)](repeating: (0, 0, 0), count: buckets)
        var lightness = 0.0, coloured = 0
        for i in stride(from: 0, to: n * 4, by: 4) {
            let c = RGB(r: Int(px[i]), g: Int(px[i + 1]), b: Int(px[i + 2]))
            let (h, s, l) = c.hsl
            lightness += l
            guard s > 0.22, l > 0.1, l < 0.9 else { continue }
            coloured += 1
            let bucket = Int(h * Double(buckets)) % buckets
            let w = pow(s, 1.5) * (1 - abs(l - 0.5))
            weight[bucket] += w
            sums[bucket].0 += Double(c.r) * w; sums[bucket].1 += Double(c.g) * w; sums[bucket].2 += Double(c.b) * w
        }
        let averageLightness = lightness / Double(max(1, n))
        // A cover with hardly any colour: the neutral cloth nearest its lightness.
        if coloured < n / 12 { return RGB(h: 0.08, s: 0.06, l: averageLightness < 0.5 ? 0.2 : 0.82) }
        func around(_ b: Int) -> Double { weight[(b + buckets - 1) % buckets] + weight[b] + weight[(b + 1) % buckets] }
        let best = (0 ..< buckets).max { around($0) < around($1) }!
        var total = (0.0, 0.0, 0.0), w = 0.0
        for j in [best - 1, best, best + 1] {
            let k = (j + buckets) % buckets
            total.0 += sums[k].0; total.1 += sums[k].1; total.2 += sums[k].2; w += weight[k]
        }
        let (h, s, l) = RGB(r: Int(total.0 / w), g: Int(total.1 / w), b: Int(total.2 / w)).hsl
        return RGB(h: h, s: s, l: l * (averageLightness > 0.55 ? 1 : 0.8))
    }

    /// The cloth for a book with no cover to read: a quiet colour of its own, the same on every device.
    static func forBook(_ id: String) -> Cloth {
        let h = stableHash(id + "hue")
        return h % 11 == 0 ? nearest(RGB(0x2b2926)) : nearest(RGB(h: Double(h % 1000) / 1000, s: 0.5, l: 0.35))
    }
}
