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
    /// The first sentence of each block; nil for a block with none.
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

    /// The words of some sentences that are in one block, from the first of them there to the last:
    /// one stretch to wash or underline. Nil when none of them is in it.
    func span(of sentences: ClosedRange<Int>, in block: Int) -> NSRange? {
        guard firstOfBlock.indices.contains(block), let start = firstOfBlock[block] else { return nil }
        var end = start
        while end < all.count && all[end].block == block { end += 1 }
        let from = max(sentences.lowerBound, start)
        let to = min(sentences.upperBound, end - 1)
        guard from <= to else { return nil }
        return NSRange(location: all[from].range.location, length: NSMaxRange(all[to].range) - all[from].range.location)
    }
}
