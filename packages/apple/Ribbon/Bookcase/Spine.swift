import CoreText
import UIKit

// A spine set the way a publisher sets a series: one cloth, a foil for the rules and the volume number, the title at
// one size across the shelf, the author's surname at the foot. Drawn with Core Graphics into the pictures the 3D book wears.

/// A typeface as the spines use it: Newsreader or Inter at a weight, in capitals or not, tracked, and its leading.
struct SpineFace {
    let serif: Bool
    let weight: CGFloat
    let upper: Bool
    let tracking: CGFloat
    let lineHeight: CGFloat

    func font(_ size: CGFloat) -> UIFont { serif ? Faces.text(size: size, weight: weight) : Faces.ui(size: size, weight: weight) }

    /// The spines' type: the title in Newsreader capitals, the surname in small Inter capitals, the number in Newsreader.
    static let title = SpineFace(serif: true, weight: 500, upper: true, tracking: 0.09, lineHeight: 1.12)
    static let author = SpineFace(serif: false, weight: 600, upper: true, tracking: 0.18, lineHeight: 1)
    static let number = SpineFace(serif: true, weight: 500, upper: false, tracking: 0, lineHeight: 1)
    static let label = SpineFace(serif: false, weight: 600, upper: true, tracking: 0.1, lineHeight: 1)
}

/// The title's size on every spine with room for it, and the smallest it may go; the author's size. At k = 1.
private let titleSize: CGFloat = 12, smallestTitle: CGFloat = 7.5, authorTarget: CGFloat = 6.4

private var widths: [String: CGFloat] = [:]
private let widthsLock = NSLock()

/// How long a run of text is per point of type, tracking included. Safe from any thread.
func measure(_ text: String, _ face: SpineFace) -> CGFloat {
    let key = "\(face.serif)\(face.weight)|\(text)"
    widthsLock.lock(); let cached = widths[key]; widthsLock.unlock()
    let w: CGFloat
    if let cached { w = cached } else {
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: face.font(100)]))
        w = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)) / 100
        widthsLock.lock(); widths[key] = w; widthsLock.unlock()
    }
    return w + face.tracking * CGFloat(max(0, text.utf16.count - 1))
}

/// A picture drawn with Core Graphics, in plain 8-bit colour: Metal refuses an extended-range picture in some of a material's slots.
/// `clear` draws over nothing, for lettering laid on something else.
func picture(_ w: CGFloat, _ h: CGFloat, scale: CGFloat, clear: Bool = false, _ draw: (CGContext) -> Void) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = scale
    format.opaque = !clear
    format.preferredRange = .standard
    return UIGraphicsImageRenderer(size: CGSize(width: max(1, w), height: max(1, h)), format: format).image { draw($0.cgContext) }
}

/// A run of text centred on x, its baseline at y.
func drawRun(_ text: String, _ face: SpineFace, _ size: CGFloat, x: CGFloat, baseline: CGFloat, colour: UIColor) {
    let font = face.font(size)
    let attr = NSAttributedString(string: text, attributes: [.font: font, .kern: face.tracking * size, .foregroundColor: colour])
    attr.draw(at: CGPoint(x: x - measure(text, face) * size / 2, y: baseline - font.ascender))
}

/// Sideways, as a printed spine turns its words: top to bottom, the first line on the right.
private func drawSideways(_ ctx: CGContext, _ lines: [String], _ face: SpineFace, _ size: CGFloat, cx: CGFloat, cy: CGFloat, colour: UIColor) {
    ctx.saveGState()
    ctx.translateBy(x: cx, y: cy)
    ctx.rotate(by: .pi / 2)
    let capMid = face.font(size).capHeight / 2, pitch = size * face.lineHeight
    for (i, line) in lines.enumerated() {
        drawRun(line, face, size, x: 0, baseline: (CGFloat(i) - CGFloat(lines.count - 1) / 2) * pitch + capMid, colour: colour)
    }
    ctx.restoreGState()
}

private let noise: CGImage = {
    let n = 64
    var bytes = [UInt8](repeating: 255, count: n * n * 4)
    for i in stride(from: 0, to: bytes.count, by: 4) { let v = UInt8.random(in: 0 ... 255); bytes[i] = v; bytes[i + 1] = v; bytes[i + 2] = v }
    let ctx = CGContext(data: &bytes, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    return ctx.makeImage()!
}()

/// A faint grain, so cloth reads as matte stuff rather than flat colour.
private func grain(_ ctx: CGContext, _ rect: CGRect, alpha: CGFloat) {
    ctx.saveGState()
    ctx.clip(to: rect)
    ctx.setAlpha(alpha)
    ctx.setBlendMode(.overlay)
    ctx.draw(noise, in: CGRect(x: 0, y: 0, width: 32, height: 32), byTiling: true)
    ctx.restoreGState()
}

/// The surname, as a spine carries it: the last word of the first author.
func surnameOf(_ author: String) -> String {
    let first = author.components(separatedBy: CharacterSet(charactersIn: ",&")).first ?? author
    return first.trimmingCharacters(in: .whitespaces).split(separator: " ").last.map(String.init) ?? ""
}

/// What a spine says: the volume number, if the title carries one ("29. Vengeful Spirit", "…, Book 7"), and the title
/// before its subtitle. The lectern shows the whole title; a spine, like a printed one, carries the short form.
func spineTitle(_ title: String) -> (number: String?, main: String) {
    var rest = title, number: String?
    if let m = try? NSRegularExpression(pattern: "^(\\d+)\\.\\s+").firstMatch(in: rest, range: NSRange(rest.startIndex..., in: rest)),
       let digits = Range(m.range(at: 1), in: rest), let whole = Range(m.range, in: rest) {
        number = String(Int(rest[digits]) ?? 0)
        rest = String(rest[whole.upperBound...])
    }
    let parts = rest.components(separatedBy: ": ")
    if number == nil, let volume = try? NSRegularExpression(pattern: "\\b(?:Book|Volume|Part)\\s+([0-9IVX]+)") {
        for part in parts.dropFirst() {
            if let m = volume.firstMatch(in: part, range: NSRange(part.startIndex..., in: part)), let r = Range(m.range(at: 1), in: part) { number = String(part[r]); break }
        }
    }
    return (number, parts[0])
}

/// A title on one line, the best break into two, and the best into three: the ones whose longest line is shortest.
private func titleLines(_ title: String, _ face: SpineFace) -> [[String]] {
    let words = title.split(whereSeparator: \.isWhitespace).map(String.init)
    let longest = { (parts: [String]) in parts.map { measure($0, face) }.max() ?? 0 }
    var options = [[words.joined(separator: " ")]]
    if words.count > 1 {
        options.append((1 ..< words.count).map { [words[..<$0].joined(separator: " "), words[$0...].joined(separator: " ")] }.min { longest($0) < longest($1) }!)
    }
    if words.count > 2 {
        var three: [[String]] = []
        for i in 1 ..< words.count - 1 {
            for j in i + 1 ..< words.count { three.append([words[..<i], words[i ..< j], words[j...]].map { $0.joined(separator: " ") }) }
        }
        options.append(three.min { longest($0) < longest($1) }!)
    }
    return options
}

/// A spine laid out: its size and where everything on it goes, from the top, in points.
struct SpineLayout {
    let width: CGFloat
    let height: CGFloat
    let number: String?
    let numberSize: CGFloat
    let numberMid: CGFloat
    /// The finished tick's diameter, or 0.
    let tick: CGFloat
    let tickMid: CGFloat
    let lines: [String]
    let size: CGFloat
    let titleTop: CGFloat
    let titleBottom: CGFloat
    let author: String?
    let authorSize: CGFloat
    let authorMid: CGFloat
    /// From the head (and the foot) to the first rule.
    let edge: CGFloat

    /// Fit a spine: the title at the shelf's one size if it fits on one line, then two, then three; smaller only when it
    /// must, and wider before it gets too small. Never cut.
    init(_ b: ShelfBook, k: CGFloat) {
        let (number, main) = spineTitle(b.title)
        let options = titleLines(main.uppercased(), SpineFace.title)
        let (startWidth, H) = spineSize(b, k)
        let surname = surnameOf(b.author).uppercased()
        let step = max(1, (2 * k).rounded())
        var W = startWidth
        var withAuthor = !surname.isEmpty
        while true {
            let pad = max(3 * k, W * 0.17), across = W - 2 * pad
            let edge = 7 * k, rules = 6 * k
            var y = edge + rules
            let numberSize = number.map { min(9 * k, across / max(0.5, measure($0, SpineFace.number))) } ?? 0
            let numberMid = y + numberSize * 0.5 + 3 * k
            if number != nil { y += numberSize + 7 * k }
            let tick = b.finished ? min(across + 2, 10 * k) : 0
            let tickMid = y + tick / 2 + 1 * k
            if tick > 0 { y += tick + 5 * k }
            let titleTop = y + 3 * k
            let authorSize = min(authorTarget * k, across * 0.9)
            let authorLength = withAuthor ? measure(surname, SpineFace.author) * authorSize : 0
            let footStart = H - edge - rules
            let authorMid = footStart - 5 * k - authorLength / 2
            let titleBottom = withAuthor ? authorMid - authorLength / 2 - 9 * k : footStart - 4 * k
            let along = titleBottom - titleTop
            var chosen: ([String], CGFloat)?
            var best: ([String], CGFloat) = (options[0], 0)
            for lines in options {
                let longest = lines.map { measure($0, SpineFace.title) }.max() ?? 1
                let fit = min(across / (CGFloat(lines.count) * SpineFace.title.lineHeight), along / longest)
                if fit >= titleSize * k { chosen = (lines, titleSize * k); break }
                if fit > best.1 { best = (lines, fit) }
            }
            let pick = chosen ?? best
            // Wide enough, or as wide as a spine goes with the author already given up.
            if pick.1 >= smallestTitle * k || (W >= 64 * k && !withAuthor) {
                self.width = W; self.height = H; self.number = number; self.numberSize = numberSize; self.numberMid = numberMid
                self.tick = tick; self.tickMid = tickMid; self.lines = pick.0; self.size = max(pick.1, smallestTitle * k * 0.9)
                self.titleTop = titleTop; self.titleBottom = titleBottom; self.author = withAuthor ? surname : nil
                self.authorSize = authorSize; self.authorMid = authorMid; self.edge = edge
                return
            }
            if W < 64 * k { W += step } else { withAuthor = false }
        }
    }

    /// Draw the spine in its cloth. `mask` draws the same spine as a map for the 3D book's foil, in the cloth given
    /// (black and grey for what's metal, light and dark for what's smooth): no grain, no tick.
    func draw(_ ctx: CGContext, cloth p: Cloth, k: CGFloat, mask: Bool = false) {
        let W = width, H = height
        ctx.setFillColor(p.ground.cg); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        if !mask { grain(ctx, CGRect(x: 0, y: 0, width: W, height: H), alpha: 0.05) }
        // Hairline pairs at the head and the foot, in the foil.
        let hair = max(0.75, 0.7 * k)
        ctx.setFillColor(p.foil.cg)
        for y in [edge, edge + 3 * k, H - edge - hair, H - edge - 3 * k - hair] { ctx.fill(CGRect(x: 0, y: y, width: W, height: hair)) }
        // The volume number, upright, as a series' spines carry it.
        if let n = number {
            drawRun(n, SpineFace.number, numberSize, x: W / 2, baseline: numberMid + SpineFace.number.font(numberSize).capHeight / 2, colour: p.foil.ui)
        }
        if tick > 0, !mask { drawTick(ctx, cx: W / 2, cy: tickMid, d: tick, under: p.ground) }
        drawSideways(ctx, lines, SpineFace.title, size, cx: W / 2, cy: (titleTop + titleBottom) / 2, colour: p.ink.ui)
        if let author {
            // A short rule just before the author.
            ctx.setFillColor(p.foil.cg)
            ctx.fill(CGRect(x: W * 0.36, y: titleBottom + 4 * k, width: W * 0.28, height: hair))
            drawSideways(ctx, [author], SpineFace.author, authorSize, cx: W / 2, cy: authorMid, colour: p.ink.ui.withAlphaComponent(0.78))
        }
    }
}

/// A finished book's tick, in a small disc.
private func drawTick(_ ctx: CGContext, cx: CGFloat, cy: CGFloat, d: CGFloat, under: RGB) {
    let dark = (0.299 * Double(under.r) + 0.587 * Double(under.g) + 0.114 * Double(under.b)) / 255 > 0.6
    ctx.setFillColor(RGB(dark ? 0x1d1b18 : 0xfbfaf7).cg)
    ctx.fillEllipse(in: CGRect(x: cx - d / 2, y: cy - d / 2, width: d, height: d))
    ctx.setStrokeColor(RGB(dark ? 0xfbfaf7 : 0x1a1a1a).cg)
    ctx.setLineWidth(d * 0.11)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.move(to: CGPoint(x: cx - d * 0.2, y: cy + d * 0.02))
    ctx.addLine(to: CGPoint(x: cx - d * 0.06, y: cy + d * 0.16))
    ctx.addLine(to: CGPoint(x: cx + d * 0.21, y: cy - d * 0.16))
    ctx.strokePath()
}

/// A book's front board, for the book in your hand: its own cover. Square audiobook art sits at the top of a
/// book-shaped cover with the title on a band below, as a jacket would set it; with no cover, the title on its cloth.
func drawFront(_ ctx: CGContext, _ w: CGFloat, _ h: CGFloat, _ b: ShelfBook, cover: CGImage?, cloth p: Cloth) {
    ctx.setFillColor(p.ground.cg); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    let art = cover.map { (image: $0, w: CGFloat($0.width), h: CGFloat($0.height)) }
    let square = art.map { abs($0.w / $0.h - 1) < 0.15 } ?? false
    if let art, !square || h <= w * 1.1 { fill(art.image, CGRect(x: 0, y: 0, width: w, height: h)); return }
    if let art { fill(art.image, CGRect(x: 0, y: 0, width: w, height: w)) }
    let band = art == nil ? h : h - w, top = art == nil ? 0 : w
    let face = SpineFace(serif: true, weight: 500, upper: false, tracking: 0, lineHeight: 1.1)
    var size = band * (art == nil ? 0.1 : 0.26), lines = [b.title]
    while size > band * 0.04 {
        lines = wrapWords(b.title, face, size, w * 0.84)
        if lines.count <= (art == nil ? 4 : 2), lines.allSatisfy({ measure($0, face) * size <= w * 0.86 }) { break }
        size *= 0.93
    }
    let shown = Array(lines.prefix(art == nil ? 4 : 2))
    let capMid = face.font(size).capHeight / 2, cy = top + band * 0.42
    for (i, l) in shown.enumerated() {
        drawRun(l, face, size, x: w / 2, baseline: cy + (CGFloat(i) - CGFloat(shown.count - 1) / 2) * size * 1.1 + capMid, colour: p.ink.ui)
    }
    let author = b.author.uppercased()
    let authorSize = min(band * (art == nil ? 0.035 : 0.11), w * 0.8 / max(1, measure(author, SpineFace.label)))
    drawRun(author, SpineFace.label, authorSize, x: w / 2, baseline: h - band * 0.14, colour: p.ink.ui.withAlphaComponent(0.8))
}

/// A picture filling a rectangle, cropped to its shape.
private func fill(_ image: CGImage, _ rect: CGRect) {
    let iw = CGFloat(image.width), ih = CGFloat(image.height)
    let scale = max(rect.width / iw, rect.height / ih)
    let w = rect.width / scale, h = rect.height / scale
    if let crop = image.cropping(to: CGRect(x: (iw - w) / 2, y: (ih - h) / 2, width: w, height: h)) { UIImage(cgImage: crop).draw(in: rect) }
}

private func wrapWords(_ text: String, _ face: SpineFace, _ size: CGFloat, _ maxWidth: CGFloat) -> [String] {
    var lines: [String] = [], line = ""
    for word in text.split(separator: " ").map(String.init) {
        let t = line.isEmpty ? word : "\(line) \(word)"
        if !line.isEmpty, measure(t, face) * size > maxWidth { lines.append(line); line = word } else { line = t }
    }
    if !line.isEmpty { lines.append(line) }
    return lines
}
