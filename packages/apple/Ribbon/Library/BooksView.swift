import SwiftUI

/// Every book in the library, in a plain list: its cover, its title, who wrote and reads it, and how far through it you
/// are. In the order you choose, which the app remembers. The bookcase shows the same books as a thing to look at;
/// this is the list to find one in, and on an iPhone held upright it is the only place every book is.
///
/// Opened for a person (`by`), from their name on a book's page, it lists what they wrote, or what they read aloud.
struct BooksView: View {
    @Environment(AppModel.self) private var model
    let by: BookPerson?
    @AppStorage("books.order") private var order = BookOrder.title

    var body: some View {
        let all = model.library?.books ?? []
        let books = (by.map { all.by($0) } ?? all).inOrder(order)
        ScrollView {
            VStack(alignment: .leading, spacing: 28.scaled) {
                SectionHeader(title: by?.name ?? "Books", description: described(books.count)) {
                    if books.count > 1 { orderMenu }
                }
                if books.isEmpty {
                    Text(by == nil ? "No books on \(model.host) yet." : "Nothing \(by!.said) is in the library now.").font(.ui(24)).foregroundStyle(Color.ink2)
                }
                // Lazy: a long library makes only the rows near the screen.
                LazyVStack(alignment: .leading, spacing: 4.scaled) {
                    ForEach(books) { book in BookRow(book: book) }
                }
                .padding(.horizontal, -20.scaled)
            }
            .screenEdges(horizontal: 96, vertical: 56)
        }
        .background(Color.canvas.ignoresSafeArea())
    }

    /// "All 182 books, by title." or "7 books by Frank Herbert, by title."
    private func described(_ count: Int) -> String {
        let books = count == 1 ? "1 book" : "\(count) books"
        guard let by else { return count > 1 ? "All \(books), \(order.said)." : "\(books)." }
        return count > 1 ? "\(books) \(by.said), \(order.said)." : "\(books) \(by.said)."
    }

    private var orderMenu: some View {
        Menu {
            Picker("Order", selection: $order) {
                ForEach(BookOrder.allCases) { Text($0.name).tag($0) }
            }
        } label: {
            Label(order.name, systemImage: "arrow.up.arrow.down")
        }
        .menuStyle(.button)
        .buttonStyle(RibbonButtonStyle())
        .accessibilityLabel("Order: \(order.name)")
    }
}
