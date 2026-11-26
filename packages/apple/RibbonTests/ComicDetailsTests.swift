import XCTest
@testable import Ribbon

/// A comic's own details on its page (Ribbon/Library/ComicDetails.swift; docs/BOOK-DETAILS.md, section 4): decoded
/// from a server that has them and from one from before, and worded as the desktop's page words them
/// (packages/desktop/test/comic-details.test.ts).
final class ComicDetailsTests: XCTestCase {
    private func decoded<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    /// A comic as a server with comics' own details answers `GET /api/books/:id` (its shape as the scratch server
    /// built from PR #300 answered it), with a ComicVine match beside its edits, as step 8 will add.
    private let matchedComic = """
    {
      "book": {
        "id": "0123456789abcdef", "title": "Steel Giants #7: Iron Rain", "rawTitle": "Iron Rain", "author": "Dana Pen; Eli Ink",
        "narrator": "", "series": "Steel Giants (2023)", "seriesIndex": 7, "year": 2024, "publisher": "Made Up Press",
        "description": "The giants wake.", "comic": "book.cbz", "pages": 4, "issue": "7", "imprint": "Made Up Black",
        "coverDate": "2024-07", "onSale": "2024-07-10", "storyArcs": ["The Long Forge"], "comicvine": "4000-1234567",
        "credits": {
          "writers": ["Dana Pen"], "pencils": ["Eli Ink"], "inks": ["Eli Ink"], "colours": ["Fay Hue"], "letters": ["Gil Type"],
          "coverArtists": ["Eli Ink", "Hal Brush"], "editors": ["Ivy Red", "Jo Quill"]
        },
        "durationMs": 0, "sizeBytes": 1000, "fileCount": 1
      },
      "files": [], "chapters": [], "parts": [],
      "pages": [{ "name": "page-001.png", "width": 1000, "height": 1500 }],
      "edited": { "values": { "onSale": "2024-07-10" }, "original": { "onSale": "" }, "updatedAt": "2026-11-25T00:00:00.000Z" },
      "matched": { "address": "https://comicvine.gamespot.com/steel-giants-7-iron-rain/4000-1234567/", "values": { "title": "Iron Rain" } }
    }
    """

    func testAComicsOwnDetailsDecode() throws {
        let detail = try decoded(matchedComic, as: ServerBookDetail.self)
        let about = detail.book
        XCTAssertEqual(about.issue, "7")
        XCTAssertNil(about.volume)
        XCTAssertEqual(about.imprint, "Made Up Black")
        XCTAssertEqual(about.coverDate, "2024-07")
        XCTAssertEqual(about.onSale, "2024-07-10")
        XCTAssertEqual(about.storyArcs, ["The Long Forge"])
        XCTAssertEqual(about.credits?.coverArtists, ["Eli Ink", "Hal Brush"])
        XCTAssertNil(about.credits?.translators)
        XCTAssertEqual(detail.matched?.address, "https://comicvine.gamespot.com/steel-giants-7-iron-rain/4000-1234567/")
        XCTAssertEqual(detail.pages?.count, 1)
    }

    /// A server from before comics had details of their own (0.50.0) says only these of a comic, and the page
    /// shows its year and publisher as it did.
    func testAComicFromAServerFromBeforeStillDecodes() throws {
        let detail = try decoded("""
        {
          "book": { "id": "0123456789abcdef", "title": "Steel Giants #7", "author": "Dana Pen", "narrator": "", "series": "Steel Giants",
                    "seriesIndex": 7, "year": 2024, "publisher": "Made Up Press", "description": null, "comic": "book.cbz", "pages": 4,
                    "rightToLeft": true, "durationMs": 0, "sizeBytes": 1000, "fileCount": 1 },
          "files": [], "chapters": [], "parts": []
        }
        """, as: ServerBookDetail.self)
        XCTAssertEqual(detail.book.rightToLeft, true)
        XCTAssertNil(detail.book.credits)
        XCTAssertNil(detail.book.coverDate)
        XCTAssertNil(detail.matched)
        XCTAssertEqual(ComicDetails.published(detail.book), [.init(term: "Year", value: "2024"), .init(term: "Publisher", value: "Made Up Press")])
        XCTAssertEqual(ComicDetails.madeBy(detail.book), [])
        XCTAssertNil(ComicDetails.comicVinePage(detail.matched))
    }

    /// A series' books gain their label; a server from before doesn't say one.
    func testASeriesLabelDecodesAndAnOldSeriesStillDoes() throws {
        struct Answer: Decodable { let series: [ServerSeries] }
        let labelled = try decoded("""
        { "series": [{ "id": "steel-giants-2023", "name": "Steel Giants (2023)", "books": [
            { "id": "a", "number": 1, "title": null, "shelved": true, "label": "Vol. 1" },
            { "id": "b", "number": 7, "title": null, "shelved": true, "label": "#7" },
            { "id": "c", "number": 8, "title": null, "shelved": true, "label": null } ] }] }
        """, as: Answer.self)
        XCTAssertEqual(labelled.series[0].books.map(\.label), ["Vol. 1", "#7", nil])
        let before = try decoded("""
        { "series": [{ "id": "the-waygates", "name": "The Waygates", "books": [{ "id": "a", "number": 1, "title": null, "shelved": true }] }] }
        """, as: Answer.self)
        XCTAssertNil(before.series[0].books[0].label)
    }

    /// A match whose answer has no address, or an address that isn't a web page, still decodes, and says nothing.
    func testAMatchWithNoPageShowsNoLink() throws {
        struct Answer: Decodable { let matched: ServerBookDetail.Matched? }
        XCTAssertNil(ComicDetails.comicVinePage(try decoded(#"{ "matched": { "values": {} } }"#, as: Answer.self).matched))
        XCTAssertNil(ComicDetails.comicVinePage(try decoded(#"{ "matched": { "address": "4000-1234567" } }"#, as: Answer.self).matched))
        XCTAssertNil(ComicDetails.comicVinePage(try decoded(#"{ "matched": null }"#, as: Answer.self).matched))
        XCTAssertEqual(ComicDetails.comicVinePage(.init(address: "https://comicvine.gamespot.com/x/4000-1/"))?.host(), "comicvine.gamespot.com")
    }

    func testItsPeopleARoleToALineInTheFormsOrderAndWords() throws {
        let about = try decoded(matchedComic, as: ServerBookDetail.self).book
        XCTAssertEqual(ComicDetails.madeBy(about), [
            .init(term: "Writer", value: "Dana Pen"),
            .init(term: "Art", value: "Eli Ink"),
            .init(term: "Inks", value: "Eli Ink"),
            .init(term: "Colours", value: "Fay Hue"),
            .init(term: "Letters", value: "Gil Type"),
            .init(term: "Cover", value: "Eli Ink and Hal Brush"),
            .init(term: "Editors", value: "Ivy Red and Jo Quill"),
            .init(term: "Story arc", value: "The Long Forge"),
        ])
        // As the desktop's test has them: one name or several, empty roles left out.
        var credits = ServerBookDetail.Credits()
        credits.colours = ["Mike Spicer"]
        credits.writers = ["Daniel Warren Johnson", "Ada Quill"]
        credits.pencils = []
        credits.translators = ["Cy Ink", " "]
        let lines = ComicDetails.madeBy(.init(description: nil, year: nil, publisher: nil, credits: credits, storyArcs: ["One", "Two"]))
        XCTAssertEqual(lines, [
            .init(term: "Writers", value: "Daniel Warren Johnson and Ada Quill"),
            .init(term: "Colours", value: "Mike Spicer"),
            .init(term: "Translator", value: "Cy Ink"),
            .init(term: "Story arcs", value: "One and Two"),
        ])
    }

    func testNamesAreListedAsASentenceDoes() {
        XCTAssertEqual(ComicDetails.listed([]), "")
        XCTAssertEqual(ComicDetails.listed(["Ada Quill"]), "Ada Quill")
        XCTAssertEqual(ComicDetails.listed(["Ada Quill", "Ben Nib", "Cy Ink"]), "Ada Quill, Ben Nib and Cy Ink")
    }

    /// The cover date stands for the year, the day on sale and the imprint come after, and a collection says the
    /// issues it holds, in the reader's own language.
    func testItsDatesImprintAndIssuesAmongTheFacts() throws {
        let british = Locale(identifier: "en_GB")
        let about = try decoded(matchedComic, as: ServerBookDetail.self).book
        XCTAssertEqual(ComicDetails.published(about, locale: british), [
            .init(term: "Cover date", value: "July 2024"),
            .init(term: "On sale", value: "10 July 2024"),
            .init(term: "Publisher", value: "Made Up Press"),
            .init(term: "Imprint", value: "Made Up Black"),
        ])
        let collection = ServerBookDetail.About(description: nil, year: 2023, publisher: nil, volume: "1", collects: "1–6, Annual 1", coverDate: "2023")
        XCTAssertEqual(ComicDetails.published(collection, locale: british), [
            .init(term: "Cover date", value: "2023"),
            .init(term: "Collects", value: "#1–#6, Annual 1"),
        ])
    }

    func testACoverDateIsAMonthAndAYearAndADayOnSaleADay() {
        let british = Locale(identifier: "en_GB")
        let american = Locale(identifier: "en_US")
        XCTAssertEqual(ComicDetails.coverDateText("2024-07", locale: british), "July 2024")
        XCTAssertEqual(ComicDetails.coverDateText("2024-07", locale: american), "July 2024")
        XCTAssertEqual(ComicDetails.coverDateText("2024-01", locale: Locale(identifier: "fr_FR")), "janvier 2024")
        XCTAssertEqual(ComicDetails.coverDateText("2024", locale: british), "2024")
        XCTAssertEqual(ComicDetails.dayText("2024-07-10", locale: british), "10 July 2024")
        XCTAssertEqual(ComicDetails.dayText("2024-07-10", locale: american), "July 10, 2024")
        // The first and last of a month stay in it, whatever the time zone.
        XCTAssertEqual(ComicDetails.dayText("2024-12-31", locale: british), "31 December 2024")
        XCTAssertEqual(ComicDetails.dayText("2024-01-01", locale: british), "1 January 2024")
        // Anything that isn't a date as Ribbon keeps one is said as it is.
        XCTAssertEqual(ComicDetails.coverDateText("2024-13", locale: british), "2024-13")
        XCTAssertEqual(ComicDetails.dayText("2024-02-30", locale: british), "2024-02-30")
        XCTAssertEqual(ComicDetails.dayText("sometime", locale: british), "sometime")
    }

    /// As core's `issuesText` (packages/core/test/comic-name.test.ts).
    func testTheIssuesACollectionHoldsAsTheShelfSaysThem() {
        XCTAssertEqual(ComicDetails.issuesText("1–6, Annual 1"), "#1–#6, Annual 1")
        XCTAssertEqual(ComicDetails.issuesText("#1-#6"), "#1–#6")
        XCTAssertEqual(ComicDetails.issuesText("7, 9, 1.MU"), "#7, #9, #1.MU")
        XCTAssertEqual(ComicDetails.issuesText("½"), "#½")
    }

    // The series line ------------------------------------------------------------------------------------------

    private func comic(_ id: String, series: String = "Steel Giants (2023)") -> ServerBook {
        ServerBook(id: id, title: id, author: "", narrator: "", series: series, seriesIndex: nil, durationMs: 0, audio: false, ebook: false, ebookBytes: nil, words: nil, cover: nil, addedAt: nil, comic: true, pages: 4)
    }

    /// "Transformers (2023) · #7 of 19" where a book says "Book 7 of 19".
    func testAComicIsPlacedInItsSeriesByItsLabel() {
        let (volume, seven, eight) = (comic("vol-1"), comic("7"), comic("8"))
        let series = Library.Series(id: "steel-giants-2023", name: "Steel Giants (2023)", books: [volume, seven, eight], numbers: ["vol-1": 1, "7": 7], labels: ["vol-1": "Vol. 1", "7": "#7"])
        XCTAssertEqual(series.place(of: volume, at: 0), "Vol. 1 of 3")
        XCTAssertEqual(series.place(of: seven, at: 1), "#7 of 3")
        // With no label, as any book: by its number, else its place in the list.
        XCTAssertEqual(series.place(of: eight, at: 2), "Book 3 of 3")
        // The name is the series' own, however it is written.
        let written = Library.Series(id: "steel-giants-2023", name: "steel giants (2023) ", books: [seven], labels: ["7": "#7"])
        XCTAssertEqual(written.place(of: seven, at: 0), "#7 of 1")
    }

    /// In a reading list made by hand, an issue's number says nothing about where it comes, as on the desktop.
    func testAComicInAReadingListIsPlacedAsAnyBook() {
        let seven = comic("7")
        let list = Library.Series(id: "best-of-2024", name: "Best of 2024", books: [comic("other", series: "Other"), seven], labels: ["7": "#7"])
        XCTAssertEqual(list.place(of: seven, at: 1), "Book 2 of 2")
    }

    /// A book is "Book 2 of 9", as ever.
    func testABookIsPlacedByItsNumber() {
        let book = ServerBook(id: "b", title: "B", author: "", narrator: "", series: "The Waygates", seriesIndex: 2, durationMs: 1000, audio: true, ebook: false, ebookBytes: nil, words: nil, cover: nil, addedAt: nil)
        let series = Library.Series(id: "the-waygates", name: "The Waygates", books: [comic("a", series: "The Waygates"), book], numbers: ["b": 2])
        XCTAssertEqual(series.place(of: book, at: 1), "Book 2 of 2")
    }
}
