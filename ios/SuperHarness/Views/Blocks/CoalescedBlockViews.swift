import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Block Coalescing

public enum CoalescedSegment: Sendable, Equatable {
    case single(UnifiedBlock)
    case traceGroup([UnifiedBlock])
    case imageGroup([UnifiedBlock])

    public static func coalesce(_ blocks: [UnifiedBlock]) -> [CoalescedSegment] {
        var result: [CoalescedSegment] = []
        var traceBuf: [UnifiedBlock] = []
        var imageBuf: [UnifiedBlock] = []

        func flushTrace() {
            if !traceBuf.isEmpty {
                // Coalesce diffs and multi-step traces under one calm disclosure row;
                // a single standalone diff also folds into a traceGroup so file changes never spam the main view.
                if traceBuf.count >= 2 || traceBuf.contains(where: { if case .fileChange = $0 { return true }; return false }) {
                    result.append(.traceGroup(traceBuf))
                } else if let only = traceBuf.first {
                    result.append(.single(only))
                }
                traceBuf.removeAll(keepingCapacity: true)
            }
        }

        func flushImages() {
            if !imageBuf.isEmpty {
                result.append(.imageGroup(imageBuf))
                imageBuf.removeAll(keepingCapacity: true)
            }
        }

        for block in blocks {
            if block.isTraceBlock {
                flushImages()
                traceBuf.append(block)
            } else if case .image = block {
                flushTrace()
                imageBuf.append(block)
            } else {
                flushTrace()
                flushImages()
                result.append(.single(block))
            }
        }
        flushTrace()
        flushImages()
        return result
    }
}

// MARK: - Collapsed Trace Group (Compact Inline Disclosure Row)

public struct CollapsedTraceGroupView: View, Equatable {
    public let blocks: [UnifiedBlock]
    public var trailingMeta: String? = nil
    public let onAnswerQuestion: (String) -> Void
    public let onTapImage: (LightboxPayload) -> Void
    public let onLoadMedia: ((String) async -> Data?)?
    @State private var isExpanded: Bool = false

    nonisolated public static func == (lhs: CollapsedTraceGroupView, rhs: CollapsedTraceGroupView) -> Bool {
        lhs.blocks == rhs.blocks && lhs.trailingMeta == rhs.trailingMeta
    }

    public init(
        blocks: [UnifiedBlock],
        trailingMeta: String? = nil,
        onAnswerQuestion: @escaping (String) -> Void,
        onTapImage: @escaping (LightboxPayload) -> Void,
        onLoadMedia: ((String) async -> Data?)? = nil
    ) {
        self.blocks = blocks
        self.trailingMeta = trailingMeta
        self.onAnswerQuestion = onAnswerQuestion
        self.onTapImage = onTapImage
        self.onLoadMedia = onLoadMedia
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: SHLayout.itemGap) {
            SHInlineDisclosureRow(
                icon: summaryIcon,
                title: summaryText,
                trailingMeta: trailingMeta,
                isExpanded: isExpanded
            ) {
                isExpanded.toggle()
            }

            if isExpanded {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                        CompactTraceRowView(
                            block: block,
                            onAnswerQuestion: onAnswerQuestion,
                            onTapImage: onTapImage,
                            onLoadMedia: onLoadMedia
                        )
                    }
                }
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(SHColor.lineHairline)
                        .frame(width: 1.5)
                        .padding(.vertical, 2)
                }
            }
        }
    }

    private var summaryIcon: String {
        let cmdCount = blocks.filter { if case .command = $0 { return true }; return false }.count
        let thinkCount = blocks.filter { if case .thinking = $0 { return true }; return false }.count
        if cmdCount > 0 && thinkCount == 0 { return "list.bullet" }
        if thinkCount > 0 { return "sparkles" }
        return "list.bullet"
    }

    private var summaryText: String {
        var counts: [String] = []
        let thinkCount = blocks.filter { if case .thinking = $0 { return true }; return false }.count
        let cmdCount = blocks.filter { if case .command = $0 { return true }; return false }.count
        let toolCount = blocks.filter { if case .toolCall = $0 { return true }; return false }.count
        let searchCount = blocks.filter { if case .webSearch = $0 { return true }; return false }.count
        let diffFileCount = blocks.reduce(0) { acc, blk in
            if case .fileChange(let changes, _) = blk { return acc + max(1, changes.count) }
            return acc
        }
        if thinkCount > 0 { counts.append(thinkCount == 1 ? "Thought" : "\(thinkCount) thoughts") }
        if cmdCount > 0 {
            counts.append(cmdCount == 1 ? "Ran 1 command" : "Ran \(cmdCount) commands")
        }
        if toolCount > 0 { counts.append(toolCount == 1 ? "1 tool" : "\(toolCount) tools") }
        if searchCount > 0 { counts.append(searchCount == 1 ? "1 search" : "\(searchCount) searches") }
        if diffFileCount > 0 {
            counts.append(diffFileCount == 1 ? "1 file changed" : "\(diffFileCount) files changed")
        }
        return counts.isEmpty ? "\(blocks.count) steps" : counts.joined(separator: " · ")
    }
}


// MARK: - Slim Mobile Trace Row (Replaces Bulky Stacked Cards Inside CollapsedTraceGroupView)

private struct CompactTraceRowView: View {
    let block: UnifiedBlock
    let onAnswerQuestion: (String) -> Void
    let onTapImage: (LightboxPayload) -> Void
    let onLoadMedia: ((String) async -> Data?)?

    @State private var isDetailOpen: Bool = false

    private static func stripOuterQuotes(_ raw: String) -> String {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.count >= 2 && ((t.hasPrefix("\"") && t.hasSuffix("\"")) || (t.hasPrefix(") && t.hasSuffix("))) {
            return String(t.dropFirst().dropLast())
        }
        return t
    }

    var body: some View {
        switch block {
        case .command(let command, _, let output, let exitCode, let durationMs, let status):
            let cleanCmd = Self.stripOuterQuotes(command)
            let isRunning = status?.lowercased() == "running"
            let failed = (exitCode ?? 0) != 0 || status?.lowercased() == "failed"
            let hasOutput = !(output ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

            VStack(alignment: .leading, spacing: 4) {
                Button {
                    if hasOutput || CommandFirstLineText.needsFullView(cleanCmd) {
                        withAnimation(.easeInOut(duration: 0.14)) { isDetailOpen.toggle() }
                    }
                } label: {
                    HStack(alignment: .center, spacing: 7) {
                        if isRunning {
                            ProgressView()
                                .controlSize(.mini)
                                .scaleEffect(0.75)
                                .frame(width: 12, height: 12)
                        } else {
                            Image(systemName: failed ? "xmark.circle.fill" : "terminal")
                                .font(.system(size: 10.5, weight: .medium))
                                .foregroundStyle(failed ? SHColor.statusDanger : SHColor.inkFaint)
                                .frame(width: 12)
                        }
                        CommandFirstLineText(text: cleanCmd, color: SHColor.inkSecondary)
                        if let durationMs, durationMs >= 1000 {
                            Text(String(format: "%.1fs", durationMs / 1000.0))
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(SHColor.inkFaint)
                        }
                        if hasOutput || CommandFirstLineText.needsFullView(cleanCmd) {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(SHColor.inkFaint)
                                .rotationEffect(.degrees(isDetailOpen ? 90 : 0))
                        }
                    }
                    .padding(.vertical, 5)
                    .padding(.horizontal, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if isDetailOpen, CommandFirstLineText.needsFullView(cleanCmd) {
                    FullCommandText(command: cleanCmd)
                        .padding(9)
                        .background(SHColor.surfaceCode)
                        .clipShape(RoundedRectangle(cornerRadius: SHRadius.sm, style: .continuous))
                        .padding(.leading, 18)
                }

                if isDetailOpen, let output, !output.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(output)
                            .font(SHTypography.monoSmall)
                            .foregroundStyle(SHColor.inkSecondary)
                            .textSelection(.enabled)
                            .padding(9)
                    }
                    .frame(maxHeight: 200)
                    .background(SHColor.surfaceCode)
                    .clipShape(RoundedRectangle(cornerRadius: SHRadius.sm, style: .continuous))
                    .padding(.leading, 18)
                }
            }

        case .thinking(let text, let summary):
            let title = (summary?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
                ?? text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .newlines).first
                ?? "Thought"
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    withAnimation(.easeInOut(duration: 0.14)) { isDetailOpen.toggle() }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 10.5))
                            .foregroundStyle(SHColor.inkFaint)
                            .frame(width: 12)
                        Text(title)
                            .font(.system(size: 12.5))
                            .foregroundStyle(SHColor.inkMuted)
                            .lineLimit(isDetailOpen ? nil : 1)
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(SHColor.inkFaint)
                            .rotationEffect(.degrees(isDetailOpen ? 90 : 0))
                    }
                    .padding(.vertical, 5)
                    .padding(.horizontal, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if isDetailOpen {
                    Text(text)
                        .font(.system(size: 12.5))
                        .foregroundStyle(SHColor.inkSecondary)
                        .textSelection(.enabled)
                        .padding(.leading, 25)
                        .padding(.bottom, 4)
                }
            }

        case .toolCall(let name, let server, let args, let output, let status, _):
            let label = [server, name].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
            let hasBody = !(args ?? "").isEmpty || !(output ?? "").isEmpty
            let isRunning = status?.lowercased() == "running"
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    if hasBody {
                        withAnimation(.easeInOut(duration: 0.14)) { isDetailOpen.toggle() }
                    }
                } label: {
                    HStack(alignment: .center, spacing: 7) {
                        if isRunning {
                            ProgressView().controlSize(.mini).scaleEffect(0.75).frame(width: 12, height: 12)
                        } else {
                            Image(systemName: "wrench.adjustable")
                                .font(.system(size: 10.5))
                                .foregroundStyle(SHColor.inkFaint)
                                .frame(width: 12)
                        }
                        Text(label.isEmpty ? name : label)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(SHColor.inkSecondary)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        if hasBody {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(SHColor.inkFaint)
                                .rotationEffect(.degrees(isDetailOpen ? 90 : 0))
                        }
                    }
                    .padding(.vertical, 5)
                    .padding(.horizontal, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if isDetailOpen {
                    VStack(alignment: .leading, spacing: 4) {
                        if let args, !args.isEmpty {
                            Text(args)
                                .font(SHTypography.monoSmall)
                                .foregroundStyle(SHColor.inkMuted)
                                .lineLimit(8)
                        }
                        if let output, !output.isEmpty {
                            Text(output)
                                .font(SHTypography.monoSmall)
                                .foregroundStyle(SHColor.inkSecondary)
                                .lineLimit(12)
                        }
                    }
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(SHColor.surfaceCode)
                    .clipShape(RoundedRectangle(cornerRadius: SHRadius.sm, style: .continuous))
                    .padding(.leading, 18)
                }
            }

        case .webSearch(let query, _):
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 10.5))
                    .foregroundStyle(SHColor.inkFaint)
                    .frame(width: 12)
                Text(query)
                    .font(.system(size: 12.5))
                    .foregroundStyle(SHColor.inkSecondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 6)

        default:
            UnifiedBlockView(
                block: block,
                isUserBubble: false,
                onAnswerQuestion: onAnswerQuestion,
                onTapImage: onTapImage,
                onLoadMedia: onLoadMedia
            )
        }
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

// MARK: - 1. Markdown Text + Copyable Fenced Code Blocks (Powered by SHMarkdownView GFM Engine)

private struct MarkdownTextBlockView: View, Equatable {
    let text: String
    let isUserBubble: Bool

    nonisolated static func == (lhs: MarkdownTextBlockView, rhs: MarkdownTextBlockView) -> Bool {
        lhs.text == rhs.text && lhs.isUserBubble == rhs.isUserBubble
    }

    var body: some View {
        SHMarkdownView(text: text, isUserBubble: isUserBubble)
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

    var body: some View {
        let title = name ?? ((path as NSString).lastPathComponent.isEmpty ? "Image" : (path as NSString).lastPathComponent)
        SHAttachmentThumbStrip(
            items: [
                SHAttachmentThumbItem(
                    id: path.isEmpty ? title : path,
                    name: title,
                    path: path,
                    mimeType: "image/jpeg",
                    dataUrl: dataUrl
                )
            ],
            thumbSize: SHLayout.thumbSize,
            onTap: { item in
                onTapImage(LightboxPayload(title: item.name, dataUrl: item.dataUrl, path: item.path))
            },
            onLoadMedia: onLoadMedia
        )
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

struct CommandBlockView: View, Equatable {
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
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "terminal.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(SHColor.inkMuted)
                        CommandFirstLineText(text: "$ \(command)", color: SHColor.inkPrimary)
                        exitBadge
                    }

                    let canExpand = !(output ?? "").isEmpty || CommandFirstLineText.needsFullView(command)
                    if !(cwd ?? "").isEmpty || durationMs != nil || canExpand {
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
                        if canExpand {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(SHColor.inkFaint)
                                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                                .accessibilityLabel(isExpanded ? "Collapse" : "Expand")
                        }
                    }
                    }
                }
                .padding(13)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded, CommandFirstLineText.needsFullView(command) {
                Divider().overlay(SHColor.lineHairline)
                FullCommandText(command: command)
                    .padding(13)
            }

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

    /// Status words that mean the command finished normally; nothing is shown for these.
    nonisolated static let quietStatuses: Set<String> = ["completed", "complete", "success", "succeeded", "done", "ok", "finished"]

    /// Trailing badge text: the exit code when it is non-zero, otherwise any status that is
    /// not a plain success (running, failed, cancelled...). Nil means show nothing.
    nonisolated static func trailingBadge(exitCode: Int?, status: String?) -> (text: String, isFailure: Bool)? {
        if let code = exitCode, code != 0 {
            return ("exit \(code)", true)
        }
        let trimmed = status?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty, !quietStatuses.contains(trimmed.lowercased()) else { return nil }
        if exitCode == 0, trimmed.lowercased() != "running" { return nil }
        let failureWords: Set<String> = ["failed", "failure", "error", "errored", "timeout", "timed_out", "cancelled", "canceled", "interrupted"]
        return (trimmed, failureWords.contains(trimmed.lowercased()))
    }

    @ViewBuilder
    private var exitBadge: some View {
        if let badge = Self.trailingBadge(exitCode: exitCode, status: status) {
            if badge.isFailure {
                Text(badge.text)
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(SHColor.statusDanger)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(SHColor.statusDanger.opacity(0.14))
                    .clipShape(Capsule())
            } else {
                Text(badge.text)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(SHColor.inkMuted)
            }
        }
    }
}

/// The beginning of a command on exactly one line. Command text never wraps on mobile:
/// only the first line is shown, and text wider than the row fades out at the trailing edge.
struct CommandFirstLineText: View {
    let text: String
    let color: Color

    static let font = Font.system(size: 11.5, design: .monospaced)
    /// Longest command that reliably fits a phone-width row at `font`.
    static let fittingCharacterCount = 38

    nonisolated static func firstLine(of command: String) -> String {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    }

    /// True when the single faded line cannot show the whole command, so the
    /// expanded state needs a separate full-command view.
    nonisolated static func needsFullView(_ command: String) -> Bool {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.contains(where: \.isNewline) || trimmed.count > fittingCharacterCount
    }

    var body: some View {
        Text(Self.firstLine(of: text))
            .font(Self.font)
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
            .mask(
                LinearGradient(
                    stops: [
                        .init(color: .black, location: 0),
                        .init(color: .black, location: 0.86),
                        .init(color: .clear, location: 1),
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
            .accessibilityLabel(text)
    }
}

/// The whole command, shown only when a block is expanded. Lines keep their own breaks and
/// scroll sideways instead of wrapping.
struct FullCommandText: View {
    let command: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(command.trimmingCharacters(in: .whitespacesAndNewlines))
                .font(CommandFirstLineText.font)
                .foregroundStyle(SHColor.inkSecondary)
                .fixedSize(horizontal: true, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxHeight: 220)
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
