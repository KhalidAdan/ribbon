import Metal
import SceneKit
import UIKit

/// A shelf's spines, side by side on a few large textures. The graphics card gives a tall, narrow texture far more memory
/// than its pixels: on an iPhone SE a 75 × 570 spine, 166 KB of pixels, took 480 KB as a texture of its own, where a
/// sheet 2048 across takes hardly more than its pixels. On the phone's long shelf that was 48 MB of spines holding 30 MB.
///
/// Every spine's place is planned at the start, from the layout's sizes, so books made side by side on many threads each
/// draw into a place of their own. A spine is seen at its own size on a shelf, never much smaller, so the sheets keep no
/// smaller copies of themselves; and each place has a margin of its own edge pixels, so no spine shows its neighbour's.
final class SpineSheets: @unchecked Sendable {
    private struct Place { let sheet: Int, x: Int, y: Int, width: Int, height: Int }
    private let places: [String: Place]
    private let sheets: [MTLTexture]
    /// Writing to a sheet, one spine at a time.
    private let writing = NSLock()
    private static let across = 2048, margin = 2

    init(_ items: [ShelfItem], scale: CGFloat) {
        // As picture() draws them: whole pixels, rounded up.
        func pixels(_ points: CGFloat) -> Int { Int((max(1, points) * scale).rounded(.up)) }
        let spines = items.map { (id: $0.id, width: pixels($0.spine.width), height: pixels($0.spine.height)) }
        let tallest = spines.map(\.height).max() ?? 0
        let down = max(Self.across, tallest + 2 * Self.margin)
        // Tallest first, in rows across a sheet, rows down it until it's full; each sheet only as big as its spines need.
        var places: [String: Place] = [:], sizes: [(width: Int, height: Int)] = []
        var x = 0, y = 0, row = 0, widest = 0
        for spine in spines.sorted(by: { $0.height > $1.height }) {
            let w = spine.width + 2 * Self.margin, h = spine.height + 2 * Self.margin
            if x + w > Self.across { y += row; x = 0; row = 0 }
            if y + h > down { sizes.append((widest, y)); x = 0; y = 0; row = 0; widest = 0 }
            places[spine.id] = Place(sheet: sizes.count, x: x + Self.margin, y: y + Self.margin, width: spine.width, height: spine.height)
            x += w; row = max(row, h); widest = max(widest, x)
        }
        if widest > 0 { sizes.append((widest, y + row)) }
        self.places = places
        sheets = sizes.compactMap { size in
            let described = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: size.width, height: size.height, mipmapped: false)
            described.usage = .shaderRead
            described.storageMode = .shared
            return GraphicsCard.device.makeTexture(descriptor: described)
        }
    }

    /// A spine's art drawn into its place: the sheet it's on, and where on it, as the material's texture transform.
    /// Nothing if it has no place, or its art isn't the size it was planned at.
    func put(_ art: UIImage, for id: String) -> (sheet: MTLTexture, place: SCNMatrix4)? {
        guard let place = places[id], place.sheet < sheets.count, let cg = art.cgImage,
              cg.width == place.width, cg.height == place.height else { return nil }
        let m = Self.margin, w = cg.width + 2 * m, h = cg.height + 2 * m
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
              let bytes = ctx.data else { return nil }
        ctx.draw(cg, in: CGRect(x: m, y: m, width: cg.width, height: cg.height))
        // The margin: the art's edge pixels repeated out into it, as a texture of its own repeats them past its edges.
        let pixels = bytes.bindMemory(to: UInt32.self, capacity: w * h)
        for y in m ..< m + cg.height {
            let row = pixels + y * w
            for x in 0 ..< m { row[x] = row[m]; row[m + cg.width + x] = row[m + cg.width - 1] }
        }
        for y in 0 ..< m {
            (pixels + y * w).update(from: pixels + m * w, count: w)
            (pixels + (m + cg.height + y) * w).update(from: pixels + (m + cg.height - 1) * w, count: w)
        }
        let sheet = sheets[place.sheet]
        writing.lock()
        sheet.replace(region: MTLRegionMake2D(place.x - m, place.y - m, w, h), mipmapLevel: 0, withBytes: bytes, bytesPerRow: w * 4)
        writing.unlock()
        let across = Float(sheet.width), down = Float(sheet.height)
        let scaled = SCNMatrix4MakeScale(Float(place.width) / across, Float(place.height) / down, 1)
        return (sheet, SCNMatrix4Mult(scaled, SCNMatrix4MakeTranslation(Float(place.x) / across, Float(place.y) / down, 0)))
    }
}
