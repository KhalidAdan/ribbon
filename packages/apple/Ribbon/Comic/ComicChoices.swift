import SwiftUI

/// What is behind a comic's page (docs/COMICS.md, section 15): Ribbon's own ground, the app's dark, or black, grey or
/// white, as Panels had them. Chosen in Settings and kept on this device, for every comic. Ribbon's own is the
/// default, so nothing on screen changes until someone chooses.
enum ComicGround: String, CaseIterable {
    case ribbon, black, grey, white

    /// Where the choice is kept, for `@AppStorage`.
    static let key = "ribbon.comic.ground"

    var color: Color {
        switch self {
        case .ribbon: .canvas
        case .black: .black
        // Panels' grey: dark enough that a page's white still stands out from it.
        case .grey: Color(uiColor: UIColor(rgb: 0x525252))
        case .white: .white
        }
    }

    /// What Settings calls it.
    var name: String {
        switch self {
        case .ribbon: "Ribbon's own"
        case .black: "Black"
        case .grey: "Grey"
        case .white: "White"
        }
    }

    /// The one after it, as a press in Settings goes through them, and back to the first after the last.
    var next: ComicGround {
        let all = Self.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }
}

/// How comics are read on this iPad or iPhone, for every comic: a page at a time, or one long scroll of pages (docs/COMICS.md,
/// section 15). Kept on the device, as one page or two is on the desktop.
enum ComicReading {
    /// Where the choice is kept, for `@AppStorage`: true for one long scroll.
    static let longScrollKey = "ribbon.comic.longScroll"
}
