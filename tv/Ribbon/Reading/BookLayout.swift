import UIKit

/// A book's read-along set in type for the TV, once, when it opens: each
/// block a paragraph laid out by TextKit at the column's width. Every
/// sentence's place on the column is then known exactly, and a paragraph is
/// drawn exactly as it was measured. The same idea as the web reader, which
/// lays out every line itself (docs/READING.md, section 1).
///
/// Made off the main thread (TextKit's own objects may be, before anything
/// draws them), then only read.
final class BookLayout: @unchecked Sendable {
    /// The type, for reading from a sofa three metres away: about sixty letters a line. On the iPad, at arm's
    /// length, the same sixty letters a line, the column narrow enough for an iPad mini held upright, so turning
    /// the iPad keeps every line as it was.
    enum Measure {
        #if os(tvOS)
        static let width: CGFloat = 1200
        static let size: CGFloat = 42
        static let lineHeight: CGFloat = 68
        #else
        static let width: CGFloat = 680
        static let size: CGFloat = 24
        static let lineHeight: CGFloat = 39
        #endif
        static let indent = size * 1.5
    }

    final class Paragraph {
        /// Where it sits on the column.
        let top: CGFloat
        let height: CGFloat
        private let storage: NSTextStorage
        private let manager = NSLayoutManager()
        private let container: NSTextContainer
        /// The height of its letters, from the top of the tallest to the bottom of the lowest: what a wash covers.
        private let letters: CGFloat

        init(_ text: NSAttributedString, top: CGFloat, letters: CGFloat) {
            storage = NSTextStorage(attributedString: text)
            container = NSTextContainer(size: CGSize(width: Measure.width, height: .greatestFiniteMagnitude))
            container.lineFragmentPadding = 0
            manager.addTextContainer(container)
            storage.addLayoutManager(manager)
            manager.ensureLayout(for: container)
            self.top = top
            self.letters = letters
            height = ceil(manager.usedRect(for: container).height)
        }

        /// A stretch of the paragraph's text, line by line, as boxes around its letters: what is washed behind it.
        func lineBoxes(_ range: NSRange) -> [CGRect] {
            let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            var boxes: [CGRect] = []
            manager.enumerateLineFragments(forGlyphRange: glyphs) { line, _, _, lineGlyphs, _ in
                let part = NSIntersectionRange(lineGlyphs, glyphs)
                guard part.length > 0 else { return }
                let run = self.manager.boundingRect(forGlyphRange: part, in: self.container)
                boxes.append(CGRect(x: run.minX, y: line.midY - self.letters / 2, width: run.width, height: self.letters))
            }
            return boxes
        }

        /// Draw its words, at the top left of the current context.
        func draw() {
            manager.drawGlyphs(forGlyphRange: manager.glyphRange(for: container), at: .zero)
        }

        /// Draw only a stretch of its words, where they are in the paragraph.
        func draw(_ range: NSRange) {
            manager.drawGlyphs(forGlyphRange: manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil), at: .zero)
        }

        /// The character nearest a point in the paragraph: where a finger lands on its words.
        func character(at point: CGPoint) -> Int {
            manager.characterIndexForGlyph(at: manager.glyphIndex(for: point, in: container))
        }
    }

    let paragraphs: [Paragraph]
    let height: CGFloat

    init(_ readAlong: ReadAlong) {
        var paragraphs: [Paragraph] = []
        var y: CGFloat = 0
        for block in readAlong.blocks {
            let set = Self.set(block)
            y += set.before
            let paragraph = Paragraph(set.text, top: y, letters: set.letters)
            paragraphs.append(paragraph)
            y += paragraph.height + set.after
        }
        self.paragraphs = paragraphs
        height = y
    }

    /// The paragraphs that reach into a stretch of the column, found by halves.
    func paragraphs(from top: CGFloat, to bottom: CGFloat) -> Range<Int> {
        var low = 0
        var high = paragraphs.count
        while low < high {
            let mid = (low + high) / 2
            if paragraphs[mid].top + paragraphs[mid].height < top { low = mid + 1 } else { high = mid }
        }
        var end = low
        while end < paragraphs.count && paragraphs[end].top <= bottom { end += 1 }
        return low..<end
    }

    /// The paragraph at a height on the column; in the room between two, the one below. Nil for a book with none.
    func paragraph(at y: CGFloat) -> Int? {
        guard !paragraphs.isEmpty else { return nil }
        return min(paragraphs(from: y, to: y).lowerBound, paragraphs.count - 1)
    }

    /// The box around a sentence's first line on the column: what the side buttons sit beside.
    func firstLine(of sentence: Sentences.Sentence) -> CGRect? {
        let paragraph = paragraphs[sentence.block]
        return paragraph.lineBoxes(sentence.range).first?.offsetBy(dx: 0, dy: paragraph.top)
    }

    /// Where a sentence is on the column: the box around all its lines.
    func frame(of sentence: Sentences.Sentence) -> CGRect {
        let paragraph = paragraphs[sentence.block]
        let boxes = paragraph.lineBoxes(sentence.range)
        guard let first = boxes.first else { return CGRect(x: 0, y: paragraph.top, width: Measure.width, height: paragraph.height) }
        return boxes.dropFirst().reduce(first) { $0.union($1) }.offsetBy(dx: 0, dy: paragraph.top)
    }

    /// A block in type: its text with its faces and paragraph style, the room above and below it, and how tall its letters are.
    private static func set(_ block: ReadAlong.Block) -> (text: NSAttributedString, before: CGFloat, after: CGFloat, letters: CGFloat) {
        let style = NSMutableParagraphStyle()
        let lineHeight: CGFloat
        let font: (ReadAlong.Run) -> UIFont
        var colour = Look.ink
        var before: CGFloat = 0
        var after: CGFloat = 0
        switch block.k {
        case .h:
            let big = (block.level ?? 1) <= 2
            let size = Measure.size * (big ? 1.4 : 1.15)
            lineHeight = round(size * 1.35)
            font = { _ in Faces.text(size: size, weight: 600) }
            style.alignment = .center
            before = Measure.lineHeight * (big ? 2 : 1.25)
            after = Measure.lineHeight * 0.5
        case .hr:
            lineHeight = Measure.lineHeight
            font = { _ in Faces.text(size: Measure.size) }
            colour = Look.ink3
            style.alignment = .center
            before = Measure.lineHeight * 0.5
            after = Measure.lineHeight * 0.5
        case .p:
            lineHeight = Measure.lineHeight
            font = { run in Faces.text(size: Measure.size, weight: run.b == true ? 650 : 400, italic: run.i == true) }
            // Justified, with words broken where the language allows, as a book is set.
            style.alignment = block.center == true ? .center : .justified
            style.hyphenationFactor = block.center == true ? 0 : 1
            style.firstLineHeadIndent = block.indent == true ? Measure.indent : 0
            if block.quote == true {
                style.headIndent += Measure.indent
                style.firstLineHeadIndent += Measure.indent
                style.tailIndent = -Measure.indent
            }
            before = block.space == true ? Measure.lineHeight * 0.75 : 0
        }
        style.minimumLineHeight = lineHeight
        style.maximumLineHeight = lineHeight
        let runs = block.k == .hr ? [ReadAlong.Run(t: "·   ·   ·", i: nil, b: nil)] : block.runs ?? []
        let text = NSMutableAttributedString()
        var letters: CGFloat = 0
        for run in runs {
            let face = font(run)
            letters = max(letters, face.lineHeight)
            // A line taller than its letters puts the room above them; half of it goes back below, so they sit in the middle.
            text.append(NSAttributedString(string: run.t, attributes: [.font: face, .foregroundColor: colour, .paragraphStyle: style, .baselineOffset: (lineHeight - face.lineHeight) / 2]))
        }
        return (text, before, after, letters)
    }
}
