import XCTest
@testable import Ribbon

/// The gain that brings a book to the library's loudness, the same answers as the desktop's
/// (packages/core/test/loudness.test.ts, `gainDb`).
final class LoudnessTests: XCTestCase {
    func testBringsAMeasuredBookToTheTarget() {
        XCTAssertEqual(Loudness.gainDb(integratedLufs: -23.4, truePeakDbtp: -10), 5.4)
        XCTAssertEqual(Loudness.gainDb(integratedLufs: -12, truePeakDbtp: -1), -6)
    }

    func testNeverMoreThanTwelveEitherWay() {
        XCTAssertEqual(Loudness.gainDb(integratedLufs: -40, truePeakDbtp: -30), 12)
        XCTAssertEqual(Loudness.gainDb(integratedLufs: 0, truePeakDbtp: 0), -12)
    }

    func testPeaksStayUnderTheCeiling() {
        XCTAssertEqual(Loudness.gainDb(integratedLufs: -23.4, truePeakDbtp: -1.2), 0.2)
    }

    func testABookNotMeasuredYetPlaysAsItIs() throws {
        let unmeasured = ServerBookDetail(files: [], chapters: [], book: .init(description: nil, year: nil, publisher: nil))
        XCTAssertEqual(unmeasured.gainDb, 0)
        XCTAssertEqual(Loudness.linear(0), 1)
        XCTAssertEqual(Double(Loudness.linear(6)), 1.995, accuracy: 0.001)
    }
}
