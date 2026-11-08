import SceneKit
import SwiftUI
import UIKit

/// The phone's bookcase: every book on one long shelf, in one scene, seen by one camera that walks along it as you scroll.
///
/// The stacked shelves of the TV and the iPad each have a camera of their own, fixed at the shelf's middle. Cut into
/// screen-wide pieces, a long shelf showed every piece's middle as its own vanishing point, and the books turned the other
/// way at each join. Here there is one camera, so a book shows its right side as it passes left of the screen's middle
/// and its left side to the right of it, as a real shelf does when you walk past it, and nothing restarts.
///
/// Every book is made once, off the main thread, and stays in the scene: what is off screen costs memory, not drawing,
/// since SceneKit only draws what the camera sees. Before the shelf is shown, the camera walks it once out of sight,
/// so nothing is drawn for the first time as you scroll to it. No book ever appears late, and none makes the shelf stutter.
final class LongShelf {
    let items: [ShelfItem]
    /// The shelf's length, from the case's left side to its right, in points.
    let width: CGFloat
    let k: CGFloat
    let scene = SCNScene()
    let camera = SCNNode()
    /// Where the books' bottom edge sits, from the view's top, and the view's height, in points.
    let top: CGFloat
    let height: CGFloat
    weak var view: SCNView?
    weak var scroller: UIScrollView?
    /// Every book is on the shelf and the camera has walked it once: the shelf can be shown.
    private(set) var ready = false
    var onReady: (() -> Void)?

    private let rig: ShelfRig
    /// The camera's height and distance: only its place along the shelf changes.
    private let cameraY: Float, cameraZ: Float
    private var pivots: [String: (node: SCNNode, base: SCNVector3)] = [:]
    private var lifted: String?
    /// The lamps hang on fixed hooks along the whole shelf, but only the few near the camera are lit:
    /// a lamp whose light can't reach the screen moves to the next hook ahead, out of sight.
    private var lamps: [SCNNode] = []
    private var lampHooks = 0
    private var lampOn: [Int] = []
    private var glide: Glide?
    private var viewWidth: CGFloat = 0
    private var walking = false
    private var everyBookPlaced = false
    /// Waiting for frames to be drawn, during the walk.
    private var framesToWait = 0
    private var afterFrames: (() -> Void)?

    init(items: [ShelfItem], width W: CGFloat, k: CGFloat, scale: CGFloat) {
        self.items = items; self.width = W; self.k = k
        let a = shelfTilt * .pi / 180, ca = cos(a), sa = sin(a)
        let pad = (16 * k).rounded(), shelfH = (shelfHeight * k).rounded(), boardH = (12 * k).rounded()
        let front = (8 * k).rounded(), depth = (150 * k).rounded()
        rig = ShelfRig(width: W, shelfH: shelfH, pad: pad, depth: depth, front: front, k: k)
        // From the front edge of the shelf above to the front edge of its own board, as the camera sees them: as ShelfRow.
        top = (pad + shelfH) * ca - front * sa
        let bottom = -boardH * ca - front * sa
        height = top - bottom

        // The same long lens as the stacked shelves, so a point of scrolling moves the spines a point on the screen.
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
        cameraY = Float(c * ca + distance * sa)
        cameraZ = Float(-c * sa + distance * ca)
        camera.position = SCNVector3(0, cameraY, cameraZ)
        scene.rootNode.addChildNode(camera)
        scene.background.contents = Look.canvas
        let root = scene.rootNode

        // The case: its back, its board, the shelf above, and a side at each end.
        let back = SCNNode(geometry: SCNPlane(width: W, height: pad + shelfH + 2 * boardH + 400))
        back.geometry?.materials = [ShelfRow.wood(Lamplight.caseBack, rough: 0.9, along: W)]
        back.position = SCNVector3(Float(W / 2), Float((pad + shelfH) / 2), Float(-depth))
        root.addChildNode(back)
        let boardMat = ShelfRow.wood(Lamplight.caseBoard, rough: 0.75, along: W)
        let board = SCNNode(geometry: SCNBox(width: W, height: boardH, length: depth + front, chamferRadius: 1.2 * k))
        board.geometry?.materials = [boardMat]
        board.position = SCNVector3(Float(W / 2), Float(-boardH / 2), Float((front - depth) / 2))
        root.addChildNode(board)
        let above = SCNNode(geometry: SCNBox(width: W, height: boardH, length: depth + front, chamferRadius: 0))
        above.geometry?.materials = [boardMat]
        above.position = SCNVector3(Float(W / 2), Float(pad + shelfH + boardH / 2), Float((front - depth) / 2))
        root.addChildNode(above)
        for x in [-6 * k, W + 6 * k] {
            let wall = SCNNode(geometry: SCNBox(width: 12 * k, height: pad + shelfH + 2 * boardH, length: depth + front, chamferRadius: 0))
            wall.geometry?.materials = [ShelfRow.wood(Lamplight.caseBack, rough: 0.9, along: W)]
            wall.position = SCNVector3(Float(x), Float((pad + shelfH) / 2), Float((front - depth) / 2))
            root.addChildNode(wall)
        }
        // The labels on the board's front edge, where each month begins: lettering laid on the wood,
        // rather than one picture as long as the shelf.
        drawLabels(items, k: k, boardH: boardH) { label, x, w in
            let art = picture(w, boardH, scale: scale, clear: true) { _ in
                drawRun(label, SpineFace.label, 8 * k, x: w / 2, baseline: boardH / 2 + SpineFace.label.font(8 * k).capHeight / 2, colour: labelInk)
            }
            let m = BookModel.material(art, rough: 0.9 as NSNumber)
            m.isDoubleSided = false
            m.blendMode = .alpha
            m.writesToDepthBuffer = false
            let decal = SCNNode(geometry: SCNPlane(width: w, height: boardH))
            decal.geometry?.materials = [m]
            decal.renderingOrder = 1
            decal.position = SCNVector3(Float(x + w / 2), Float(-boardH / 2), Float(front + 0.2))
            root.addChildNode(decal)
        }

        lightRoom(scene, centre: SCNVector3(Float(W / 2), Float(shelfH / 2), Float(-depth / 2)), reach: W * 0.58)
        // Four lamps cover the screen and the reach of their light beyond it: the hooks either side of the camera.
        lampHooks = lampCount(along: W, k: k)
        lamps = (0 ..< min(4, lampHooks)).map { _ in shelfLamp() }
        lampOn = Array(repeating: -1, count: lamps.count)
        lamps.forEach(root.addChildNode)
        self.look(from: 0, width: 0)

        build(scale: scale, front: front)
    }

    /// Make every book off the main thread, a dozen at a time from the left, where the shelf opens. Each dozen goes on the
    /// shelf, out of sight to the right of the screen, and its pictures go to the graphics card before the next is made.
    private func build(scale: CGFloat, front: CGFloat) {
        let batches = stride(from: 0, to: items.count, by: 12).map { Array(items[$0 ..< min(items.count, $0 + 12)]) }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            for batch in batches {
                guard let self else { return }
                let books = batch.map { standingBook($0, k: self.k, scale: scale, front: front) }
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.main.async {
                    self.place(books)
                    if let view = self.view { view.prepare(books.map(\.node)) { _ in group.leave() } } else { group.leave() }
                }
                group.wait()
            }
            DispatchQueue.main.async {
                self?.everyBookPlaced = true
                self?.walkIfReady()
            }
        }
    }

    private func place(_ books: [StandingBook]) {
        SCNTransaction.begin()
        SCNTransaction.disableActions = true
        for b in books {
            scene.rootNode.addChildNode(b.node)
            pivots[b.pivot.name ?? ""] = (b.pivot, b.pivot.position)
        }
        SCNTransaction.commit()
        // A book chosen before it was made comes out now.
        if let id = lifted, books.contains(where: { $0.pivot.name == id }) { lifted = nil; lift(id) }
        playBriefly(view, 0.1)
    }

    /// SceneKit makes what it needs to draw each kind of thing (a paperback, a ribbon, a label, a book under three lamps
    /// rather than two) the first time one is on screen, and on a phone that holds up a frame for a fifth of a second.
    /// So, still hidden, the camera walks the whole shelf a screen at a time, two frames at each stop, and only then is the
    /// shelf shown, at its start.
    func walkIfReady() {
        guard !ready, !walking, everyBookPlaced, view != nil, viewWidth > 0 else { return }
        walking = true
        let last = max(0, width - viewWidth)
        let stops = Array(stride(from: 0, to: last, by: viewWidth * 0.75)) + [last]
        func visit(_ i: Int) {
            guard i < stops.count else {
                walking = false
                ready = true
                look(from: scroller?.contentOffset.x ?? 0, width: viewWidth)
                onReady?()
                return
            }
            framesToWait = 2
            afterFrames = { visit(i + 1) }
            look(from: stops[i], width: viewWidth)
        }
        visit(0)
    }

    /// The view has drawn a frame (called on SceneKit's thread).
    func drewFrame() {
        DispatchQueue.main.async {
            guard self.afterFrames != nil else { return }
            self.framesToWait -= 1
            if self.framesToWait <= 0, let next = self.afterFrames { self.afterFrames = nil; next() }
        }
    }

    /// Put the camera over the middle of what the scroll view shows, and the lamps on the hooks around it.
    /// While the shelf walks itself out of sight, it ignores the scroll view.
    func look(from offset: CGFloat, width viewWidth: CGFloat, scrolled: Bool = false) {
        guard !(scrolled && walking) else { return }
        self.viewWidth = viewWidth
        let x = offset + viewWidth / 2
        SCNTransaction.begin()
        SCNTransaction.disableActions = true
        camera.position = SCNVector3(Float(x), cameraY, cameraZ)
        hangLamps(around: x)
        SCNTransaction.commit()
        playBriefly(view, 0.25)
    }

    /// Hook i hangs at the middle of the i-th equal part of the shelf, as the stacked shelves space their lamps. Each hook has
    /// its own lamp (hook i, lamp i mod 4), so as the camera passes a hook only the lamp two hooks behind moves, to two hooks ahead.
    private func hangLamps(around x: CGFloat) {
        guard !lamps.isEmpty else { return }
        let spacing = width / CGFloat(lampHooks)
        let nearest = Int((x / spacing - 0.5).rounded(.down))
        let first = max(0, min(lampHooks - lamps.count, nearest - lamps.count / 2 + 1))
        for hook in first ..< first + lamps.count {
            let i = hook % lamps.count
            guard lampOn[i] != hook else { continue }
            lampOn[i] = hook
            hang(lamps[i], over: spacing * (CGFloat(hook) + 0.5), rig)
        }
    }

    /// The book at a point on the screen: whichever the finger lands on, by its shape in the scene.
    func item(at point: CGPoint, offset: CGFloat) -> ShelfItem? {
        let hits = view?.hitTest(point, options: [.searchMode: SCNHitTestSearchMode.closest.rawValue]) ?? []
        var node = hits.first?.node
        while let n = node, pivots[n.name ?? ""] == nil { node = n.parent }
        let x = point.x + offset
        let id = node?.name ?? items.first { x >= $0.x && x < $0.x + $0.w }?.id
        return items.first { $0.id == id }
    }

    /// Take one book down, tipped towards you and then drawn out (takeOut), and put the last one back.
    func lift(_ id: String?) {
        guard id != lifted else { return }
        let was = lifted
        lifted = id
        if let was, let p = pivots[was] { putBack(p.node, base: p.base) }
        if let id, let p = pivots[id] { takeOut(p.node, base: p.base, k: k) { [weak self] in self?.lifted == id } }
        playBriefly(view, 0.5)
    }

    /// Scroll a book to the middle of the screen, gliding there however far it is.
    func bringIntoView(_ it: ShelfItem) {
        guard let scroll = scroller else { return }
        let far = max(0, scroll.contentSize.width - scroll.bounds.width)
        let to = min(far, max(0, it.x + it.w / 2 - scroll.bounds.width / 2))
        glide?.stop()
        glide = Glide(scroll, to: to)
    }
}

/// A scroll view moved to a place over a time that grows a little with the distance, easing in and out,
/// a frame at a time so the camera follows every step. A finger on the shelf stops it.
final class Glide: NSObject {
    private weak var scroll: UIScrollView?
    private let from: CGFloat, to: CGFloat, duration: Double
    private let started = CACurrentMediaTime()
    private var link: CADisplayLink?

    init(_ scroll: UIScrollView, to: CGFloat) {
        self.scroll = scroll
        from = scroll.contentOffset.x
        self.to = to
        duration = 0.35 + min(0.45, Double(abs(to - from)) / 5000)
        super.init()
        link = CADisplayLink(target: self, selector: #selector(step))
        link?.add(to: .main, forMode: .common)
    }

    @objc private func step() {
        guard let scroll, !scroll.isTracking else { stop(); return }
        let t = min(1, (CACurrentMediaTime() - started) / duration)
        let eased = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
        scroll.contentOffset.x = from + (to - from) * CGFloat(eased)
        if t >= 1 { stop() }
    }

    func stop() { link?.invalidate(); link = nil }
}

/// The long shelf on screen: the 3D view stays put and a scroll view over it, holding nothing you can see, gives the
/// shelf the phone's own scrolling, its fling and its bounce. Every step it takes moves the camera.
struct LongShelfView: UIViewRepresentable {
    let shelf: LongShelf
    let onPick: (ShelfItem) -> Void

    func makeUIView(context: Context) -> ShelfScroller { ShelfScroller(shelf, onPick: onPick) }
    func updateUIView(_ v: ShelfScroller, context: Context) { v.onPick = onPick }
}

final class ShelfScroller: UIView, UIScrollViewDelegate {
    let shelf: LongShelf
    var onPick: (ShelfItem) -> Void
    private let scene = SCNView(frame: .zero, options: nil)
    private let scroll = UIScrollView()
    private let frames = FrameWatch()

    init(_ shelf: LongShelf, onPick: @escaping (ShelfItem) -> Void) {
        self.shelf = shelf
        self.onPick = onPick
        super.init(frame: .zero)
        scene.scene = shelf.scene
        scene.pointOfView = shelf.camera
        scene.backgroundColor = Look.canvas
        scene.antialiasingMode = .multisampling4X
        scene.rendersContinuously = false
        scene.isPlaying = false
        scene.isUserInteractionEnabled = false
        // Hidden until every book is on it and it has been walked once, so it comes in whole.
        scene.alpha = 0
        scroll.isUserInteractionEnabled = false
        frames.onFrame = { [weak shelf] in shelf?.drewFrame() }
        scene.delegate = frames
        shelf.onReady = { [weak self] in
            guard let self else { return }
            self.scroll.isUserInteractionEnabled = true
            UIView.animate(withDuration: 0.25) { self.scene.alpha = 1 }
        }
        scroll.delegate = self
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        addSubview(scene)
        addSubview(scroll)
        shelf.view = scene
        shelf.scroller = scroll
        // VoiceOver reads the shelf a book at a time, left to right.
        scroll.accessibilityElements = shelf.items.map { it in
            let e = BookElement(accessibilityContainer: scroll)
            e.accessibilityLabel = "\(it.book.title), \(it.book.author)"
            e.accessibilityTraits = .button
            e.accessibilityFrameInContainerSpace = CGRect(x: it.x, y: shelf.top - it.h, width: it.w, height: it.h)
            e.activate = { [weak self] in self?.onPick(it) }
            return e
        }
    }

    required init?(coder: NSCoder) { fatalError("made in code") }

    override func layoutSubviews() {
        super.layoutSubviews()
        scene.frame = bounds
        scroll.frame = bounds
        scroll.contentSize = CGSize(width: shelf.width, height: bounds.height)
        shelf.look(from: scroll.contentOffset.x, width: bounds.width, scrolled: true)
        shelf.walkIfReady()
    }

    func scrollViewDidScroll(_ s: UIScrollView) { shelf.look(from: s.contentOffset.x, width: s.bounds.width, scrolled: true) }

    @objc private func tapped(_ g: UITapGestureRecognizer) {
        if let it = shelf.item(at: g.location(in: scene), offset: scroll.contentOffset.x) { onPick(it) }
    }
}

/// Tells the shelf of every frame its view draws.
final class FrameWatch: NSObject, SCNSceneRendererDelegate {
    var onFrame: () -> Void = {}
    func renderer(_ renderer: SCNSceneRenderer, didRenderScene scene: SCNScene, atTime time: TimeInterval) {
        onFrame()
    }
}

final class BookElement: UIAccessibilityElement {
    var activate: () -> Void = {}
    override func accessibilityActivate() -> Bool { activate(); return true }
}
