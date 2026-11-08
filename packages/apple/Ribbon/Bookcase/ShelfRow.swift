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
    /// Each book's spine drawn flat, for the shelf before its 3D picture is ready.
    private(set) var flat: [String: UIImage] = [:]
    /// The shelf drawn in 3D at rest, as a still picture: what shows whenever it isn't the shelf in use.
    @Published var still: UIImage?
    /// Drawn live: the shelf holding the selected book, or one not yet pictured. Only these keep a 3D view and its memory.
    @Published var live = true
    /// Holds the selected book.
    private(set) var active = false

    init(id: Int, items: [ShelfItem], width W: CGFloat, k: CGFloat, scale: CGFloat) {
        self.id = id; self.items = items; self.width = W; self.k = k
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

        for it in items {
            let book = standingBook(it, k: k, scale: scale, front: front)
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

    /// The 3D view has drawn its first frame: keep a still picture of it, and let the view go unless the shelf is in use.
    func drawn(_ v: SCNView) {
        measured("first shelf in 3D")
        if still == nil { still = v.snapshot() }
        if !active { live = false }
    }

    /// The selected book has come to this shelf, or left it.
    func use(_ on: Bool) {
        active = on
        if on { live = true; return }
        // Let the book settle back before the view goes; the still picture is of the shelf at rest.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self, !self.active else { return }
            if self.still == nil, let v = self.view { self.still = v.snapshot() }
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

/// Made on any thread: it touches no scene. `front` is how far the shelf's board stands in front of the spines.
func standingBook(_ it: ShelfItem, k: CGFloat, scale: CGFloat, front: CGFloat) -> StandingBook {
    let b = it.book
    let d = min((it.h * 0.66).rounded(), (144 * k).rounded())
    let dress = spineDress(it, front: it.cloth.ground.ui, k: k, scale: scale)
    let box = BookModel.make(T: it.w, H: it.h, D: d, look: dress, paperback: b.paperback)
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
    return StandingBook(node: node, pivot: pivot, depth: d, spine: dress.spine)
}

/// A spine's art and its foil: the lettering and rules stamped in metal and smoother than the cloth around them.
/// A paperback's spine is printed, so it has no foil; a hardback's headband is in its foil's colour and cream.
func spineDress(_ it: ShelfItem, front: Any, k: CGFloat, scale: CGFloat) -> BookLook {
    let s = it.spine, p = it.cloth
    let spine = picture(s.width, s.height, scale: scale) { s.draw($0, cloth: p, k: k) }
    var dress = BookLook(spine: spine, front: front, cloth: p.ground.ui)
    if !it.book.paperback {
        dress.spineMetal = picture(s.width, s.height, scale: max(1, scale / 2)) {
            s.draw($0, cloth: Cloth(ground: RGB(0x000000), ink: RGB(0xb3b3b3), foil: RGB(0xb3b3b3)), k: k, mask: true)
        }
        dress.spineRough = picture(s.width, s.height, scale: max(1, scale / 2)) {
            s.draw($0, cloth: Cloth(ground: RGB(0xdbdbdb), ink: RGB(0x5c5c5c), foil: RGB(0x5c5c5c)), k: k, mask: true)
        }
    }
    dress.headband = (p.foil.ui, Cloth.cream.ui)
    return dress
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
        let v = SCNView(frame: .zero, options: nil)
        v.scene = scene
        v.pointOfView = camera
        v.backgroundColor = clear ? .clear : Look.canvas
        // Hidden until it has drawn, so the still picture or flat shelf beneath never flashes.
        if onDrawn != nil { v.alpha = 0 }
        context.coordinator.onDrawn = onDrawn
        v.delegate = context.coordinator
        #if os(tvOS)
        // A 4K screen seen from a sofa: lighter smoothing is invisible there and halves the view's memory.
        v.antialiasingMode = .multisampling2X
        #else
        v.antialiasingMode = .multisampling4X
        #endif
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
