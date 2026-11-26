import PhotosUI
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

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
    public let onRemoveAttachment: (String) -> Void
    public let onTapAttachment: (ImageAttachment) -> Void
    public let onSelectModel: ((HarnessModelOption) -> Void)?
    public let onSelectReasoningEffort: ((String) -> Void)?
    public let onTranscribeAudio: ((Data) async throws -> String)?
    public let onSend: () -> Void
    public let onAbort: () -> Void

    @State private var selectedPhotoItems: [PhotosPickerItem] = []
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
        onRemoveAttachment: @escaping (String) -> Void,
        onTapAttachment: @escaping (ImageAttachment) -> Void,
        onSelectModel: ((HarnessModelOption) -> Void)? = nil,
        onSelectReasoningEffort: ((String) -> Void)? = nil,
        onTranscribeAudio: ((Data) async throws -> String)? = nil,
        onSend: @escaping () -> Void,
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
        self.onRemoveAttachment = onRemoveAttachment
        self.onTapAttachment = onTapAttachment
        self.onSelectModel = onSelectModel
        self.onSelectReasoningEffort = onSelectReasoningEffort
        self.onTranscribeAudio = onTranscribeAudio
        self.onSend = onSend
        self.onAbort = onAbort
    }

    private var hasContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    /// Mirrors desktop SessionComposer: Stop (■) replaces Send (↑) while working/streaming
    /// unless the user types a follow-up (in which case it smoothly switches to Queue ↑).
    private var showsStopButton: Bool {
        (isStreaming || isAgentBusy) && (session.isMaster || !hasContent)
    }

    private var isQueueMode: Bool {
        isAgentBusy && !session.isMaster && hasContent
    }

    private var currentModelLabel: String {
        if let modelId = session.model,
           let matched = availableModels.first(where: { $0.id == modelId || $0.label == modelId }) {
            return matched.label
        }
        return session.model ?? HarnessVisual.forKind(session.harness).label
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(attachments) { att in
                            attachmentThumbnail(att)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 4)
                }
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
                    : (isAgentBusy ? "Type a follow-up to queue…" : "Ask anything…"),
                text: $text,
                axis: .vertical
            )
            .lineLimit(1...6)
            .font(SHTypography.body)
            .foregroundStyle(SHColor.inkPrimary)
            .padding(.horizontal, 14)
            .padding(.top, 11)
            .padding(.bottom, 8)
            .accessibilityIdentifier("composer.input")

            HStack(spacing: 8) {
                PhotosPicker(
                    selection: $selectedPhotoItems,
                    maxSelectionCount: 4,
                    matching: .images
                ) {
                    Image(systemName: "photo.badge.plus")
                        .font(.system(size: 15.5, weight: .medium))
                        .foregroundStyle(SHColor.inkMuted)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .onChange(of: selectedPhotoItems) { _, newItems in
                    guard !newItems.isEmpty else { return }
                    let items = newItems
                    selectedPhotoItems = []
                    Task {
                        for (index, item) in items.enumerated() {
                            if let rawData = try? await item.loadTransferable(type: Data.self) {
                                let jpeg = await Task.detached(priority: .userInitiated) {
                                    Self.compressedJPEG(from: rawData) ?? rawData
                                }.value
                                onPickPhotoData(jpeg, "photo-\(index + 1).jpg")
                            }
                        }
                    }
                }
                .accessibilityLabel("Attach image")

                // Interactive Model & Effort menus (for non-Master sessions when catalog is available)
                modelAndEffortControls

                Spacer(minLength: 4)

                if isQueueMode {
                    Text("Queue")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(SHColor.statusWarning)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(SHColor.statusWarning.opacity(0.14))
                        .clipShape(Capsule())
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }

                if onTranscribeAudio != nil {
                    micButton
                }

                actionButton
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 10)
        }
        .background(SHColor.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.xl, style: .continuous))
        .animation(.easeInOut(duration: 0.16), value: showsStopButton)
        .animation(.easeInOut(duration: 0.16), value: isQueueMode)
        .animation(.easeInOut(duration: 0.16), value: dictation.state)
        .onDisappear {
            if dictation.state == .recording {
                dictation.cancel()
            }
        }
    }

    @ViewBuilder
    private var modelAndEffortControls: some View {
        if !session.isMaster && !availableModels.isEmpty, let onSelectModel {
            HStack(spacing: 6) {
                Menu {
                    ForEach(availableModels) { option in
                        Button {
                            onSelectModel(option)
                        } label: {
                            if session.model == option.id || session.model == option.label {
                                Label(option.label, systemImage: "checkmark")
                            } else {
                                Text(option.label)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        HarnessLogoView(harness: session.harness, size: 12.5)
                        Text(currentModelLabel)
                            .font(SHTypography.micro.weight(.medium))
                            .foregroundStyle(SHColor.inkSecondary)
                            .lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 8.5, weight: .semibold))
                            .foregroundStyle(SHColor.inkFaint)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(SHColor.surfaceSubtle)
                    .clipShape(Capsule())
                }
                .accessibilityLabel("Switch model")

                if !reasoningLevels.isEmpty, let onSelectReasoningEffort {
                    Menu {
                        ForEach(reasoningLevels, id: \.self) { level in
                            Button {
                                onSelectReasoningEffort(level)
                            } label: {
                                if session.reasoningEffort == level {
                                    Label(level.capitalized, systemImage: "checkmark")
                                } else {
                                    Text(level.capitalized)
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "sparkles")
                                .font(.system(size: 9.5, weight: .semibold))
                                .foregroundStyle(SHColor.harness(session.harness))
                            Text((session.reasoningEffort ?? reasoningLevels.last ?? "High").capitalized)
                                .font(SHTypography.micro.weight(.medium))
                                .foregroundStyle(SHColor.inkSecondary)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(SHColor.surfaceSubtle)
                        .clipShape(Capsule())
                    }
                    .accessibilityLabel("Switch thinking effort")
                }
            }
        } else {
            HStack(spacing: 6) {
                HarnessLogoView(harness: session.harness, size: 13)
                Text(currentModelLabel)
                    .font(SHTypography.micro)
                    .foregroundStyle(SHColor.inkMuted)
                    .lineLimit(1)
            }
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
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(SHColor.inkMuted)
                    .frame(width: 30, height: 30)
                    .background(SHColor.surfaceSubtle)
                    .clipShape(Circle())
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
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(SHColor.statusDanger.opacity(0.16))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop recording and transcribe")
            .accessibilityIdentifier("composer.mic")

        case .transcribing:
            HStack(spacing: 5) {
                ProgressView()
                    .controlSize(.mini)
                    .tint(SHColor.brandAntigravity)
            }
            .frame(width: 30, height: 30)
            .background(SHColor.surfaceSubtle)
            .clipShape(Circle())
            .accessibilityLabel("Transcribing voice dictation")
            .accessibilityIdentifier("composer.mic")
        }
    }

    private func handleDictationTap() async {
        guard let transcribe = onTranscribeAudio else { return }
        if let spoken = await dictation.toggleRecording(transcribe: transcribe), !spoken.isEmpty {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                text = spoken
            } else {
                text = text.hasSuffix(" ") || text.hasSuffix("\n") ? text + spoken : text + " " + spoken
            }
        }
    }

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
                    .background(SHColor.inkPrimary)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop agent")
            .accessibilityIdentifier("composer.stop")
        } else {
            Button {
                triggerHaptic(.light)
                onSend()
            } label: {
                Group {
                    if isSending {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(SHColor.surfaceRail)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(SHColor.surfaceRail)
                    }
                }
                .frame(width: 32, height: 32)
                .background(isQueueMode ? SHColor.statusWarning : SHColor.inkPrimary)
                .opacity(hasContent && !isSending ? 1.0 : 0.25)
                .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!hasContent || isSending)
            .accessibilityLabel(isQueueMode ? "Queue follow-up message" : "Send message")
            .accessibilityIdentifier("composer.send")
        }
    }

    private func attachmentThumbnail(_ att: ImageAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            Button {
                onTapAttachment(att)
            } label: {
                Group {
                    if let uiImage = DataURLImageDecoder.decode(att.previewDataUrl) {
                        Image(uiImage: uiImage)
                            .resizable()
                            .scaledToFill()
                    } else {
                        ZStack {
                            SHColor.surfaceRaised
                            Image(systemName: "photo")
                                .foregroundStyle(SHColor.inkMuted)
                        }
                    }
                }
                .frame(width: 54, height: 54)
                .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
                .overlay {
                    if uploadingAttachmentIds.contains(att.id) {
                        ZStack {
                            Color.black.opacity(0.38)
                            ProgressView()
                                .controlSize(.mini)
                                .tint(.white)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
                    }
                }
            }
            .buttonStyle(.plain)

            Button {
                onRemoveAttachment(att.id)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 16))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(SHColor.inkPrimary, SHColor.surfaceRail)
            }
            .buttonStyle(.plain)
            .offset(x: 4, y: -4)
            .accessibilityLabel("Remove \(att.name)")
        }
    }

    private func triggerHaptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: style).impactOccurred()
        #endif
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

    nonisolated private static func compressedJPEG(from data: Data) -> Data? {
        downscaledJPEG(from: data, maxDimension: 1600, quality: 0.75)
    }
}
