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

    func testOnTheTVRightGoesForwardUnlessTheComicReadsTheOtherWay() {
        XCTAssertEqual(ComicPaging.turn(by: 1, rightToLeft: false), 1)
        XCTAssertEqual(ComicPaging.turn(by: -1, rightToLeft: false), -1)
        XCTAssertEqual(ComicPaging.turn(by: 1, rightToLeft: true), -1)
        XCTAssertEqual(ComicPaging.turn(by: -1, rightToLeft: true), 1)
    }

    func testAPageAsWideAsTheScreenIsMovedAlongAndNeverPastItsEnds() {
        // A scanned page, 2000 by 3000, on a TV 1920 by 1080: 2880 tall, so 1800 of it is below the screen.
        let page = ComicPaging.height(of: CGSize(width: 2000, height: 3000), atWidth: 1920)
        XCTAssertEqual(page, 2880)
        XCTAssertEqual(ComicPaging.foot(page: page, screen: 1080), 1800)
        // Down moves most of a screen, keeping the last lines seen in sight.
        XCTAssertEqual(ComicPaging.move(from: 0, by: 1, page: page, screen: 1080), 648)
        XCTAssertEqual(ComicPaging.move(from: 648, by: 1, page: page, screen: 1080), 1296)
        // The last move stops at the page's foot, and the press after it is for the next page.
        XCTAssertEqual(ComicPaging.move(from: 1296, by: 1, page: page, screen: 1080), 1800)
        XCTAssertNil(ComicPaging.move(from: 1800, by: 1, page: page, screen: 1080))
        // Up the same, to its head, and then for the page before.
        XCTAssertEqual(ComicPaging.move(from: 400, by: -1, page: page, screen: 1080), 0)
        XCTAssertNil(ComicPaging.move(from: 0, by: -1, page: page, screen: 1080))
    }

    func testAPageShorterThanTheScreenHasNowhereToMove() {
        // Drawn across two, 4000 by 1500: 720 tall at the screen's width.
        let page = ComicPaging.height(of: CGSize(width: 4000, height: 1500), atWidth: 1920)
        XCTAssertEqual(page, 720)
        XCTAssertEqual(ComicPaging.foot(page: page, screen: 1080), 0)
        XCTAssertNil(ComicPaging.move(from: 0, by: 1, page: page, screen: 1080))
        XCTAssertEqual(ComicPaging.height(of: .zero, atWidth: 1920), 0)
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
