import XCTest

@testable import BinsightKit

/// The URL rules exist because of one real incident: a saved `…/api/` produced `…/api//auth/login`,
/// and the web `/api` proxy authenticates without ever handing the app a token.
final class APIURLTests: XCTestCase {
    func testTrailingSlashIsStripped() {
        XCTAssertEqual(
            normalizedAPIURL("https://api.binsight.thomasott.fr/"),
            "https://api.binsight.thomasott.fr")
    }

    func testRepeatedTrailingSlashesAreStripped() {
        XCTAssertEqual(normalizedAPIURL("https://host/api///"), "https://host/api")
    }

    func testSurroundingWhitespaceIsTrimmed() {
        // Pasting a URL routinely brings a trailing newline with it.
        XCTAssertEqual(normalizedAPIURL("  https://host \n"), "https://host")
    }

    func testAnAlreadyCleanURLIsUntouched() {
        XCTAssertEqual(normalizedAPIURL("http://localhost:8787"), "http://localhost:8787")
    }

    func testNormalizationIsIdempotent() {
        let once = normalizedAPIURL("https://host/api/")
        XCTAssertEqual(normalizedAPIURL(once), once)
    }

    func testALoneSlashIsNotEatenIntoAnEmptyString() {
        // Degenerate input must stay a (useless but harmless) string rather than becoming "".
        XCTAssertEqual(normalizedAPIURL("/"), "/")
    }

    func testStoringAURLNormalizesIt() {
        let previous = Config.apiURL
        defer { Config.apiURL = previous }
        Config.apiURL = "https://host/api/"
        XCTAssertEqual(Config.apiURL, "https://host/api")
    }

    func testWebProxyURLIsRecognized() {
        XCTAssertTrue(looksLikeWebBFF("https://binsight.thomasott.fr/api"))
        XCTAssertTrue(looksLikeWebBFF("https://binsight.thomasott.fr/api/"))
        XCTAssertTrue(looksLikeWebBFF("https://binsight.thomasott.fr/api/v2"))
    }

    func testTheAPIHostIsNotFlaggedAsTheProxy() {
        XCTAssertFalse(looksLikeWebBFF("https://api.binsight.thomasott.fr"))
        XCTAssertFalse(looksLikeWebBFF("http://localhost:8787"))
        // "api" as a host prefix or inside another path segment is not the /api proxy path.
        XCTAssertFalse(looksLikeWebBFF("https://host/apiary"))
    }
}
