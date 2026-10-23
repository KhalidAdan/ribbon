import Foundation

/// A book's text with when each of its sentences is read, as the server
/// makes it (src/core/reading/readalong.ts, `ReadAlong`): the TV can't
/// parse an EPUB or pair it with the narration, so the server does both,
/// with the same code the apps use.
struct ReadAlong: Decodable {
    struct Entry: Decodable {
        let title: String
        /// The block it starts at.
        let block: Int
    }

    struct Block: Decodable {
        enum Kind: String, Decodable {
            /// A paragraph, a heading, a break between scenes.
            case p, h, hr
        }

        let k: Kind
        let level: Int?
        let runs: [Run]?
        let indent: Bool?
        let center: Bool?
        let space: Bool?
        let quote: Bool?
        let sentences: [Sentence]?
    }

    struct Run: Decodable {
        let t: String
        let i: Bool?
        let b: Bool?
    }

    /// Where a sentence starts and ends in its block's text (UTF-16, as NSString counts), and when it's read.
    struct Sentence: Decodable {
        let start: Int
        let end: Int
        let ms: Int
        let endMs: Int
        /// Placed to the sentence by a transcript, not only by its chapter: the one being read is marked.
        let exact: Bool
    }

    let contents: [Entry]
    let blocks: [Block]
}

/// Every sentence of a book in order, counted across it the way the server
/// counts them: the remote steps through them, and the narration is followed
/// by them.
struct Sentences {
    struct Sentence {
        let block: Int
        /// In the block's text.
        let range: NSRange
        let ms: Int
        let endMs: Int
        let exact: Bool
        /// Text the narration skips (a title page, a contents) starts and ends at once.
        var narrated: Bool { endMs > ms }
    }

    let all: [Sentence]
    /// The first sentence of each block, for stepping a paragraph at a time; nil for a block with none.
    let firstOfBlock: [Int?]

    init(_ readAlong: ReadAlong) {
        var all: [Sentence] = []
        var first: [Int?] = []
        for (index, block) in readAlong.blocks.enumerated() {
            let sentences = block.sentences ?? []
            first.append(sentences.isEmpty ? nil : all.count)
            all += sentences.map { Sentence(block: index, range: NSRange(location: $0.start, length: $0.end - $0.start), ms: $0.ms, endMs: $0.endMs, exact: $0.exact) }
        }
        self.all = all
        firstOfBlock = first
    }

    var count: Int { all.count }

    subscript(index: Int) -> Sentence { all[index] }

    /// The sentence being read at a moment of the recording: the last narrated one started by then
    /// (src/core/reading/readalong.ts, `sentenceReadAt`).
    func read(at ms: Int) -> Int {
        // Sentences start in the order they're read, so the last one started is found by halves.
        var low = 0
        var high = all.count
        while low < high {
            let mid = (low + high) / 2
            if all[mid].ms <= ms { low = mid + 1 } else { high = mid }
        }
        var found = max(0, low - 1)
        while found > 0 && !all[found].narrated { found -= 1 }
        return found
    }

    /// The first sentence of the paragraph `by` paragraphs from the one this sentence is in.
    func paragraph(from index: Int, by step: Int) -> Int {
        let blocks = firstOfBlock.indices
        var block = all[index].block
        // Back from the middle of a paragraph is to its own start.
        if step < 0, let start = firstOfBlock[block], start < index { return start }
        var left = abs(step)
        while left > 0 {
            block += step > 0 ? 1 : -1
            guard blocks.contains(block) else { return step > 0 ? all.count - 1 : 0 }
            if firstOfBlock[block] != nil { left -= 1 }
        }
        return firstOfBlock[block]!
    }
}
