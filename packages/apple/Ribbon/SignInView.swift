import SwiftUI

/// Signing in to a Ribbon server, once per person: its address, your name and
/// your password, top to bottom, then Sign in. A server whose people sign in
/// with Pocket ID says so once its address is in (`way`), and the name and
/// password give way to that: a button that opens the sign-in sheet on the
/// iPhone and the iPad, a code to sign in with from a phone on the TV
/// (`CodeSignIn`). The focus starts on the first
/// field still empty (someone added on a TV that has people already finds the
/// address there); the keyboard's Next goes from field to field, and Done on
/// the password goes on to Sign in. Menu goes back to Who's reading, when
/// there is anyone to choose; on the iPad, Cancel does.
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""
    @State private var name = ""
    @State private var password = ""
    @State private var working = false
    @State private var problem: String?
    /// How the server at `asked` signs people in, once it has said. Until then the form is the one for a password.
    @State private var way: RibbonServer.SignInWay?
    /// The address `way` is the answer for.
    @State private var asked = ""
    @FocusState private var field: Field?
    /// Where the focus goes when the keyboard gives it back.
    @State private var afterKeyboard: Field?

    private enum Field: Hashable {
        case address, name, password, signIn
    }

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 28.scaled) {
                Text("Ribbon").font(.ui(56, weight: 600)).foregroundStyle(Color.ink)
                Text("Sign in to your Ribbon server to read along with its books.").font(.ui(28)).foregroundStyle(Color.ink2)
                    .padding(.bottom, 20.scaled)
                TextField("Server address", text: $address)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .focused($field, equals: .address)
                    #if os(iOS)
                    .ribbonField()
                    .submitLabel(.next)
                    .onSubmit { field = .name }
                    #endif
                if case .browser(let provider) = way {
                    #if os(tvOS)
                    CodeSignIn(address: address, provider: provider) { model.signedIn($0) }
                    #else
                    Text("This server signs people in with \(provider). It opens here, and brings you back once you're in.")
                        .font(.ui(24)).foregroundStyle(Color.ink2)
                    #endif
                } else {
                    TextField("Name", text: $name)
                        .textContentType(.username)
                        .focused($field, equals: .name)
                        #if os(iOS)
                        .ribbonField()
                        .submitLabel(.next)
                        .onSubmit { field = .password }
                        #endif
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($field, equals: .password)
                        #if os(iOS)
                        .ribbonField()
                        .submitLabel(.go)
                        #endif
                        .onSubmit(passwordDone)
                }
                // The TV has nothing to press for a code: it's on the screen, and signing in happens on a phone.
                if showsSignIn {
                    HStack(spacing: 24.scaled) {
                        Button(working ? "Signing in…" : signInLabel) { signIn() }
                            .buttonStyle(RibbonButtonStyle(kind: .primary))
                            .disabled(!ready)
                            .focused($field, equals: .signIn)
                        #if os(iOS)
                        if !model.people.isEmpty {
                            Button("Cancel") { model.cancelAdding() }.buttonStyle(RibbonButtonStyle())
                        }
                        #endif
                    }
                    .padding(.top, 12.scaled)
                }
                Text(problem ?? " ").font(.ui(24)).foregroundStyle(Color.ink2)
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .column(width: 760)
        }
        .onAppear {
            address = model.signInHint.address
            name = model.signInHint.name
            fillInForDevelopment()
            askHow()
            field = address.isEmpty ? .address : name.isEmpty ? .name : password.isEmpty ? .password : .signIn
        }
        #if os(tvOS)
        .onExitCommand(perform: model.people.isEmpty ? nil : { model.cancelAdding() })
        #endif
        .onChange(of: field) { was, now in
            // The address is in once the focus leaves it: ask its server how people sign in there.
            if was == .address, now != .address { askHow() }
            // While the keyboard is up nothing here has the focus; it comes back to the field as the keyboard closes, and moves on from there.
            guard now != nil, let next = afterKeyboard else { return }
            afterKeyboard = nil
            field = next
        }
    }

    /// In a debug build, RIBBON_SERVER, RIBBON_NAME and RIBBON_PASSWORD fill the form in:
    /// the simulator's keyboard is slow, and a scratch server is signed in to often (packages/apple/README.md).
    private func fillInForDevelopment() {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        address = environment["RIBBON_SERVER"] ?? address
        name = environment["RIBBON_NAME"] ?? name
        password = environment["RIBBON_PASSWORD"] ?? password
        #endif
    }

    /// Whether the server said its people sign in on pages of its own.
    private var inBrowser: Bool {
        if case .browser = way { return true }
        return false
    }

    private var showsSignIn: Bool {
        #if os(tvOS)
        return !inBrowser
        #else
        return true
        #endif
    }

    private var signInLabel: String {
        if case .browser(let provider) = way { return "Sign in with \(provider)" }
        return "Sign in"
    }

    /// Everything filled in, and not signing in already. The TV has nothing to press for a code: it's on the screen.
    private var ready: Bool {
        #if os(tvOS)
        if inBrowser { return false }
        #endif
        return !working && !address.isEmpty && (inBrowser || (!name.isEmpty && !password.isEmpty))
    }

    /// Ask the server at the address how its people sign in, once per address. One that can't be reached, or isn't
    /// a server, leaves the form as it is: signing in says what's wrong.
    private func askHow() {
        let address = address
        guard !address.isEmpty, address != asked else { return }
        asked = address
        way = nil
        Task {
            let answer = try? await RibbonServer.howToSignIn(address: address)
            guard asked == address else { return }
            way = answer
            // The fields it was heading for are gone: the focus goes to what's left.
            if inBrowser, field == .name || field == .password { field = .signIn }
        }
    }

    /// Done on the password's keyboard. The TV's gives the focus back to the field as it closes, so it goes on to
    /// Sign in from there; the iPad's signs in at once.
    private func passwordDone() {
        #if os(tvOS)
        afterKeyboard = .signIn
        #else
        if ready { signIn() }
        #endif
    }

    private func signIn() {
        working = true
        problem = nil
        Task {
            do {
                #if os(iOS)
                if inBrowser {
                    // Nil when they closed the sheet: nothing to say.
                    if let account = try await BrowserSignIn.shared.signIn(address: address) { model.signedIn(account) }
                    working = false
                    return
                }
                #endif
                model.signedIn(try await RibbonServer.signIn(address: address, name: name, password: password))
            } catch {
                problem = error.localizedDescription
            }
            working = false
        }
    }
}
