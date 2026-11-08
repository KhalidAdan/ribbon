import SceneKit
import UIKit

/// The bookcase's light: a lamp-lit study, after Néstor Almendros on Days of Heaven. One believable source, little fill
/// so the scene keeps its depth, muted colour, dark real wood, nothing white fighting the warm lamp. Overhead lamps at
/// 3000 K, chosen by the owner from four moods on 7 November 2026 ("a PI's shelf in a Marlowe book").
enum Lamplight {
    /// Dark walnut: the case's back, and its boards.
    static let caseBack = RGB(0x1f1610)
    static let caseBoard = RGB(0x3b2a1c)
}

/// Where a shelf's lamps hang: spread along it, just under the shelf above, a little in front.
struct ShelfRig {
    let width: CGFloat
    let shelfH: CGFloat
    let pad: CGFloat
    let depth: CGFloat
    let front: CGFloat
    let k: CGFloat
}

/// Light a scene: a shelf's row of lamps, or, with no shelf, one lamp over the book in your hand.
func light(_ scene: SCNScene, shelf: ShelfRig?, centre: SCNVector3, reach: CGFloat) {
    lightRoom(scene, centre: centre, reach: reach)
    if let s = shelf {
        let count = lampCount(along: s.width, k: s.k)
        for i in 0 ..< count {
            let lamp = shelfLamp()
            hang(lamp, over: s.width * (CGFloat(i) + 0.5) / CGFloat(count), s)
            scene.rootNode.addChildNode(lamp)
        }
    } else {
        let lamp = spot(intensity: 1_100_000, inner: 22, outer: 60)
        lamp.position = SCNVector3(-40, 520, 300)
        lamp.look(at: SCNVector3Zero)
        scene.rootNode.addChildNode(lamp)
    }
}

/// Everything but the lamps: the room's faint ambient and the fill bounced back from it. Clears the scene's lights first.
func lightRoom(_ scene: SCNScene, centre: SCNVector3, reach: CGFloat) {
    scene.rootNode.childNodes.filter { $0.name == "light" }.forEach { $0.removeFromParentNode() }
    // Hardly any ambient: what isn't lit by the lamps falls away into shadow, as it would in a room at night.
    _ = BookTextures.studioReady
    scene.lightingEnvironment.contents = BookTextures.studio
    scene.lightingEnvironment.intensity = 0.25
    // The fill: a whisper of the lamp's own warmth bounced back from the room.
    let fill = SCNLight()
    fill.type = .directional
    fill.temperature = 2700
    fill.intensity = 70
    let node = SCNNode()
    node.light = fill
    node.name = "light"
    let dir = (Float(0), Float(-0.15), Float(-1)), n = sqrt(dir.1 * dir.1 + dir.2 * dir.2)
    node.position = SCNVector3(centre.x - dir.0 / n * 2500, centre.y - dir.1 / n * 2500, centre.z - dir.2 / n * 2500)
    node.look(at: centre)
    scene.rootNode.addChildNode(node)
}

/// A shelf's lamps hang about every 260 points (at k = 1), spread evenly along it.
func lampCount(along width: CGFloat, k: CGFloat) -> Int { max(2, Int((width / (260 * k)).rounded())) }

/// One of a shelf's overhead lamps.
func shelfLamp() -> SCNNode { spot(intensity: 290_000, inner: 16, outer: 64) }

/// Hung under the shelf above, out in front, aimed down the spines: the tops catch the hot centre, the feet the edge of the cone.
func hang(_ lamp: SCNNode, over x: CGFloat, _ s: ShelfRig) {
    let x = Float(x)
    lamp.position = SCNVector3(x, Float(s.pad + s.shelfH + 10 * s.k), Float(s.front + 70 * s.k))
    lamp.look(at: SCNVector3(x, Float(s.shelfH * 0.5), Float(-s.depth * 0.1)))
}

/// Develop the picture as Almendros did: a little under-exposed rather than flattened with fill, colour kept muted,
/// in high dynamic range with no auto-exposure.
func grade(_ cam: SCNCamera) {
    cam.wantsHDR = true
    cam.wantsExposureAdaptation = false
    cam.bloomIntensity = 0
    cam.exposureOffset = 0.5
    cam.contrast = 0.22
    cam.saturation = 0.88
}

/// A 3000 K spot with soft shadows. Its light falls off as real light does, so its intensity is large at this scale (a point a metre).
private func spot(intensity: CGFloat, inner: CGFloat, outer: CGFloat) -> SCNNode {
    let l = SCNLight()
    l.type = .spot
    l.temperature = 3000
    l.intensity = intensity
    l.spotInnerAngle = inner
    l.spotOuterAngle = outer
    l.castsShadow = true
    l.shadowMode = .forward
    l.shadowColor = UIColor(white: 0, alpha: 0.85)
    l.shadowRadius = 5
    l.shadowSampleCount = 8
    l.shadowMapSize = CGSize(width: 1024, height: 1024)
    let node = SCNNode()
    node.light = l
    node.name = "light"
    return node
}
