import ImageIO
import SwiftUI
import UIKit

/// A comic open to read (docs/COMICS.md, section 7): its pages come from the server one at a time, the few around
/// the one being read are kept decoded, and the page is told to the server, which keeps it for every other device.
///
/// As the desktop's comic reader has it (packages/core/src/comic/): a page is its number among the comic's pages,
/// counted here from 0 and to the server from 1; it is finished on its last page; time with it counts as reading.
@MainActor
@Observable
final class ComicSession {
    let book: ServerBook
    let pages: [ServerBookDetail.Page]
    /// Read right to left, as the comic says of itself: a turn forward goes to the left.
    let rightToLeft: Bool
    /// The page being read, counted from 0.
    private(set) var page: Int
    /// The pages kept decoded, by number: the one being read and the few around it.
    private(set) var pictures: [Int: UIImage] = [:]
    /// A page that couldn't be fetched, in the server's words.
    private(set) var problem: String?

    private let server: RibbonServer
    private let keepsSessions: Bool
    private var fetching: [Int: Task<Void, Never>] = [:]
    private var resting: Task<Void, Never>?
    /// Reading going on now: when it started and last moved, and the pages it ran between.
    private var stretch: (start: Date, last: Date, from: Int, to: Int)?
    /// Set once a page is turned: opening a comic is not reading it.
    private var moved = false

    /// How long a page stays before the server is told of it, as the text reader waits.
    private static let rest: Duration = .seconds(5)
    /// Longer than this without a turn and the reader has looked away: the stretch ends where they did.
    private static let idleAfter: TimeInterval = 5 * 60
    /// A stretch shorter than this isn't kept, and one that ends is given this long past its last turn.
    private static let shortest: TimeInterval = 30
    private static let lingerFor: TimeInterval = 60

    init(book: ServerBook, server: RibbonServer, pages: [ServerBookDetail.Page], rightToLeft: Bool, place: ComicPlace?, keepsSessions: Bool) {
        self.book = book
        self.server = server
        self.pages = pages
        self.rightToLeft = rightToLeft
        self.keepsSessions = keepsSessions
        page = ComicPaging.clamp((place?.page ?? 1) - 1, of: pages.count)
        fill()
    }

    var count: Int { pages.count }
    /// How far through, 0 on the first page and 1 on the last.
    var fraction: Double { ComicPaging.progress(page: page, of: count) }
    var hasNext: Bool { page + 1 < count }
    var hasPrevious: Bool { page > 0 }

    func next() { turn(to: page + 1) }
    func previous() { turn(to: page - 1) }

    /// Turn to a page, counted from 0.
    func turn(to wanted: Int) {
        let to = ComicPaging.clamp(wanted, of: count)
        guard to != page else { return }
        page = to
        moved = true
        timeOn()
        fill()
        // Told once the reader settles on a page, not at every one flicked past.
        resting?.cancel()
        resting = Task { [weak self] in
            try? await Task.sleep(for: Self.rest)
            guard !Task.isCancelled else { return }
            self?.tellPlace(why: .periodic)
        }
    }

    /// Out of the comic: its page is kept, if it was read, and the stretch of reading ends.
    func close() {
        resting?.cancel()
        if moved { tellPlace(why: .close) }
        endStretch()
        for task in fetching.values { task.cancel() }
        fetching = [:]
    }

    private func tellPlace(why: Why) {
        let (server, id, at) = (server, book.id, page + 1)
        Task { try? await server.tell(page: at, why: why, in: id) }
    }

    // Time spent reading ---------------------------------------------------

    /// Reading going on now and not sent yet, for the daily goal.
    var stretchMs: Int {
        guard let stretch else { return 0 }
        return Int(min(Date.now, stretch.last.addingTimeInterval(Self.lingerFor)).timeIntervalSince(stretch.start) * 1000)
    }

    private func timeOn() {
        let now = Date.now
        if let s = stretch, now.timeIntervalSince(s.last) > Self.idleAfter { endStretch(at: now) }
        if stretch != nil {
            stretch?.last = now
            stretch?.to = page
        } else {
            stretch = (now, now, page, page)
        }
    }

    /// The stretch of reading ends: kept by the server when it was long enough, as a text's is.
    func endStretch(at time: Date = .now) {
        guard let s = stretch else { return }
        stretch = nil
        let end = min(time, s.last.addingTimeInterval(Self.lingerFor))
        guard end.timeIntervalSince(s.start) >= Self.shortest else { return }
        let (server, id, keep) = (server, book.id, keepsSessions)
        Task { try? await server.read(from: s.start, to: end, pages: s.from + 1, to: s.to + 1, keep: keep, in: id) }
    }

    // Pages kept ready -----------------------------------------------------

    /// Fetch and decode the pages around this one, nearest first, and let go of the rest.
    private func fill() {
        let wanted = ComicPaging.keep(around: page, of: count)
        for at in pictures.keys where !wanted.contains(at) { pictures[at] = nil }
        for (at, task) in fetching where !wanted.contains(at) {
            task.cancel()
            fetching[at] = nil
        }
        // No larger than the screen can show at twice its size: a scanned page decoded whole is 24 MB.
        let longest = max(UIScreen.main.nativeBounds.width, UIScreen.main.nativeBounds.height) * 2
        for at in wanted where pictures[at] == nil && fetching[at] == nil {
            let (server, id) = (server, book.id)
            fetching[at] = Task { [weak self] in
                do {
                    let data = try await server.page(at + 1, of: id)
                    let picture = await Task.detached(priority: .userInitiated) { ComicPaging.picture(from: data, longest: longest) }.value
                    guard !Task.isCancelled, let self else { return }
                    self.fetching[at] = nil
                    if let picture, ComicPaging.keep(around: self.page, of: self.count).contains(at) { self.pictures[at] = picture }
                    if picture == nil, at == self.page { self.problem = "Page \(at + 1) isn't a picture this \(ThisDevice.kind) can show." }
                } catch {
                    guard !Task.isCancelled, let self else { return }
                    self.fetching[at] = nil
                    if at == self.page { self.problem = error.localizedDescription }
                }
            }
        }
        if pictures[page] != nil { problem = nil }
    }
}

/// What a comic's reader works out that needs no screen and no server.
enum ComicPaging {
    static func clamp(_ page: Int, of count: Int) -> Int {
        max(0, min(count - 1, page))
    }

    /// How far through a comic a page is: 0 on the first, 1 on the last (packages/core/src/comic/session.ts, `pageProgress`).
    static func progress(page: Int, of count: Int) -> Double {
        count <= 1 ? 1 : max(0, min(1, Double(page) / Double(count - 1)))
    }

    /// The pages to keep decoded around one, nearest first, ahead before behind: far fewer than a comic has, since a
    /// decoded page is dear (packages/core/src/comic/window.ts, `DECODED`).
    static func keep(around page: Int, of count: Int, behind: Int = 1, ahead: Int = 2) -> [Int] {
        guard count > 0 else { return [] }
        let at = clamp(page, of: count)
        var out = [at]
        for step in 1...max(behind, ahead, 1) {
            if step <= ahead, at + step < count { out.append(at + step) }
            if step <= behind, at - step >= 0 { out.append(at - step) }
        }
        return out
    }

    /// The page a touch at `x`, a fraction of the screen's width, asks for: the third on the side the comic goes on
    /// to is the next page, the other third the one before, and the middle is the page's own.
    static func turn(at x: Double, rightToLeft: Bool) -> Int {
        if x < 1.0 / 3 { return rightToLeft ? 1 : -1 }
        if x > 2.0 / 3 { return rightToLeft ? -1 : 1 }
        return 0
    }

    /// A page's picture from its file, decoded now and no larger than `longest` pixels on its longer side.
    nonisolated static func picture(from data: Data, longest: CGFloat) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: longest,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}
