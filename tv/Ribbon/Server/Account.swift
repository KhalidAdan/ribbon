import Foundation
import Security
import UIKit

/// Someone signed in on this TV: their server's address, their name, the
/// sign-in token the requests carry, and the session cookie the player sends
/// with the audio (Apple's player can send cookies but not a sign-in header).
/// Each person's place is their own on the server.
struct Account: Codable, Equatable, Identifiable {
    var url: URL
    var name: String
    var token: String
    var cookieName: String
    var cookieValue: String

    /// Who they are on which server, as the apps key a server's sign-in (`url#person`).
    var id: String { "\(url.absoluteString)#\(name)" }

    /// The session cookie, for the player's requests to this server.
    var cookie: HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [.name: cookieName, .value: cookieValue, .domain: url.host() ?? "", .path: "/"]
        // Any value at all makes a cookie secure, so the key is there only for HTTPS.
        if url.scheme == "https" { properties[.secure] = "TRUE" }
        return HTTPCookie(properties: properties)
    }
}

/// Everyone signed in on this TV, in the order they first signed in.
///
/// Kept in the Keychain. tvOS may clear an app's files whenever it likes,
/// but not its Keychain, so nobody has to sign in again.
enum People {
    private static let item = "ribbon.people"

    static func load() -> [Account] {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: item, kSecReturnData: true]
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return [] }
        return (try? JSONDecoder().decode([Account].self, from: data)) ?? []
    }

    static func save(_ people: [Account]) {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: item] as CFDictionary)
        guard !people.isEmpty, let data = try? JSONEncoder().encode(people) else { return }
        let entry: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: item, kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock]
        SecItemAdd(entry as CFDictionary, nil)
    }
}

/// This TV, as the position log names its writers (docs/POSITION-FORMAT.md, section 2):
/// a random id made once, and a name people recognise in a list of devices.
enum ThisDevice {
    private static let key = "ribbon.device"

    static var id: String {
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = "urn:uuid:\(UUID().uuidString.lowercased())"
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    static var name: String { "Ribbon on \(UIDevice.current.name)" }

    static var app: String { "Ribbon \(kind) \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")" }

    /// What this device is, in what the app says about it: "this TV", "this iPad".
    #if os(tvOS)
    static let kind = "TV"
    #else
    static let kind = "iPad"
    #endif
}
