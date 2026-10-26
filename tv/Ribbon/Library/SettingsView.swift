import SwiftUI

/// The TV's settings, as the desktop keeps its own in Settings: whether this
/// TV keeps listening sessions, and who's reading on which server, with the
/// way back to Who's reading. Reached from the person's name at the top of
/// the library; Menu goes back.
struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let name = model.server?.account.name ?? ""
        ZStack {
            Color.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 56.scaled) {
                    VStack(alignment: .leading, spacing: 10.scaled) {
                        Text("Settings").font(.book(56, weight: 500)).foregroundStyle(Color.ink)
                        Text("On this \(ThisDevice.kind), for \(name).").font(.ui(26)).foregroundStyle(Color.ink2)
                    }
                    VStack(alignment: .leading, spacing: 40.scaled) {
                        Rows(label: "Listening") {
                            Button { model.keepSessions(!model.keepsSessions) } label: {
                                Row(
                                    title: "Keep listening sessions",
                                    description: model.keepsSessions
                                        ? "The end of a book says when you started and finished it, and how long it took."
                                        : "Off on this \(ThisDevice.kind): the end of a book won't count the time spent here."
                                ) {
                                    HStack(spacing: 10.scaled) {
                                        Text(model.keepsSessions ? "On" : "Off")
                                        Image(systemName: model.keepsSessions ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(model.keepsSessions ? Color.place : Color.ink3)
                                    }
                                }
                            }
                            .buttonStyle(LiftStyle.row())
                        }
                        Rows(label: "Reader") {
                            Row(title: name, description: "Signed in to \(model.host).")
                            Button { model.switchReader() } label: {
                                Row(title: "Switch reader", description: "Back to Who's reading. Your place in every book is kept.") {
                                    Image(systemName: "person.2")
                                }
                            }
                            .buttonStyle(LiftStyle.row())
                        }
                    }
                    .frame(maxWidth: 1100.scaled, alignment: .leading)
                }
                .screenEdges(horizontal: 96, vertical: 72)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
