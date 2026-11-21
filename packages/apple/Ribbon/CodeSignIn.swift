#if os(tvOS)
import CoreImage.CIFilterBuiltins
import SwiftUI

/// Signing in on the TV to a server whose people sign in with Pocket ID
/// (docs/SERVER.md, section 6): a passkey is on a phone, not on a TV, so the
/// TV shows a code and a picture of the address to scan, someone signs in
/// for it on their phone, and the TV, asking the server every few seconds,
/// finds itself signed in. A code lasts ten minutes; when one runs out
/// another takes its place.
struct CodeSignIn: View {
    let address: String
    /// What signs this server's people in: "Pocket ID".
    let provider: String
    let signedIn: (Account) -> Void

    @State private var code: RibbonServer.DeviceCode?
    @State private var problem: String?

    var body: some View {
        HStack(alignment: .center, spacing: 48.scaled) {
            if let code, let picture = Self.picture(of: code.complete) {
                Image(uiImage: picture)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 240.scaled, height: 240.scaled)
                    .padding(16.scaled)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 12.scaled))
                    .accessibilityLabel("A picture of the address to scan with a phone")
            }
            VStack(alignment: .leading, spacing: 16.scaled) {
                Text("Sign in with \(provider), on your phone.").font(.ui(28)).foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let code {
                    Text("Scan the picture, or open \(Self.shown(code.url)) and type:").font(.ui(24)).foregroundStyle(Color.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(code.code).font(.system(size: 60.scaled, weight: .semibold, design: .monospaced)).foregroundStyle(Color.ink)
                        .lineLimit(1).minimumScaleFactor(0.6)
                        .accessibilityLabel(code.code.map(String.init).joined(separator: " "))
                } else {
                    Text(problem ?? "Getting a code…").font(.ui(24)).foregroundStyle(Color.ink2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: address) { await wait() }
    }

    /// Show a code and ask whether it has been used, a new one each time one runs out, until someone signs in or
    /// this leaves the screen.
    private func wait() async {
        while !Task.isCancelled {
            do {
                let code = try await RibbonServer.askForCode(address: address)
                self.code = code
                problem = nil
                let until = Date().addingTimeInterval(code.expiresIn)
                while Date() < until {
                    try await Task.sleep(for: .seconds(code.interval))
                    if let account = try await RibbonServer.signedInByCode(address: address, secret: code.secret) {
                        signedIn(account)
                        return
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                // The code ran out, or the server couldn't be reached: say so, and try for another in a while.
                code = nil
                problem = error.localizedDescription
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    /// An address as someone would type it: without the `https://`.
    private static func shown(_ url: String) -> String {
        url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
    }

    /// An address as a picture a phone's camera reads (a QR code), or nil when one can't be drawn.
    private static func picture(of text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let small = filter.outputImage else { return nil }
        // Drawn large here, so it is sharp squares on the screen rather than a small picture stretched.
        let large = small.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        guard let drawn = CIContext().createCGImage(large, from: large.extent) else { return nil }
        return UIImage(cgImage: drawn)
    }
}
#endif
