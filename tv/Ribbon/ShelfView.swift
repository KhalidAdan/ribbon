import SwiftUI

/// The books there are to read along with: those on the server with both a
/// text and a narration, as covers in rows. The focus starts on the book this
/// person read last on this TV, and comes back to it when that book is
/// closed; Switch reader is last, below the books. With more than one person
/// here, Menu goes back to Who's reading.
struct ShelfView: View {
    @Environment(AppModel.self) private var model
    @State private var books: [ServerBook]?
    @State private var problem: String?
    @FocusState private var focused: String?

    private let columns = Array(repeating: GridItem(.fixed(CoverView.width), spacing: 64, alignment: .top), count: 5)

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 48) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Ribbon").font(.ui(40, weight: 600)).foregroundStyle(Color.ink)
                        Text(subtitle).font(.ui(26)).foregroundStyle(Color.ink2)
                    }
                    if let books {
                        LazyVGrid(columns: columns, alignment: .leading, spacing: 72) {
                            ForEach(books) { book in
                                card(book)
                            }
                        }
                    }
                    if let problem = problem ?? model.problem {
                        Text(problem).font(.ui(26)).foregroundStyle(Color.ink2)
                        Button("Try again") { Task { await load() } }
                    }
                    Button("Switch reader") { model.switchReader() }
                        .padding(.top, 24)
                }
                .padding(.horizontal, 80)
                .padding(.vertical, 60)
            }
        }
        .onExitCommand(perform: model.people.count > 1 ? { model.switchReader() } : nil)
        .task { await load() }
    }

    private func card(_ book: ServerBook) -> some View {
        // Room under the cover for it to lift into when it has the focus.
        VStack(alignment: .leading, spacing: 32) {
            Button { Task { await model.open(book) } } label: {
                CoverView(book: book, server: model.server)
                    .overlay {
                        if model.opening == book.id { ProgressView() }
                    }
            }
            .buttonStyle(.card)
            .focused($focused, equals: book.id)
            VStack(alignment: .leading, spacing: 6) {
                Text(book.title).font(.ui(24, weight: 500)).foregroundStyle(Color.ink).lineLimit(2)
                Text(book.author).font(.ui(22)).foregroundStyle(Color.ink3).lineLimit(1)
            }
        }
    }

    private var host: String { model.server?.account.url.host() ?? "the server" }

    private var subtitle: String {
        let who = model.server?.account.name ?? ""
        guard let books else { return "\(who) · Asking \(host) for its books…" }
        if books.isEmpty { return "\(who) · No book on \(host) has both its text and its narration yet." }
        return "\(who) · " + (books.count == 1 ? "One book to read along with" : "\(books.count) books to read along with")
    }

    private func load() async {
        guard let server = model.server else { return }
        problem = nil
        do {
            let found = try await server.books()
            books = found
            // The books arrive after the screen is up: the focus goes to the one read last here, else the first.
            focused = found.first { $0.id == model.lastRead }?.id ?? found.first?.id
        } catch let error as ServerError where error.status == 401 {
            model.signInAgain(server.account)
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// A book's cover, drawn at its own shape in its own colour before the picture arrives, so nothing moves when it does.
struct CoverView: View {
    static let width: CGFloat = 260
    let book: ServerBook
    let server: RibbonServer?
    @State private var image: UIImage?

    var body: some View {
        let aspect = book.cover?.aspect ?? 2 / 3
        ZStack {
            Color(uiColor: UIColor(hex: book.cover?.colour) ?? Look.raised)
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fill).transition(.opacity)
            } else if book.cover == nil {
                Text(book.title).font(.book(26, weight: 500)).foregroundStyle(Color.ink2).multilineTextAlignment(.center).padding(20)
            }
        }
        .frame(width: Self.width, height: Self.width / aspect)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .task(id: book.cover?.hash) {
            guard let hash = book.cover?.hash, let server else { return }
            let found = try? await server.cover(hash, width: 400)
            withAnimation(.easeOut(duration: 0.2)) { image = found }
        }
    }
}

extension UIColor {
    /// A colour as the server writes one: `#7c7251`.
    convenience init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(rgb: value)
    }
}
