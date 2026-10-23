import Foundation
import Security
import UIKit

/// The server this TV is signed in to: its address, the sign-in token the
/// requests carry, and the session cookie the player sends with the audio
/// (Apple's player can send cookies but not a sign-in header).
///
/// Kept in the Keychain. tvOS may clear an app's files whenever it likes,
/// but not its Keychain, so a TV stays signed in.
struct Account: Codable, Equatable {
    var url: URL
    var name: String
    var token: String
    var cookieName: String
    var cookieValue: String

    private static let item = "ribbon.server"

    static var saved: Account? {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: item, kSecReturnData: true]
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
        return try? JSONDecoder().decode(Account.self, from: data)
    }

    func save() {
        Account.forget()
        let data = (try? JSONEncoder().encode(self)) ?? Data()
        let item: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: Account.item, kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock]
        SecItemAdd(item as CFDictionary, nil)
    }

    static func forget() {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: item] as CFDictionary)
    }

    /// The session cookie, for the player's requests to this server.
    var cookie: HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [.name: cookieName, .value: cookieValue, .domain: url.host() ?? "", .path: "/"]
        // Any value at all makes a cookie secure, so the key is there only for HTTPS.
        if url.scheme == "https" { properties[.secure] = "TRUE" }
        return HTTPCookie(properties: properties)
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

    static var app: String { "Ribbon TV \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")" }
}
