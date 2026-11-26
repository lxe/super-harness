import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Block Coalescing

public enum CoalescedSegment: Sendable, Equatable {
    case single(UnifiedBlock)
    case traceGroup([UnifiedBlock])

    public static func coalesce(_ blocks: [UnifiedBlock]) -> [CoalescedSegment] {
        var result: [CoalescedSegment] = []
        var buffer: [UnifiedBlock] = []

        func flush() {
            if buffer.count >= 2 {
                result.append(.traceGroup(buffer))
            } else if let only = buffer.first {
                result.append(.single(only))
            }
            buffer.removeAll(keepingCapacity: true)
        }

        for block in blocks {
            if block.isTraceBlock {
                buffer.append(block)
            } else {
                flush()
                result.append(.single(block))
            }
        }
        flush()
        return result
    }
}

// MARK: - Collapsed Trace Group

public struct CollapsedTraceGroupView: View, Equatable {
    public let blocks: [UnifiedBlock]
    public let onAnswerQuestion: (String) -> Void
    public let onTapImage: (LightboxPayload) -> Void
    public let onLoadMedia: ((String) async -> Data?)?
    @State private var isExpanded: Bool = false

    nonisolated public static func == (lhs: CollapsedTraceGroupView, rhs: CollapsedTraceGroupView) -> Bool {
        lhs.blocks == rhs.blocks
    }

    public init(
        blocks: [UnifiedBlock],
        onAnswerQuestion: @escaping (String) -> Void,
        onTapImage: @escaping (LightboxPayload) -> Void,
        onLoadMedia: ((String) async -> Data?)? = nil
    ) {
        self.blocks = blocks
        self.onAnswerQuestion = onAnswerQuestion
        self.onTapImage = onTapImage
        self.onLoadMedia = onLoadMedia
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: SHSpacing.sm) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(SHColor.inkFaint)
                    Image(systemName: "bolt.horizontal.circle")
                        .font(.system(size: 13))
                        .foregroundStyle(SHColor.inkMuted)
                    Text(summaryText)
                        .font(SHTypography.caption)
                        .foregroundStyle(SHColor.inkMuted)
                        .lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 10)
                .background(SHColor.surfaceSubtle)
                .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: SHSpacing.sm) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                        UnifiedBlockView(
                            block: block,
                            isUserBubble: false,
                            onAnswerQuestion: onAnswerQuestion,
                            onTapImage: onTapImage,
                            onLoadMedia: onLoadMedia
                        )
                    }
                }
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(SHColor.lineSubtle)
                        .frame(width: 2)
                        .padding(.vertical, 2)
                }
            }
        }
    }

    private var summaryText: String {
        var counts: [String] = []
        let thinkCount = blocks.filter { if case .thinking = $0 { return true }; return false }.count
        let cmdCount = blocks.filter { if case .command = $0 { return true }; return false }.count
        let toolCount = blocks.filter { if case .toolCall = $0 { return true }; return false }.count
        let searchCount = blocks.filter { if case .webSearch = $0 { return true }; return false }.count
        if thinkCount > 0 { counts.append(thinkCount == 1 ? "Thought" : "\(thinkCount) thoughts") }
        if cmdCount > 0 { counts.append(cmdCount == 1 ? "1 command" : "\(cmdCount) commands") }
        if toolCount > 0 { counts.append(toolCount == 1 ? "1 tool" : "\(toolCount) tools") }
        if searchCount > 0 { counts.append(searchCount == 1 ? "1 search" : "\(searchCount) searches") }
        return counts.isEmpty ? "\(blocks.count) trace steps" : counts.joined(separator: " · ")
    }
}

// MARK: - Unified Block Switcher (All 10 Block Variants)

public struct UnifiedBlockView: View, Equatable {
    public let block: UnifiedBlock
    public let isUserBubble: Bool
    public let onAnswerQuestion: (String) -> Void
    public let onTapImage: (LightboxPayload) -> Void
    public let onLoadMedia: ((String) async -> Data?)?

    nonisolated public static func == (lhs: UnifiedBlockView, rhs: UnifiedBlockView) -> Bool {
        lhs.block == rhs.block && lhs.isUserBubble == rhs.isUserBubble
    }

    public init(
        block: UnifiedBlock,
        isUserBubble: Bool,
        onAnswerQuestion: @escaping (String) -> Void,
        onTapImage: @escaping (LightboxPayload) -> Void,
        onLoadMedia: ((String) async -> Data?)? = nil
    ) {
        self.block = block
        self.isUserBubble = isUserBubble
        self.onAnswerQuestion = onAnswerQuestion
        self.onTapImage = onTapImage
        self.onLoadMedia = onLoadMedia
    }

    public var body: some View {
        switch block {
        case .text(let text):
            MarkdownTextBlockView(text: text, isUserBubble: isUserBubble)
                .equatable()
        case .image(let path, let name, let dataUrl):
            ImageBlockView(path: path, name: name, dataUrl: dataUrl, onTapImage: onTapImage, onLoadMedia: onLoadMedia)
        case .video(let path, let name, let mimeType):
            VideoBlockView(path: path, name: name, mimeType: mimeType)
                .equatable()
        case .thinking(let text, let summary):
            ThinkingBlockView(text: text, summary: summary)
                .equatable()
        case .command(let command, let cwd, let output, let exitCode, let durationMs, let status):
            CommandBlockView(command: command, cwd: cwd, output: output, exitCode: exitCode, durationMs: durationMs, status: status)
                .equatable()
        case .fileChange(let changes, let status):
            FileChangeBlockView(changes: changes, status: status)
                .equatable()
        case .toolCall(let name, let server, let args, let output, let status, let durationMs):
            ToolCallBlockView(name: name, server: server, args: args, output: output, status: status, durationMs: durationMs)
                .equatable()
        case .webSearch(let query, let url):
            WebSearchBlockView(query: query, url: url)
                .equatable()
        case .question(let questions, let answered):
            QuestionBlockView(questions: questions, answered: answered ?? false, onSelectOption: onAnswerQuestion)
        case .notice(let title, let detail):
            NoticeBlockView(title: title, detail: detail)
                .equatable()
        }
    }
}

// MARK: - 1. Markdown Text + Copyable Fenced Code Blocks

private final class AttributedStringBox: NSObject {
    let value: AttributedString
    init(_ value: AttributedString) {
        self.value = value
    }
}

private final class TextChunkListBox: NSObject {
    let value: [TextChunk]
    init(_ value: [TextChunk]) {
        self.value = value
    }
}

@MainActor
private enum MarkdownRenderCache {
    private static let attributedCache: NSCache<NSString, AttributedStringBox> = {
        let cache = NSCache<NSString, AttributedStringBox>()
        cache.countLimit = 500
        return cache
    }()

    private static let chunkCache: NSCache<NSString, TextChunkListBox> = {
        let cache = NSCache<NSString, TextChunkListBox>()
        cache.countLimit = 500
        return cache
    }()

    static func attributedString(for raw: String) -> AttributedString? {
        let key = raw as NSString
        if let hit = attributedCache.object(forKey: key) {
            return hit.value
        }
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard let parsed = try? AttributedString(markdown: raw, options: opts) else {
            return nil
        }
        attributedCache.setObject(AttributedStringBox(parsed), forKey: key)
        return parsed
    }

    static func chunks(for source: String) -> [TextChunk] {
        let key = source as NSString
        if let hit = chunkCache.object(forKey: key) {
            return hit.value
        }
        let parsed = TextChunk.parse(source)
        chunkCache.setObject(TextChunkListBox(parsed), forKey: key)
        return parsed
    }
}

private enum TextChunk: Identifiable, Equatable {
    case prose(id: Int, String)
    case code(id: Int, language: String, content: String)

    var id: Int {
        switch self {
        case .prose(let id, _), .code(let id, _, _): return id
        }
    }

    static func parse(_ source: String) -> [TextChunk] {
        var chunks: [TextChunk] = []
        let lines = source.components(separatedBy: "\n")
        var inCode = false
        var currentLang = ""
        var buffer: [String] = []
        var nextId = 0

        for line in lines {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if inCode {
                    chunks.append(.code(id: nextId, language: currentLang, content: buffer.joined(separator: "\n")))
                    nextId += 1
                    buffer.removeAll()
                    currentLang = ""
                    inCode = false
                } else {
                    let prose = buffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !prose.isEmpty {
                        chunks.append(.prose(id: nextId, prose))
                        nextId += 1
                    }
                    buffer.removeAll()
                    currentLang = line.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "```", with: "")
                    inCode = true
                }
            } else {
                buffer.append(line)
            }
        }

        let remaining = buffer.joined(separator: "\n")
        if inCode {
            chunks.append(.code(id: nextId, language: currentLang, content: remaining))
        } else if !remaining.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            chunks.append(.prose(id: nextId, remaining.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        return chunks
    }
}

private struct MarkdownTextBlockView: View, Equatable {
    let text: String
    let isUserBubble: Bool

    nonisolated static func == (lhs: MarkdownTextBlockView, rhs: MarkdownTextBlockView) -> Bool {
        lhs.text == rhs.text && lhs.isUserBubble == rhs.isUserBubble
    }

    var body: some View {
        let chunks = MarkdownRenderCache.chunks(for: text)
        VStack(alignment: .leading, spacing: SHSpacing.sm) {
            ForEach(chunks) { chunk in
                switch chunk {
                case .prose(_, let content):
                    proseText(content)
                        .font(SHTypography.body)
                        .foregroundStyle(isUserBubble ? SHColor.inkPrimary : SHColor.inkSecondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                case .code(_, let lang, let code):
                    CopyableCodeCard(language: lang, code: code)
                }
            }
        }
    }

    private func proseText(_ raw: String) -> Text {
        if let attr = MarkdownRenderCache.attributedString(for: raw) {
            return Text(attr)
        }
        return Text(raw)
    }
}

private struct CopyableCodeCard: View {
    let language: String
    let code: String
    @State private var copied = false

    var body: some View {
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
                    .font(SHTypography.mono)
                    .foregroundStyle(SHColor.inkPrimary)
                    .textSelection(.enabled)
                    .padding(13)
            }
        }
        .background(SHColor.surfaceCode)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }
}

// MARK: - 2. Image Block + Zoomable Lightbox

public enum DataURLImageDecoder {
    #if canImport(UIKit)
    public static func decode(_ dataUrl: String?) -> UIImage? {
        guard let dataUrl, let commaIndex = dataUrl.firstIndex(of: ",") else { return nil }
        let base64 = String(dataUrl[dataUrl.index(after: commaIndex)...])
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }
    #endif
}

private struct ImageBlockView: View {
    let path: String
    let name: String?
    let dataUrl: String?
    let onTapImage: (LightboxPayload) -> Void
    let onLoadMedia: ((String) async -> Data?)?

    #if canImport(UIKit)
    @State private var remoteImage: UIImage?
    #endif
    @State private var isLoadingRemote = false

    var body: some View {
        let title = name ?? ((path as NSString).lastPathComponent.isEmpty ? "Image" : (path as NSString).lastPathComponent)
        Button {
            onTapImage(LightboxPayload(title: title, dataUrl: dataUrl, path: path))
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                #if canImport(UIKit)
                if let uiImage = DataURLImageDecoder.decode(dataUrl) ?? remoteImage {
                    Image(uiImage: uiImage)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 260, maxHeight: 190)
                        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
                } else if isLoadingRemote {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(title)
                            .font(SHTypography.caption)
                            .foregroundStyle(SHColor.inkMuted)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 16)
                } else {
                    imagePlaceholder(title: title)
                }
                #else
                imagePlaceholder(title: title)
                #endif

                HStack(spacing: 4) {
                    Image(systemName: "photo")
                        .font(.system(size: 10))
                    Text(title)
                        .font(SHTypography.micro)
                        .lineLimit(1)
                }
                .foregroundStyle(SHColor.inkMuted)
            }
            .padding(10)
            .background(SHColor.surfaceCode)
            .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
        }
        .buttonStyle(.plain)
        .task(id: path) {
            #if canImport(UIKit)
            guard DataURLImageDecoder.decode(dataUrl) == nil,
                  remoteImage == nil,
                  !path.isEmpty,
                  let loader = onLoadMedia else {
                return
            }
            isLoadingRemote = true
            defer { isLoadingRemote = false }
            if let data = await loader(path), let img = UIImage(data: data) {
                remoteImage = img
            }
            #endif
        }
    }

    private func imagePlaceholder(title: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "photo.fill")
                .foregroundStyle(SHColor.inkMuted)
            Text(title)
                .font(SHTypography.caption)
                .foregroundStyle(SHColor.inkSecondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 16)
    }
}

public struct ImageLightboxView: View {
    public let payload: LightboxPayload
    public let onLoadMedia: ((String) async -> Data?)?
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1.0
    @State private var lastScale: CGFloat = 1.0
    #if canImport(UIKit)
    @State private var remoteImage: UIImage?
    #endif
    @State private var isLoadingRemote = false

    public init(payload: LightboxPayload, onLoadMedia: ((String) async -> Data?)? = nil) {
        self.payload = payload
        self.onLoadMedia = onLoadMedia
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                #if canImport(UIKit)
                if let uiImage = DataURLImageDecoder.decode(payload.dataUrl) ?? remoteImage {
                    Image(uiImage: uiImage)
                        .resizable()
                        .scaledToFit()
                        .scaleEffect(scale)
                        .gesture(
                            MagnificationGesture()
                                .onChanged { value in
                                    scale = min(max(lastScale * value, 1.0), 4.0)
                                }
                                .onEnded { _ in
                                    lastScale = scale
                                }
                        )
                        .onTapGesture(count: 2) {
                            withAnimation(.spring(duration: 0.25)) {
                                scale = scale > 1.1 ? 1.0 : 2.2
                                lastScale = scale
                            }
                        }
                } else if isLoadingRemote {
                    ProgressView()
                        .tint(SHColor.inkPrimary)
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "photo")
                            .font(.system(size: 36))
                            .foregroundStyle(SHColor.inkMuted)
                        Text(payload.path ?? payload.title)
                            .font(SHTypography.monoSmall)
                            .foregroundStyle(SHColor.inkMuted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                }
                #endif
            }
            .navigationTitle(payload.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(SHColor.inkPrimary)
                }
            }
            .task(id: payload.path) {
                #if canImport(UIKit)
                guard DataURLImageDecoder.decode(payload.dataUrl) == nil,
                      remoteImage == nil,
                      let path = payload.path, !path.isEmpty,
                      let loader = onLoadMedia else {
                    return
                }
                isLoadingRemote = true
                defer { isLoadingRemote = false }
                if let data = await loader(path), let img = UIImage(data: data) {
                    remoteImage = img
                }
                #endif
            }
        }
    }
}

// MARK: - 2b. Video Media Card Block

private struct VideoBlockView: View, Equatable {
    let path: String
    let name: String?
    let mimeType: String?
    @State private var copied = false

    nonisolated static func == (lhs: VideoBlockView, rhs: VideoBlockView) -> Bool {
        lhs.path == rhs.path && lhs.name == rhs.name && lhs.mimeType == rhs.mimeType
    }

    private var displayName: String {
        if let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return name
        }
        let last = (path as NSString).lastPathComponent
        return last.isEmpty ? "Recording" : last
    }

    private var formatTag: String? {
        if let mimeType, !mimeType.isEmpty {
            return mimeType.components(separatedBy: "/").last?.uppercased() ?? mimeType.uppercased()
        }
        let ext = (path as NSString).pathExtension
        return ext.isEmpty ? nil : ext.uppercased()
    }

    var body: some View {
        HStack(spacing: SHSpacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: SHRadius.sm + 2, style: .continuous)
                    .fill(SHColor.brandAntigravity.opacity(0.16))
                    .frame(width: 40, height: 40)
                Image(systemName: "play.rectangle.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(SHColor.brandAntigravity)
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(displayName)
                        .font(SHTypography.label.weight(.semibold))
                        .foregroundStyle(SHColor.inkPrimary)
                        .lineLimit(1)
                    if let formatTag {
                        Text(formatTag)
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundStyle(SHColor.brandAntigravity)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1.5)
                            .background(SHColor.brandAntigravity.opacity(0.14))
                            .clipShape(Capsule())
                    }
                }
                if !path.isEmpty {
                    Text(path)
                        .font(SHTypography.monoSmall)
                        .foregroundStyle(SHColor.inkMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Spacer(minLength: 4)

            if !path.isEmpty {
                Button {
                    #if canImport(UIKit)
                    UIPasteboard.general.string = path
                    #endif
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_400_000_000)
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(copied ? SHColor.statusSuccess : SHColor.inkMuted)
                        .frame(width: 28, height: 28)
                        .background(SHColor.surfaceRaised)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy video path")
            }
        }
        .padding(13)
        .background(SHColor.surfaceCode)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }
}

// MARK: - 3. Thinking Block

private struct ThinkingBlockView: View, Equatable {
    let text: String
    let summary: String?
    @State private var isExpanded = false

    nonisolated static func == (lhs: ThinkingBlockView, rhs: ThinkingBlockView) -> Bool {
        lhs.text == rhs.text && lhs.summary == rhs.summary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.16)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "brain.head.profile")
                        .font(.system(size: 12))
                        .foregroundStyle(SHColor.brandMaster)
                    Text(summary ?? "Thinking")
                        .font(SHTypography.caption.weight(.medium))
                        .foregroundStyle(SHColor.inkSecondary)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(SHColor.inkFaint)
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Divider().overlay(SHColor.lineHairline)
                Text(text)
                    .font(SHTypography.caption.italic())
                    .foregroundStyle(SHColor.inkMuted)
                    .textSelection(.enabled)
                    .padding(13)
            }
        }
        .background(SHColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }
}

// MARK: - 4. Command Terminal Block

private struct CommandBlockView: View, Equatable {
    let command: String
    let cwd: String?
    let output: String?
    let exitCode: Int?
    let durationMs: Double?
    let status: String?
    @State private var isExpanded = false

    nonisolated static func == (lhs: CommandBlockView, rhs: CommandBlockView) -> Bool {
        lhs.command == rhs.command
            && lhs.cwd == rhs.cwd
            && lhs.output == rhs.output
            && lhs.exitCode == rhs.exitCode
            && lhs.durationMs == rhs.durationMs
            && lhs.status == rhs.status
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.16)) { isExpanded.toggle() }
            } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Image(systemName: "terminal.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(SHColor.inkMuted)
                        Text("$ \(command)")
                            .font(SHTypography.mono)
                            .foregroundStyle(SHColor.inkPrimary)
                            .lineLimit(isExpanded ? nil : 1)
                        Spacer(minLength: 4)
                        exitBadge
                    }

                    HStack(spacing: 8) {
                        if let cwd, !cwd.isEmpty {
                            Text((cwd as NSString).lastPathComponent)
                                .font(SHTypography.monoSmall)
                                .foregroundStyle(SHColor.inkFaint)
                                .lineLimit(1)
                        }
                        if let durationMs {
                            Text(durationMs >= 1000 ? String(format: "%.1fs", durationMs / 1000.0) : "\(Int(durationMs))ms")
                                .font(SHTypography.monoSmall)
                                .foregroundStyle(SHColor.inkFaint)
                        }
                        Spacer()
                        if let output, !output.isEmpty {
                            Text(isExpanded ? "Hide output" : "Output")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(SHColor.inkMuted)
                        }
                    }
                }
                .padding(13)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded, let output, !output.isEmpty {
                Divider().overlay(SHColor.lineHairline)
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(output)
                        .font(SHTypography.monoSmall)
                        .foregroundStyle(SHColor.inkSecondary)
                        .textSelection(.enabled)
                        .padding(13)
                }
            }
        }
        .background(SHColor.surfaceCode)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }

    @ViewBuilder
    private var exitBadge: some View {
        if let code = exitCode {
            let ok = code == 0
            Text("exit \(code)")
                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(ok ? SHColor.statusSuccess : SHColor.statusDanger)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background((ok ? SHColor.statusSuccess : SHColor.statusDanger).opacity(0.14))
                .clipShape(Capsule())
        } else if let status, !status.isEmpty {
            Text(status)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(SHColor.inkMuted)
        }
    }
}

// MARK: - 5. File Change & Colorized Unified Diff Block

private struct FileChangeBlockView: View, Equatable {
    let changes: [FileChangeEntry]
    let status: String?
    @State private var expandedPaths: Set<String> = []

    nonisolated static func == (lhs: FileChangeBlockView, rhs: FileChangeBlockView) -> Bool {
        lhs.changes == rhs.changes && lhs.status == rhs.status
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "doc.badge.gearshape")
                    .font(.system(size: 12))
                    .foregroundStyle(SHColor.brandCodex)
                Text(changes.count == 1 ? "1 file changed" : "\(changes.count) files changed")
                    .font(SHTypography.caption.weight(.semibold))
                    .foregroundStyle(SHColor.inkPrimary)
                Spacer()
                if let status, !status.isEmpty {
                    Text(status)
                        .font(SHTypography.micro)
                        .foregroundStyle(SHColor.inkFaint)
                }
            }
            .padding(.horizontal, 11)
            .padding(.top, 9)

            ForEach(Array(changes.enumerated()), id: \.offset) { _, change in
                let isOpen = expandedPaths.contains(change.path) || changes.count == 1
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) {
                            if expandedPaths.contains(change.path) {
                                expandedPaths.remove(change.path)
                            } else {
                                expandedPaths.insert(change.path)
                            }
                        }
                    } label: {
                        HStack(spacing: 7) {
                            kindPill(change.kind)
                            Text(change.path)
                                .font(SHTypography.monoSmall)
                                .foregroundStyle(SHColor.inkSecondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer()
                            if change.diff != nil {
                                Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                                    .font(.system(size: 10))
                                    .foregroundStyle(SHColor.inkFaint)
                            }
                        }
                        .padding(.horizontal, 11)
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if isOpen, let diff = change.diff, !diff.isEmpty {
                        ColorizedDiffView(diff: diff)
                    }
                }
                .background(SHColor.surfaceCode)
                .clipShape(RoundedRectangle(cornerRadius: SHRadius.sm, style: .continuous))
                .padding(.horizontal, 10)
            }
        }
        .padding(.bottom, 10)
        .background(SHColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }

    private func kindPill(_ kind: String) -> some View {
        let lower = kind.lowercased()
        let color: Color = lower.contains("add") || lower.contains("create")
            ? SHColor.statusSuccess
            : (lower.contains("del") || lower.contains("rem") ? SHColor.statusDanger : SHColor.statusWarning)
        let short = lower.prefix(1).uppercased()
        return Text(short)
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(color)
            .frame(width: 18, height: 18)
            .background(color.opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

private struct ColorizedDiffView: View {
    let diff: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : line)
                        .font(SHTypography.monoSmall)
                        .foregroundStyle(lineColor(line))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 1.5)
                        .background(lineBackground(line))
                }
            }
            .padding(.vertical, 4)
        }
        .background(SHColor.surfaceCode)
    }

    private func lineColor(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return SHColor.statusSuccess }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return SHColor.statusDanger }
        if line.hasPrefix("@@") { return SHColor.brandAntigravity }
        return SHColor.inkMuted
    }

    private func lineBackground(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return SHColor.statusSuccess.opacity(0.10) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return SHColor.statusDanger.opacity(0.10) }
        if line.hasPrefix("@@") { return SHColor.brandAntigravity.opacity(0.08) }
        return Color.clear
    }
}

// MARK: - 6. Tool Call (MCP / Function) Block

private struct ToolCallBlockView: View, Equatable {
    let name: String
    let server: String?
    let args: String?
    let output: String?
    let status: String?
    let durationMs: Double?
    @State private var isExpanded = false

    nonisolated static func == (lhs: ToolCallBlockView, rhs: ToolCallBlockView) -> Bool {
        lhs.name == rhs.name
            && lhs.server == rhs.server
            && lhs.args == rhs.args
            && lhs.output == rhs.output
            && lhs.status == rhs.status
            && lhs.durationMs == rhs.durationMs
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.16)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "wrench.and.screwdriver")
                        .font(.system(size: 11))
                        .foregroundStyle(SHColor.brandAntigravity)
                    Text(name)
                        .font(SHTypography.mono)
                        .foregroundStyle(SHColor.inkPrimary)
                        .lineLimit(1)
                    if let server, !server.isEmpty {
                        Text(server)
                            .font(.system(size: 10.5, weight: .medium))
                            .foregroundStyle(SHColor.inkMuted)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.white.opacity(0.06))
                            .clipShape(Capsule())
                    }
                    Spacer(minLength: 4)
                    if let durationMs {
                        Text("\(Int(durationMs))ms")
                            .font(SHTypography.monoSmall)
                            .foregroundStyle(SHColor.inkFaint)
                    }
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10))
                        .foregroundStyle(SHColor.inkFaint)
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Divider().overlay(SHColor.lineHairline)
                VStack(alignment: .leading, spacing: 8) {
                    if let args, !args.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("ARGUMENTS")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(SHColor.inkFaint)
                            Text(args)
                                .font(SHTypography.monoSmall)
                                .foregroundStyle(SHColor.inkSecondary)
                                .textSelection(.enabled)
                        }
                    }
                    if let output, !output.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("OUTPUT")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(SHColor.inkFaint)
                            Text(output)
                                .font(SHTypography.monoSmall)
                                .foregroundStyle(SHColor.inkSecondary)
                                .textSelection(.enabled)
                        }
                    }
                }
                .padding(13)
            }
        }
        .background(SHColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }
}

// MARK: - 7. Web Search Block

private struct WebSearchBlockView: View, Equatable {
    let query: String
    let url: String?

    nonisolated static func == (lhs: WebSearchBlockView, rhs: WebSearchBlockView) -> Bool {
        lhs.query == rhs.query && lhs.url == rhs.url
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(SHColor.brandAntigravity)
            Text(query)
                .font(SHTypography.caption)
                .foregroundStyle(SHColor.inkSecondary)
                .lineLimit(2)
            Spacer(minLength: 4)
            if let urlStr = url, let link = URL(string: urlStr) {
                Link(destination: link) {
                    Image(systemName: "arrow.up.right.square")
                        .font(.system(size: 13))
                        .foregroundStyle(SHColor.inkMuted)
                }
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 10)
        .background(SHColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }
}

// MARK: - 8. Interactive Question Block

private struct QuestionBlockView: View {
    let questions: [QuestionItem]
    let answered: Bool
    let onSelectOption: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: SHSpacing.md) {
            HStack(spacing: 6) {
                Image(systemName: answered ? "checkmark.bubble.fill" : "questionmark.bubble.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(answered ? SHColor.statusSuccess : SHColor.statusWarning)
                Text(answered ? "Answered" : "Input Requested")
                    .font(SHTypography.micro.weight(.semibold))
                    .foregroundStyle(answered ? SHColor.statusSuccess : SHColor.statusWarning)
            }

            ForEach(Array(questions.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: SHSpacing.sm) {
                    Text(item.question)
                        .font(SHTypography.label.weight(.semibold))
                        .foregroundStyle(SHColor.inkPrimary)

                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(item.options, id: \.self) { option in
                            let isChosen = item.answer == option
                            Button {
                                guard !answered else { return }
                                onSelectOption(option)
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: isChosen ? "checkmark.circle.fill" : "circle")
                                        .font(.system(size: 13))
                                        .foregroundStyle(isChosen ? SHColor.statusSuccess : SHColor.inkMuted)
                                    Text(option)
                                        .font(SHTypography.caption.weight(.medium))
                                        .foregroundStyle(isChosen ? SHColor.inkPrimary : SHColor.inkSecondary)
                                        .multilineTextAlignment(.leading)
                                    Spacer()
                                }
                                .padding(.horizontal, 13)
                                .padding(.vertical, 10)
                                .background(isChosen ? SHColor.statusSuccess.opacity(0.14) : SHColor.surfaceRaised)
                                .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .disabled(answered)
                        }
                    }
                }
            }
        }
        .padding(14)
        .background(SHColor.surfacePopover)
        .overlay(
            RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous)
                .stroke(answered ? Color.clear : SHColor.statusWarning.opacity(0.28), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }
}

// MARK: - 9. Notice Block

private struct NoticeBlockView: View, Equatable {
    let title: String
    let detail: String?

    nonisolated static func == (lhs: NoticeBlockView, rhs: NoticeBlockView) -> Bool {
        lhs.title == rhs.title && lhs.detail == rhs.detail
    }

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "info.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(SHColor.brandAntigravity)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(SHTypography.caption.weight(.semibold))
                    .foregroundStyle(SHColor.inkPrimary)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(SHTypography.micro)
                        .foregroundStyle(SHColor.inkMuted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(SHColor.brandAntigravity.opacity(0.09))
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }
}
