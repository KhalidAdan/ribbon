import XCTest
@testable import Ribbon

/// Signing in through the browser (docs/SERVER.md, section 6): what the app
/// sends the server at the start, which the server must be able to check at
/// the end.
final class SignInTests: XCTestCase {
    /// The hash the server is given is the one it will make itself from the secret (packages/auth/src/sign-ins.ts,
    /// `challengeOf`): SHA-256 in base64url, here for the example in the PKCE standard (RFC 7636, appendix B).
    func testTheChallengeIsTheHashTheServerMakes() {
        XCTAssertEqual(RibbonServer.challenge(of: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testEverySecretIsNewAndSafeInAnAddress() {
        let one = RibbonServer.newVerifier()
        let other = RibbonServer.newVerifier()
        XCTAssertNotEqual(one, other)
        XCTAssertEqual(one.count, 43)
        XCTAssertNil(one.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
    }

    func testTheBrowserIsSentToTheServerWithWhereToComeBackAndTheHash() throws {
        let start = try XCTUnwrap(RibbonServer.browserSignIn(address: "books.example.net/", verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", returnTo: "ribbon://signed-in"))
        let parts = try XCTUnwrap(URLComponents(url: start, resolvingAgainstBaseURL: false))
        XCTAssertEqual(parts.scheme, "https")
        XCTAssertEqual(parts.host, "books.example.net")
        XCTAssertEqual(parts.path, "/sign-in/start")
        XCTAssertEqual(parts.queryItems?.first { $0.name == "return" }?.value, "ribbon://signed-in")
        XCTAssertEqual(parts.queryItems?.first { $0.name == "challenge" }?.value, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertNil(RibbonServer.browserSignIn(address: "", verifier: "x", returnTo: "ribbon://signed-in"))
    }
}
