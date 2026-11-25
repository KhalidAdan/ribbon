import SwiftUI
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

    func testAPanelFillsTheScreenFromItsMiddleWithNothingElseShowing() {
        // A scanned page, 2000 by 3000, on a TV 1920 by 1080. Whole, it is as tall as the screen.
        let (page, screen) = (CGSize(width: 2000, height: 3000), CGSize(width: 1920, height: 1080))
        let whole = ComicPaging.whole(page: page, screen: screen)
        XCTAssertEqual(whole.scale, 0.36, accuracy: 0.0001)
        XCTAssertEqual(whole.offset, .zero)
        XCTAssertEqual(whole.window.width, 720, accuracy: 0.001)

        // A wide panel across the top of the page: the screen's width holds it, less a little room either side.
        let top = ComicPanel(x: 0.05, y: 0.05, w: 0.9, h: 0.25)
        let close = ComicPaging.close(on: top, page: page, screen: screen)
        XCTAssertEqual(close.scale, 1920 * 0.94 / 1800, accuracy: 0.0001)
        XCTAssertEqual(close.window.width, 1920 * 0.94, accuracy: 0.001)
        XCTAssertLessThanOrEqual(close.window.height, 1080)
        // Its middle is the page's across, and well above the page's middle: the page is moved down to bring it to the screen's.
        XCTAssertEqual(close.offset.width, 0, accuracy: 0.001)
        XCTAssertEqual(close.offset.height, 3000 * close.scale * (0.5 - 0.175), accuracy: 0.001)

        // A small inset is not blown up past four times the whole page's size.
        let inset = ComicPanel(x: 0.6, y: 0.1, w: 0.05, h: 0.05)
        XCTAssertEqual(ComicPaging.close(on: inset, page: page, screen: screen).scale, whole.scale * 4, accuracy: 0.0001)
    }

    func testAPageWithNoPanelsIsHungFromTheScreensTop() {
        let (page, screen) = (CGSize(width: 2000, height: 3000), CGSize(width: 1920, height: 1080))
        let head = ComicPaging.wide(page: page, screen: screen, down: 0)
        XCTAssertEqual(head.scale, 0.96, accuracy: 0.0001)
        // Its middle is 900 below the screen's when its top is at the screen's top, and less by as far as it is moved down.
        XCTAssertEqual(head.offset.height, 900, accuracy: 0.001)
        XCTAssertEqual(ComicPaging.wide(page: page, screen: screen, down: 648).offset.height, 252, accuracy: 0.001)
        XCTAssertEqual(head.window, screen)
    }

    func testAPressPastAPagesLastPanelIsForTheNextPage() {
        XCTAssertEqual(ComicPaging.step(from: 0, by: 1, of: 5), 1)
        XCTAssertEqual(ComicPaging.step(from: 3, by: -1, of: 5), 2)
        XCTAssertNil(ComicPaging.step(from: 4, by: 1, of: 5))
        XCTAssertNil(ComicPaging.step(from: 0, by: -1, of: 5))
    }

    func testAComicsPanelsAreReadFromTheServersAnswer() throws {
        struct Answer: Decodable {
            struct Page: Decodable {
                let page: Int
                let panels: [ComicPanel]
            }
            let pages: [Page]
        }
        let answer = try JSONDecoder().decode(Answer.self, from: Data(#"{"pages":[{"page":2,"panels":[{"x":0.05,"y":0.05,"w":0.9,"h":0.25},{"x":0.05,"y":0.35,"w":0.42,"h":0.6}]}]}"#.utf8))
        XCTAssertEqual(answer.pages[0].page, 2)
        XCTAssertEqual(answer.pages[0].panels, [ComicPanel(x: 0.05, y: 0.05, w: 0.9, h: 0.25), ComicPanel(x: 0.05, y: 0.35, w: 0.42, h: 0.6)])
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

    // Jumping, the strip and one long scroll (docs/COMICS.md, section 15) ------------------------

    func testAPageTypedIsCountedFromOneAndPastEitherEndIsThatEnd() {
        XCTAssertEqual(ComicPaging.page(typed: "3", of: 24), 2)
        XCTAssertEqual(ComicPaging.page(typed: " 12 ", of: 24), 11)
        XCTAssertEqual(ComicPaging.page(typed: "99", of: 24), 23)
        XCTAssertEqual(ComicPaging.page(typed: "0", of: 24), 0)
        XCTAssertNil(ComicPaging.page(typed: "", of: 24))
        XCTAssertNil(ComicPaging.page(typed: "three", of: 24))
        XCTAssertNil(ComicPaging.page(typed: "3", of: 0))
    }

    func testAPageThatDoesntSayItsSizeIsAPrintedPagesShape() {
        XCTAssertEqual(ComicPaging.aspect(of: CGSize(width: 2000, height: 3000)), 2.0 / 3)
        XCTAssertEqual(ComicPaging.aspect(of: CGSize(width: 4000, height: 3000)), 4.0 / 3)
        XCTAssertEqual(ComicPaging.aspect(of: .zero), 2.0 / 3)
    }

    func testTheStripKeepsTheSmallPicturesNearestWhereItIsLooking() {
        // Under the most, nothing goes.
        XCTAssertEqual(ComicPaging.forget(kept: [1, 2, 3], near: 2, most: 4), [])
        // Over it, the furthest from the page last asked for go first, on either side.
        XCTAssertEqual(Set(ComicPaging.forget(kept: [0, 1, 2, 3, 4, 5, 6, 30], near: 4, most: 5)), [30, 0, 1])
        XCTAssertEqual(ComicPaging.forget(kept: Array(0..<600), near: 300, most: 48).count, 552)
        XCTAssertFalse(ComicPaging.forget(kept: Array(0..<600), near: 300, most: 48).contains(300))
    }

    func testEveryPageHasItsPlaceDownTheLongScrollBeforeAnyPictureComes() {
        XCTAssertEqual(ComicPaging.tops(of: [1500, 1500, 750]), [0, 1500, 3000, 3750])
        XCTAssertEqual(ComicPaging.tops(of: []), [0])
    }

    func testThePageBeingReadInTheLongScrollFillsTheScreensTopThird() {
        // Three pages 1500 tall and a wide one 750 tall, on a screen 1200 tall: the line is 400 down it.
        let tops = ComicPaging.tops(of: [1500, 1500, 1500, 750])
        XCTAssertEqual(ComicPaging.reading(at: 0, screen: 1200, tops: tops), 0)
        XCTAssertEqual(ComicPaging.reading(at: 1000, screen: 1200, tops: tops), 0)
        XCTAssertEqual(ComicPaging.reading(at: 1100, screen: 1200, tops: tops), 1)
        XCTAssertEqual(ComicPaging.reading(at: 2700, screen: 1200, tops: tops), 2)
        // At the very foot it is the last page, though the line is still in the one before: the comic can be finished.
        XCTAssertEqual(ComicPaging.reading(at: 5250 - 1200, screen: 1200, tops: tops), 3)
        // A comic shorter than the screen is on its first page.
        XCTAssertEqual(ComicPaging.reading(at: 0, screen: 1200, tops: ComicPaging.tops(of: [300, 300])), 0)
    }

    func testTheGroundBehindThePageIsRibbonsOwnUntilChosenAndGoesRound() {
        XCTAssertEqual(ComicGround(rawValue: UserDefaults(suiteName: "ComicTests")!.string(forKey: ComicGround.key) ?? "ribbon"), .ribbon)
        XCTAssertEqual(ComicGround.ribbon.next, .black)
        XCTAssertEqual(ComicGround.black.next, .grey)
        XCTAssertEqual(ComicGround.grey.next, .white)
        XCTAssertEqual(ComicGround.white.next, .ribbon)
        XCTAssertEqual(ComicGround.ribbon.color, Color.canvas)
    }

    func testAComicIsWordedByItsPages() {
        XCTAssertEqual(Format.pages(24), "24 pages")
        XCTAssertEqual(Format.pages(1), "1 page")
    }
}
