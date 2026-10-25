import SwiftUI

/// The few shapes every screen is built from, as the desktop's are
/// (src/ui/kit.tsx, docs/DESIGN.md), at the TV's size: a section header,
/// grouped inset rows, buttons, and the progress marks in the place colour.
/// Whatever has the focus lifts a little and lights up, the way tvOS shows it.
/// The iPad has no focus to show: there the primary button is in inverted ink
/// as the desktop's is, and a press shrinks what's under the finger.

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
            VStack(alignment: .leading, spacing: 4.scaled) {
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
        .frame(height: 4.scaled)
    }
}

/// A series at a glance: one segment per book, finished ones solid, the one you're in filled as far as you've got.
struct SegmentedProgress: View {
    let parts: [Double]

    var body: some View {
        HStack(spacing: 3.scaled) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, fraction in
                ProgressLine(fraction: fraction).clipShape(RoundedRectangle(cornerRadius: 1))
            }
        }
        .frame(height: 4.scaled)
    }
}

/// A group of rows in an inset card: a small label above, an outer ring, and rows one step lighter inside it.
struct Rows<Content: View>: View {
    var label: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12.scaled) {
            if let label { Text(label).font(.ui(22, weight: 500)).foregroundStyle(Color.ink3).padding(.horizontal, 4.scaled) }
            VStack(spacing: 6.scaled) { content }
                .padding(6.scaled)
                .background(RoundedRectangle(cornerRadius: 16.scaled).fill(Color.surface))
                .overlay(RoundedRectangle(cornerRadius: 16.scaled).stroke(Color.line))
        }
    }
}

/// One row of a group: a title, a muted line under it, and what sits on the right.
struct Row<Aside: View>: View {
    let title: String
    var description: String?
    @ViewBuilder var aside: Aside

    var body: some View {
        HStack(spacing: 16.scaled) {
            VStack(alignment: .leading, spacing: 4.scaled) {
                Text(title).font(.ui(26, weight: 500)).foregroundStyle(Color.ink)
                if let description { Text(description).font(.ui(22)).foregroundStyle(Color.ink2).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 16.scaled)
            aside.font(.ui(24)).foregroundStyle(Color.ink2).monospacedDigit()
        }
        .padding(.horizontal, 22.scaled)
        .padding(.vertical, 16.scaled)
        .frame(minHeight: 72.scaled)
        .background(RoundedRectangle(cornerRadius: 10.scaled).fill(Color.raised))
    }
}

extension Row where Aside == EmptyView {
    init(title: String, description: String? = nil) {
        self.init(title: title, description: description) { EmptyView() }
    }
}

extension View {
    /// How a button moves: it lifts with the focus, and settles when pressed,
    /// each eased rather than snapped, the press quicker so a click is felt at
    /// once. Every button style here, and the player's and the picker's, use it.
    func lifts(focused: Bool, pressed: Bool) -> some View {
        animation(.easeOut(duration: 0.15), value: focused)
            .animation(.easeOut(duration: 0.1), value: pressed)
    }
}

/// How big a control is drawn as it's pressed. On the TV it has the focus,
/// so it's lifted, and settles back a little as it's clicked; on the iPad
/// nothing is lifted, and it shrinks under the finger and comes back
/// (docs/DESIGN.md, section 7): a button to 97%, a card or a row to 98%.
enum Pressed {
    #if os(tvOS)
    static func button(settlingTo lifted: CGFloat) -> CGFloat { lifted }
    static func card(settlingTo lifted: CGFloat) -> CGFloat { lifted }
    #else
    static func button(settlingTo lifted: CGFloat) -> CGFloat { 0.97 }
    static func card(settlingTo lifted: CGFloat) -> CGFloat { 0.98 }
    #endif

    /// Whether a primary control is drawn in inverted ink: on the TV only with the focus, which is how it's
    /// known; on the iPad always, as the desktop draws one.
    static func inverted(focused: Bool, primary: Bool) -> Bool {
        #if os(tvOS)
        focused
        #else
        focused || primary
        #endif
    }
}

/// The app's buttons (docs/DESIGN.md, section 7), as a TV shows them: only
/// the button with the focus is lit in inverted ink, and lifts, so it's never
/// in doubt which that is. Without the focus a button is raised with a
/// hairline ring, the primary one a shade lighter.
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
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            let lit = Pressed.inverted(focused: focused, primary: kind == .primary)
            configuration.label
                .font(.ui(26, weight: 500))
                .opacity(enabled ? 1 : 0.45)
                .foregroundStyle(lit ? Color.canvas : Color.ink)
                .padding(.horizontal, 28.scaled)
                .padding(.vertical, 14.scaled)
                .background(RoundedRectangle(cornerRadius: 12.scaled).fill(lit ? Color.ink : kind == .primary ? Color.lineStrong : Color.raised))
                .overlay(RoundedRectangle(cornerRadius: 12.scaled).stroke(lit ? Color.clear : Color.line))
                .scaleEffect(configuration.isPressed ? Pressed.button(settlingTo: 1.02) : focused ? 1.08 : 1)
                .shadow(color: .black.opacity(focused ? 0.5 : 0), radius: 18, y: 12)
                .lifts(focused: focused, pressed: configuration.isPressed)
        }
    }
}

/// A card or a row that's one button, as the shelf's are: with the focus it lifts and lightens. A row in a
/// group grows only a little, so it stays inside the group.
struct LiftStyle: ButtonStyle {
    var radius: CGFloat = 16
    var grows: CGFloat = 1.04

    /// For a row in a list or a group.
    static func row(radius: CGFloat = 10) -> LiftStyle {
        LiftStyle(radius: radius, grows: 1.015)
    }

    func makeBody(configuration: Configuration) -> some View {
        Lift(configuration: configuration, radius: radius.scaled, grows: grows)
    }

    private struct Lift: View {
        let configuration: Configuration
        let radius: CGFloat
        let grows: CGFloat
        @Environment(\.isFocused) private var focused

        var body: some View {
            configuration.label
                // Over what it shows, not under it: a row has a ground of its own.
                .overlay(RoundedRectangle(cornerRadius: radius).fill(focused ? Color.white.opacity(0.1) : Color.clear).allowsHitTesting(false))
                .overlay(RoundedRectangle(cornerRadius: radius).stroke(focused ? Color.white.opacity(0.3) : Color.clear))
                // Shown where it can be pressed: a row's ground is clear but for the one open.
                .contentShape(RoundedRectangle(cornerRadius: radius))
                .scaleEffect(configuration.isPressed ? Pressed.card(settlingTo: 1.005) : focused ? grows : 1)
                .shadow(color: .black.opacity(focused ? 0.45 : 0), radius: 20, y: 14)
                .lifts(focused: focused, pressed: configuration.isPressed)
        }
    }
}

/// The way back on the iPad, which has no Menu button: a chevron and the screen it goes back to, quiet until
/// pressed, as the desktop's ghost buttons are. Without a title, the screen beneath; without an action, back to it.
/// The TV goes back with Menu, and draws nothing here.
struct BackButton: View {
    var title: String?
    var action: (() -> Void)?
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        #if os(iOS)
        Button { if let action { action() } else { dismiss() } } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold))
                let words = title ?? model.beneath
                if !words.isEmpty { Text(words).font(.ui(24)).lineLimit(1) }
            }
            // A finger's width, at least.
            .frame(minWidth: 44, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(GhostStyle())
        .accessibilityLabel("Back")
        #endif
    }

    /// Text in the second ink that turns to the first while it's pressed, and shrinks a little.
    private struct GhostStyle: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .foregroundStyle(configuration.isPressed ? Color.ink : Color.ink2)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
        }
    }
}

extension View {
    /// A text field as the iPad draws one: raised, with a hairline ring, as the desktop's inputs are
    /// (docs/DESIGN.md, section 1). The TV draws its own, lifted with the focus.
    @ViewBuilder
    func ribbonField() -> some View {
        #if os(iOS)
        font(.ui(26))
            .padding(.horizontal, 22.scaled)
            .padding(.vertical, 18.scaled)
            .background(RoundedRectangle(cornerRadius: 12.scaled).fill(Color.raised))
            .overlay(RoundedRectangle(cornerRadius: 12.scaled).stroke(Color.line))
        #else
        self
        #endif
    }

    /// A screen over the library with, on the iPad, the way back above it, where it stays as the screen scrolls.
    @ViewBuilder
    func wayBack() -> some View {
        #if os(iOS)
        safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                BackButton()
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            // What scrolls under it fades away, and a book's wash shows through.
            .background(LinearGradient(colors: [Color.canvas.opacity(0.9), Color.canvas.opacity(0)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        }
        #else
        self
        #endif
    }
}

/// A round button with a glyph, as the player's transport is: raised, the primary one a shade lighter,
/// and lit in inverted ink only with the focus.
struct RoundButtonStyle: ButtonStyle {
    var size: CGFloat = 64
    var primary = false

    func makeBody(configuration: Configuration) -> some View {
        Lift(configuration: configuration, size: size.scaled, primary: primary)
    }

    private struct Lift: View {
        let configuration: Configuration
        let size: CGFloat
        let primary: Bool
        @Environment(\.isFocused) private var focused

        var body: some View {
            let lit = Pressed.inverted(focused: focused, primary: primary)
            configuration.label
                .font(.system(size: size * 0.36, weight: .semibold))
                .foregroundStyle(lit ? Color.canvas : Color.ink)
                .frame(width: size, height: size)
                .background(Circle().fill(lit ? Color.ink : primary ? Color.lineStrong : Color.raised))
                .overlay(Circle().stroke(lit ? Color.clear : Color.line))
                .scaleEffect(configuration.isPressed ? Pressed.button(settlingTo: 1.04) : focused ? 1.14 : 1)
                .shadow(color: .black.opacity(focused ? 0.5 : 0), radius: 16, y: 10)
                .lifts(focused: focused, pressed: configuration.isPressed)
        }
    }
}
