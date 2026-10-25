import SwiftUI

/// Who's reading? Everyone signed in on this TV, side by side, and Someone
/// else last, to sign another person in. The focus starts on whoever read
/// last here. Holding Select on a person (on the iPad, holding them) offers to
/// take them off this TV; their places stay on the server.
struct PeopleView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focused: String?

    private static let someoneElse = "someone-else"

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            VStack(spacing: 80.scaled) {
                Text("Who's reading?").font(.ui(56, weight: 600)).foregroundStyle(Color.ink)
                HStack(alignment: .top, spacing: 72.scaled) {
                    ForEach(model.people) { person in
                        Button { model.choose(person) } label: {
                            Person(initial: String(person.name.prefix(1)).uppercased(), name: person.name, server: manyServers ? person.url.host() : nil)
                        }
                        .buttonStyle(PersonStyle())
                        .focused($focused, equals: person.id)
                        .contextMenu {
                            Button("Take \(person.name) off this \(ThisDevice.kind)", role: .destructive) { model.remove(person) }
                        }
                    }
                    Button { model.addSomeone() } label: {
                        Person(initial: "+", name: "Someone else", server: nil)
                    }
                    .buttonStyle(PersonStyle())
                    .focused($focused, equals: Self.someoneElse)
                }
            }
        }
        .onAppear {
            let last = model.people.first { $0.id == model.lastPerson }
            focused = last?.id ?? model.people.first?.id ?? Self.someoneElse
        }
    }

    /// When people here use different servers, each says which.
    private var manyServers: Bool {
        Set(model.people.map(\.url)).count > 1
    }
}

/// A person as a circle with their initial, their name under it.
private struct Person: View {
    let initial: String
    let name: String
    let server: String?
    @Environment(\.isFocused) private var focused

    var body: some View {
        VStack(spacing: 24.scaled) {
            // Focused, the circle turns to the inverted ink of a primary action (docs/DESIGN.md).
            Text(initial)
                .font(.ui(84, weight: 600))
                .foregroundStyle(focused ? Color.canvas : Color.ink2)
                .frame(width: 200.scaled, height: 200.scaled)
                .background(Circle().fill(focused ? Color.ink : Color.raised))
            VStack(spacing: 6.scaled) {
                Text(name).font(.ui(28, weight: 500)).foregroundStyle(focused ? Color.ink : Color.ink2)
                if let server { Text(server).font(.ui(22)).foregroundStyle(Color.ink3) }
            }
        }
        .frame(width: 240.scaled)
    }
}

/// The lift tvOS gives what has the focus, for a person's circle.
private struct PersonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Lifted(configuration: configuration)
    }

    private struct Lifted: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isFocused) private var focused

        var body: some View {
            configuration.label
                .scaleEffect(configuration.isPressed ? Pressed.button(settlingTo: 1.04) : focused ? 1.1 : 1)
                .shadow(color: .black.opacity(focused ? 0.5 : 0), radius: 24, y: 16)
                .lifts(focused: focused, pressed: configuration.isPressed)
        }
    }
}
