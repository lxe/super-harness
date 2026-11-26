import AVFoundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#endif

private struct VideoTransferable: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let dst = FileManager.default.temporaryDirectory
                .appendingPathComponent("sh-video-\(UUID().uuidString).\(received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension)")
            try? FileManager.default.removeItem(at: dst)
            try FileManager.default.copyItem(at: received.file, to: dst)
            return Self(url: dst)
        }
    }
}

public struct ComposerView: View {
    public let session: UnifiedSession
    @Binding public var text: String
    public let attachments: [ImageAttachment]
    public let uploadingAttachmentIds: Set<String>
    public let availableModels: [HarnessModelOption]
    public let reasoningLevels: [String]
    public let isSending: Bool
    public let isStreaming: Bool
    public let isAgentBusy: Bool
    public let onPickPhotoData: (Data, String) -> Void
    public let onPickFileData: ((Data, String, String, Data?) -> Void)?
    public let onRemoveAttachment: (String) -> Void
    public let onTapAttachment: (ImageAttachment) -> Void
    public let onSelectModel: ((HarnessModelOption) -> Void)?
    public let onSelectReasoningEffort: ((String) -> Void)?
    public let onTranscribeAudio: ((Data) async throws -> String)?
    /// Runs when recording starts, so the host connection can be opened while the user speaks.
    public let onDictationStart: (@MainActor () async -> Void)?
    public let onSend: (SendMode) -> Void
    public let onAbort: () -> Void

    @State private var selectedMediaItems: [PhotosPickerItem] = []
    @State private var isPhotoPickerPresented: Bool = false
    @State private var isFileImporterPresented: Bool = false
    @State private var dictation = DictationController()

    public init(
        session: UnifiedSession,
        text: Binding<String>,
        attachments: [ImageAttachment],
        uploadingAttachmentIds: Set<String> = [],
        availableModels: [HarnessModelOption] = [],
        reasoningLevels: [String] = [],
        isSending: Bool,
        isStreaming: Bool,
        isAgentBusy: Bool,
        onPickPhotoData: @escaping (Data, String) -> Void,
        onPickFileData: ((Data, String, String, Data?) -> Void)? = nil,
        onRemoveAttachment: @escaping (String) -> Void,
        onTapAttachment: @escaping (ImageAttachment) -> Void,
        onSelectModel: ((HarnessModelOption) -> Void)? = nil,
        onSelectReasoningEffort: ((String) -> Void)? = nil,
        onTranscribeAudio: ((Data) async throws -> String)? = nil,
        onDictationStart: (@MainActor () async -> Void)? = nil,
        onSend: @escaping (SendMode) -> Void,
        onAbort: @escaping () -> Void
    ) {
        self.session = session
        self._text = text
        self.attachments = attachments
        self.uploadingAttachmentIds = uploadingAttachmentIds
        self.availableModels = availableModels
        self.reasoningLevels = reasoningLevels
        self.isSending = isSending
        self.isStreaming = isStreaming
        self.isAgentBusy = isAgentBusy
        self.onPickPhotoData = onPickPhotoData
        self.onPickFileData = onPickFileData
        self.onRemoveAttachment = onRemoveAttachment
        self.onTapAttachment = onTapAttachment
        self.onSelectModel = onSelectModel
        self.onSelectReasoningEffort = onSelectReasoningEffort
        self.onTranscribeAudio = onTranscribeAudio
        self.onDictationStart = onDictationStart
        self.onSend = onSend
        self.onAbort = onAbort
    }

    private var hasContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    private var showsStopButton: Bool {
        (isStreaming || isAgentBusy) && !hasContent
    }

    private static let effortSuffixes = ["-low", "-medium", "-high", "-xhigh", "-max"]

    private static func baseModelStem(_ id: String) -> String {
        let lower = id.lowercased()
        for suf in effortSuffixes where lower.hasSuffix(suf) {
            return String(id.dropLast(suf.count))
        }
        return id
    }

    private static func embeddedEffort(from id: String?) -> String? {
        guard let lower = id?.lowercased() else { return nil }
        for suf in effortSuffixes where lower.hasSuffix(suf) {
            return String(suf.dropFirst())
        }
        return nil
    }

    private static func cleanBaseDisplayLabel(_ label: String) -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        for tag in [" (Low)", " (Medium)", " (High)", " (XHigh)", " (Max)"] {
            if trimmed.hasSuffix(tag) {
                return String(trimmed.dropLast(tag.count))
            }
        }
        return shortModelName(trimmed)
    }

    /// Deduplicates sibling effort-suffixed slugs (e.g. Antigravity `gemini-4-neon-high` / `-medium`)
    /// so the Model menu stays clean while the Thinking Effort section switches the effort variant.
    private var menuModelOptions: [(stem: String, displayLabel: String, representative: HarnessModelOption)] {
        var seen: [String] = []
        var byStem: [String: HarnessModelOption] = [:]
        let activeStem = session.model.map(Self.baseModelStem)
        for opt in availableModels {
            let stem = Self.baseModelStem(opt.id)
            if byStem[stem] == nil {
                seen.append(stem)
                byStem[stem] = opt
            } else if stem == activeStem && opt.id == session.model {
                byStem[stem] = opt
            }
        }
        return seen.compactMap { stem in
            guard let rep = byStem[stem] else { return nil }
            return (stem, Self.cleanBaseDisplayLabel(rep.label), rep)
        }
    }

    private var currentModelLabel: String {
        if let raw = session.model, !raw.isEmpty {
            if let match = availableModels.first(where: { $0.id == raw || $0.label == raw }) {
                return Self.cleanBaseDisplayLabel(match.label)
            }
            return Self.cleanBaseDisplayLabel(Self.baseModelStem(raw))
        }
        if let def = availableModels.first(where: { $0.isDefault == true }) ?? availableModels.first {
            return Self.cleanBaseDisplayLabel(def.label)
        }
        return HarnessVisual.forKind(session.harness).label
    }

    private var currentEffortLabel: String? {
        if let embedded = Self.embeddedEffort(from: session.model) {
            return embedded.capitalized
        }
        guard !reasoningLevels.isEmpty else { return nil }
        return (session.reasoningEffort ?? reasoningLevels.last)?.capitalized
    }

    public var body: some View {
        SHComposerSurface {
            VStack(spacing: 0) {
                if !attachments.isEmpty {
                    SHAttachmentThumbStrip(
                        items: attachments.map { att in
                            SHAttachmentThumbItem(
                                id: att.id,
                                name: att.name,
                                path: att.path,
                                mimeType: att.mimeType,
                                dataUrl: att.previewDataUrl,
                                sizeBytes: att.sizeBytes,
                                isUploading: uploadingAttachmentIds.contains(att.id)
                            )
                        },
                        thumbSize: SHLayout.composerThumbSize,
                        onTap: { item in
                            if let match = attachments.first(where: { $0.id == item.id }) {
                                onTapAttachment(match)
                            }
                        },
                        onRemove: onRemoveAttachment
                    )
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 2)
                }

                if let err = dictation.errorMessage {
                    HStack(spacing: 6) {
                        Image(systemName: "mic.slash.fill")
                            .font(.system(size: 10.5))
                            .foregroundStyle(SHColor.statusDanger)
                        Text(err)
                            .font(SHTypography.micro)
                            .foregroundStyle(SHColor.statusDanger)
                            .lineLimit(1)
                        Spacer()
                        Button {
                            dictation.errorMessage = nil
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 9.5, weight: .semibold))
                                .foregroundStyle(SHColor.inkFaint)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                }

                TextField(
                    session.isMaster
                        ? "Ask Master Orchestrator anything, or /status…"
                        : "Message \(HarnessVisual.forKind(session.harness).label)…",
                    text: $text,
                    axis: .vertical
                )
                .lineLimit(1...5)
                .font(SHTypography.body)
                .foregroundStyle(SHColor.inkPrimary)
                .padding(.horizontal, 15)
                .padding(.top, 15)
                .padding(.bottom, 12)
                .accessibilityIdentifier("composer.input")

                HStack(spacing: 8) {
                    attachMenuButton
                    combinedModelEffortPill
                    Spacer(minLength: 4)
                    if onTranscribeAudio != nil {
                        micButton
                    }
                    actionButton
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
            }
        }
        .photosPicker(
            isPresented: $isPhotoPickerPresented,
            selection: $selectedMediaItems,
            maxSelectionCount: 4,
            matching: .any(of: [.images, .videos])
        )
        .onChange(of: selectedMediaItems) { _, newItems in
            guard !newItems.isEmpty else { return }
            let items = newItems
            selectedMediaItems = []
            handlePickedMediaItems(items)
        }
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            handleImportedFiles(result)
        }
        .onDisappear {
            if dictation.state == .recording {
                dictation.cancel()
            }
        }
    }

    private var attachMenuButton: some View {
        Menu {
            Button {
                isPhotoPickerPresented = true
            } label: {
                Label("Photos & Videos", systemImage: "photo.on.rectangle.angled")
            }
            Button {
                isFileImporterPresented = true
            } label: {
                Label("Choose File", systemImage: "doc")
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(SHColor.inkSecondary)
                .frame(width: 32, height: 32)
                .background(SHColor.surfaceBubble, in: Circle())
        }
        .accessibilityLabel("Attach media or file")
        .accessibilityIdentifier("composer.attach")
    }

    @ViewBuilder
    private var combinedModelEffortPill: some View {
        if !availableModels.isEmpty, let onSelectModel {
            Menu {
                Section("Model") {
                    let currentStem = session.model.map(Self.baseModelStem)
                    ForEach(menuModelOptions, id: \.stem) { item in
                        Button {
                            onSelectModel(item.representative)
                        } label: {
                            let isSelected = (currentStem == item.stem || session.model == item.representative.id || session.model == item.representative.label)
                            if isSelected {
                                Label(item.displayLabel, systemImage: "checkmark")
                            } else {
                                Text(item.displayLabel)
                            }
                        }
                    }
                }
                if !reasoningLevels.isEmpty, let onSelectReasoningEffort {
                    let activeEffort = Self.embeddedEffort(from: session.model) ?? session.reasoningEffort ?? reasoningLevels.last
                    Section("Thinking Effort") {
                        ForEach(reasoningLevels, id: \.self) { level in
                            Button {
                                onSelectReasoningEffort(level)
                            } label: {
                                if activeEffort?.lowercased() == level.lowercased() {
                                    Label(level.capitalized, systemImage: "checkmark")
                                } else {
                                    Text(level.capitalized)
                                }
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    HarnessLogoView(harness: session.harness, size: 12.5)
                    Text(currentModelLabel)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(SHColor.inkPrimary)
                        .lineLimit(1)
                    if let effort = currentEffortLabel {
                        Text(effort)
                            .font(.system(size: 12, weight: .regular))
                            .foregroundStyle(SHColor.inkMuted)
                            .lineLimit(1)
                    }
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundStyle(SHColor.inkFaint)
                }
                .padding(.horizontal, 11)
                .frame(height: 32)
                .background(SHColor.surfaceBubble, in: Capsule())
            }
            .accessibilityLabel("Switch model and effort")
        } else {
            HStack(spacing: 5) {
                HarnessLogoView(harness: session.harness, size: 12.5)
                Text(currentModelLabel)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(SHColor.inkMuted)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(SHColor.surfaceBubble.opacity(0.6), in: Capsule())
        }
    }

    @ViewBuilder
    private var micButton: some View {
        switch dictation.state {
        case .idle:
            Button {
                triggerHaptic(.light)
                Task { await handleDictationTap() }
            } label: {
                Image(systemName: "mic.fill")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(SHColor.inkMuted)
                    .frame(width: 32, height: 32)
                    .background(SHColor.surfaceBubble, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Start voice dictation")
            .accessibilityIdentifier("composer.mic")

        case .recording:
            Button {
                triggerHaptic(.medium)
                Task { await handleDictationTap() }
            } label: {
                HStack(spacing: 5) {
                    Circle()
                        .fill(SHColor.statusDanger)
                        .frame(width: 7, height: 7)
                    Text(dictation.formattedDuration)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(SHColor.statusDanger)
                    Image(systemName: "stop.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(SHColor.statusDanger)
                }
                .padding(.horizontal, 10)
                .frame(height: 32)
                .background(SHColor.statusDanger.opacity(0.16), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop recording and transcribe")
            .accessibilityIdentifier("composer.mic")

        case .transcribing:
            ProgressView()
                .controlSize(.mini)
                .tint(SHColor.brandAntigravity)
                .frame(width: 32, height: 32)
                .background(SHColor.surfaceBubble, in: Circle())
                .accessibilityLabel("Transcribing voice dictation")
                .accessibilityIdentifier("composer.mic")
        }
    }

    private func handleDictationTap() async {
        guard let transcribe = onTranscribeAudio else { return }
        if let spoken = await dictation.toggleRecording(prewarm: onDictationStart, transcribe: transcribe), !spoken.isEmpty {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                text = spoken
            } else {
                text = text.hasSuffix(" ") || text.hasSuffix("\n") ? text + spoken : text + " " + spoken
            }
        }
    }

    /// Default tap immediately steers (`SendMode.steer`). Long-press opens a menu to Steer Now or Queue for Later.
    @ViewBuilder
    private var actionButton: some View {
        if showsStopButton {
            Button {
                triggerHaptic(.medium)
                onAbort()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(SHColor.surfaceRail)
                    .frame(width: 32, height: 32)
                    .background(SHColor.inkPrimary, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop agent")
            .accessibilityIdentifier("composer.stop")
        } else {
            Button {
                triggerHaptic(.light)
                onSend(.steer)
            } label: {
                Group {
                    if isSending {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(SHColor.surfaceRail)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 13.5, weight: .bold))
                            .foregroundStyle(SHColor.surfaceRail)
                    }
                }
                .frame(width: 32, height: 32)
                .background(SHColor.inkPrimary, in: Circle())
                .opacity(hasContent && !isSending ? 1.0 : 0.28)
            }
            .buttonStyle(.plain)
            .disabled(!hasContent || isSending)
            .contextMenu {
                if hasContent && !isSending {
                    Button {
                        triggerHaptic(.light)
                        onSend(.steer)
                    } label: {
                        Label("Steer Now", systemImage: "arrow.up.circle.fill")
                    }
                    Button {
                        triggerHaptic(.light)
                        onSend(.queue)
                    } label: {
                        Label("Queue for Later", systemImage: "text.badge.plus")
                    }
                }
            }
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("composer.send")
        }
    }

    // MARK: - Media & File Picking Helpers

    private func handlePickedMediaItems(_ items: [PhotosPickerItem]) {
        Task {
            for (index, item) in items.enumerated() {
                let isVideo = item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) || $0.conforms(to: .video) })
                if isVideo, let video = try? await item.loadTransferable(type: VideoTransferable.self) {
                    let result = await Task.detached(priority: .userInitiated) { () -> (Data, String, String, Data?)? in
                        defer { try? FileManager.default.removeItem(at: video.url) }
                        guard let raw = try? Data(contentsOf: video.url), !raw.isEmpty else { return nil }
                        let ext = video.url.pathExtension.lowercased()
                        let mime = ext == "mp4" ? "video/mp4" : "video/quicktime"
                        let thumb = await Self.videoThumbnailJPEG(url: video.url)
                        return (raw, mime, "video-\(index + 1).\(ext.isEmpty ? "mov" : ext)", thumb)
                    }.value
                    if let (data, mime, name, thumb) = result {
                        if let onPickFileData {
                            onPickFileData(data, mime, name, thumb)
                        }
                    }
                } else if let rawData = try? await item.loadTransferable(type: Data.self) {
                    let jpeg = await Task.detached(priority: .userInitiated) {
                        Self.downscaledJPEG(from: rawData, maxDimension: 1600, quality: 0.75) ?? rawData
                    }.value
                    onPickPhotoData(jpeg, "photo-\(index + 1).jpg")
                }
            }
        }
    }

    private func handleImportedFiles(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result else { return }
        Task {
            for url in urls.prefix(4) {
                let accessed = url.startAccessingSecurityScopedResource()
                let prepared = await Task.detached(priority: .userInitiated) { () -> (Data, String, String, Data?)? in
                    defer {
                        if accessed { url.stopAccessingSecurityScopedResource() }
                    }
                    guard let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
                    let name = url.lastPathComponent.isEmpty ? "file.bin" : url.lastPathComponent
                    let utType = UTType(filenameExtension: url.pathExtension)
                    let mime = utType?.preferredMIMEType ?? "application/octet-stream"
                    if mime.hasPrefix("image/") {
                        let jpeg = Self.downscaledJPEG(from: data, maxDimension: 1600, quality: 0.75) ?? data
                        return (jpeg, "image/jpeg", name, jpeg)
                    } else if mime.hasPrefix("video/") {
                        let thumb = await Self.videoThumbnailJPEG(url: url)
                        return (data, mime, name, thumb)
                    }
                    return (data, mime, name, nil)
                }.value
                if let (data, mime, name, thumb) = prepared {
                    if let onPickFileData {
                        onPickFileData(data, mime, name, thumb)
                    } else if mime.hasPrefix("image/") {
                        onPickPhotoData(data, name)
                    }
                }
            }
        }
    }

    nonisolated private static func videoThumbnailJPEG(url: URL) async -> Data? {
        #if canImport(UIKit)
        let asset = AVURLAsset(url: url)
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 320, height: 320)
        guard let result = try? await gen.image(at: CMTime(seconds: 0.1, preferredTimescale: 600)) else {
            return nil
        }
        return UIImage(cgImage: result.image).jpegData(compressionQuality: 0.72)
        #else
        return nil
        #endif
    }

    private func triggerHaptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: style).impactOccurred()
        #endif
    }

    private static func shortModelName(_ label: String) -> String {
        // Strip trailing parenthesized effort "(Medium)" when effort is already shown alongside.
        if let idx = label.range(of: " (") {
            return String(label[..<idx.lowerBound])
        }
        return label
    }

    nonisolated public static func downscaledJPEG(from data: Data, maxDimension: CGFloat = 1600, quality: CGFloat = 0.75) -> Data? {
        #if canImport(UIKit)
        guard let img = UIImage(data: data) else { return nil }
        let size = img.size
        let longest = max(size.width, size.height)
        guard longest > 0 else { return img.jpegData(compressionQuality: quality) }
        if longest <= maxDimension {
            return img.jpegData(compressionQuality: quality)
        }
        let scale = maxDimension / longest
        let targetSize = CGSize(width: floor(size.width * scale), height: floor(size.height * scale))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1.0
        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
        let resized = renderer.image { _ in
            img.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        return resized.jpegData(compressionQuality: quality)
        #else
        return data
        #endif
    }
}
