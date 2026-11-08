import SceneKit
import SwiftUI
import UIKit

/// One shelf of the bookcase on the TV and the iPad, as its own small SceneKit scene, seen through a long lens that only
/// tilts down a little, so every spine is where the layout puts it. It draws only when something on it moves; a shelf
/// not in use shows a still picture of itself and lets its 3D view go.
final class ShelfRow: ObservableObject, Identifiable {
    let id: Int
    let items: [ShelfItem]
    let width: CGFloat
    let k: CGFloat
    /// The screen's pixels to a point.
    private let scale: CGFloat
    let scene = SCNScene()
    let camera = SCNNode()
    /// Where the books' bottom edge sits, from the row's top, and the row's height, in points.
    let top: CGFloat
    let height: CGFloat
    private let tilt: CGFloat
    private var pivots: [String: (node: SCNNode, base: SCNVector3, depth: CGFloat)] = [:]
    /// The book drawn out of this shelf, if any.
    private var lifted: String?
    weak var view: SCNView?
    /// Each book's spine drawn flat, for the shelf before its 3D picture is ready, and let go once it is.
    private(set) var flat: [String: UIImage] = [:]
    /// The shelf drawn in 3D at rest, as a still picture: what shows whenever it isn't the shelf in use.
    @Published var still: UIImage?
    /// Drawn live: the shelf holding the selected book, or one not yet pictured. Only these keep a 3D view and its memory.
    @Published var live = true
    /// Holds the selected book.
    private(set) var active = false
    /// How many times the shelf has come into use, so a still picture begun before it last did is known to be spoiled.
    private var uses = 0
    private var picturing = false

    /// `sheets`, if given, holds the spines' art: those of every shelf in the case, planned together.
    init(id: Int, items: [ShelfItem], width W: CGFloat, k: CGFloat, scale: CGFloat, sheets: SpineSheets? = nil) {
        self.id = id; self.items = items; self.width = W; self.k = k; self.scale = scale
        let a = shelfTilt * .pi / 180, ca = cos(a), sa = sin(a)
        tilt = a
        let pad = (16 * k).rounded(), shelfH = (shelfHeight * k).rounded(), boardH = (12 * k).rounded()
        let front = (8 * k).rounded(), depth = (150 * k).rounded()
        // The row runs from the front edge of the shelf above to the front edge of its own board, as the camera sees them.
        top = (pad + shelfH) * ca - front * sa
        let bottom = -boardH * ca - front * sa
        height = top - bottom

        let cam = SCNCamera()
        cam.fieldOfView = 14
        let distance = (height / 2) / tan(7 * .pi / 180)
        cam.zNear = Double(distance * 0.5); cam.zFar = Double(distance * 2)
        grade(cam)
        cam.screenSpaceAmbientOcclusionIntensity = 0.9
        cam.screenSpaceAmbientOcclusionRadius = 5 * k
        camera.camera = cam
        camera.eulerAngles = SCNVector3(Float(-a), 0, 0)
        let c = (top + bottom) / 2
        camera.position = SCNVector3(Float(W / 2), Float(c * ca + distance * sa), Float(-c * sa + distance * ca))
        scene.rootNode.addChildNode(camera)
        // Behind the case, the app's own background, so nothing shows where the scene ends.
        scene.background.contents = Look.canvas
        let root = scene.rootNode

        let back = SCNNode(geometry: SCNPlane(width: W, height: pad + shelfH + 2 * boardH + 400))
        back.geometry?.materials = [Self.wood(Lamplight.caseBack, rough: 0.9, along: W)]
        back.position = SCNVector3(Float(W / 2), Float((pad + shelfH) / 2), Float(-depth))
        root.addChildNode(back)

        // Its board, labelled on its front edge where each month begins.
        let labels = picture(W, boardH, scale: scale) { ctx in
            ctx.setFillColor(Lamplight.caseBoard.cg); ctx.fill(CGRect(x: 0, y: 0, width: W, height: boardH))
            drawLabels(items, k: k, boardH: boardH) { label, x, w in
                drawRun(label, SpineFace.label, 8 * k, x: x + w / 2, baseline: boardH / 2 + SpineFace.label.font(8 * k).capHeight / 2, colour: labelInk)
            }
        }
        let boardMat = Self.wood(Lamplight.caseBoard, rough: 0.75, along: W)
        let board = SCNNode(geometry: SCNBox(width: W, height: boardH, length: depth + front, chamferRadius: 1.2 * k))
        board.geometry?.materials = [BookModel.material(labels, rough: 0.9 as NSNumber), boardMat, boardMat, boardMat, boardMat, boardMat]
        board.position = SCNVector3(Float(W / 2), Float(-boardH / 2), Float((front - depth) / 2))
        root.addChildNode(board)
        // The shelf above: out of sight, but it casts its shadow on these books.
        let above = SCNNode(geometry: SCNBox(width: W, height: boardH, length: depth + front, chamferRadius: 0))
        above.geometry?.materials = [boardMat]
        above.position = SCNVector3(Float(W / 2), Float(pad + shelfH + boardH / 2), Float((front - depth) / 2))
        root.addChildNode(above)
        // The case's sides, just out of sight, so the light falls into a case and not across an open shelf.
        for x in [-6 * k, W + 6 * k] {
            let wall = SCNNode(geometry: SCNBox(width: 12 * k, height: pad + shelfH + 2 * boardH, length: depth + front, chamferRadius: 0))
            wall.geometry?.materials = [Self.wood(Lamplight.caseBack, rough: 0.9, along: W)]
            wall.position = SCNVector3(Float(x), Float((pad + shelfH) / 2), Float((front - depth) / 2))
            root.addChildNode(wall)
        }

        for (it, book) in zip(items, measured("making a shelf's books") { standingBooks(items, k: k, scale: scale, front: front, sheets: sheets) }) {
            flat[it.id] = book.spine
            root.addChildNode(book.node)
            pivots[it.id] = (book.pivot, book.pivot.position, book.depth)
        }

        light(scene, shelf: ShelfRig(width: W, shelfH: shelfH, pad: pad, depth: depth, front: front, k: k),
              centre: SCNVector3(Float(W / 2), Float(shelfH / 2), Float(-depth / 2)), reach: W * 0.58)
    }

    /// The case's wood: its colour with the grain running along the shelf. Matte, as old wood is.
    static func wood(_ colour: RGB, rough: CGFloat, along W: CGFloat) -> SCNMaterial {
        let m = BookModel.material(colour.ui, rough: rough as NSNumber)
        m.multiply.contents = BookTextures.woodGrain
        m.multiply.intensity = 0.5
        m.multiply.wrapS = .repeat
        m.multiply.wrapT = .repeat
        m.multiply.contentsTransform = SCNMatrix4MakeScale(Float(W / 420), 1, 1)
        return m
    }

    /// The 3D view has drawn its first frame: unless the shelf is in use, picture it at rest and let the view go.
    /// On the Apple TV, picture it now even in use, as each still costs it the most later (pictureAtRest).
    func drawn(_ v: SCNView) {
        measured("first shelf in 3D")
        #if os(tvOS)
        if still == nil { still = v.snapshot() }
        if !active { live = false }
        #else
        if !active { pictureAtRest(from: v) }
        #endif
        // Once the flat shelf has faded out under the 3D one.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.flat = [:] }
    }

    /// The selected book has come to this shelf, or left it.
    func use(_ on: Bool) {
        active = on
        if on { uses += 1; live = true; return }
        // Let the book settle back before the view goes; the still picture is of the shelf at rest.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self, !self.active else { return }
            if self.still == nil { self.pictureAtRest(from: self.view) } else { self.live = false }
        }
    }

    /// The shelf at rest as a still picture, drawn off screen and away from the main thread, and then its 3D view let go.
    /// Taken from the view itself, on the main thread, it held up the screen for a twelfth of a second each time a shelf
    /// came into use. A book taken down from the shelf meanwhile would spoil it: then it's thrown away, and the shelf is
    /// pictured again when the book goes back.
    ///
    /// Not on the Apple TV, whose graphics chip is busy drawing a 4K screen: there a still drawn beside the view took up
    /// to 0.7 s and made the book coming off the shelf stutter, and one taken from the view held the screen 0.3 s. So the
    /// TV pictures each shelf as soon as it's first drawn (drawn), while the page is still coming in, as it always has.
    private func pictureAtRest(from view: SCNView?) {
        guard still == nil, !picturing else { return }
        #if os(tvOS)
        if let view { still = view.snapshot(); live = false; return }
        #endif
        picturing = true
        let begun = uses
        ShelfStills.draw(scene, camera: camera, size: CGSize(width: width, height: height), scale: scale) { [weak self] image in
            guard let self else { return }
            self.picturing = false
            guard let image, !self.active, self.uses == begun else { return }
            self.still = image
            self.live = false
        }
    }

    /// A row's height at a size: from the front edge of the shelf above to the front edge of its own board.
    static func height(k: CGFloat) -> CGFloat {
        ((16 * k).rounded() + (shelfHeight * k).rounded() + (12 * k).rounded()) * cos(shelfTilt * .pi / 180)
    }

    /// Where a book's button goes over the picture: its front face and the top that shows above it.
    func frame(of it: ShelfItem) -> CGRect {
        let d = pivots[it.id]?.depth ?? 0
        let y = max(0, top - it.h * cos(tilt) - d * sin(tilt))
        return CGRect(x: it.x, y: y, width: it.w, height: top - y)
    }

    func item(at x: CGFloat) -> ShelfItem? { items.first { x >= $0.x && x < $0.x + $0.w } }

    /// Take one book down and put the last one back. By hand it tips towards you, then comes out (takeOut); seen from
    /// a sofa, the TV tips it and draws it out in one movement, which reads across a room.
    func lift(_ id: String?) {
        guard id != lifted else { return }
        let was = lifted
        lifted = id
        #if os(tvOS)
        SCNTransaction.begin()
        SCNTransaction.animationDuration = 0.18
        SCNTransaction.animationTimingFunction = CAMediaTimingFunction(name: .easeOut)
        for key in [was, id].compactMap({ $0 }) {
            guard let p = pivots[key] else { continue }
            let on = key == id
            p.node.position = on ? SCNVector3(p.base.x, p.base.y + Float(4 * k), p.base.z + Float(22 * k)) : p.base
            p.node.eulerAngles = SCNVector3(on ? Float(11 * CGFloat.pi / 180) : 0, p.node.eulerAngles.y, p.node.eulerAngles.z)
        }
        SCNTransaction.commit()
        playBriefly(view, 0.3)
        #else
        if let was, let p = pivots[was] { putBack(p.node, base: p.base) }
        if let id, let p = pivots[id] { takeOut(p.node, base: p.base, k: k) { [weak self] in self?.lifted == id } }
        playBriefly(view, 0.5)
        #endif
    }
}

/// How far the camera looks down on a shelf, in degrees: enough to see the books' tops and the shelf's depth.
let shelfTilt: CGFloat = 6

/// The labels' lettering on the dark wood.
let labelInk = UIColor(white: 1, alpha: 0.5)

/// Each label on a shelf's edge where it begins, unless it would run into the one before.
func drawLabels(_ items: [ShelfItem], k: CGFloat, boardH: CGFloat, _ draw: (_ label: String, _ x: CGFloat, _ width: CGFloat) -> Void) {
    var lastEnd = -CGFloat.infinity
    for it in items {
        guard let label = it.label?.uppercased(), it.x >= lastEnd + 8 * k else { continue }
        let w = (measure(label, SpineFace.label) * 8 * k).rounded(.up) + 2
        lastEnd = it.x + w
        draw(label, it.x, w)
    }
}

/// A book standing spine-out where the layout puts it, with the ribbon of your place hanging over the shelf's edge.
/// `node` holds both, ready to add to a scene; `pivot` is the book itself, for taking it down.
struct StandingBook {
    let node: SCNNode
    let pivot: SCNNode
    let depth: CGFloat
    let spine: UIImage
}

/// Books made side by side, one to each of the device's cores, in their order. Made on any thread.
func standingBooks(_ items: [ShelfItem], k: CGFloat, scale: CGFloat, front: CGFloat, sheets: SpineSheets? = nil) -> [StandingBook] {
    var made = [StandingBook?](repeating: nil, count: items.count)
    let lock = NSLock(), copies = GraphicsCard.Copies()
    DispatchQueue.concurrentPerform(iterations: items.count) { i in
        let book = standingBook(items[i], k: k, scale: scale, front: front, sheets: sheets, copies: copies)
        lock.lock(); made[i] = book; lock.unlock()
    }
    copies.make()
    return made.map { $0! }
}

/// Made on any thread: it touches no scene. `front` is how far the shelf's board stands in front of the spines;
/// `sheets`, if given, is where the shelf's spines are drawn, and `copies`, if given, makes its textures' smaller copies
/// with the rest of the shelf's, and it isn't ready to draw until they're made.
func standingBook(_ it: ShelfItem, k: CGFloat, scale: CGFloat, front: CGFloat, sheets: SpineSheets? = nil, copies: GraphicsCard.Copies? = nil) -> StandingBook {
    let b = it.book
    let d = min((it.h * 0.66).rounded(), (144 * k).rounded())
    let dress = spineDress(it, front: it.cloth.ground.ui, k: k, scale: scale, sheets: sheets, copies: copies)
    let box = BookModel.make(T: it.w, H: it.h, D: d, look: dress.look, paperback: b.paperback)
    // The spine's crown at the shelf's front line, where the flat spine stood.
    box.position = SCNVector3(0, 0, Float(-BookModel.roundness(it.w, paperback: b.paperback)))
    let pivot = SCNNode()
    pivot.name = b.id
    pivot.position = SCNVector3(Float(it.x), 0, 0)
    if it.lean { pivot.eulerAngles = SCNVector3(0, 0, Float(8 * CGFloat.pi / 180)) }
    pivot.addChildNode(box)
    let node = SCNNode()
    node.addChildNode(pivot)
    // Your place: the ribbon hangs over the shelf's edge.
    if b.fraction > 0, !b.finished {
        let cx = Float(it.x + it.w / 2)
        let hang = SCNNode(geometry: swallowtail(width: 5 * k, length: 22 * k))
        hang.position = SCNVector3(cx, 0, Float(front + 0.4))
        let flat = SCNNode(geometry: SCNPlane(width: 5 * k, height: front + 2))
        flat.geometry?.materials = hang.geometry!.materials
        flat.eulerAngles = SCNVector3(-Float.pi / 2, 0, 0)
        flat.position = SCNVector3(cx, 0.3, Float(front / 2 - 1))
        node.addChildNode(hang); node.addChildNode(flat)
    }
    return StandingBook(node: node, pivot: pivot, depth: d, spine: dress.flat)
}

/// A spine's art and its foil: the lettering and rules stamped in metal and smoother than the cloth around them.
/// A paperback's spine is printed, so it has no foil; a hardback's headband is in its foil's colour and cream.
/// The art goes to the graphics card, onto the shelf's sheets if it has them, and `flat`, if wanted, is the same art as
/// an image, for drawing the shelf flat.
func spineDress(_ it: ShelfItem, front: Any, k: CGFloat, scale: CGFloat, sheets: SpineSheets? = nil, copies: GraphicsCard.Copies? = nil) -> (look: BookLook, flat: UIImage) {
    let s = it.spine, p = it.cloth
    let art = picture(s.width, s.height, scale: scale) { s.draw($0, cloth: p, k: k) }
    let shared = sheets?.put(art, for: it.id)
    var dress = BookLook(spine: shared?.sheet ?? GraphicsCard.colour(art) ?? art, front: front, cloth: p.ground.ui)
    dress.spinePlace = shared?.place
    if !it.book.paperback {
        let white = RGB(0xffffff)
        dress.spineFoil = GraphicsCard.foil(s.width, s.height, scale: max(1, scale / 2), copies: copies) {
            s.draw($0, cloth: Cloth(ground: RGB(0x000000), ink: white, foil: white), k: k, mask: true)
        }
    }
    dress.headband = (p.foil.ui, Cloth.cream.ui)
    return (dress, art)
}

/// The ribbon marking your place: silk, lit like everything else, so it glows amber under a lamp rather than burning out.
func swallowtail(width w: CGFloat, length l: CGFloat) -> SCNShape {
    let p = UIBezierPath()
    p.move(to: CGPoint(x: -w / 2, y: 0)); p.addLine(to: CGPoint(x: w / 2, y: 0)); p.addLine(to: CGPoint(x: w / 2, y: -l))
    p.addLine(to: CGPoint(x: 0, y: -0.8 * l)); p.addLine(to: CGPoint(x: -w / 2, y: -l)); p.close()
    let s = SCNShape(path: p, extrusionDepth: 0.2)
    s.materials = [BookModel.material(Look.place.darker(0.8), rough: 0.45 as NSNumber)]
    return s
}

/// Taking a book down by hand, as from a real shelf: a finger hooked over its head tips it towards you on its front
/// foot, then draws it out. `stillWanted` stops the pull when another book was chosen while this one tipped.
func takeOut(_ node: SCNNode, base: SCNVector3, k: CGFloat, stillWanted: @escaping () -> Bool) {
    SCNTransaction.begin()
    SCNTransaction.animationDuration = 0.14
    SCNTransaction.animationTimingFunction = CAMediaTimingFunction(name: .easeOut)
    SCNTransaction.completionBlock = {
        DispatchQueue.main.async {
            guard stillWanted() else { return }
            SCNTransaction.begin()
            SCNTransaction.animationDuration = 0.22
            SCNTransaction.animationTimingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            node.position = SCNVector3(base.x, base.y + Float(3 * k), base.z + Float(28 * k))
            SCNTransaction.commit()
        }
    }
    node.eulerAngles = SCNVector3(Float(11 * CGFloat.pi / 180), node.eulerAngles.y, node.eulerAngles.z)
    SCNTransaction.commit()
}

/// Put back: pushed home and stood upright in one movement.
func putBack(_ node: SCNNode, base: SCNVector3) {
    SCNTransaction.begin()
    SCNTransaction.animationDuration = 0.18
    SCNTransaction.animationTimingFunction = CAMediaTimingFunction(name: .easeOut)
    node.position = base
    node.eulerAngles = SCNVector3(0, node.eulerAngles.y, node.eulerAngles.z)
    SCNTransaction.commit()
}

/// SceneKit draws only while playing: play just long enough for an animation, then stop, so a still shelf costs nothing.
private var playingUntil: [ObjectIdentifier: CFTimeInterval] = [:]

func playBriefly(_ view: SCNView?, _ seconds: Double) {
    guard let view else { return }
    let until = CACurrentMediaTime() + seconds
    playingUntil[ObjectIdentifier(view)] = max(until, playingUntil[ObjectIdentifier(view)] ?? 0)
    view.isPlaying = true
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak view] in
        guard let view, CACurrentMediaTime() >= (playingUntil[ObjectIdentifier(view)] ?? 0) - 0.001 else { return }
        view.isPlaying = false
    }
}

/// How much the shelves are smoothed. On a 4K screen seen from a sofa, lighter smoothing is invisible there and halves a
/// view's memory.
#if os(tvOS)
let shelfSmoothing = SCNAntialiasingMode.multisampling2X
#else
let shelfSmoothing = SCNAntialiasingMode.multisampling4X
#endif

/// The shelves' still pictures, drawn off screen as their views would draw them, one at a time, by one renderer while
/// there are pictures to draw: a renderer of its own for each spent most of its time readying the lamplight and every
/// texture again, and on the Apple TV took 0.7 s a picture. It goes once the last is drawn, and its memory with it.
enum ShelfStills {
    private static let queue = DispatchQueue(label: "app.ribbon.shelf-stills", qos: .userInitiated)
    /// Touched only on the queue.
    private static var renderer: SCNRenderer?
    private static var waiting = 0
    private static let counting = NSLock()

    /// A shelf's scene through its camera at a size in points, then `done` on the main thread with the picture.
    static func draw(_ scene: SCNScene, camera: SCNNode, size: CGSize, scale: CGFloat, done: @escaping (UIImage?) -> Void) {
        counting.lock(); waiting += 1; counting.unlock()
        queue.async {
            let drawing = renderer ?? SCNRenderer(device: GraphicsCard.device, options: nil)
            renderer = drawing
            drawing.scene = scene
            drawing.pointOfView = camera
            let pixels = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
            let image = measured("a shelf's still picture, off the main thread") {
                drawing.snapshot(atTime: 0, with: pixels, antialiasingMode: shelfSmoothing).cgImage
            }
            drawing.scene = nil
            counting.lock(); waiting -= 1; let last = waiting == 0; counting.unlock()
            if last { renderer = nil }
            DispatchQueue.main.async { done(image.map { UIImage(cgImage: $0, scale: scale, orientation: .up) }) }
        }
    }
}

/// A SceneKit view in SwiftUI that draws only when asked, smoothed, hidden until its first frame.
struct SceneHost: UIViewRepresentable {
    let scene: SCNScene
    let camera: SCNNode
    var clear = false
    /// Called once, on the main thread, when the view has drawn its first frame.
    var onDrawn: ((SCNView) -> Void)? = nil
    var onView: (SCNView) -> Void

    final class Coordinator: NSObject, SCNSceneRendererDelegate {
        var onDrawn: ((SCNView) -> Void)?
        private var fired = false
        func renderer(_ renderer: SCNSceneRenderer, didRenderScene scene: SCNScene, atTime time: TimeInterval) {
            // A shelf's frames, not the book in hand's.
            if onDrawn != nil { measuredFrame() }
            guard !fired, let v = renderer as? SCNView else { return }
            fired = true
            DispatchQueue.main.async {
                v.alpha = 1
                self.onDrawn?(v)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SCNView {
        let v = measured("making a 3D view") { SCNView(frame: .zero, options: nil) }
        v.scene = scene
        v.pointOfView = camera
        v.backgroundColor = clear ? .clear : Look.canvas
        // Hidden until it has drawn, so the still picture or flat shelf beneath never flashes.
        if onDrawn != nil { v.alpha = 0 }
        context.coordinator.onDrawn = onDrawn
        v.delegate = context.coordinator
        v.antialiasingMode = shelfSmoothing
        v.rendersContinuously = false
        v.isPlaying = false
        v.isUserInteractionEnabled = false
        onView(v)
        return v
    }

    /// SwiftUI keeps the view when a shelf is built again in its place: show the new shelf's scene.
    func updateUIView(_ v: SCNView, context: Context) {
        guard v.scene !== scene else { return }
        v.scene = scene
        v.pointOfView = camera
        onView(v)
    }
}
