import SceneKit
import SwiftUI
import UIKit

/// The way into the bookcase, at the foot of the library below the series: a picture of your newest books standing
/// under the lamp, one of them tipped out towards you, and a few words asking you in. Choosing it opens the bookcase,
/// a page of its own on every device, so going there is a choice and never an accident of turning the phone.
struct BookcaseInvitation: View {
    let library: Library
    @Environment(AppModel.self) private var app
    @Environment(\.narrow) private var narrow

    var body: some View {
        let count = library.shelved.count
        Button { app.openBookcase() } label: {
            Group {
                if narrow {
                    VStack(alignment: .leading, spacing: 18) {
                        BookcasePicture(library: library, aspect: BookcasePicture.narrow, drawing: app.path.isEmpty)
                        words(count).padding(.horizontal, 4)
                    }
                } else {
                    HStack(alignment: .center, spacing: 56.scaled) {
                        BookcasePicture(library: library, aspect: BookcasePicture.wide, drawing: app.path.isEmpty)
                        words(count).frame(width: 560.scaled, alignment: .leading)
                    }
                }
            }
            .padding(narrow ? 0 : 24.scaled)
            .contentShape(Rectangle())
        }
        .buttonStyle(LiftStyle(radius: 28))
        .accessibilityLabel("The bookcase, all \(count) books. Opens it.")
    }

    private func words(_ count: Int) -> some View {
        VStack(alignment: .leading, spacing: 6.scaled) {
            Text(count == 1 ? "Your book, on the shelf" : "All \(count) of your books, on the shelf").font(.ui(30, weight: 600)).foregroundStyle(Color.ink)
            Text("Newest first, under the lamp. Take one down and start it there.")
                .font(.ui(24)).foregroundStyle(Color.ink2)
                .fixedSize(horizontal: false, vertical: true)
            // The look of a button, inside the one button the whole invitation is.
            Label("Browse the bookcase", systemImage: "books.vertical")
                .font(.ui(24, weight: 500))
                .foregroundStyle(Color.ink)
                .padding(.horizontal, 22.scaled)
                .frame(height: narrow ? 44 : 64.scaled)
                .background(Capsule().fill(Color.raised))
                .overlay(Capsule().stroke(Color.line))
                .padding(.top, 22.scaled)
        }
    }
}

/// The invitation's picture (Vignette), as wide as there is room for, in the proportions of a shelf seen from a little to
/// one side. The bookcase's page shows it too, on an iPhone held upright, and the picture is drawn once for both.
struct BookcasePicture: View {
    let library: Library
    let aspect: CGFloat
    /// Whether it may be drawn now. The library's waits while a page is over it: an iPhone turned on its side for the
    /// bookcase lays the library out sideways too, out of sight, and that picture would never be seen.
    var drawing = true
    @Environment(\.displayScale) private var displayScale
    @State private var picture: UIImage?

    /// Its proportions on a phone, and beside the words on the TV and the iPad.
    static let narrow: CGFloat = 1.55
    static let wide: CGFloat = 2.1

    var body: some View {
        Color.clear
            .aspectRatio(aspect, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .overlay {
                GeometryReader { geo in
                    ZStack {
                        // Until the picture is drawn, the lamp's glow alone, where the books will stand.
                        RadialGradient(colors: [Color(uiColor: Lamplight.caseBoard.ui).opacity(0.55), .clear], center: UnitPoint(x: 0.36, y: 0.5),
                                       startRadius: 0, endRadius: geo.size.width * 0.55)
                        if let picture {
                            Image(uiImage: picture).resizable().transition(.opacity)
                        }
                    }
                    // The picture's edges dissolve into the page, as the bookcase's own do.
                    .mask(fade(.horizontal, 0.12))
                    .mask(fade(.vertical, 0.1))
                    .task(id: "\(Int(geo.size.width))x\(Int(geo.size.height)) \(library.shelved.count) \(drawing)") { if drawing { await draw(geo.size) } }
                }
            }
            .accessibilityHidden(true)
    }

    /// The picture, drawn off the main thread once the library is on screen, and kept for when the library is shown again.
    private func draw(_ size: CGSize) async {
        guard size.width > 50 else { return }
        let newest = Array(shelfOrder(library.shelfBooks).prefix(Vignette.books))
        let scale = displayScale
        let key = Vignette.key(newest, size: size, scale: scale)
        if let kept = Vignette.kept(key) { picture = kept; return }
        let cloths = await CoverCloths.cloths(for: newest.map(\.book), server: library.server)
        // The library comes first: what you were in the middle of is on screen before any of this is drawn.
        try? await Task.sleep(for: .milliseconds(400))
        guard !Task.isCancelled else { return }
        let drawn = await Task.detached(priority: .utility) { Vignette.draw(newest, cloths: cloths, size: size, scale: scale) }.value
        guard let drawn, !Task.isCancelled else { return }
        Vignette.keep(drawn, as: key)
        withAnimation(.easeOut(duration: 0.4)) { picture = drawn }
    }

    private func fade(_ axis: Axis, _ edge: CGFloat) -> some View {
        LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: edge), .init(color: .black, location: 1 - edge), .init(color: .clear, location: 1)],
                       startPoint: axis == .horizontal ? .leading : .top, endPoint: axis == .horizontal ? .trailing : .bottom)
    }
}

/// The invitation's picture: a short run of the newest books on a shelf of the bookcase, seen from a little to the left
/// and above, with the fourth tipped towards you as a finger takes it down, under one lamp. It is the bookcase's own
/// scene, books, wood and light, drawn once into a picture; the scene is let go as soon as it is drawn.
enum Vignette {
    /// How many books stand in the picture: enough to run out of sight into the dark, even in a wide one.
    static let books = 22
    /// The book tipped out, counted from the left.
    private static let tipped = 3

    private static var last: (key: String, image: UIImage)?

    static func key(_ books: [ShelfBook], size: CGSize, scale: CGFloat) -> String {
        "\(books.map(\.id).joined(separator: ",")) \(Int(size.width))x\(Int(size.height)) \(scale)"
    }

    @MainActor static func kept(_ key: String) -> UIImage? { last?.key == key ? last?.image : nil }
    @MainActor static func keep(_ image: UIImage, as key: String) { last = (key, image) }

    /// Made on any thread: the scene is its own, and nothing else draws it.
    static func draw(_ books: [ShelfBook], cloths: [String: Cloth], size: CGSize, scale: CGFloat) -> UIImage? {
        guard !books.isEmpty, let device = MTLCreateSystemDefaultDevice() else { return nil }
        let k: CGFloat = 1
        let items = layoutLine(books, k: k, cloths: cloths).items
        let pad = (16 * k).rounded(), shelfH = (shelfHeight * k).rounded(), boardH = (12 * k).rounded()
        let front = (8 * k).rounded(), depth = (150 * k).rounded()
        let length = (items.last.map { $0.x + $0.w } ?? 0) + 40 * k
        let scene = SCNScene()
        scene.background.contents = Look.canvas
        let root = scene.rootNode

        // The case: its back, its board and the shelf above, with no ends, so the run of books carries on out of sight.
        let back = SCNNode(geometry: SCNPlane(width: length + 800, height: pad + shelfH + 2 * boardH + 400))
        back.geometry?.materials = [ShelfRow.wood(Lamplight.caseBack, rough: 0.9, along: length + 800)]
        back.position = SCNVector3(Float(length / 2), Float((pad + shelfH) / 2), Float(-depth))
        root.addChildNode(back)
        let boardMat = ShelfRow.wood(Lamplight.caseBoard, rough: 0.75, along: length + 800)
        for y in [-boardH / 2, pad + shelfH + boardH / 2] {
            let board = SCNNode(geometry: SCNBox(width: length + 800, height: boardH, length: depth + front, chamferRadius: 1.2 * k))
            board.geometry?.materials = [boardMat]
            board.position = SCNVector3(Float(length / 2), Float(y), Float((front - depth) / 2))
            root.addChildNode(board)
        }

        var focus = SCNVector3(Float(length / 2), Float(shelfH * 0.45), 0)
        for (i, it) in items.enumerated() {
            let book = standingBook(it, k: k, scale: scale, front: front)
            if i == min(tipped, items.count - 1) {
                // Where takeOut leaves a book: tipped on its front foot towards you, and drawn a little out.
                book.pivot.eulerAngles = SCNVector3(Float(11 * CGFloat.pi / 180), 0, 0)
                book.pivot.position = SCNVector3(Float(it.x), Float(3 * k), Float(28 * k))
                focus = SCNVector3(Float(it.x + it.w / 2), Float(it.h * 0.5), Float(20 * k))
            }
            root.addChildNode(book.node)
        }

        // The bookcase's light: the room's faint fill, and a lamp over the tipped book, another further along fading out.
        let rig = ShelfRig(width: length, shelfH: shelfH, pad: pad, depth: depth, front: front, k: k)
        lightRoom(scene, centre: SCNVector3(focus.x, Float(shelfH / 2), Float(-depth / 2)), reach: length * 0.58)
        for x in [CGFloat(focus.x), CGFloat(focus.x) + 260 * k] {
            let lamp = shelfLamp()
            hang(lamp, over: x, rig)
            root.addChildNode(lamp)
        }

        // Seen from a little to the left and above, so the run recedes to the right and the tipped book stands out of it.
        let cam = SCNCamera()
        cam.fieldOfView = 24
        cam.zNear = 50; cam.zFar = 4000
        grade(cam)
        cam.screenSpaceAmbientOcclusionIntensity = 0.9
        cam.screenSpaceAmbientOcclusionRadius = 5 * k
        let camera = SCNNode()
        camera.camera = cam
        // Nearer in a wide picture, where the run has room to carry on to the right.
        let wide = size.width / size.height > 1.8
        let distance: Float = wide ? 520 : 600, turn: Float = 30 * .pi / 180, rise: Float = 9 * .pi / 180
        camera.position = SCNVector3(focus.x - distance * sin(turn) * cos(rise), focus.y + distance * sin(rise), focus.z + distance * cos(turn) * cos(rise))
        root.addChildNode(camera)
        // Aimed a little right of the tipped book, so the books it stands among fill the picture.
        camera.look(at: SCNVector3(focus.x + Float((wide ? 120 : 70) * k), focus.y, focus.z - 20))

        let renderer = SCNRenderer(device: device, options: nil)
        renderer.scene = scene
        renderer.pointOfView = camera
        let pixels = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let image = renderer.snapshot(atTime: 0, with: pixels, antialiasingMode: .multisampling4X)
        guard let cg = image.cgImage else { return nil }
        return UIImage(cgImage: cg, scale: scale, orientation: .up)
    }
}
