import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - CommonMark + GFM Block AST

public enum SHMarkdownAlignment: Sendable, Equatable {
    case leading
    case center
    case trailing

    var swiftUIAlignment: Alignment {
        switch self {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    var textAlignment: TextAlignment {
        switch self {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

public struct SHMarkdownListItem: Sendable, Equatable, Identifiable {
    public let id: Int
    public let indentLevel: Int
    public let ordinal: Int?
    public let taskChecked: Bool?
    public let text: String

    public init(id: Int, indentLevel: Int = 0, ordinal: Int? = nil, taskChecked: Bool? = nil, text: String) {
        self.id = id
        self.indentLevel = indentLevel
        self.ordinal = ordinal
        self.taskChecked = taskChecked
        self.text = text
    }
}

public enum SHMarkdownBlock: Sendable, Equatable, Identifiable {
    case heading(id: Int, level: Int, text: String)
    case paragraph(id: Int, text: String)
    case codeBlock(id: Int, language: String, code: String)
    case blockquote(id: Int, blocks: [SHMarkdownBlock])
    case unorderedList(id: Int, items: [SHMarkdownListItem])
    case orderedList(id: Int, items: [SHMarkdownListItem])
    case table(id: Int, headers: [String], alignments: [SHMarkdownAlignment], rows: [[String]])
    case thematicBreak(id: Int)

    public var id: Int {
        switch self {
        case .heading(let id, _, _),
             .paragraph(let id, _),
             .codeBlock(let id, _, _),
             .blockquote(let id, _),
             .unorderedList(let id, _),
             .orderedList(let id, _),
             .table(let id, _, _, _),
             .thematicBreak(let id):
            return id
        }
    }
}

// MARK: - Block Parser (CommonMark + GFM Tables, Task Lists, Nested Lists, Multi-Tick Fences)

public enum SHMarkdownParser {
    public static func parse(_ source: String) -> [SHMarkdownBlock] {
        let normalized = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        return parseLines(lines)
    }

    private static func parseLines(_ lines: [String]) -> [SHMarkdownBlock] {
        var blocks: [SHMarkdownBlock] = []
        var i = 0
        var nextId = 0

        func takeId() -> Int {
            defer { nextId += 1 }
            return nextId
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Skip blank lines
            if trimmed.isEmpty {
                i += 1
                continue
            }

            // 1. Fenced code block (3+ backticks or 3+ tildes)
            if let fence = parseFenceOpen(trimmed) {
                var codeLines: [String] = []
                i += 1
                while i < lines.count {
                    let closeCandidate = lines[i].trimmingCharacters(in: .whitespaces)
                    if isFenceClose(closeCandidate, char: fence.char, minLength: fence.length) {
                        i += 1
                        break
                    }
                    codeLines.append(lines[i])
                    i += 1
                }
                blocks.append(.codeBlock(id: takeId(), language: fence.language, code: codeLines.joined(separator: "\n")))
                continue
            }

            // 2. Thematic break (---, ***, ___)
            if isThematicBreak(trimmed) {
                blocks.append(.thematicBreak(id: takeId()))
                i += 1
                continue
            }

            // 3. ATX Heading (# through ######)
            if let heading = parseATXHeading(trimmed) {
                blocks.append(.heading(id: takeId(), level: heading.level, text: heading.text))
                i += 1
                continue
            }

            // 4. GFM Pipe Table (header row + separator row)
            if i + 1 < lines.count,
               line.contains("|"),
               let alignments = parseTableSeparator(lines[i + 1]) {
                let headers = splitTableRow(line)
                if !headers.isEmpty && headers.count == alignments.count {
                    var rows: [[String]] = []
                    i += 2
                    while i < lines.count {
                        let rowLine = lines[i]
                        let rowTrimmed = rowLine.trimmingCharacters(in: .whitespaces)
                        if rowTrimmed.isEmpty || !rowLine.contains("|") { break }
                        var cells = splitTableRow(rowLine)
                        if cells.count < headers.count {
                            cells.append(contentsOf: Array(repeating: "", count: headers.count - cells.count))
                        } else if cells.count > headers.count {
                            cells = Array(cells.prefix(headers.count))
                        }
                        rows.append(cells)
                        i += 1
                    }
                    blocks.append(.table(id: takeId(), headers: headers, alignments: alignments, rows: rows))
                    continue
                }
            }

            // 5. Blockquote (> ...)
            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while i < lines.count {
                    let qTrim = lines[i].trimmingCharacters(in: .whitespaces)
                    if qTrim.hasPrefix(">") {
                        var inner = String(qTrim.dropFirst())
                        if inner.hasPrefix(" ") { inner.removeFirst() }
                        quoteLines.append(inner)
                        i += 1
                    } else if qTrim.isEmpty {
                        break
                    } else {
                        break
                    }
                }
                let nested = parseLines(quoteLines)
                blocks.append(.blockquote(id: takeId(), blocks: nested))
                continue
            }

            // 6. Unordered list (-, *, +, with nesting and GFM task checkboxes)
            if parseUnorderedListLine(line) != nil {
                var items: [SHMarkdownListItem] = []
                var itemId = 0
                while i < lines.count {
                    if let parsed = parseUnorderedListLine(lines[i]) {
                        var itemText = parsed.text
                        i += 1
                        // Continuation lines indented beneath the list item
                        while i < lines.count {
                            let nextLine = lines[i]
                            let nextTrim = nextLine.trimmingCharacters(in: .whitespaces)
                            if nextTrim.isEmpty || parseUnorderedListLine(nextLine) != nil || parseOrderedListLine(nextLine) != nil || parseFenceOpen(nextTrim) != nil || parseATXHeading(nextTrim) != nil || nextTrim.hasPrefix(">") || isThematicBreak(nextTrim) {
                                break
                            }
                            if leadingSpaces(nextLine) >= 2 {
                                itemText += "\n" + nextTrim
                                i += 1
                            } else {
                                break
                            }
                        }
                        items.append(SHMarkdownListItem(
                            id: itemId,
                            indentLevel: parsed.indentLevel,
                            ordinal: nil,
                            taskChecked: parsed.taskChecked,
                            text: itemText
                        ))
                        itemId += 1
                    } else {
                        break
                    }
                }
                blocks.append(.unorderedList(id: takeId(), items: items))
                continue
            }

            // 7. Ordered list (1. / 1) with nesting)
            if parseOrderedListLine(line) != nil {
                var items: [SHMarkdownListItem] = []
                var itemId = 0
                while i < lines.count {
                    if let parsed = parseOrderedListLine(lines[i]) {
                        var itemText = parsed.text
                        i += 1
                        while i < lines.count {
                            let nextLine = lines[i]
                            let nextTrim = nextLine.trimmingCharacters(in: .whitespaces)
                            if nextTrim.isEmpty || parseOrderedListLine(nextLine) != nil || parseUnorderedListLine(nextLine) != nil || parseFenceOpen(nextTrim) != nil || parseATXHeading(nextTrim) != nil || nextTrim.hasPrefix(">") || isThematicBreak(nextTrim) {
                                break
                            }
                            if leadingSpaces(nextLine) >= 2 {
                                itemText += "\n" + nextTrim
                                i += 1
                            } else {
                                break
                            }
                        }
                        items.append(SHMarkdownListItem(
                            id: itemId,
                            indentLevel: parsed.indentLevel,
                            ordinal: parsed.ordinal,
                            taskChecked: nil,
                            text: itemText
                        ))
                        itemId += 1
                    } else {
                        break
                    }
                }
                blocks.append(.orderedList(id: takeId(), items: items))
                continue
            }

            // 8. Paragraph — join consecutive prose lines cleanly, preserving explicit hard breaks
            var paraLines: [String] = [line]
            i += 1
            while i < lines.count {
                let next = lines[i]
                let nextTrim = next.trimmingCharacters(in: .whitespaces)
                if nextTrim.isEmpty { break }
                if parseFenceOpen(nextTrim) != nil { break }
                if isThematicBreak(nextTrim) { break }
                if parseATXHeading(nextTrim) != nil { break }
                if nextTrim.hasPrefix(">") { break }
                if parseUnorderedListLine(next) != nil { break }
                if parseOrderedListLine(next) != nil { break }
                if i + 1 < lines.count && next.contains("|") && parseTableSeparator(lines[i + 1]) != nil { break }
                paraLines.append(next)
                i += 1
            }
            let joined = joinParagraphLines(paraLines)
            if !joined.isEmpty {
                blocks.append(.paragraph(id: takeId(), text: joined))
            }
        }

        return blocks
    }

    // MARK: - Line Matchers

    private static func leadingSpaces(_ line: String) -> Int {
        var count = 0
        for ch in line {
            if ch == " " { count += 1 }
            else if ch == "\t" { count += 2 }
            else { break }
        }
        return count
    }

    private static func parseFenceOpen(_ trimmed: String) -> (char: Character, length: Int, language: String)? {
        guard let first = trimmed.first, first == "`" || first == "~" else { return nil }
        var count = 0
        for ch in trimmed {
            if ch == first { count += 1 } else { break }
        }
        guard count >= 3 else { return nil }
        let rest = String(trimmed.dropFirst(count)).trimmingCharacters(in: .whitespaces)
        // Backtick info string cannot contain backticks (CommonMark spec)
        if first == "`" && rest.contains("`") { return nil }
        let lang = rest.split(separator: " ").first.map(String.init) ?? ""
        return (first, count, lang)
    }

    private static func isFenceClose(_ trimmed: String, char: Character, minLength: Int) -> Bool {
        guard trimmed.count >= minLength else { return false }
        return trimmed.allSatisfy { $0 == char }
    }

    private static func isThematicBreak(_ trimmed: String) -> Bool {
        let compact = trimmed.filter { !$0.isWhitespace }
        guard compact.count >= 3, let first = compact.first, first == "-" || first == "*" || first == "_" else {
            return false
        }
        return compact.allSatisfy { $0 == first }
    }

    private static func parseATXHeading(_ trimmed: String) -> (level: Int, text: String)? {
        var level = 0
        for ch in trimmed {
            if ch == "#" { level += 1 } else { break }
        }
        guard (1...6).contains(level) else { return nil }
        let afterHashes = trimmed.dropFirst(level)
        guard afterHashes.isEmpty || afterHashes.first == " " || afterHashes.first == "\t" else { return nil }
        var title = String(afterHashes).trimmingCharacters(in: .whitespaces)
        // Strip optional closing ### sequence per CommonMark
        while title.hasSuffix("#") {
            let without = title.dropLast()
            if without.isEmpty || without.last == " " || without.last == "#" {
                title = String(without).trimmingCharacters(in: .whitespaces)
            } else {
                break
            }
        }
        return (level, title)
    }

    private static func parseUnorderedListLine(_ line: String) -> (indentLevel: Int, taskChecked: Bool?, text: String)? {
        let spaces = leadingSpaces(line)
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else { return nil }
        let marker = trimmed.first!
        guard marker == "-" || marker == "*" || marker == "+" else { return nil }
        let secondIdx = trimmed.index(after: trimmed.startIndex)
        guard trimmed[secondIdx] == " " || trimmed[secondIdx] == "\t" else { return nil }
        var body = String(trimmed[trimmed.index(after: secondIdx)...]).trimmingCharacters(in: .whitespaces)
        var taskChecked: Bool? = nil
        if body.hasPrefix("[x] ") || body.hasPrefix("[X] ") {
            taskChecked = true
            body = String(body.dropFirst(4))
        } else if body.hasPrefix("[ ] ") {
            taskChecked = false
            body = String(body.dropFirst(4))
        }
        return (min(4, spaces / 2), taskChecked, body)
    }

    private static func parseOrderedListLine(_ line: String) -> (indentLevel: Int, ordinal: Int, text: String)? {
        let spaces = leadingSpaces(line)
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var digits = ""
        var idx = trimmed.startIndex
        while idx < trimmed.endIndex && trimmed[idx].isNumber && digits.count < 9 {
            digits.append(trimmed[idx])
            idx = trimmed.index(after: idx)
        }
        guard !digits.isEmpty, let num = Int(digits), idx < trimmed.endIndex else { return nil }
        let delim = trimmed[idx]
        guard delim == "." || delim == ")" else { return nil }
        let afterDelim = trimmed.index(after: idx)
        guard afterDelim < trimmed.endIndex, trimmed[afterDelim] == " " || trimmed[afterDelim] == "\t" else {
            return nil
        }
        let body = String(trimmed[trimmed.index(after: afterDelim)...]).trimmingCharacters(in: .whitespaces)
        return (min(4, spaces / 2), num, body)
    }

    private static func parseTableSeparator(_ line: String) -> [SHMarkdownAlignment]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("|") && trimmed.contains("-") else { return nil }
        let cells = splitTableRow(trimmed)
        guard !cells.isEmpty else { return nil }
        var alignments: [SHMarkdownAlignment] = []
        for rawCell in cells {
            let cell = rawCell.trimmingCharacters(in: .whitespaces)
            guard !cell.isEmpty else { return nil }
            let leftColon = cell.hasPrefix(":")
            let rightColon = cell.hasSuffix(":")
            var core = cell
            if leftColon { core.removeFirst() }
            if rightColon && !core.isEmpty { core.removeLast() }
            guard core.count >= 1 && core.allSatisfy({ $0 == "-" }) else { return nil }
            if leftColon && rightColon {
                alignments.append(.center)
            } else if rightColon {
                alignments.append(.trailing)
            } else {
                alignments.append(.leading)
            }
        }
        return alignments
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") && !trimmed.hasSuffix("\\|") { trimmed.removeLast() }
        var cells: [String] = []
        var current = ""
        var escaped = false
        for ch in trimmed {
            if escaped {
                current.append(ch)
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if ch == "|" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(ch)
            }
        }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    private static func joinParagraphLines(_ lines: [String]) -> String {
        guard lines.count > 1 else {
            return lines.first?.trimmingCharacters(in: .whitespaces) ?? ""
        }
        var out = ""
        for (idx, raw) in lines.enumerated() {
            let hasHardBreak = raw.hasSuffix("  ") || raw.hasSuffix("\\")
            var piece = raw.trimmingCharacters(in: .whitespaces)
            if raw.hasSuffix("\\") && piece.hasSuffix("\\") {
                piece.removeLast()
            }
            out += piece
            if idx < lines.count - 1 {
                out += hasHardBreak ? "\n" : "\n"
            }
        }
        return out
    }
}

// MARK: - Inline Styling & LRU Cache

private final class MarkdownBlockBox: NSObject {
    let value: [SHMarkdownBlock]
    init(_ value: [SHMarkdownBlock]) { self.value = value }
}

private final class StyledAttributedBox: NSObject {
    let value: AttributedString
    init(_ value: AttributedString) { self.value = value }
}

@MainActor
public enum SHMarkdownCache {
    private static let astCache: NSCache<NSString, MarkdownBlockBox> = {
        let c = NSCache<NSString, MarkdownBlockBox>()
        c.countLimit = 500
        return c
    }()

    private static let inlineCache: NSCache<NSString, StyledAttributedBox> = {
        let c = NSCache<NSString, StyledAttributedBox>()
        c.countLimit = 800
        return c
    }()

    public static func blocks(for source: String) -> [SHMarkdownBlock] {
        let key = source as NSString
        if let hit = astCache.object(forKey: key) { return hit.value }
        let parsed = SHMarkdownParser.parse(source)
        astCache.setObject(MarkdownBlockBox(parsed), forKey: key)
        return parsed
    }

    public static func inlineAttributedString(for raw: String, isUserBubble: Bool, scale: CGFloat = 1) -> AttributedString {
        // The inline-code font size is baked into the styled string, so the scale is part of the key.
        let cacheKey = "\(isUserBubble ? "u" : "a")\(Int((scale * 100).rounded()))|\(raw)" as NSString
        if let hit = inlineCache.object(forKey: cacheKey) { return hit.value }

        let opts = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        var attr = (try? AttributedString(markdown: raw, options: opts)) ?? AttributedString(raw)

        // Auto-linkify bare http(s):// and cross-harness session:// URLs in non-code runs
        // because Foundation's AttributedString(markdown:) does not auto-link bare URLs.
        autolinkBareURLs(in: &attr)

        // Style inline code, links, bold, and strikethrough runs to match Obsidian design tokens.
        for run in attr.runs {
            let range = run.range
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.code) {
                    attr[range].font = Font.system(size: 13.5 * scale, weight: .regular, design: .monospaced)
                    attr[range].foregroundColor = Color(hex: 0x93C5FD)
                    attr[range].backgroundColor = SHColor.surfaceBubble.opacity(0.92)
                }
                if intent.contains(.stronglyEmphasized) && !intent.contains(.code) {
                    attr[range].foregroundColor = SHColor.inkPrimary
                }
                if intent.contains(.strikethrough) {
                    attr[range].strikethroughStyle = .single
                    attr[range].foregroundColor = SHColor.inkMuted
                }
            }
            if run.link != nil {
                attr[range].foregroundColor = SHColor.brandAntigravity
                attr[range].underlineStyle = .single
            }
        }

        inlineCache.setObject(StyledAttributedBox(attr), forKey: cacheKey)
        return attr
    }

    private static let bareURLRegex: NSRegularExpression? = try? NSRegularExpression(
        pattern: #"(?i)\b(?:https?|conversation|session|sh|super-harness|antigravity|agy|codex|claude|muse|pi)://[^\s<>"'\[\]]+"#
    )

    private static func autolinkBareURLs(in attr: inout AttributedString) {
        guard let regex = bareURLRegex else { return }
        let plain = String(attr.characters)
        let nsPlain = plain as NSString
        let matches = regex.matches(in: plain, range: NSRange(location: 0, length: nsPlain.length))
        guard !matches.isEmpty else { return }

        let trailingTrimChars = CharacterSet(charactersIn: ".,;:!?)")
        for match in matches {
            var rawSlice = nsPlain.substring(with: match.range)
            var trimCount = 0
            while let last = rawSlice.unicodeScalars.last, trailingTrimChars.contains(last) {
                // Keep balanced ')' if URL contains '(' (e.g. Wikipedia links)
                if last == ")" && rawSlice.filter({ $0 == "(" }).count >= rawSlice.filter({ $0 == ")" }).count {
                    break
                }
                rawSlice.removeLast()
                trimCount += 1
            }
            guard !rawSlice.isEmpty, let url = URL(string: rawSlice) else { continue }
            let adjustedNSRange = NSRange(location: match.range.location, length: match.range.length - trimCount)
            guard let swiftRange = Range(adjustedNSRange, in: plain),
                  let attrStart = AttributedString.Index(swiftRange.lowerBound, within: attr),
                  let attrEnd = AttributedString.Index(swiftRange.upperBound, within: attr),
                  attrStart < attrEnd else {
                continue
            }
            let attrRange = attrStart..<attrEnd
            // Never overwrite an existing markdown link. Inside inline code, linkify only when the
            // URL is the whole code span (`https://host/`): agents often write a link that way and
            // code styling looks tappable. A URL inside a longer code span is part of a command and
            // stays plain.
            var skip = false
            for run in attr[attrRange].runs {
                if run.link != nil {
                    skip = true
                    break
                }
                if run.inlinePresentationIntent?.contains(.code) == true {
                    // `run` is clipped to the URL; look up the full code span it belongs to.
                    let fullSpan = attr.runs.first { $0.range.lowerBound <= attrStart && attrStart < $0.range.upperBound }
                    let spanText = fullSpan.map { String(attr[$0.range].characters) } ?? ""
                    if spanText.trimmingCharacters(in: .whitespaces) != rawSlice {
                        skip = true
                        break
                    }
                }
            }
            if !skip {
                attr[attrRange].link = url
            }
        }
    }
}

// MARK: - SwiftUI GFM Markdown Renderer

public struct SHMarkdownView: View, Equatable {
    public let text: String
    public let isUserBubble: Bool

    nonisolated public static func == (lhs: SHMarkdownView, rhs: SHMarkdownView) -> Bool {
        lhs.text == rhs.text && lhs.isUserBubble == rhs.isUserBubble
    }

    public init(text: String, isUserBubble: Bool = false) {
        self.text = text
        self.isUserBubble = isUserBubble
    }

    public var body: some View {
        let blocks = SHMarkdownCache.blocks(for: text)
        SHMarkdownBlockListView(blocks: blocks, isUserBubble: isUserBubble)
    }
}

private struct SHMarkdownBlockListView: View {
    let blocks: [SHMarkdownBlock]
    let isUserBubble: Bool
    @Environment(\.shChatMetrics) private var metrics

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.blockGap) {
            ForEach(blocks) { block in
                renderBlock(block)
            }
        }
    }

    @ViewBuilder
    private func renderBlock(_ block: SHMarkdownBlock) -> some View {
        switch block {
        case .heading(_, let level, let content):
            inlineText(
                content,
                fontSize: headingPointSize(level) * metrics.scale,
                fontWeight: headingUIWeight(level),
                color: SHColor.inkPrimary,
                lineSpacing: 2
            )
            .padding(.top, level <= 2 ? 6 : 3)
            .fixedSize(horizontal: false, vertical: true)

        case .paragraph(_, let content):
            inlineText(
                content,
                fontSize: 15 * metrics.scale,
                fontWeight: .regular,
                color: isUserBubble ? SHColor.inkPrimary : SHColor.inkSecondary,
                lineSpacing: metrics.lineSpacing
            )
            .fixedSize(horizontal: false, vertical: true)

        case .codeBlock(_, let language, let code):
            SHCodeFenceCard(language: language, code: code)

        case .blockquote(_, let nested):
            SHMarkdownBlockListView(blocks: nested, isUserBubble: false)
                .opacity(0.88)
                .padding(.leading, 11)
                .padding(.vertical, 2)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(SHColor.lineStrong)
                        .frame(width: 2.5)
                }

        case .unorderedList(_, let items):
            VStack(alignment: .leading, spacing: metrics.listItemGap) {
                ForEach(items) { item in
                    HStack(alignment: .top, spacing: 7) {
                        if let checked = item.taskChecked {
                            Image(systemName: checked ? "checkmark.square.fill" : "square")
                                .font(metrics.font(13.5, weight: .medium))
                                .foregroundStyle(checked ? SHColor.statusSuccess : SHColor.inkMuted)
                                .padding(.top, 2)
                        } else {
                            Text(item.indentLevel % 2 == 0 ? "•" : "◦")
                                .font(metrics.font(15, weight: .semibold))
                                .foregroundStyle(SHColor.inkMuted)
                                .frame(width: 10, alignment: .center)
                        }
                        inlineText(
                            item.text,
                            fontSize: 15 * metrics.scale,
                            fontWeight: .regular,
                            color: isUserBubble ? SHColor.inkPrimary : SHColor.inkSecondary,
                            lineSpacing: metrics.lineSpacing
                        )
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(item.indentLevel) * 16)
                }
            }

        case .orderedList(_, let items):
            VStack(alignment: .leading, spacing: metrics.listItemGap) {
                ForEach(items) { item in
                    HStack(alignment: .top, spacing: 6) {
                        Text("\(item.ordinal ?? 1).")
                            .font(metrics.font(14, weight: .medium, design: .monospaced))
                            .foregroundStyle(SHColor.inkMuted)
                            .frame(minWidth: 20 * metrics.scale, alignment: .trailing)
                        inlineText(
                            item.text,
                            fontSize: 15 * metrics.scale,
                            fontWeight: .regular,
                            color: isUserBubble ? SHColor.inkPrimary : SHColor.inkSecondary,
                            lineSpacing: metrics.lineSpacing
                        )
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(item.indentLevel) * 16)
                }
            }

        case .table(_, let headers, let alignments, let rows):
            SHMarkdownTableView(headers: headers, alignments: alignments, rows: rows)

        case .thematicBreak:
            Rectangle()
                .fill(SHColor.lineSubtle)
                .frame(height: 1)
                .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func inlineText(
        _ raw: String,
        fontSize: CGFloat,
        fontWeight: SHPlatformFontWeight,
        color: Color,
        lineSpacing: CGFloat
    ) -> some View {
        #if canImport(UIKit)
        SHSelectableMarkdownText(
            raw: raw,
            isUserBubble: isUserBubble,
            fontSize: fontSize,
            fontWeight: fontWeight,
            baseColor: color,
            lineSpacing: lineSpacing,
            scale: metrics.scale
        )
        #else
        let attr = SHMarkdownCache.inlineAttributedString(for: raw, isUserBubble: isUserBubble, scale: metrics.scale)
        Text(attr)
            .font(.system(size: fontSize))
            .foregroundStyle(color)
            .lineSpacing(lineSpacing)
            .textSelection(.enabled)
        #endif
    }

    private func headingPointSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return 18
        case 2: return 16.5
        case 3: return 15
        case 4: return 14.5
        default: return 14
        }
    }

    private func headingUIWeight(_ level: Int) -> SHPlatformFontWeight {
        switch level {
        case 1: return .bold
        case 2, 3, 4: return .semibold
        default: return .medium
        }
    }
}

#if canImport(UIKit)
private typealias SHPlatformFontWeight = UIFont.Weight

/// Read-only non-scrolling UITextView that provides native iOS draggable text selection handles
/// and native long-press link menus ("Open in Browser" / "Copy Link") inside SwiftUI transcripts.
private struct SHSelectableMarkdownText: UIViewRepresentable {
    let raw: String
    let isUserBubble: Bool
    let fontSize: CGFloat
    let fontWeight: UIFont.Weight
    let baseColor: Color
    let lineSpacing: CGFloat
    let scale: CGFloat

    @Environment(\.lineLimit) private var lineLimit
    @Environment(\.openURL) private var openURL

    private var renderKey: String {
        "\(isUserBubble ? 1 : 0)|\(Int((fontSize * 10).rounded()))|\(fontWeight.rawValue)|\(Int((lineSpacing * 10).rounded()))|\(Int((scale * 100).rounded()))|\(lineLimit ?? 0)|\(raw)"
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(openURL: openURL)
    }

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.delegate = context.coordinator
        tv.isEditable = false
        tv.isSelectable = true
        tv.isScrollEnabled = false
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.textContainer.lineBreakMode = .byTruncatingTail
        tv.adjustsFontForContentSizeCategory = false
        tv.tintColor = UIColor(SHColor.accentInfo)
        tv.linkTextAttributes = [
            .foregroundColor: UIColor(SHColor.brandAntigravity),
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
        tv.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tv.setContentHuggingPriority(.required, for: .vertical)
        applyContent(to: tv, coordinator: context.coordinator)
        return tv
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        context.coordinator.openURL = openURL
        applyContent(to: uiView, coordinator: context.coordinator)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let maxW = proposal.width ?? uiView.bounds.width
        guard maxW > 1 else { return nil }
        let fitting = uiView.sizeThatFits(CGSize(width: maxW, height: .greatestFiniteMagnitude))
        let w = isUserBubble ? min(maxW, ceil(fitting.width)) : maxW
        return CGSize(width: max(1, w), height: max(1, ceil(fitting.height)))
    }

    private func applyContent(to tv: UITextView, coordinator: Coordinator) {
        let key = renderKey
        guard coordinator.lastRenderKey != key else { return }
        coordinator.lastRenderKey = key
        tv.textContainer.maximumNumberOfLines = lineLimit ?? 0
        tv.attributedText = buildNSAttributedString()
        tv.invalidateIntrinsicContentSize()
    }

    private func buildNSAttributedString() -> NSAttributedString {
        let attr = SHMarkdownCache.inlineAttributedString(for: raw, isUserBubble: isUserBubble, scale: scale)
        let baseFont = UIFont.systemFont(ofSize: fontSize, weight: fontWeight)
        let baseUIColor = UIColor(baseColor)
        let codeFont = UIFont.monospacedSystemFont(ofSize: 13.5 * scale, weight: .regular)
        let codeColor = UIColor(Color(hex: 0x93C5FD))
        let codeBg = UIColor(SHColor.surfaceBubble.opacity(0.92))
        let primaryColor = UIColor(SHColor.inkPrimary)
        let mutedColor = UIColor(SHColor.inkMuted)
        let linkColor = UIColor(SHColor.brandAntigravity)

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        paragraph.lineBreakMode = .byWordWrapping

        let out = NSMutableAttributedString()
        for run in attr.runs {
            let chunk = String(attr[run.range].characters)
            var attrs: [NSAttributedString.Key: Any] = [
                .font: baseFont,
                .foregroundColor: baseUIColor,
                .paragraphStyle: paragraph,
            ]
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.code) {
                    attrs[.font] = codeFont
                    attrs[.foregroundColor] = codeColor
                    attrs[.backgroundColor] = codeBg
                } else {
                    var traits: UIFontDescriptor.SymbolicTraits = []
                    if intent.contains(.stronglyEmphasized) {
                        traits.insert(.traitBold)
                        attrs[.foregroundColor] = primaryColor
                    }
                    if intent.contains(.emphasized) {
                        traits.insert(.traitItalic)
                    }
                    if !traits.isEmpty, let desc = baseFont.fontDescriptor.withSymbolicTraits(traits) {
                        attrs[.font] = UIFont(descriptor: desc, size: fontSize)
                    }
                    if intent.contains(.strikethrough) {
                        attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                        attrs[.foregroundColor] = mutedColor
                    }
                }
            }
            if let url = run.link {
                attrs[.link] = url
                attrs[.foregroundColor] = linkColor
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            out.append(NSAttributedString(string: chunk, attributes: attrs))
        }
        return out
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var openURL: OpenURLAction
        var lastRenderKey: String = ""

        init(openURL: OpenURLAction) {
            self.openURL = openURL
        }

        func textView(
            _ textView: UITextView,
            primaryActionFor textItem: UITextItem,
            defaultAction: UIAction
        ) -> UIAction? {
            if case .link(let url) = textItem.content {
                return UIAction { [weak self] _ in
                    self?.openURL(url)
                }
            }
            return defaultAction
        }

        func textView(
            _ textView: UITextView,
            menuConfigurationFor textItem: UITextItem,
            defaultMenu: UIMenu
        ) -> UITextItem.MenuConfiguration? {
            guard case .link(let url) = textItem.content else {
                return nil
            }
            let isSessionLink = url.scheme?.lowercased() == "session"
            let openAction = UIAction(
                title: isSessionLink ? "Open Session" : "Open in Browser",
                image: UIImage(systemName: isSessionLink ? "arrow.right.circle" : "safari")
            ) { [weak self] _ in
                self?.openURL(url)
            }
            let copyAction = UIAction(
                title: "Copy Link",
                image: UIImage(systemName: "doc.on.doc")
            ) { _ in
                UIPasteboard.general.string = url.absoluteString
            }
            let menu = UIMenu(title: url.absoluteString, children: [openAction, copyAction])
            return UITextItem.MenuConfiguration(menu: menu)
        }
    }
}
#else
private typealias SHPlatformFontWeight = Font.Weight
#endif

private struct SHMarkdownTableView: View {
    let headers: [String]
    let alignments: [SHMarkdownAlignment]
    let rows: [[String]]
    @Environment(\.shChatMetrics) private var metrics

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                // Header row
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { colIdx, header in
                        let align = colIdx < alignments.count ? alignments[colIdx] : .leading
                        Text(SHMarkdownCache.inlineAttributedString(for: header, isUserBubble: false, scale: metrics.scale))
                            .font(metrics.font(12.5, weight: .semibold))
                            .foregroundStyle(SHColor.inkPrimary)
                            .multilineTextAlignment(align.textAlignment)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .frame(minWidth: 72, maxWidth: 240, alignment: align.swiftUIAlignment)
                    }
                }
                .background(SHColor.surfaceRaised)

                Divider().overlay(SHColor.lineSubtle)

                ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { colIdx, cell in
                            let align = colIdx < alignments.count ? alignments[colIdx] : .leading
                            Text(SHMarkdownCache.inlineAttributedString(for: cell, isUserBubble: false, scale: metrics.scale))
                                .font(metrics.font(13))
                                .foregroundStyle(SHColor.inkSecondary)
                                .multilineTextAlignment(align.textAlignment)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .frame(minWidth: 72, maxWidth: 240, alignment: align.swiftUIAlignment)
                        }
                    }
                    .background(rowIdx % 2 == 1 ? SHColor.surfaceSubtle.opacity(0.6) : Color.clear)

                    if rowIdx < rows.count - 1 {
                        Divider().overlay(SHColor.lineHairline)
                    }
                }
            }
            .background(SHColor.surfaceCode)
            .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous)
                    .strokeBorder(SHColor.lineSubtle, lineWidth: 0.75)
            )
        }
    }
}

public struct SHCodeFenceCard: View {
    public let language: String
    public let code: String
    @State private var copied = false
    @Environment(\.shChatMetrics) private var metrics

    public init(language: String, code: String) {
        self.language = language
        self.code = code
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(SHTypography.monoSmall)
                    .foregroundStyle(SHColor.inkFaint)
                Spacer()
                Button {
                    #if canImport(UIKit)
                    UIPasteboard.general.string = code
                    #endif
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_400_000_000)
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(copied ? SHColor.statusSuccess : SHColor.inkMuted)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(SHColor.surfaceRail)

            Divider().overlay(SHColor.lineHairline)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(metrics.mono)
                    .foregroundStyle(SHColor.inkPrimary)
                    .textSelection(.enabled)
                    .padding(12)
            }
        }
        .background(SHColor.surfaceCode)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous)
                .strokeBorder(SHColor.lineHairline, lineWidth: 0.75)
        )
    }
}
