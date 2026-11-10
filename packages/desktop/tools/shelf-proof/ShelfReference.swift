import SceneKit
import UIKit
import XCTest
@testable import Ribbon

/// SceneKit draws one shelf of fixed books to pictures, from the front and from other angles, and writes down where it
/// put everything, for the desktop's bookcase to be compared against (packages/desktop/tools/shelf-proof/README.md).
/// Kept beside those pages, not among the Apple app's tests, because it writes files: copy it into RibbonTests to run it.
final class ShelfReference: XCTestCase {
    private struct Entry: Decodable {
        let book: ServerBook
        let fraction: Double
        let finished: Bool
    }

    func testDrawTheReferenceShelf() throws {
        let env = ProcessInfo.processInfo.environment
        let folder = URL(fileURLWithPath: try XCTUnwrap(env["SHELF_FOLDER"]))
        let width = CGFloat(Double(env["SHELF_WIDTH"] ?? "") ?? 1180), k = CGFloat(Double(env["SHELF_K"] ?? "") ?? 1), scale: CGFloat = 2
        let entries = try JSONDecoder().decode([Entry].self, from: Data(contentsOf: folder.appendingPathComponent("books.json")))
        let books = entries.map { ShelfBook(book: $0.book, fraction: $0.fraction, finished: $0.finished) }
        let shelves = layoutCase(books, width: width, k: k, cloths: [:])
        let row = ShelfRow(id: 0, items: shelves[0], width: width, k: k, scale: scale)

        let renderer = SCNRenderer(device: GraphicsCard.device, options: nil)
        renderer.scene = row.scene
        renderer.pointOfView = row.camera
        let pixels = CGSize(width: (width * scale).rounded(), height: (row.height * scale).rounded())
        let image = renderer.snapshot(atTime: 0, with: pixels, antialiasingMode: .multisampling4X)
        try XCTUnwrap(image.pngData()).write(to: folder.appendingPathComponent("scenekit-shelf.png"))

        // The same shelf from other angles, close to, and with a book pulled out (views.json).
        struct View: Decodable { let name: String; let target: [Float]; let distance: Float; let yaw: Float; let pitch: Float; let fov: CGFloat; let lift: String? }
        let views = try JSONDecoder().decode([View].self, from: Data(contentsOf: folder.appendingPathComponent("views.json")))
        for view in views {
            let cam = SCNCamera()
            cam.fieldOfView = view.fov
            cam.zNear = 20; cam.zFar = 4000
            grade(cam)
            cam.screenSpaceAmbientOcclusionIntensity = 0.9
            cam.screenSpaceAmbientOcclusionRadius = 5 * k
            let eye = SCNNode()
            eye.camera = cam
            let yaw = view.yaw * .pi / 180, pitch = view.pitch * .pi / 180
            let target = SCNVector3(view.target[0], view.target[1], view.target[2])
            eye.position = SCNVector3(target.x + view.distance * sin(yaw) * cos(pitch), target.y + view.distance * sin(pitch), target.z + view.distance * cos(yaw) * cos(pitch))
            eye.look(at: target)
            row.scene.rootNode.addChildNode(eye)
            let book = view.lift.flatMap { row.scene.rootNode.childNode(withName: $0, recursively: true) }
            let home = book?.position
            if let book, let home {
                // As takeOut leaves it: tipped towards you on its front foot, then drawn out.
                book.position = SCNVector3(home.x, home.y + Float(3 * k), home.z + Float(28 * k))
                book.eulerAngles.x = Float(11 * CGFloat.pi / 180)
            }
            renderer.pointOfView = eye
            let shot = renderer.snapshot(atTime: 0, with: CGSize(width: 1800, height: 1120), antialiasingMode: .multisampling4X)
            try XCTUnwrap(shot.pngData()).write(to: folder.appendingPathComponent("scenekit-\(view.name).png"))
            if let book, let home { book.position = home; book.eulerAngles.x = 0 }
            eye.removeFromParentNode()
        }

        // The spines drawn flat, side by side, to compare the lettering alone.
        let flats = folder.appendingPathComponent("flat")
        try? FileManager.default.createDirectory(at: flats, withIntermediateDirectories: true)
        for (i, it) in shelves[0].enumerated() {
            if let flat = row.flat[it.id]?.pngData() { try flat.write(to: flats.appendingPathComponent(String(format: "%02d.png", i))) }
        }

        func hex(_ c: RGB) -> String { String(format: "#%02x%02x%02x", c.r, c.g, c.b) }
        let laid: [[[String: Any]]] = shelves.map { shelf in
            shelf.map { it in
                let s = it.spine
                return [
                    "id": it.id, "x": it.x, "w": it.w, "h": it.h, "lean": it.lean, "label": it.label ?? "", "paperback": it.book.paperback,
                    "ground": hex(it.cloth.ground), "ink": hex(it.cloth.ink), "foil": hex(it.cloth.foil),
                    "number": s.number ?? "", "numberSize": s.numberSize, "numberMid": s.numberMid, "tick": s.tick, "tickMid": s.tickMid,
                    "lines": s.lines, "size": s.size, "titleTop": s.titleTop, "titleBottom": s.titleBottom,
                    "author": s.author ?? "", "authorSize": s.authorSize, "authorMid": s.authorMid, "edge": s.edge,
                ]
            }
        }
        let faces: [String: Any] = [
            "titleCap": SpineFace.title.font(100).capHeight, "authorCap": SpineFace.author.font(100).capHeight,
            "numberCap": SpineFace.number.font(100).capHeight, "labelCap": SpineFace.label.font(100).capHeight,
            "rowHeight": row.height, "rowTop": row.top,
            "camera": [row.camera.position.x, row.camera.position.y, row.camera.position.z],
        ]
        let json = try JSONSerialization.data(withJSONObject: ["shelves": laid, "faces": faces], options: [.prettyPrinted, .sortedKeys])
        try json.write(to: folder.appendingPathComponent("scenekit-layout.json"))
    }
}
