import SceneKit
import UIKit

/// The lectern's book: the one you're on, in your hand. It comes spine-on, as it left the shelf, and turns to its
/// front; by touch you can turn it yourself. Each book is made away from the main thread, and the books either side
/// are made ahead so moving along the shelf finds them ready.
///
/// A book is made bound in its cloth with its title on the board, as a book with no cover is. Its cover is the one
/// picture the bookcase ever fetches, and only for the book you have landed on: once it has been in hand a moment the
/// picture is asked for, and comes into focus on the front board, out of a blur, when it arrives. A book passed on the
/// way to another fetches nothing. The desktop's is packages/desktop/src/bookcase3d/book-in-hand.ts.
final class BookInHand {
    let scene = SCNScene()
    let camera = SCNNode()
    weak var view: SCNView?
    /// A cover from the server, by its hash.
    private let cover: (String) async -> CGImage?
    private var book: SCNNode?
    private var turn: DispatchWorkItem?
    private let queue = DispatchQueue(label: "app.ribbon.book-in-hand", qos: .userInitiated)
    /// The books made lately, the newest last: the one in hand and the three made ahead of it.
    private var made: [String: SCNNode] = [:]
    private var order: [String] = []
    private var making: Set<String> = []
    private var wanted: String?
    /// The books made lately whose covers are on their boards already, and the wait for the cover of the one in hand.
    private var covered: Set<String> = []
    private var landing: Task<Void, Never>?
    /// How long a book is in hand before its cover is fetched: you have landed on it, not passed over it.
    private static let landed = Duration.milliseconds(140)
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
        landing?.cancel()
        if let node = made[it.id] { present(node, it, scale: scale) } else { make(it, k: k, scale: scale) }
    }

    /// Make the books either side ahead of time.
    func prefetch(_ items: [ShelfItem], k: CGFloat, scale: CGFloat) {
        for it in items where made[it.id] == nil { make(it, k: k, scale: scale) }
    }

    private func make(_ it: ShelfItem, k: CGFloat, scale: CGFloat) {
        guard !making.contains(it.id) else { return }
        making.insert(it.id)
        queue.async {
            let node = Self.build(it, k: k, scale: scale)
            DispatchQueue.main.async {
                self.making.remove(it.id)
                self.made[it.id] = node
                self.order.removeAll { $0 == it.id }
                self.order.append(it.id)
                while self.order.count > 4 {
                    let gone = self.order.removeFirst()
                    self.made[gone] = nil
                    self.covered.remove(gone)
                }
                if self.wanted == it.id { self.present(node, it, scale: scale) } else { self.view?.prepare([node], completionHandler: nil) }
            }
        }
    }

    /// The book is in hand: once it has been a moment, fetch its cover and bring it into focus on the front board.
    private func land(on it: ShelfItem, _ node: SCNNode, scale: CGFloat) {
        guard let hash = it.book.coverHash, !covered.contains(it.id) else { return }
        landing = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.landed)
            guard let self, !Task.isCancelled, self.wanted == it.id else { return }
            guard let art = await self.cover(hash), !Task.isCancelled, self.wanted == it.id else { return }
            let fronts = await Task.detached(priority: .userInitiated) { Self.fronts(it, cover: art, scale: scale) }.value
            guard !Task.isCancelled, self.wanted == it.id, self.made[it.id] === node else { return }
            self.covered.insert(it.id)
            self.develop(fronts, on: node)
        }
    }

    /// The front board with its cover on it, and the same picture at its softest: drawn small and stretched back to size.
    private nonisolated static func fronts(_ it: ShelfItem, cover: CGImage, scale: CGFloat) -> (soft: UIImage, sharp: UIImage) {
        let H = it.h, D = (H * 0.68).rounded(), s = min(3, scale * 1.25)
        let sharp = picture(D, H, scale: s) { drawFront($0, D, H, it.book, cover: cover, cloth: it.cloth) }
        let small = picture(max(2, D / 14), max(2, H / 14), scale: 1) { _ in sharp.draw(in: CGRect(x: 0, y: 0, width: max(2, D / 14), height: max(2, H / 14))) }
        let soft = picture(D, H, scale: 1) { ctx in
            ctx.interpolationQuality = .high
            small.draw(in: CGRect(x: 0, y: 0, width: D, height: H))
        }
        return (soft, sharp)
    }

    /// Bring a cover into focus on a book's front board: the soft picture fades in over the cloth, then sharpens. With
    /// reduced motion it is simply there.
    private func develop(_ fronts: (soft: UIImage, sharp: UIImage), on node: SCNNode) {
        var boards: [SCNMaterial] = []
        node.enumerateHierarchy { child, _ in boards += child.geometry?.materials.filter { $0.name == BookModel.frontBoard } ?? [] }
        guard !boards.isEmpty else { return }
        let fade = { (picture: UIImage, seconds: Double, then: (() -> Void)?) in
            SCNTransaction.begin()
            SCNTransaction.animationDuration = seconds
            SCNTransaction.animationTimingFunction = CAMediaTimingFunction(name: .easeOut)
            SCNTransaction.completionBlock = then
            for board in boards { board.diffuse.contents = picture }
            SCNTransaction.commit()
        }
        if UIAccessibility.isReduceMotionEnabled {
            fade(fronts.sharp, 0, nil)
        } else {
            fade(fronts.soft, 0.2) { fade(fronts.sharp, 0.34, nil) }
        }
        playBriefly(view, 0.7)
    }

    private func present(_ node: SCNNode, _ it: ShelfItem, scale: CGFloat) {
        land(on: it, node, scale: scale)
        measured("book in hand")
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

    /// The book in hand: its title on the front board until its cover comes, its spine as on the shelf, its ribbon at your place.
    private static func build(_ it: ShelfItem, k: CGFloat, scale: CGFloat) -> SCNNode {
        let b = it.book
        // Drawn at the screen's own density: the book in hand is about twice its size on the shelf.
        let W = it.w, H = it.h, D = (H * 0.68).rounded(), s = min(3, scale * 1.25)
        let front = picture(D, H, scale: s) { drawFront($0, D, H, b, cover: nil, cloth: it.cloth) }
        let look = spineDress(it, front: GraphicsCard.colour(front) ?? front, k: k, scale: s).look
        let model = BookModel.make(T: W, H: H, D: D, look: look, paperback: b.paperback)
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
