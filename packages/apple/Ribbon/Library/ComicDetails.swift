import Foundation

/// A book's details as its page says them, a comic's own above all (docs/BOOK-DETAILS.md, section 4), worded as the
/// desktop's page words them (packages/desktop/src/ui/comic-details.ts): its people by what they did, its cover date
/// as a month and a year, the day it went on sale, its imprint beside its publisher, and the issues a collection
/// holds. Kept apart from the page so they can be tested without drawing it.
enum ComicDetails {
    /// A line of the page: what it is, and what it says.
    struct Line: Hashable {
        let term: String
        let value: String
    }

    /// What each role is called on a book's page, for one name and for several: the edit form's words.
    private static let roles: [(names: KeyPath<ServerBookDetail.Credits, [String]?>, one: String, several: String)] = [
        (\.writers, "Writer", "Writers"),
        (\.pencils, "Art", "Art"),
        (\.inks, "Inks", "Inks"),
        (\.colours, "Colours", "Colours"),
        (\.letters, "Letters", "Letters"),
        (\.coverArtists, "Cover", "Cover"),
        (\.editors, "Editor", "Editors"),
        (\.translators, "Translator", "Translators"),
    ]

    /// A comic's people by what they did, a line for each role someone is named for, in the order the form asks
    /// for them; then its story arcs.
    static func madeBy(_ about: ServerBookDetail.About) -> [Line] {
        var lines: [Line] = roles.compactMap { role in
            let names = given(about.credits?[keyPath: role.names])
            guard !names.isEmpty else { return nil }
            return Line(term: names.count == 1 ? role.one : role.several, value: listed(names))
        }
        let arcs = given(about.storyArcs)
        if !arcs.isEmpty {
            lines.append(Line(term: arcs.count == 1 ? "Story arc" : "Story arcs", value: listed(arcs)))
        }
        return lines
    }

    /// When a book came out and who published it, as its page lists them among the facts: its year, or a comic's
    /// cover date in its place, and the day it went on sale; its publisher, and a comic's imprint beside it; and
    /// the issues a collection holds. A book with none of a comic's own details has its year and publisher, as ever.
    static func published(_ about: ServerBookDetail.About, locale: Locale = .current) -> [Line] {
        var facts: [Line] = []
        // A comic's cover date stands for its year, which is made from it.
        if let coverDate = present(about.coverDate) {
            facts.append(Line(term: "Cover date", value: coverDateText(coverDate, locale: locale)))
        } else if let year = about.year {
            facts.append(Line(term: "Year", value: String(year)))
        }
        if let onSale = present(about.onSale) { facts.append(Line(term: "On sale", value: dayText(onSale, locale: locale))) }
        if let publisher = present(about.publisher) { facts.append(Line(term: "Publisher", value: publisher)) }
        if let imprint = present(about.imprint) { facts.append(Line(term: "Imprint", value: imprint)) }
        if let collects = present(about.collects) { facts.append(Line(term: "Collects", value: issuesText(collects))) }
        return facts
    }

    /// ComicVine's page for a comic whose details came from there, which its page links back to; nil for a comic
    /// nobody matched, and for an address that isn't a web page's.
    static func comicVinePage(_ matched: ServerBookDetail.Matched?) -> URL? {
        guard let address = present(matched?.address), let page = URL(string: address), page.scheme == "https" || page.scheme == "http" else { return nil }
        return page
    }

    /// Names as a sentence lists them: "Ada Quill", "Ada Quill and Ben Nib", "Ada Quill, Ben Nib and Cy Ink".
    static func listed(_ names: [String]) -> String {
        guard let last = names.last else { return "" }
        return names.count == 1 ? last : "\(names.dropLast().joined(separator: ", ")) and \(last)"
    }

    /// A cover date as people say it: "2024-07" is "July 2024", in the reader's own language; "2024" is "2024".
    /// Anything else as it is.
    static func coverDateText(_ coverDate: String, locale: Locale = .current) -> String {
        guard let date = day(coverDate, pattern: #"^(\d{4})-(\d{2})$"#) else { return coverDate }
        return written(date, template: "MMMMy", locale: locale)
    }

    /// A day as people say it: "2024-07-10" is "10 July 2024", or "July 10, 2024", as the reader's language has
    /// it. Anything else as it is.
    static func dayText(_ day: String, locale: Locale = .current) -> String {
        guard let date = Self.day(day, pattern: #"^(\d{4})-(\d{2})-(\d{2})$"#) else { return day }
        return written(date, template: "dMMMMy", locale: locale)
    }

    /// The issues a collection holds, as the shelf says them: "1–6, Annual 1" is "#1–#6, Annual 1"
    /// (packages/core/src/comic-name.ts, `issuesText`).
    static func issuesText(_ collects: String) -> String {
        collects
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map { part in
                if let found = try? issueRange.wholeMatch(in: part), let first = found.output[1].substring, let last = found.output[2].substring {
                    return "#\(first)–#\(last)"
                }
                if let found = try? oneIssue.wholeMatch(in: part), let number = found.output[1].substring {
                    return "#\(number)"
                }
                return part
            }
            .joined(separator: ", ")
    }

    /// A piece of a list of issues that is an issue's number: "7", "#7", "½", "1.MU".
    private static let issue = #"#?\s*([\d½][A-Za-z0-9_.½]*)"#
    private static let oneIssue = try! Regex(issue)
    /// Two of them with a dash between: "1–6", "#1 - #6".
    private static let issueRange = try! Regex(#"\#(issue)\s*[-–—]\s*\#(issue)"#)

    /// What a list says, without empty names.
    private static func given(_ names: [String]?) -> [String] {
        (names ?? []).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private static func present(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        return text
    }

    /// The day a date written as numbers names, at noon in UTC so no time zone moves it to another day.
    private static func day(_ text: String, pattern: String) -> Date? {
        guard let match = try? Regex(pattern).wholeMatch(in: text) else { return nil }
        let numbers = match.output.dropFirst().compactMap { $0.substring.flatMap { Int($0) } }
        guard numbers.count >= 2 else { return nil }
        let parts = DateComponents(calendar: Calendar(identifier: .gregorian), timeZone: .gmt, year: numbers[0], month: numbers[1], day: numbers.count > 2 ? numbers[2] : 1, hour: 12)
        guard (1...12).contains(numbers[1]), parts.isValidDate else { return nil }
        return parts.date
    }

    private static func written(_ date: Date, template: String, locale: Locale) -> String {
        let format = DateFormatter()
        format.locale = locale
        format.timeZone = .gmt
        format.setLocalizedDateFormatFromTemplate(template)
        return format.string(from: date)
    }
}
