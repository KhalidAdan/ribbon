import ImageIO
import Metal
import SceneKit
import UIKit

/// A hardback, built the way a binder makes one: a case of two boards and a rounded spine, with the joint pressed in
/// where each board meets the spine, and the pages inside it, set back from the boards' edges by the squares, their
/// fore-edge a little hollow as a rounded spine makes it. Sizes in points: T thick (the spine's width), H tall, D deep
/// (a cover's width). The spine faces +z; the back board's outer face is x = 0, the front board's x = T; it stands on y = 0.
struct BookLook {
    /// The spine's art, and its foil: what's metal, and how rough each part is.
    var spine: UIImage
    var spineMetal: UIImage?
    var spineRough: UIImage?
    /// The front cover: its art, or a colour.
    var front: Any
    var cloth: UIColor
    var endpaper = UIColor(red: 0.93, green: 0.9, blue: 0.83, alpha: 1)
    /// A hardback's headband: its two colours, wound in stripes.
    var headband = (UIColor(red: 0.55, green: 0.12, blue: 0.12, alpha: 1), UIColor(white: 0.92, alpha: 1))
}

enum BookModel {
    /// How far the spine is rounded, as a part of the book's thickness: a hardback's well rounded, a paperback's nearly flat.
    static func roundness(_ T: CGFloat, paperback: Bool = false) -> CGFloat { T * (paperback ? 0.035 : 0.16) }

    /// A paperback is a card cover glued round the pages: flush with them, no boards standing proud, no joint, no headband.
    static func make(T: CGFloat, H: CGFloat, D: CGFloat, look: BookLook, paperback: Bool = false) -> SCNNode {
        let t = Float(T), h = Float(H), d = Float(D)
        let board: Float = paperback ? 0.45 : Float(min(max(H * 0.011, 1.0), T * 0.12))
        let squares: Float = paperback ? 0.15 : Float(H * 0.012)
        let r = Float(roundness(T, paperback: paperback))
        let joint = Float(max(3, D * 0.05)), groove: Float = paperback ? 0 : board * 0.5, grooveHalf: Float = 0.9
        // Every outside edge is softened a little, so it catches a thin line of light as a real edge does.
        let soft: Float = paperback ? 0.3 : min(0.7, board * 0.45)
        let vTop = soft / h, vBottom = 1 - soft / h
        let mesh = Mesh()

        // The case's outside: the back board, the spine, the front board, each its own material.
        let back = mesh.element(), spine = mesh.element(), front = mesh.element()
        // From the board's inner fore-edge, round its outer corner, then along its face, past the joint, to the spine.
        var backFace: [Ring] = [Ring(board, -d, 0, -1, 0), Ring(soft, -d, 0, -1, 0)]
        for k in 0 ... 4 {
            let th = Float.pi / 2 * Float(k) / 4
            backFace.append(Ring(soft - soft * sin(th), -d + soft - soft * cos(th), -sin(th), -cos(th), 0))
        }
        if groove > 0 {
            backFace += [
                Ring(0, -joint - grooveHalf, -1, 0, 0),
                Ring(0, -joint - grooveHalf, -grooveHalf, groove, 0), Ring(groove, -joint, -grooveHalf, groove, 0),
                Ring(groove, -joint, -grooveHalf, -groove, 0), Ring(0, -joint + grooveHalf, -grooveHalf, -groove, 0),
                Ring(0, -joint + grooveHalf, -1, 0, 0),
            ]
        }
        backFace.append(Ring(0, 0, -1, 0, 0))
        backFace = backFace.map { var p = $0; p.u = ($0.z + d) / d; return p }
        let frontFace = backFace.reversed().map { Ring(t - $0.x, $0.z, -$0.nx, $0.nz, -$0.z / d) }
        let steps = 16
        var arc = (0 ... steps).map { i -> Ring in
            let phi = Float.pi * Float(i) / Float(steps)
            return Ring(t / 2 * (1 - cos(phi)), r * sin(phi), -r * cos(phi), t / 2 * sin(phi), 0)
        }
        // The spine's art runs round the curve by distance, so it isn't squeezed at the shoulders.
        var run: Float = 0
        for i in arc.indices { if i > 0 { run += hypot(arc[i].x - arc[i - 1].x, arc[i].z - arc[i - 1].z) }; arc[i].u = run }
        arc = arc.map { var p = $0; p.u /= run; return p }
        for (element, ring) in [(back, backFace), (spine, arc), (front, frontFace)] {
            mesh.strip(element, ring, y0: soft, y1: h - soft, v0: vBottom, v1: vTop)
            mesh.chamfer(element, ring, inset: soft, from: h - soft, to: h, vFrom: vTop, vTo: 0)
            mesh.chamfer(element, ring, inset: soft, from: soft, to: 0, vFrom: vBottom, vTo: 1)
        }

        // Its edges: the boards' tops and bottoms, inside the softened rim, and the spine's.
        let edges = mesh.element()
        for (x0, x1) in [(soft, board), (t - board, t - soft)] {
            mesh.cap(edges, [(x0, -d + soft), (x1, -d + soft), (x1, 0), (x0, 0)], y: h, up: true)
            mesh.cap(edges, [(x0, -d + soft), (x1, -d + soft), (x1, 0), (x0, 0)], y: 0, up: false)
        }
        let rIn = max(0, r - board)
        let inner = (0 ... steps).map { i -> (Float, Float) in
            let phi = Float.pi * Float(i) / Float(steps)
            return (board + (t / 2 - board) * (1 - cos(phi)), rIn * sin(phi))
        }
        let rim = arc.map { p -> (Float, Float) in
            let n = max(1e-6, hypot(p.nx, p.nz))
            return (p.x - p.nx / n * soft, p.z - p.nz / n * soft)
        }
        mesh.band(edges, outer: rim, inner: inner, y: h, up: true)
        mesh.band(edges, outer: rim, inner: inner, y: 0, up: false)

        // Its inside, seen only past the squares: the endpapers.
        let lining = mesh.element()
        mesh.wall(lining, from: (board, -d), to: (board, 0), y0: 0, y1: h, normal: (1, 0))
        mesh.wall(lining, from: (t - board, 0), to: (t - board, -d), y0: 0, y1: h, normal: (-1, 0))

        // The pages: set back from the boards by the squares, the fore-edge hollowed, the back following the spine.
        let pages = mesh.element()
        let xb = board + 0.15, xf = t - board - 0.15, zf = -d + squares, hollow = (xf - xb) * (paperback ? 0.02 : 0.08)
        let tbR = max(0.5, rIn - 0.4)
        var outline: [Ring] = [Ring(xb, 0, -1, 0, 0), Ring(xb, zf, -1, 0, 0)]
        for i in 0 ... steps {
            let s = Float(i) / Float(steps), x = xb + (xf - xb) * s
            let slope = hollow * .pi / (xf - xb) * cos(.pi * s)
            outline.append(Ring(x, zf + hollow * sin(.pi * s), slope, -1, 0))
        }
        outline += [Ring(xf, zf, 1, 0, 0), Ring(xf, 0, 1, 0, 0)]
        let a = (xf - xb) / 2
        for i in 0 ... steps {
            let phi = Float.pi * Float(i) / Float(steps)
            outline.append(Ring((xb + xf) / 2 + a * cos(phi), tbR * sin(phi), cos(phi) / a, sin(phi) / tbR, 0))
        }
        outline = outline.map { var p = $0; p.u = (p.x - xb) / (xf - xb); return p }
        mesh.strip(pages, outline, y0: squares, y1: h - squares)
        let flat = outline.map { ($0.x, $0.z) }
        mesh.fan(pages, flat, y: h - squares, up: true, u: { ($0 - xb) / (xf - xb) }, v: { ($0 - zf) / (tbR - zf) })
        mesh.fan(pages, flat, y: squares, up: false, u: { ($0 - xb) / (xf - xb) }, v: { ($0 - zf) / (tbR - zf) })

        // A hardback's headbands: the little striped cords at the head and tail of the pages, just inside the spine.
        var headband: Int?
        if !paperback {
            let band = mesh.element()
            headband = band
            let hb = min(squares * 0.9, 1.5), hr = tbR + 0.25, ha = a + 0.1
            var cord = (0 ... steps).map { i -> Ring in
                let phi = Float.pi * Float(i) / Float(steps)
                return Ring((xb + xf) / 2 + ha * cos(phi), hr * sin(phi), cos(phi) / ha, sin(phi) / hr, 0)
            }
            var length: Float = 0
            for i in cord.indices { if i > 0 { length += hypot(cord[i].x - cord[i - 1].x, cord[i].z - cord[i - 1].z) }; cord[i].u = length / 1.2 }
            mesh.strip(band, cord, y0: h - squares - 0.2, y1: h - squares + hb)
            mesh.strip(band, cord, y0: squares - hb, y1: squares + 0.2)
            let inside = (0 ... steps).map { i -> (Float, Float) in
                let phi = Float.pi * Float(i) / Float(steps)
                return ((xb + xf) / 2 + (ha - 1) * cos(phi), max(0, hr - 1) * sin(phi))
            }
            mesh.band(band, outer: cord.map { ($0.x, $0.z) }, inner: inside, y: h - squares + hb, up: true)
            mesh.band(band, outer: cord.map { ($0.x, $0.z) }, inner: inside, y: squares - hb, up: false)
        }

        let geometry = mesh.geometry()
        // The scanned weave repeats about every twelve points, a finger's width of book cloth.
        let weave = (Float(T / 12), Float(H / 12)), coverWeave = (Float(D / 12), Float(H / 12))
        let clothMat: SCNMaterial, spineMat: SCNMaterial
        if paperback {
            // Printed card: smoother than cloth, no foil, the board's texture barely there.
            clothMat = material(look.cloth, rough: 0.62 as NSNumber, normal: BookTextures.clothNormal, scale: weave)
            spineMat = material(look.spine, rough: 0.6 as NSNumber, normal: BookTextures.clothNormal, scale: weave)
            clothMat.normal.intensity = 0.12
            spineMat.normal.intensity = 0.12
        } else {
            clothMat = material(look.cloth, rough: BookTextures.clothRough ?? 0.86 as NSNumber, normal: BookTextures.clothNormal, scale: weave, fibres: true)
            spineMat = material(look.spine, rough: look.spineRough ?? 0.86 as NSNumber, metal: look.spineMetal ?? 0 as NSNumber, normal: BookTextures.clothNormal, scale: weave, fibres: true)
        }
        // A printed cover is paper over the board: the cloth only just shows through it.
        let frontMat = material(look.front, rough: paperback ? 0.6 : 0.7, normal: BookTextures.clothNormal, scale: coverWeave)
        frontMat.normal.intensity = paperback ? 0.1 : 0.25
        let edgeMat = material(paperback ? UIColor(white: 0.88, alpha: 1) : look.cloth.darker(0.82), rough: 0.9)
        let liningMat = material(look.endpaper, rough: 0.95)
        let pagesMat = material(BookTextures.pages, rough: 0.92, normal: BookTextures.pageRidges, scale: (Float(T / 26), 1))
        pagesMat.diffuse.contentsTransform = SCNMatrix4MakeScale(Float(T / 26), 1, 1)
        pagesMat.diffuse.wrapS = .repeat
        var materials = [clothMat, spineMat, frontMat, edgeMat, liningMat, pagesMat]
        if headband != nil {
            let stripes = material(BookTextures.stripes(look.headband.0, look.headband.1), rough: 0.7)
            stripes.diffuse.wrapS = .repeat
            stripes.diffuse.magnificationFilter = .nearest
            materials.append(stripes)
        }
        geometry.materials = materials
        let node = SCNNode(geometry: geometry)
        node.castsShadow = true
        return node
    }

    /// `fibres` lays the scanned cloth's own light and dark threads faintly over the colour.
    static func material(_ diffuse: Any, rough: Any, metal: Any = 0 as NSNumber, normal: UIImage? = nil, scale: (Float, Float)? = nil, fibres: Bool = false) -> SCNMaterial {
        let m = SCNMaterial()
        m.lightingModel = .physicallyBased
        m.diffuse.contents = diffuse
        m.diffuse.mipFilter = .linear
        m.diffuse.maxAnisotropy = 8
        m.roughness.contents = rough
        m.metalness.contents = metal
        let tile = scale.map { SCNMatrix4MakeScale($0.0, $0.1, 1) } ?? SCNMatrix4Identity
        if rough is UIImage { m.roughness.wrapS = .repeat; m.roughness.wrapT = .repeat; m.roughness.contentsTransform = tile }
        if let normal {
            m.normal.contents = normal
            m.normal.intensity = 0.7
            m.normal.wrapS = .repeat
            m.normal.wrapT = .repeat
            m.normal.contentsTransform = tile
        }
        if fibres, let colour = BookTextures.clothColour {
            m.multiply.contents = colour
            m.multiply.intensity = 0.2
            m.multiply.wrapS = .repeat
            m.multiply.wrapT = .repeat
            m.multiply.contentsTransform = tile
        }
        m.isDoubleSided = true
        return m
    }
}

/// A point on a cross-section of the book, seen from above, with its outward normal and how far along its texture it is.
struct Ring {
    var x: Float, z: Float, nx: Float, nz: Float, u: Float
    init(_ x: Float, _ z: Float, _ nx: Float, _ nz: Float, _ u: Float) { self.x = x; self.z = z; self.nx = nx; self.nz = nz; self.u = u }
}

/// Triangles, normals and texture coordinates, a list of triangles per material.
final class Mesh {
    private var positions: [SCNVector3] = []
    private var normals: [SCNVector3] = []
    private var uvs: [CGPoint] = []
    private var elements: [[UInt32]] = []

    func element() -> Int { elements.append([]); return elements.count - 1 }

    private func vertex(_ x: Float, _ y: Float, _ z: Float, _ n: (Float, Float, Float), _ u: Float, _ v: Float) -> UInt32 {
        let len = max(1e-6, sqrt(n.0 * n.0 + n.1 * n.1 + n.2 * n.2))
        positions.append(SCNVector3(x, y, z))
        normals.append(SCNVector3(n.0 / len, n.1 / len, n.2 / len))
        uvs.append(CGPoint(x: CGFloat(u), y: CGFloat(v)))
        return UInt32(positions.count - 1)
    }

    /// A cross-section swept up from y0 to y1; v runs from v0 at y0 to v1 at y1 (the texture's top is 0).
    func strip(_ e: Int, _ ring: [Ring], y0: Float, y1: Float, v0: Float = 1, v1: Float = 0) {
        for i in 0 ..< ring.count - 1 {
            let p = ring[i], q = ring[i + 1]
            if p.x == q.x, p.z == q.z { continue }
            let a = vertex(p.x, y0, p.z, (p.nx, 0, p.nz), p.u, v0), b = vertex(q.x, y0, q.z, (q.nx, 0, q.nz), q.u, v0)
            let c = vertex(q.x, y1, q.z, (q.nx, 0, q.nz), q.u, v1), d = vertex(p.x, y1, p.z, (p.nx, 0, p.nz), p.u, v1)
            elements[e] += [a, b, c, a, c, d]
        }
    }

    /// A softened edge: the cross-section at `from`, drawn in by `inset` at `to`, its normals halfway between the side and the top.
    func chamfer(_ e: Int, _ ring: [Ring], inset: Float, from: Float, to: Float, vFrom: Float, vTo: Float) {
        let up: Float = to > from ? 1 : -1
        func moved(_ p: Ring) -> (Float, Float, Float, Float) {
            let n = max(1e-6, hypot(p.nx, p.nz))
            return (p.x - p.nx / n * inset, p.z - p.nz / n * inset, p.nx / n, p.nz / n)
        }
        for i in 0 ..< ring.count - 1 {
            let p = ring[i], q = ring[i + 1]
            if p.x == q.x, p.z == q.z { continue }
            let pi = moved(p), qi = moved(q)
            let a = vertex(p.x, from, p.z, (pi.2, up, pi.3), p.u, vFrom), b = vertex(q.x, from, q.z, (qi.2, up, qi.3), q.u, vFrom)
            let c = vertex(qi.0, to, qi.1, (qi.2, up, qi.3), q.u, vTo), d = vertex(pi.0, to, pi.1, (pi.2, up, pi.3), p.u, vTo)
            elements[e] += [a, b, c, a, c, d]
        }
    }

    /// A flat quad, given its corners as (x, z) at height y.
    func cap(_ e: Int, _ corners: [(Float, Float)], y: Float, up: Bool) {
        let n: (Float, Float, Float) = (0, up ? 1 : -1, 0)
        let ids = corners.map { vertex($0.0, y, $0.1, n, 0, 0) }
        elements[e] += [ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]]
    }

    /// A vertical wall between two points of the cross-section.
    func wall(_ e: Int, from p: (Float, Float), to q: (Float, Float), y0: Float, y1: Float, normal: (Float, Float)) {
        let n = (normal.0, Float(0), normal.1)
        let a = vertex(p.0, y0, p.1, n, 0, 0), b = vertex(q.0, y0, q.1, n, 1, 0), c = vertex(q.0, y1, q.1, n, 1, 1), d = vertex(p.0, y1, p.1, n, 0, 1)
        elements[e] += [a, b, c, a, c, d]
    }

    /// The flat band between two curves of the same number of points, at height y.
    func band(_ e: Int, outer: [(Float, Float)], inner: [(Float, Float)], y: Float, up: Bool) {
        let n: (Float, Float, Float) = (0, up ? 1 : -1, 0)
        for i in 0 ..< outer.count - 1 {
            let a = vertex(outer[i].0, y, outer[i].1, n, 0, 0), b = vertex(outer[i + 1].0, y, outer[i + 1].1, n, 0, 0)
            let c = vertex(inner[i + 1].0, y, inner[i + 1].1, n, 0, 0), d = vertex(inner[i].0, y, inner[i].1, n, 0, 0)
            elements[e] += [a, b, c, a, c, d]
        }
    }

    /// A flat face filling a closed outline, fanned from its middle.
    func fan(_ e: Int, _ outline: [(Float, Float)], y: Float, up: Bool, u: (Float) -> Float, v: (Float) -> Float) {
        let n: (Float, Float, Float) = (0, up ? 1 : -1, 0)
        let cx = outline.map(\.0).reduce(0, +) / Float(outline.count), cz = outline.map(\.1).reduce(0, +) / Float(outline.count)
        let centre = vertex(cx, y, cz, n, u(cx), v(cz))
        let ids = outline.map { vertex($0.0, y, $0.1, n, u($0.0), v($0.1)) }
        for i in 0 ..< ids.count { elements[e] += [centre, ids[i], ids[(i + 1) % ids.count]] }
    }

    func geometry() -> SCNGeometry {
        let sources = [SCNGeometrySource(vertices: positions), SCNGeometrySource(normals: normals), SCNGeometrySource(textureCoordinates: uvs)]
        let parts = elements.map { SCNGeometryElement(indices: $0, primitiveType: .triangles) }
        return SCNGeometry(sources: sources, elements: parts)
    }
}

/// Textures made once and shared by every book: the cloth's weave, paper edges, a headband's stripes, wood's grain,
/// and a small photographer's studio to light everything by. The cloth is ambientCG's Fabric082A and the studio
/// Poly Haven's Studio Small 09, both CC0 (public domain).
enum BookTextures {
    private static func bundled(_ name: String) -> UIImage? {
        Bundle.main.path(forResource: name, ofType: "jpg").flatMap(UIImage.init(contentsOfFile:))
    }

    static let clothNormal = bundled("cloth-normal")
    static let clothColour = bundled("cloth-colour")
    static let clothRough = bundled("cloth-rough")
    /// The studio, in high dynamic range: decoded here, as SceneKit won't read an EXR from a file itself, and decoded at
    /// once, whole. Left to decode when first drawn, the shelves and the book in hand, each drawing on a thread of its
    /// own, sometimes read it at the same moment, and every scene went without its light for as long as the app ran.
    static let studio: UIImage? = {
        guard let url = Bundle.main.url(forResource: "studio", withExtension: "exr"), let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }()

    /// The studio, made ready for lighting by: SceneKit works a lighting environment out once, the first time a scene with
    /// it is drawn, and keeps it. When the book in hand and the shelves all drew their first frames together and worked it
    /// out at once, it sometimes came out empty, and every scene went without its light for as long as the app ran. So it
    /// is worked out here first, drawing one tiny frame off screen, before any shelf is shown.
    static let studioReady: Void = {
        guard let studio, let device = MTLCreateSystemDefaultDevice() else { return }
        let scene = SCNScene()
        scene.lightingEnvironment.contents = studio
        let ball = SCNNode(geometry: SCNSphere(radius: 1))
        ball.geometry?.firstMaterial?.lightingModel = .physicallyBased
        scene.rootNode.addChildNode(ball)
        let eye = SCNNode()
        eye.camera = SCNCamera()
        eye.position = SCNVector3(0, 0, 4)
        scene.rootNode.addChildNode(eye)
        let renderer = SCNRenderer(device: device, options: nil)
        renderer.scene = scene
        renderer.pointOfView = eye
        _ = renderer.snapshot(atTime: 0, with: CGSize(width: 8, height: 8), antialiasingMode: .none)
    }()

    /// Ridges across a page block's edge, one per leaf.
    static let pageRidges: UIImage = normalMap(size: 64) { x, _ in 0.5 + 0.5 * sin(Double(x) * .pi / 1.5) }

    /// The colour of page edges: warm paper with the faint lines of the leaves.
    static let pages: UIImage = picture(256, 64, scale: 1) { ctx in
        ctx.setFillColor(RGB(0xebe3d0).cg); ctx.fill(CGRect(x: 0, y: 0, width: 256, height: 64))
        for x in stride(from: 0, to: 256, by: 3) {
            ctx.setFillColor(UIColor(red: 0.45, green: 0.38, blue: 0.28, alpha: CGFloat.random(in: 0.05 ... 0.16)).cgColor)
            ctx.fill(CGRect(x: CGFloat(x), y: 0, width: 1, height: 64))
        }
    }

    private static var stripeCache: [String: UIImage] = [:]
    private static let stripeLock = NSLock()

    /// A headband's stripes: two colours, side by side, repeated round the cord. Safe from any thread.
    static func stripes(_ a: UIColor, _ b: UIColor) -> UIImage {
        let key = "\(a.description)|\(b.description)"
        stripeLock.lock(); defer { stripeLock.unlock() }
        if let hit = stripeCache[key] { return hit }
        let image = picture(8, 2, scale: 1) { ctx in
            ctx.setFillColor(a.cgColor); ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 2))
            ctx.setFillColor(b.cgColor); ctx.fill(CGRect(x: 4, y: 0, width: 4, height: 2))
        }
        stripeCache[key] = image
        return image
    }

    /// Wood's grain, laid lengthwise along a shelf: long streaks a shade lighter and darker, never a pattern.
    static let woodGrain: UIImage = picture(512, 128, scale: 1) { ctx in
        ctx.setFillColor(UIColor.white.cgColor); ctx.fill(CGRect(x: 0, y: 0, width: 512, height: 128))
        for _ in 0 ..< 220 {
            let y = CGFloat.random(in: 0 ..< 128), h = CGFloat.random(in: 0.4 ... 2.2)
            ctx.setFillColor(UIColor(white: CGFloat.random(in: 0.62 ... 0.95), alpha: CGFloat.random(in: 0.25 ... 0.7)).cgColor)
            ctx.fill(CGRect(x: CGFloat.random(in: -200 ... 300), y: y, width: CGFloat.random(in: 120 ... 600), height: h))
        }
    }

    /// A normal map from a height field, wrapping at its edges so it tiles.
    private static func normalMap(size n: Int, height: (Int, Int) -> Double) -> UIImage {
        var hgt = [[Double]](repeating: [Double](repeating: 0, count: n), count: n)
        for y in 0 ..< n { for x in 0 ..< n { hgt[y][x] = height(x, y) } }
        return picture(CGFloat(n), CGFloat(n), scale: 1) { ctx in
            for y in 0 ..< n {
                for x in 0 ..< n {
                    let dx = hgt[y][(x + 1) % n] - hgt[y][(x + n - 1) % n], dy = hgt[(y + 1) % n][x] - hgt[(y + n - 1) % n][x]
                    var v = (-dx, -dy, 1.0)
                    let len = sqrt(v.0 * v.0 + v.1 * v.1 + v.2 * v.2); v = (v.0 / len, v.1 / len, v.2 / len)
                    ctx.setFillColor(UIColor(red: (v.0 + 1) / 2, green: (v.1 + 1) / 2, blue: (v.2 + 1) / 2, alpha: 1).cgColor)
                    ctx.fill(CGRect(x: x, y: y, width: 1, height: 1))
                }
            }
        }
    }
}

extension UIColor {
    func darker(_ f: CGFloat) -> UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return UIColor(red: r * f, green: g * f, blue: b * f, alpha: a)
    }
}
