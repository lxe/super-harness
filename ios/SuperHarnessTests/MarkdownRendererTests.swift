import XCTest
@testable import SuperHarness

final class MarkdownRendererTests: XCTestCase {
    func testHeadingsAndThematicBreak() {
        let md = """
        # Title H1
        ## Subtitle H2 ##
        ### Section H3
        #### Deep H4
        ---
        Body paragraph text.
        """
        let blocks = SHMarkdownParser.parse(md)
        XCTAssertEqual(blocks.count, 6)
        guard case .heading(_, 1, "Title H1") = blocks[0] else { return XCTFail("Expected H1") }
        guard case .heading(_, 2, "Subtitle H2") = blocks[1] else { return XCTFail("Expected H2") }
        guard case .heading(_, 3, "Section H3") = blocks[2] else { return XCTFail("Expected H3") }
        guard case .heading(_, 4, "Deep H4") = blocks[3] else { return XCTFail("Expected H4") }
        guard case .thematicBreak = blocks[4] else { return XCTFail("Expected thematic break") }
        guard case .paragraph(_, "Body paragraph text.") = blocks[5] else { return XCTFail("Expected paragraph") }
    }

    func testFencedCodeBlocksWithNestedBackticksAndTildes() {
        let md = """
        Intro text
        ````markdown
        Here is a nested fence:
        ```swift
        let x = 1
        ```
        ````
        ~~~bash
        echo "hello"
        ~~~
        """
        let blocks = SHMarkdownParser.parse(md)
        XCTAssertEqual(blocks.count, 3)
        guard case .paragraph(_, "Intro text") = blocks[0] else { return XCTFail("Expected intro") }
        guard case .codeBlock(_, "markdown", let nested) = blocks[1] else { return XCTFail("Expected 4-tick fence") }
        XCTAssertTrue(nested.contains("```swift"))
        guard case .codeBlock(_, "bash", "echo \"hello\"") = blocks[2] else { return XCTFail("Expected tilde fence") }
    }

    func testGFMTableWithAlignmentsAndEscapedPipes() {
        let md = """
        | Endpoint | Latency | Status |
        | :--- | :---: | ---: |
        | `/api/bootstrap` | 70 ms | OK |
        | `a \\| b` | 12 ms | 200 |
        """
        let blocks = SHMarkdownParser.parse(md)
        XCTAssertEqual(blocks.count, 1)
        guard case .table(_, let headers, let alignments, let rows) = blocks[0] else {
            return XCTFail("Expected GFM table")
        }
        XCTAssertEqual(headers, ["Endpoint", "Latency", "Status"])
        XCTAssertEqual(alignments, [.leading, .center, .trailing])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0], ["`/api/bootstrap`", "70 ms", "OK"])
        XCTAssertEqual(rows[1], ["`a | b`", "12 ms", "200"])
    }

    func testNestedListsTaskListsAndOrderedLists() {
        let md = """
        - [x] Shipped push relay
        - [ ] Deploy Cloudflare worker
          - Indented child note
        1. First step
        2. Second step
        """
        let blocks = SHMarkdownParser.parse(md)
        XCTAssertEqual(blocks.count, 2)
        guard case .unorderedList(_, let uItems) = blocks[0] else { return XCTFail("Expected unordered list") }
        XCTAssertEqual(uItems.count, 3)
        XCTAssertEqual(uItems[0].taskChecked, true)
        XCTAssertEqual(uItems[1].taskChecked, false)
        XCTAssertEqual(uItems[2].indentLevel, 1)
        XCTAssertNil(uItems[2].taskChecked)

        guard case .orderedList(_, let oItems) = blocks[1] else { return XCTFail("Expected ordered list") }
        XCTAssertEqual(oItems.map(\.ordinal), [1, 2])
        XCTAssertEqual(oItems.map(\.text), ["First step", "Second step"])
    }

    func testMultiLineNestedBlockquote() {
        let md = """
        > **Heads-up:** Tailscale routed over IPv6.
        > - Check Wi-Fi
        > - Or stay on cellular
        """
        let blocks = SHMarkdownParser.parse(md)
        XCTAssertEqual(blocks.count, 1)
        guard case .blockquote(_, let inner) = blocks[0] else { return XCTFail("Expected blockquote") }
        XCTAssertEqual(inner.count, 2)
        guard case .paragraph(_, let p) = inner[0] else { return XCTFail("Expected paragraph in blockquote") }
        XCTAssertTrue(p.contains("Heads-up"))
        guard case .unorderedList(_, let items) = inner[1] else { return XCTFail("Expected list in blockquote") }
        XCTAssertEqual(items.count, 2)
    }

    @MainActor
    func testInlineCodeAndLinkStyling() {
        let styled = SHMarkdownCache.inlineAttributedString(
            for: "Check `cmd/orble` and [docs](https://example.com) with **bold** and ~~old~~.",
            isUserBubble: false
        )
        XCTAssertTrue(String(styled.characters).contains("cmd/orble"))
        XCTAssertTrue(String(styled.characters).contains("docs"))
        let hasCodeBg = styled.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true && $0.backgroundColor != nil }
        let hasLink = styled.runs.contains { $0.link == URL(string: "https://example.com") }
        XCTAssertTrue(hasCodeBg, "Inline code should have pill background styling")
        XCTAssertTrue(hasLink, "Markdown links should preserve URL attribute")
    }

    @MainActor
    func testAutolinksBareHTTPSAndSessionURLs() {
        let boldURL = SHMarkdownCache.inlineAttributedString(
            for: "Open **https://example.ts.net:8451/** or see conversation://dc969a3b-736f-45e1-b1af-60d2fe972418.",
            isUserBubble: false
        )
        let links = boldURL.runs.compactMap { $0.link?.absoluteString }
        XCTAssertTrue(links.contains("https://example.ts.net:8451/"), "Bare bold HTTPS URL must be auto-linked; got \(links)")
        XCTAssertTrue(
            links.contains("conversation://dc969a3b-736f-45e1-b1af-60d2fe972418"),
            "Bare conversation:// URL must be auto-linked without trailing period; got \(links)"
        )

        // A code span that is nothing but a URL is a link: agents often write links that way,
        // and inline code styling looks tappable.
        let codeOnly = SHMarkdownCache.inlineAttributedString(
            for: "Install from `https://example.ts.net:8451/` on the phone",
            isUserBubble: false
        )
        XCTAssertEqual(codeOnly.runs.compactMap { $0.link?.absoluteString }, ["https://example.ts.net:8451/"])
        let linkedRun = codeOnly.runs.first { $0.link != nil }
        XCTAssertEqual(linkedRun?.inlinePresentationIntent?.contains(.code), true, "the link keeps its code styling")

        // A URL inside a longer code span is part of a command and stays plain.
        let command = SHMarkdownCache.inlineAttributedString(
            for: "Run `curl -s https://not-a-link.example.com | jq .` in shell",
            isUserBubble: false
        )
        XCTAssertTrue(command.runs.compactMap(\.link).isEmpty, "URLs inside a longer code span must not be auto-linked")
    }

    @MainActor func testAutolinksTheInstallLinkPhrasingsFromRealReplies() {
        let expected = "https://archlinux.tail6026.ts.net:8451/"
        let samples = [
            "install from https://archlinux.tail6026.ts.net:8451/. It includes the fix",
            "from https://archlinux.tail6026.ts.net:8451/ as build `e895777-20261126`",
            "**Ready to install** at https://archlinux.tail6026.ts.net:8451/:",
            "from https://archlinux.tail6026.ts.net:8451/ (build `d993019-20261126`",
            "(see https://archlinux.tail6026.ts.net:8451/)",
            "\"https://archlinux.tail6026.ts.net:8451/\"",
        ]
        for sample in samples {
            let links = SHMarkdownCache.inlineAttributedString(for: sample, isUserBubble: false)
                .runs.compactMap { $0.link?.absoluteString }
            XCTAssertEqual(links, [expected], "sample: \(sample)")
        }
        // A bare host:port in backticks has no scheme and stays plain.
        let hostOnly = SHMarkdownCache.inlineAttributedString(for: "served at `archlinux.tail6026.ts.net:8451`", isUserBubble: false)
        XCTAssertTrue(hostOnly.runs.compactMap(\.link).isEmpty)
    }
}
