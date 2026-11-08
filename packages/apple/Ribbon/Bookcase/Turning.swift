#if os(iOS)
import UIKit

/// Which ways the iPhone may turn. Ribbon on the iPhone stands upright, but on the bookcase's page it may lie on its
/// side, which shows the long shelf; anywhere else it turns back upright. The iPad turns every way, always.
final class Turning: NSObject, UIApplicationDelegate {
    private static var sideways = false

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        guard Look.phone else { return .all }
        return Self.sideways ? .allButUpsideDown : .portrait
    }

    /// Let the phone lie on its side, on the bookcase's page, or stand it upright again, anywhere else.
    static func allowSideways(_ allowed: Bool) {
        guard Look.phone, allowed != sideways else { return }
        sideways = allowed
        guard let scene = windowScene else { return }
        scene.windows.first?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        if !allowed { scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) { _ in } }
    }

    /// Turn the screen on its side, as turning the phone would: for a phone whose screen is locked upright.
    static func turnSideways() {
        guard sideways, let scene = windowScene else { return }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight)) { _ in }
    }

    private static var windowScene: UIWindowScene? { UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first }
}
#endif
