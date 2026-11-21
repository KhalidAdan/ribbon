#if os(iOS)
import AuthenticationServices
import UIKit

/// Signing in on the pages of whatever proves who a server's people are
/// (Pocket ID), on the iPhone and the iPad (docs/SERVER.md, section 6).
///
/// The system's own sign-in sheet opens the server's page, so the person's
/// passkeys are there, which they wouldn't be in a web view of the app's.
/// When they're in, the server sends the sheet to `ribbon://signed-in` with a
/// one-time code, the sheet closes and hands that address back, and the code
/// is traded, with a secret made here, for a session.
@MainActor
final class BrowserSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = BrowserSignIn()

    /// The address the server sends the sheet back to: the app's own scheme, which the sheet watches for.
    private static let scheme = "ribbon"
    private static let returnTo = "ribbon://signed-in"

    /// Kept while its sheet is up: the system lets go of a session nobody holds.
    private var sheet: ASWebAuthenticationSession?

    /// Sign someone in to the server at an address. Nil when they closed the sheet without signing in.
    func signIn(address: String) async throws -> Account? {
        let verifier = RibbonServer.newVerifier()
        guard let start = RibbonServer.browserSignIn(address: address, verifier: verifier, returnTo: Self.returnTo) else {
            throw ServerError(message: "That doesn't look like a server's address.")
        }
        guard let back = try await cameBack(from: start) else { return nil }
        let carried = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let code = carried.first(where: { $0.name == "code" })?.value else {
            throw ServerError(message: carried.first { $0.name == "error" }?.value ?? "The sign-in came back without anyone signed in. Try again.")
        }
        return try await RibbonServer.finishSignIn(address: address, code: code, verifier: verifier)
    }

    /// Open the sheet at an address and wait for it to come back to the app's scheme. Nil when it was closed instead.
    private func cameBack(from start: URL) async throws -> URL? {
        defer { sheet = nil }
        return try await withCheckedThrowingContinuation { answer in
            let sheet = ASWebAuthenticationSession(url: start, callbackURLScheme: Self.scheme) { back, error in
                if let back {
                    answer.resume(returning: back)
                } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                    answer.resume(returning: nil)
                } else {
                    answer.resume(throwing: ServerError(message: "The sign-in couldn't be opened. Try again."))
                }
            }
            sheet.presentationContextProvider = self
            self.sheet = sheet
            if !sheet.start() { answer.resume(throwing: ServerError(message: "The sign-in couldn't be opened. Try again.")) }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.compactMap(\.keyWindow).first ?? ASPresentationAnchor()
    }
}
#endif
