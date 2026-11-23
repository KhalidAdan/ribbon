import XCTest
@testable import Ribbon

/// What the comic reader works out with no screen and no server (Ribbon/Comic/ComicSession.swift, `ComicPaging`),
/// held to what the desktop's reader does (packages/core/test/comic-reading.test.ts).
final class ComicTests: XCTestCase {
    func testAComicIsFinishedOnItsLastPage() {
        XCTAssertEqual(ComicPaging.progress(page: 0, of: 24), 0)
        XCTAssertEqual(ComicPaging.progress(page: 23, of: 24), 1)
        XCTAssertEqual(ComicPaging.progress(page: 6, of: 9), 0.75)
        XCTAssertEqual(ComicPaging.progress(page: 0, of: 1), 1)
    }

    func testThePagesKeptDecodedAreTheNearestFewAheadBeforeBehind() {
        XCTAssertEqual(ComicPaging.keep(around: 10, of: 100), [10, 11, 9, 12])
        XCTAssertEqual(ComicPaging.keep(around: 0, of: 100), [0, 1, 2])
        XCTAssertEqual(ComicPaging.keep(around: 99, of: 100), [99, 98])
        XCTAssertEqual(ComicPaging.keep(around: 0, of: 1), [0])
        XCTAssertEqual(ComicPaging.keep(around: 0, of: 0), [])
    }

    func testATurnStaysInsideTheComic() {
        XCTAssertEqual(ComicPaging.clamp(99, of: 24), 23)
        XCTAssertEqual(ComicPaging.clamp(-3, of: 24), 0)
    }

    func testATouchOnEitherSideTurnsAndTheMiddleIsThePagesOwn() {
        XCTAssertEqual(ComicPaging.turn(at: 0.9, rightToLeft: false), 1)
        XCTAssertEqual(ComicPaging.turn(at: 0.1, rightToLeft: false), -1)
        XCTAssertEqual(ComicPaging.turn(at: 0.5, rightToLeft: false), 0)
        // Read right to left, the comic goes on to the left.
        XCTAssertEqual(ComicPaging.turn(at: 0.1, rightToLeft: true), 1)
        XCTAssertEqual(ComicPaging.turn(at: 0.9, rightToLeft: true), -1)
    }

    func testAPageIsDecodedNoLargerThanAsked() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 1200), format: format).image { context in
            UIColor.systemPurple.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 800, height: 1200))
        }
        let file = try XCTUnwrap(drawn.pngData())
        let whole = try XCTUnwrap(ComicPaging.picture(from: file, longest: 4000))
        XCTAssertEqual(whole.cgImage?.width, 800)
        XCTAssertEqual(whole.cgImage?.height, 1200)
        let small = try XCTUnwrap(ComicPaging.picture(from: file, longest: 600))
        XCTAssertEqual(small.cgImage?.height, 600)
        XCTAssertEqual(small.cgImage?.width, 400)
        XCTAssertNil(ComicPaging.picture(from: Data("not a picture".utf8), longest: 600))
    }

    func testAComicIsWordedByItsPages() {
        XCTAssertEqual(Format.pages(24), "24 pages")
        XCTAssertEqual(Format.pages(1), "1 page")
    }
}
