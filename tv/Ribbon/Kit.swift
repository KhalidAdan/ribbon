import SwiftUI

/// The few shapes every screen is built from, as the desktop's are
/// (src/ui/kit.tsx, docs/DESIGN.md), at the TV's size: a section header,
/// grouped inset rows, buttons, and the progress marks in the place colour.
/// Whatever has the focus lifts a little and lights up, the way tvOS shows it.

extension Color {
    static let surface = Color(uiColor: Look.surface)
    /// Every border and divider: never a solid grey.
    static let line = Color.white.opacity(0.08)
    static let lineStrong = Color.white.opacity(0.14)
}

/// A title and one muted line on the left, the section's actions on the right.
struct SectionHeader<Actions: View>: View {
    let title: String
    var description: String?
    @ViewBuilder var actions: Actions

    var body: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.ui(30, weight: 600)).foregroundStyle(Color.ink)
                if let description { Text(description).font(.ui(24)).foregroundStyle(Color.ink2) }
            }
            Spacer()
            actions
        }
    }
}

extension SectionHeader where Actions == EmptyView {
    init(title: String, description: String? = nil) {
        self.init(title: title, description: description) { EmptyView() }
    }
}

/// How far along, as a hairline in the place colour.
struct ProgressLine: View {
    let fraction: Double

    var body: some View {
        GeometryReader { space in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.lineStrong)
                Capsule().fill(Color.place).frame(width: space.size.width * min(1, max(0, fraction)))
            }
        }
        .frame(height: 4)
    }
}

/// A series at a glance: one segment per book, finished ones solid, the one you're in filled as far as you've got.
struct SegmentedProgress: View {
    let parts: [Double]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, fraction in
                ProgressLine(fraction: fraction).clipShape(RoundedRectangle(cornerRadius: 1))
            }
        }
        .frame(height: 4)
    }
}

/// A group of rows in an inset card: a small label above, an outer ring, and rows one step lighter inside it.
struct Rows<Content: View>: View {
    var label: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let label { Text(label).font(.ui(22, weight: 500)).foregroundStyle(Color.ink3).padding(.horizontal, 4) }
            VStack(spacing: 6) { content }
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.surface))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.line))
        }
    }
}

/// One row of a group: a title, a muted line under it, and what sits on the right.
struct Row<Aside: View>: View {
    let title: String
    var description: String?
    @ViewBuilder var aside: Aside

    var body: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.ui(26, weight: 500)).foregroundStyle(Color.ink)
                if let description { Text(description).font(.ui(22)).foregroundStyle(Color.ink2).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 16)
            aside.font(.ui(24)).foregroundStyle(Color.ink2).monospacedDigit()
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 16)
        .frame(minHeight: 72)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.raised))
    }
}

extension Row where Aside == EmptyView {
    init(title: String, description: String? = nil) {
        self.init(title: title, description: description) { EmptyView() }
    }
}

/// The app's buttons (docs/DESIGN.md, section 7): the one primary action in
/// inverted ink, the rest raised with a hairline ring. With the focus, a
/// button lifts, and a secondary one lights as a primary.
struct RibbonButtonStyle: ButtonStyle {
    enum Kind {
        case primary, secondary
    }

    var kind: Kind = .secondary

    func makeBody(configuration: Configuration) -> some View {
        Lift(configuration: configuration, kind: kind)
    }

    private struct Lift: View {
        let configuration: Configuration
        let kind: Kind
        @Environment(\.isFocused) private var focused

        var body: some View {
            let lit = kind == .primary || focused
            configuration.label
                .font(.ui(26, weight: 500))
                .foregroundStyle(lit ? Color.canvas : Color.ink)
                .padding(.horizontal, 28)
                .padding(.vertical, 14)
                .background(RoundedRectangle(cornerRadius: 12).fill(lit ? Color.ink : Color.raised))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(lit ? Color.clear : Color.line))
                .scaleEffect(configuration.isPressed ? 1.02 : focused ? 1.08 : 1)
                .shadow(color: .black.opacity(focused ? 0.5 : 0), radius: 18, y: 12)
                .animation(.easeOut(duration: 0.15), value: focused)
        }
    }
}

/// A card or a row that's one button, as the shelf's are: with the focus it lifts and its ground lightens.
struct LiftStyle: ButtonStyle {
    var radius: CGFloat = 16

    func makeBody(configuration: Configuration) -> some View {
        Lift(configuration: configuration, radius: radius)
    }

    private struct Lift: View {
        let configuration: Configuration
        let radius: CGFloat
        @Environment(\.isFocused) private var focused

        var body: some View {
            configuration.label
                .background(RoundedRectangle(cornerRadius: radius).fill(focused ? Color.white.opacity(0.12) : Color.clear))
                .overlay(RoundedRectangle(cornerRadius: radius).stroke(focused ? Color.lineStrong : Color.clear))
                .scaleEffect(configuration.isPressed ? 1.01 : focused ? 1.04 : 1)
                .shadow(color: .black.opacity(focused ? 0.45 : 0), radius: 20, y: 14)
                .animation(.easeOut(duration: 0.15), value: focused)
        }
    }
}

/// A round button with a glyph, as the shelf's play buttons are: raised, and lit in inverted ink with the focus.
struct RoundButtonStyle: ButtonStyle {
    var size: CGFloat = 64
    var primary = false

    func makeBody(configuration: Configuration) -> some View {
        Lift(configuration: configuration, size: size, primary: primary)
    }

    private struct Lift: View {
        let configuration: Configuration
        let size: CGFloat
        let primary: Bool
        @Environment(\.isFocused) private var focused

        var body: some View {
            let lit = primary || focused
            configuration.label
                .font(.system(size: size * 0.36, weight: .semibold))
                .foregroundStyle(lit ? Color.canvas : Color.ink)
                .frame(width: size, height: size)
                .background(Circle().fill(lit ? Color.ink : Color.raised))
                .overlay(Circle().stroke(lit ? Color.clear : Color.line))
                .scaleEffect(configuration.isPressed ? 1.04 : focused ? 1.14 : 1)
                .shadow(color: .black.opacity(focused ? 0.5 : 0), radius: 16, y: 10)
                .animation(.easeOut(duration: 0.15), value: focused)
        }
    }
}
