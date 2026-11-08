import SceneKit
import UIKit

/// The lectern's book: the one you're on, in your hand. It comes spine-on, as it left the shelf, and turns to its
/// cover; by touch you can turn it yourself. Each book is made away from the main thread, its cover from the server,
/// and the books either side are made ahead so moving along the shelf finds them ready.
final class BookInHand {
    let scene = SCNScene()
    let camera = SCNNode()
    weak var view: SCNView?
    /// A cover from the server, by its hash.
    private let cover: (String) async -> CGImage?
    private var book: SCNNode?
    private var turn: DispatchWorkItem?
    private let queue = DispatchQueue(label: "app.ribbon.book-in-hand", qos: .userInitiated)
    /// The books made lately, the newest last; a few are kept.
    private var made: [String: SCNNode] = [:]
    private var order: [String] = []
    private var making: Set<String> = []
    private var wanted: String?
    private var yaw: Float = 0
    /// Turned to show its cover, a little more than square-on so the spine still shows.
    private static let coverOn = Float(-58 * CGFloat.pi / 180)

    init(cover: @escaping (String) async -> CGImage?) {
        self.cover = cover
        let cam = SCNCamera()
        cam.fieldOfView = 22
        cam.zNear = 10
        cam.zFar = 5000
        grade(cam)
        camera.camera = cam
        scene.rootNode.addChildNode(camera)
        light(scene, shelf: nil, centre: SCNVector3Zero, reach: 400)
    }

    func show(_ it: ShelfItem, k: CGFloat, scale: CGFloat) {
        let fit = shelfHeight * k / 0.95
        camera.position = SCNVector3(0, Float(fit * 0.18), Float(fit / (2 * tan(11 * CGFloat.pi / 180))))
        camera.look(at: SCNVector3Zero)
        wanted = it.id
        if let node = made[it.id] { present(node) } else { make(it, k: k, scale: scale) }
    }

    /// Make the books either side ahead of time.
    func prefetch(_ items: [ShelfItem], k: CGFloat, scale: CGFloat) {
        for it in items where made[it.id] == nil { make(it, k: k, scale: scale) }
    }

    private func make(_ it: ShelfItem, k: CGFloat, scale: CGFloat) {
        guard !making.contains(it.id) else { return }
        making.insert(it.id)
        Task { @MainActor in
            var art: CGImage?
            if let hash = it.book.coverHash { art = await cover(hash) }
            queue.async { [art] in
                let node = Self.build(it, cover: art, k: k, scale: scale)
                DispatchQueue.main.async {
                    self.making.remove(it.id)
                    self.made[it.id] = node
                    self.order.removeAll { $0 == it.id }
                    self.order.append(it.id)
                    while self.order.count > 8 { self.made[self.order.removeFirst()] = nil }
                    if self.wanted == it.id { self.present(node) } else { self.view?.prepare([node], completionHandler: nil) }
                }
            }
        }
    }

    private func present(_ node: SCNNode) {
        book?.removeFromParentNode()
        node.eulerAngles = SCNVector3(0, 0, 0)
        scene.rootNode.addChildNode(node)
        book = node
        yaw = 0
        turn?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let book = self.book, book === node else { return }
            SCNTransaction.begin()
            SCNTransaction.animationDuration = 0.56
            SCNTransaction.animationTimingFunction = CAMediaTimingFunction(name: .easeOut)
            book.eulerAngles = SCNVector3(0, Self.coverOn, 0)
            SCNTransaction.commit()
            self.yaw = Self.coverOn
            playBriefly(self.view, 0.75)
        }
        turn = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.14, execute: work)
        playBriefly(view, 0.1)
    }

    /// The book in hand: its cover on the front board, its spine as on the shelf, its ribbon at your place.
    private static func build(_ it: ShelfItem, cover: CGImage?, k: CGFloat, scale: CGFloat) -> SCNNode {
        let b = it.book
        // Drawn at the screen's own density: the book in hand is about twice its size on the shelf.
        let W = it.w, H = it.h, D = (H * 0.68).rounded(), s = min(3, scale * 1.25)
        let front = picture(D, H, scale: s) { drawFront($0, D, H, b, cover: cover, cloth: it.cloth) }
        let model = BookModel.make(T: W, H: H, D: D, look: spineDress(it, front: front, k: k, scale: s), paperback: b.paperback)
        // Turned about its own middle.
        let R = BookModel.roundness(W, paperback: b.paperback)
        model.position = SCNVector3(Float(-W / 2), Float(-H / 2), Float((D - R) / 2))
        let node = SCNNode()
        node.addChildNode(model)
        // Your place: the ribbon hangs out of the pages, as far through the book as you are, counted from the front board.
        if b.fraction > 0, !b.finished {
            let board = min(max(H * 0.011, 1.0), W * 0.12)
            let ribbon = SCNNode(geometry: swallowtail(width: 5 * k, length: H * 0.16))
            ribbon.eulerAngles = SCNVector3(0, Float.pi / 2, 0)
            ribbon.position = SCNVector3(Float(W - board - CGFloat(b.fraction) * (W - 2 * board)), Float(H * 0.012 + 1), Float(-D * 0.5))
            model.addChildNode(ribbon)
        }
        return node
    }

    /// Turned by hand, on a touch screen.
    func drag(_ dx: CGFloat, ended: Bool) {
        guard let book else { return }
        turn?.cancel()
        let y = yaw + Float(dx * 0.01)
        book.eulerAngles = SCNVector3(0, y, 0)
        if ended { yaw = y }
        playBriefly(view, 0.1)
    }
}
