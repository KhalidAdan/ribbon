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

    /// How closely the read-along follows the narration, measured when the server made it
    /// (src/core/reading/readalong.ts, `ReadAlongCheck`). Missing from a server older than the check.
    struct Check: Decodable {
        /// Of the sentences read, the share placed to the sentence; the rest are placed by how far through their
        /// chapter they are.
        let placed: Double
        /// Narration heard with nothing marked, in all and the longest stretch of it: how the read-along is felt
        /// (#163). Missing from an older server, or a book whose narration isn't transcribed.
        let unmarked: Unmarked?

        struct Unmarked: Decodable {
            let totalMs: Int
            let longestMs: Int
        }

        /// What to tell someone opening the book when it doesn't read along by sentence throughout; nil when it does.
        var caveat: (title: String, hint: String)? {
            if let unmarked {
                // A minute unmarked at most is how Voidscarred reads, and every book that reads along well.
                guard unmarked.longestMs > 60_000 else { return nil }
                let minutes = Int((Double(unmarked.longestMs) / 60_000).rounded())
                return ("Read-along drops out for up to \(minutes) \(minutes == 1 ? "minute" : "minutes") in this book", "Elsewhere each sentence is marked as it's read")
            }
            guard placed < 0.9 else { return nil }
            if placed < 0.1 {
                return ("Read-along by chapter", "The narration isn't transcribed, so the words can be up to a minute from the voice")
            }
            return ("Read-along to the sentence in \(Int((placed * 100).rounded()))% of this book", "Elsewhere it's by chapter, so the words can be up to a minute from the voice")
        }
    }

    /// How many minutes of the narration are transcribed, of how many.
    struct Transcribed: Decodable {
        let done: Int
        let total: Int
    }

    let contents: [Entry]
    let blocks: [Block]
    let check: Check?
    /// Whether it reads along: its narration is transcribed whole (#152). Missing from an older server, which always did.
    let ready: Bool?
    let transcribed: Transcribed?

    /// Reads along, marking and following the narrator's sentence; else the book opens to read only, at your place.
    var readsAlong: Bool { ready ?? true }

    /// What to tell someone opening a book that doesn't read along yet.
    var notReady: (title: String, hint: String)? {
        guard !readsAlong else { return nil }
        let share = transcribed.map { $0.total > 0 ? Int((Double($0.done) / Double($0.total) * 100).rounded(.down)) : 0 } ?? 0
        return ("Reading only for now", "Read-along comes once the narration is transcribed, \(share)% so far, on a computer with Ribbon and a graphics card")
    }
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

    /// The sentence a character of a block is in: what a finger lands on. In a block without sentences, a break
    /// between scenes, the next sentence after it. Nil in a book without any.
    func at(_ character: Int, in block: Int) -> Int? {
        guard firstOfBlock.indices.contains(block) else { return nil }
        guard let start = firstOfBlock[block] else {
            return firstOfBlock[block...].lazy.compactMap { $0 }.first ?? (all.isEmpty ? nil : all.count - 1)
        }
        var found = start
        while found + 1 < all.count && all[found + 1].block == block && all[found + 1].range.location <= character { found += 1 }
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
