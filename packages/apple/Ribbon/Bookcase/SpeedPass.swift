import Foundation
import QuartzCore
#if MEASURE
import SceneKit
import SwiftUI
import UIKit
#endif

// The bookcase's speed, measured on a real device: how long it takes to appear, how smoothly it moves, how much memory it
// holds. Only a measurement build has it (`SWIFT_ACTIVE_COMPILATION_CONDITIONS=MEASURE`, packages/apple/README.md); in
// every other build these two calls do nothing and the pass doesn't exist.

/// A moment in the bookcase's making, the first time it happens: "laid out", "shown", "first 3D frame".
@inline(__always) func measured(_ moment: String) {
    #if MEASURE
    SpeedPass.shared.mark(moment)
    #endif
}

/// How long something on the main thread took, timed around it: "making a 3D view", "a shelf's still picture".
@inline(__always) func measured<T>(_ what: String, _ work: () -> T) -> T {
    #if MEASURE
    let start = CACurrentMediaTime()
    defer { SpeedPass.shared.took(what, CACurrentMediaTime() - start) }
    #endif
    return work()
}

/// A 3D view has drawn a frame. Called on SceneKit's drawing thread.
@inline(__always) func measuredFrame() {
    #if MEASURE
    SpeedPass.shared.frame()
    #endif
}

#if MEASURE
/// The pass, started by launching with `-measure bookcase`: once the library is in, it opens the bookcase (turning a phone
/// on its side), waits for the shelf, notes the memory, drags the whole long shelf (a phone) or takes a book from each shelf
/// in turn (the TV and the iPad), notes the memory again, prints a report and quits.
///
///     xcrun devicectl device process launch --console --terminate-existing --device <id> app.ribbon.tv -measure bookcase [-cold]
final class SpeedPass: @unchecked Sendable {
    static let shared = SpeedPass()

    private var opened: CFTimeInterval = 0
    private var moments: [(String, CFTimeInterval)] = []
    private weak var bookcase: Bookcase?
    private let lock = NSLock()
    private var frames: [CFTimeInterval] = []
    private var stalls: [CFTimeInterval] = []
    private var lastTick: CFTimeInterval = 0
    private var ticker: CADisplayLink?
    private var peak: UInt64 = 0
    private var lines: [String] = []
    private var spans: [String: [CFTimeInterval]] = [:]

    static var wanted: Bool { ProcessInfo.processInfo.arguments.contains("-measure") }

    func mark(_ moment: String) {
        let now = CACurrentMediaTime()
        DispatchQueue.main.async {
            guard self.opened > 0, !self.moments.contains(where: { $0.0 == moment }) else { return }
            self.moments.append((moment, now - self.opened))
        }
    }

    func took(_ what: String, _ seconds: CFTimeInterval) {
        DispatchQueue.main.async { self.spans[what, default: []].append(seconds) }
    }

    func frame() {
        let now = CACurrentMediaTime()
        lock.lock(); frames.append(now); lock.unlock()
    }

    @MainActor func watch(_ bookcase: Bookcase) { self.bookcase = bookcase }

    @MainActor func run(_ app: AppModel) async {
        guard Self.wanted else { return }
        // `-cold`: as the first time ever, with no cover's colour kept from before.
        if ProcessInfo.processInfo.arguments.contains("-cold"), let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            try? FileManager.default.removeItem(at: caches.appendingPathComponent("cover-colours.json"))
        }
        while app.library?.books.isEmpty ?? true { try? await Task.sleep(for: .milliseconds(100)) }
        // The library on screen, settled: what the app holds before the bookcase.
        try? await Task.sleep(for: .seconds(3))
        report("books on the server", "\(app.library?.books.count ?? 0), \(app.library?.shelfBooks.count ?? 0) on the shelf")
        report("memory, the library", Self.megabytes(Self.footprint()) + ", of it graphics " + Self.megabytes(Self.graphics()))
        startWatchingTheMainThread()

        opened = CACurrentMediaTime()
        app.openBookcase()
        while bookcase == nil { try? await Task.sleep(for: .milliseconds(50)) }
        guard let bookcase else { return }
        var turned = CACurrentMediaTime()
        while !(bookcase.shelf?.ready ?? false) && !bookcase.rows.contains(where: { $0.still != nil }) {
            try? await Task.sleep(for: .milliseconds(50))
            #if os(iOS)
            // The phone on its side, as soon as the page lets it turn, and again until the shelf is on screen.
            if Look.phone, bookcase.shelf?.view == nil, CACurrentMediaTime() - turned > 0.25 { Turning.turnSideways(); turned = CACurrentMediaTime() }
            #endif
            if CACurrentMediaTime() - opened > 30 { report("shown", "not within 30 s"); break }
        }
        try? await Task.sleep(for: .seconds(1))
        for (moment, at) in moments.sorted(by: { $0.1 < $1.1 }) { report(moment, String(format: "%.2f s", at)) }
        stalls = []
        try? await Task.sleep(for: .seconds(3))
        report("memory, the bookcase at rest", Self.megabytes(Self.footprint()) + ", of it graphics " + Self.megabytes(Self.graphics()))
        report("what the shelves hold", Self.inventory([bookcase.shelf?.scene].compactMap { $0 } + bookcase.rows.map(\.scene)))
        report("what the book in hand holds", Self.inventory([bookcase.hand.scene]))

        if let shelf = bookcase.shelf, let scroll = shelf.scroller {
            await drag(scroll, shelf: shelf)
        } else {
            await takeFromEachShelf(bookcase)
        }
        try? await Task.sleep(for: .seconds(2))
        report("memory, at rest after", Self.megabytes(Self.footprint()))
        report("memory, the most", Self.megabytes(peak))
        let text = lines.joined(separator: "\n")
        print("MEASURE REPORT\n\(text)\nMEASURE END")
        fflush(stdout)
        if let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? text.write(to: documents.appendingPathComponent("bookcase-speed.txt"), atomically: true, encoding: .utf8)
        }
        try? await Task.sleep(for: .milliseconds(300))
        exit(0)
    }

    /// The long shelf dragged from one end to the other at 700 points a second, as a quick finger does.
    @MainActor private func drag(_ scroll: UIScrollView, shelf: LongShelf) async {
        let far = max(0, scroll.contentSize.width - scroll.bounds.width)
        resetFrames()
        let start = CACurrentMediaTime(), duration = Double(far) / 700
        while true {
            let t = min(1, (CACurrentMediaTime() - start) / duration)
            scroll.contentOffset.x = far * t
            if t >= 1 { break }
            try? await Task.sleep(for: .milliseconds(8))
        }
        try? await Task.sleep(for: .milliseconds(300))
        summarise("dragging the shelf, \(Int(far)) points", frames: takeFrames())
        // Then a book taken down at each of ten places along it, the shelf gliding there.
        let items = shelf.items
        guard !items.isEmpty, let bookcase else { return }
        resetFrames()
        var worst: Double = 0
        for i in stride(from: 0, to: items.count, by: max(1, items.count / 10)) {
            let begun = CACurrentMediaTime()
            bookcase.choose(items[i])
            worst = max(worst, CACurrentMediaTime() - begun)
            try? await Task.sleep(for: .milliseconds(1200))
        }
        report("choosing a book, longest on the main thread", String(format: "%.1f ms", worst * 1000))
        summarise("choosing books along the shelf", frames: takeFrames())
    }

    /// The first book of each shelf in turn, which brings each shelf into use: where a new 3D view is made, the hitch.
    @MainActor private func takeFromEachShelf(_ bookcase: Bookcase) async {
        resetFrames()
        var hitches: [Double] = []
        for row in bookcase.rows.prefix(8) {
            guard let first = row.items.first else { continue }
            let before = stalls.count
            bookcase.choose(first)
            try? await Task.sleep(for: .milliseconds(1200))
            hitches.append(stalls.dropFirst(before).max() ?? 0)
        }
        report("moving to each shelf, the longest stall each time", hitches.map { String(format: "%.0f", $0 * 1000) }.joined(separator: ", ") + " ms")
        for (what, times) in spans.sorted(by: { $0.key < $1.key }) {
            report(what, "\(times.count) times, longest \(String(format: "%.0f", (times.max() ?? 0) * 1000)) ms, in all \(String(format: "%.0f", times.reduce(0, +) * 1000)) ms")
        }
        summarise("moving from shelf to shelf", frames: takeFrames())
        // A still drawn off screen now, against the view's own picture of the same shelf: they have to match, or a shelf
        // would change as it came into use.
        if let row = bookcase.rows.first(where: { $0.live && $0.view != nil }), let v = row.view {
            let own = v.snapshot()
            let offScreen = await withCheckedContinuation { done in
                ShelfStills.draw(row.scene, camera: row.camera, size: CGSize(width: row.width, height: row.height), scale: v.contentScaleFactor) { done.resume(returning: $0) }
            }
            report("a still drawn off screen, against the view's own picture", Self.difference(own, offScreen))
        }
    }

    /// How far apart two pictures are, pixel by pixel, in sRGB: the mean, the worst, and how many differ by more than 2 of 255.
    static func difference(_ a: UIImage, _ b: UIImage?) -> String {
        guard let a = a.cgImage, let b = b?.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return "no picture" }
        let w = a.width, h = a.height
        func pixels(_ image: CGImage) -> [UInt8] {
            var px = [UInt8](repeating: 0, count: w * h * 4)
            px.withUnsafeMutableBytes { buffer in
                CGContext(data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            }
            return px
        }
        let p = pixels(a), q = pixels(b)
        var worst = 0, total = 0, over = 0
        for i in 0 ..< w * h {
            var d = 0
            for c in 0 ..< 3 { d = max(d, abs(Int(p[i * 4 + c]) - Int(q[i * 4 + c]))) }
            worst = max(worst, d); total += d
            if d > 2 { over += 1 }
        }
        return String(format: "%dx%d against %dx%d: mean %.2f, worst %d, %.2f%% differ by more than 2", a.width, a.height, b.width, b.height,
                      Double(total) / Double(w * h), worst, 100 * Double(over) / Double(w * h))
    }

    @MainActor private func summarise(_ what: String, frames times: [CFTimeInterval]) {
        // A view draws only while something moves, so a gap of a quarter second or more is a rest, not a slow frame.
        let gaps = zip(times.dropFirst(), times).map { ($0 - $1) * 1000 }.filter { $0 < 250 }.sorted()
        guard !gaps.isEmpty else { report(what, "no frames"); return }
        let at = { (p: Double) in gaps[min(gaps.count - 1, Int(Double(gaps.count) * p))] }
        report(what, String(format: "%d frames, median %.1f ms, p95 %.1f, max %.1f; main thread: %d stalls over 50 ms, longest %.0f ms",
                            gaps.count, at(0.5), at(0.95), gaps.last!, stalls.filter { $0 > 0.05 }.count, (stalls.max() ?? 0) * 1000))
        stalls = []
    }

    @MainActor private func resetFrames() { lock.lock(); frames = []; lock.unlock(); stalls = [] }
    @MainActor private func takeFrames() -> [CFTimeInterval] { lock.lock(); defer { lock.unlock() }; return frames }

    /// Every turn of the main thread's loop over two frames long is a stall; the memory's high point is noted as it goes.
    @MainActor private func startWatchingTheMainThread() {
        let link = CADisplayLink(target: Tick { [weak self] in self?.tick() }, selector: #selector(Tick.fire))
        link.add(to: .main, forMode: .common)
        ticker = link
    }

    @MainActor private func tick() {
        let now = CACurrentMediaTime()
        if lastTick > 0, now - lastTick > 0.034 { stalls.append(now - lastTick) }
        lastTick = now
        peak = max(peak, Self.footprint())
    }

    @MainActor private func report(_ what: String, _ value: String) {
        lines.append("\(what): \(value)")
        print("MEASURE \(what): \(value)")
    }

    /// What the system counts against the app, as Xcode's memory gauge shows it and as the system judges when it runs short.
    static func footprint() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : 0
    }

    /// The part of the footprint that is the graphics card's: textures, the 3D views' pictures, shadows, buffers.
    static func graphics() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? UInt64(max(0, info.ledger_tag_graphics_footprint)) : 0
    }

    /// What some scenes hold, each thing counted once however many books share it: their books' shapes, the pictures
    /// given to the graphics card, and the pictures given as images (kept twice, as the image and as the card's copy).
    @MainActor static func inventory(_ scenes: [SCNScene]) -> String {
        var seen = Set<ObjectIdentifier>(), nodes = 0, shapes = 0, shapeBytes = 0
        var cards = 0, cardBytes = 0, cardPixels = 0, images = 0, imageBytes = 0, lights = 0, shadowBytes = 0
        for scene in scenes {
            scene.rootNode.enumerateHierarchy { node, _ in
                nodes += 1
                if let l = node.light, l.castsShadow { lights += 1; shadowBytes += Int(l.shadowMapSize.width * l.shadowMapSize.height) * 4 }
                guard let g = node.geometry, seen.insert(ObjectIdentifier(g)).inserted else { return }
                shapes += 1
                shapeBytes += g.sources.reduce(0) { $0 + $1.data.count } + g.elements.reduce(0) { $0 + $1.data.count }
                for m in g.materials {
                    for p in [m.diffuse, m.normal, m.roughness, m.metalness, m.multiply, m.emission, m.ambientOcclusion] {
                        guard let c = p.contents.map({ $0 as AnyObject }), seen.insert(ObjectIdentifier(c)).inserted else { continue }
                        if let t = c as? MTLTexture {
                            cards += 1; cardBytes += t.allocatedSize
                            let bytes = t.pixelFormat == .rg8Unorm ? 2 : 4
                            cardPixels += t.width * t.height * bytes * (t.mipmapLevelCount > 1 ? 4 : 3) / 3
                        }
                        if let i = c as? UIImage, let cg = i.cgImage { images += 1; imageBytes += cg.bytesPerRow * cg.height }
                    }
                }
            }
        }
        return "\(nodes) nodes; \(shapes) shapes \(megabytes(UInt64(shapeBytes))); \(cards) pictures on the card \(megabytes(UInt64(cardBytes))) (their pixels \(megabytes(UInt64(cardPixels)))); "
            + "\(images) as images \(megabytes(UInt64(imageBytes))); \(lights) lamps with shadows \(megabytes(UInt64(shadowBytes)))"
    }

    static func megabytes(_ bytes: UInt64) -> String { String(format: "%.0f MB", Double(bytes) / 1_048_576) }
}

private final class Tick: NSObject {
    let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func fire() { action() }
}
#endif
