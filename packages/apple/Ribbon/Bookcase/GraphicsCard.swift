import Metal
import UIKit

/// The books' pictures, kept on the graphics card alone. SceneKit keeps whatever a material is given: a picture given as
/// an image stays in memory twice, once as the image and once as the card's copy of it, for every book on the shelf.
/// Given the card's copy itself, the image can go as soon as it's drawn. Safe from any thread.
enum GraphicsCard {
    static let device = MTLCreateSystemDefaultDevice()!
    private static let queue = device.makeCommandQueue()!

    /// A picture in colour, as SceneKit would have made it from the image: in sRGB, with its smaller copies for drawing it
    /// small. Copied into pixels of a known layout first, every one opaque. (MetalKit's loader, asked for sRGB, made a plain
    /// texture, and every colour came out washed pale.)
    static func colour(_ image: UIImage) -> MTLTexture? {
        guard let cg = image.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
              let bytes = ctx.data else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        return upload(bytes, width: cg.width, height: cg.height, bytesPerRow: cg.width * 4, as: .bgra8Unorm_srgb)
    }

    /// A picture of numbers rather than colours, a normal map or a roughness: its numbers as they are, as SceneKit reads
    /// them from an image, not taken as sRGB colour. A grey picture stays one channel.
    static func values(_ image: UIImage) -> MTLTexture? {
        guard let cg = image.cgImage, let space = cg.colorSpace else { return nil }
        let grey = space.model == .monochrome, bytes = grey ? 1 : 4
        // Drawn in its own colour space, so not one number changes on the way.
        guard let ctx = CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * bytes, space: space,
                                  bitmapInfo: grey ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
              let pixels = ctx.data else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        return upload(pixels, width: cg.width, height: cg.height, bytesPerRow: cg.width * bytes, as: grey ? .r8Unorm : .bgra8Unorm)
    }

    /// A spine's foil, as one texture: how metal each point is (red) and how rough (green), both from one drawing of where
    /// the foil and lettering are. Lettering is stamped foil, metal 0.7 and smooth (0.36) against the cloth's 0.86, and an
    /// edge part covered by a letter is part metal: both follow from how much of each point the lettering covers.
    static func foil(_ w: CGFloat, _ h: CGFloat, scale: CGFloat, _ draw: (CGContext) -> Void) -> MTLTexture? {
        let pw = max(1, Int((w * scale).rounded(.up))), ph = max(1, Int((h * scale).rounded(.up)))
        guard let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: pw, space: CGColorSpaceCreateDeviceGray(),
                                  bitmapInfo: CGImageAlphaInfo.none.rawValue), let covered = ctx.data else { return nil }
        // Drawn as UIKit draws: from the top, in points.
        ctx.translateBy(x: 0, y: CGFloat(ph))
        ctx.scaleBy(x: scale, y: -scale)
        UIGraphicsPushContext(ctx)
        draw(ctx)
        UIGraphicsPopContext()
        let coverage = covered.bindMemory(to: UInt8.self, capacity: pw * ph)
        var pixels = [UInt8](repeating: 0, count: pw * ph * 2)
        for i in 0 ..< pw * ph {
            let m = Int(coverage[i])
            pixels[2 * i] = UInt8((Self.metal * m + 127) / 255)
            pixels[2 * i + 1] = UInt8(Self.cloth + ((Self.lettering - Self.cloth) * m) / 255)
        }
        return upload(pixels, width: pw, height: ph, bytesPerRow: pw * 2, as: .rg8Unorm)
    }

    /// Pixels to the card, with the smaller copies SceneKit draws a texture with when it's small on the screen.
    private static func upload(_ bytes: UnsafeRawPointer, width: Int, height: Int, bytesPerRow: Int, as format: MTLPixelFormat) -> MTLTexture? {
        let described = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: width, height: height, mipmapped: true)
        described.usage = .shaderRead
        described.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: described) else { return nil }
        texture.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: bytes, bytesPerRow: bytesPerRow)
        guard let commands = queue.makeCommandBuffer(), let blit = commands.makeBlitCommandEncoder() else { return texture }
        blit.generateMipmaps(for: texture)
        blit.endEncoding()
        commands.commit()
        commands.waitUntilCompleted()
        return texture
    }

    /// The foil's metal, and the roughness of the cloth and of the lettering, as bytes.
    private static let metal = 0xb3, cloth = 0xdb, lettering = 0x5c
}
