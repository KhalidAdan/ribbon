import SwiftUI

/// Signing in to a Ribbon server, once per person: its address, your name and
/// your password, top to bottom, then Sign in. The focus starts on the first
/// field still empty (someone added on a TV that has people already finds the
/// address there); the keyboard's Next goes from field to field, and Done on
/// the password goes on to Sign in. Menu goes back to Who's reading, when
/// there is anyone to choose.
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""
    @State private var name = ""
    @State private var password = ""
    @State private var working = false
    @State private var problem: String?
    @FocusState private var field: Field?
    /// Where the focus goes when the keyboard gives it back.
    @State private var afterKeyboard: Field?

    private enum Field: Hashable {
        case address, name, password, signIn
    }

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 28) {
                Text("Ribbon").font(.ui(56, weight: 600)).foregroundStyle(Color.ink)
                Text("Sign in to your Ribbon server to read along with its books.").font(.ui(28)).foregroundStyle(Color.ink2)
                    .padding(.bottom, 20)
                TextField("Server address", text: $address)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .focused($field, equals: .address)
                TextField("Name", text: $name)
                    .textContentType(.username)
                    .focused($field, equals: .name)
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .focused($field, equals: .password)
                    .onSubmit { afterKeyboard = .signIn }
                Button(working ? "Signing in…" : "Sign in") { signIn() }
                    .buttonStyle(RibbonButtonStyle(kind: .primary))
                    .disabled(working || address.isEmpty || name.isEmpty || password.isEmpty)
                    .focused($field, equals: .signIn)
                    .padding(.top, 12)
                Text(problem ?? " ").font(.ui(24)).foregroundStyle(Color.ink2)
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .frame(width: 760)
        }
        .onAppear {
            address = model.signInHint.address
            name = model.signInHint.name
            fillInForDevelopment()
            field = address.isEmpty ? .address : name.isEmpty ? .name : password.isEmpty ? .password : .signIn
        }
        .onExitCommand(perform: model.people.isEmpty ? nil : { model.cancelAdding() })
        .onChange(of: field) { _, now in
            // While the keyboard is up nothing here has the focus; it comes back to the field as the keyboard closes, and moves on from there.
            guard now != nil, let next = afterKeyboard else { return }
            afterKeyboard = nil
            field = next
        }
    }

    /// In a debug build, RIBBON_SERVER, RIBBON_NAME and RIBBON_PASSWORD fill the form in:
    /// the simulator's keyboard is slow, and a scratch server is signed in to often (tv/README.md).
    private func fillInForDevelopment() {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        address = environment["RIBBON_SERVER"] ?? address
        name = environment["RIBBON_NAME"] ?? name
        password = environment["RIBBON_PASSWORD"] ?? password
        #endif
    }

    private func signIn() {
        working = true
        problem = nil
        Task {
            do {
                model.signedIn(try await RibbonServer.signIn(address: address, name: name, password: password))
            } catch {
                problem = error.localizedDescription
            }
            working = false
        }
    }
}
