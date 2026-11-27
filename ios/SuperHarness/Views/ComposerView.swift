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
    public let harness: HarnessKind
    public let model: String?
    public let reasoningEffort: String?
    public let placeholder: String
    public let allowsQueueMenu: Bool
    public let modelMenuIdentifier: String
    @Binding public var text: String
    public let attachments: [ImageAttachment]
    public let uploadingAttachmentIds: Set<String>
    public let availableModels: [HarnessModelOption]
    public let reasoningLevels: [String]
    /// The harness's own default effort from the host's catalog, used when neither the session
    /// nor its model names one.
    public let harnessDefaultEffort: String?
    public let isSending: Bool
    public let isStreaming: Bool
    public let isAgentBusy: Bool
    public let onPickPhotoData: (Data, String) -> Void
    public let onPickFileData: ((Data, String, String, Data?) -> Void)?
    /// Why the mic cannot be used (dictation not set up on the desktop), or nil when it can.
    public let dictationUnavailableReason: String?
    public let onRemoveAttachment: (String) -> Void
    public let onTapAttachment: (ImageAttachment) -> Void
    public let onSelectModel: ((HarnessModelOption) -> Void)?
    public let onSelectReasoningEffort: ((String) -> Void)?
    public let onSelectModelAndEffort: ((HarnessModelOption, String?) -> Void)?
    public let onTranscribeAudio: ((Data) async throws -> String)?
    /// Runs when recording starts, so the host connection can be opened while the user speaks.
    public let onDictationStart: (@MainActor () async -> Void)?
    public let onSend: (SendMode) -> Void
    public let onAbort: () -> Void

    @State private var selectedMediaItems: [PhotosPickerItem] = []
    @State private var isDictationReasonPresented = false
    @State private var isPhotoPickerPresented: Bool = false
    @State private var isFileImporterPresented: Bool = false
    @State private var dictation = DictationController()
    /// Set when send is tapped while dictation is recording or transcribing: the message goes
    /// out with this mode as soon as the dictated text has landed in the composer.
    @State private var pendingSendMode: SendMode?
    /// Bumped when dictated text lands, so the text view scrolls to its end.
    @State private var scrollToEndToken: Int = 0
    @State private var focusInputToken: Int = 0

    /// Unified initializer shared by both live chat threads and the New Thread draft view.
    public init(
        harness: HarnessKind,
        model: String?,
        reasoningEffort: String?,
        placeholder: String? = nil,
        allowsQueueMenu: Bool = true,
        modelMenuIdentifier: String = "composer.model",
        text: Binding<String>,
        attachments: [ImageAttachment],
        uploadingAttachmentIds: Set<String> = [],
        availableModels: [HarnessModelOption] = [],
        reasoningLevels: [String] = [],
        harnessDefaultEffort: String? = nil,
        isSending: Bool,
        isStreaming: Bool = false,
        isAgentBusy: Bool = false,
        onPickPhotoData: @escaping (Data, String) -> Void,
        onPickFileData: ((Data, String, String, Data?) -> Void)? = nil,
        dictationUnavailableReason: String? = nil,
        onRemoveAttachment: @escaping (String) -> Void,
        onTapAttachment: @escaping (ImageAttachment) -> Void,
        onSelectModel: ((HarnessModelOption) -> Void)? = nil,
        onSelectReasoningEffort: ((String) -> Void)? = nil,
        onSelectModelAndEffort: ((HarnessModelOption, String?) -> Void)? = nil,
        onTranscribeAudio: ((Data) async throws -> String)? = nil,
        onDictationStart: (@MainActor () async -> Void)? = nil,
        onSend: @escaping (SendMode) -> Void,
        onAbort: @escaping () -> Void = {}
    ) {
        self.harness = harness
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.placeholder = placeholder
            ?? (harness == .master
                ? "Ask Master Orchestrator anything, or /status…"
                : "Message \(HarnessVisual.forKind(harness).label)…")
        self.allowsQueueMenu = allowsQueueMenu
        self.modelMenuIdentifier = modelMenuIdentifier
        self._text = text
        self.attachments = attachments
        self.uploadingAttachmentIds = uploadingAttachmentIds
        self.availableModels = availableModels
        self.reasoningLevels = reasoningLevels
        self.harnessDefaultEffort = harnessDefaultEffort
        self.isSending = isSending
        self.isStreaming = isStreaming
        self.isAgentBusy = isAgentBusy
        self.onPickPhotoData = onPickPhotoData
        self.onPickFileData = onPickFileData
        self.dictationUnavailableReason = dictationUnavailableReason
        self.onRemoveAttachment = onRemoveAttachment
        self.onTapAttachment = onTapAttachment
        self.onSelectModel = onSelectModel
        self.onSelectReasoningEffort = onSelectReasoningEffort
        self.onSelectModelAndEffort = onSelectModelAndEffort
        self.onTranscribeAudio = onTranscribeAudio
        self.onDictationStart = onDictationStart
        self.onSend = onSend
        self.onAbort = onAbort
    }

    public init(
        session: UnifiedSession,
        text: Binding<String>,
        attachments: [ImageAttachment],
        uploadingAttachmentIds: Set<String> = [],
        availableModels: [HarnessModelOption] = [],
        reasoningLevels: [String] = [],
        harnessDefaultEffort: String? = nil,
        isSending: Bool,
        isStreaming: Bool,
        isAgentBusy: Bool,
        onPickPhotoData: @escaping (Data, String) -> Void,
        onPickFileData: ((Data, String, String, Data?) -> Void)? = nil,
        dictationUnavailableReason: String? = nil,
        onRemoveAttachment: @escaping (String) -> Void,
        onTapAttachment: @escaping (ImageAttachment) -> Void,
        onSelectModel: ((HarnessModelOption) -> Void)? = nil,
        onSelectReasoningEffort: ((String) -> Void)? = nil,
        onSelectModelAndEffort: ((HarnessModelOption, String?) -> Void)? = nil,
        onTranscribeAudio: ((Data) async throws -> String)? = nil,
        onDictationStart: (@MainActor () async -> Void)? = nil,
        onSend: @escaping (SendMode) -> Void,
        onAbort: @escaping () -> Void
    ) {
        self.init(
            harness: session.harness,
            model: session.model,
            reasoningEffort: session.reasoningEffort,
            placeholder: session.isMaster
                ? "Ask Master Orchestrator anything, or /status…"
                : "Message \(HarnessVisual.forKind(session.harness).label)…",
            allowsQueueMenu: true,
            modelMenuIdentifier: "composer.model",
            text: text,
            attachments: attachments,
            uploadingAttachmentIds: uploadingAttachmentIds,
            availableModels: availableModels,
            reasoningLevels: reasoningLevels,
            harnessDefaultEffort: harnessDefaultEffort,
            isSending: isSending,
            isStreaming: isStreaming,
            isAgentBusy: isAgentBusy,
            onPickPhotoData: onPickPhotoData,
            onPickFileData: onPickFileData,
            dictationUnavailableReason: dictationUnavailableReason,
            onRemoveAttachment: onRemoveAttachment,
            onTapAttachment: onTapAttachment,
            onSelectModel: onSelectModel,
            onSelectReasoningEffort: onSelectReasoningEffort,
            onSelectModelAndEffort: onSelectModelAndEffort,
            onTranscribeAudio: onTranscribeAudio,
            onDictationStart: onDictationStart,
            onSend: onSend,
            onAbort: onAbort
        )
    }

    private var hasContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    private var showsStopButton: Bool {
        (isStreaming || isAgentBusy) && !hasContent && dictation.state == .idle
    }

    private static let effortSuffixes = ["-low", "-medium", "-high", "-xhigh", "-max"]

    nonisolated static func baseModelStem(_ id: String) -> String {
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

    nonisolated static func cleanBaseDisplayLabel(_ label: String) -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let effortTags = [
            " (none)",
            " (minimal)",
            " (low)",
            " (medium)",
            " (high)",
            " (xhigh)",
            " (extra high)",
            " (max)",
            " (ultra)",
        ]
        let lowered = trimmed.lowercased()
        for tag in effortTags where lowered.hasSuffix(tag) {
            return String(trimmed.dropLast(tag.count))
        }
        return trimmed
    }

    /// Resolves the model ID and next thinking effort when picking a model from the menu.
    /// Shared by live chat sessions and the new-thread draft view.
    nonisolated static func resolveModelSelection(
        picked: HarnessModelOption,
        currentEffort: String?,
        availableModels: [HarnessModelOption],
        allowExtreme: Bool
    ) -> (modelId: String, effort: String?) {
        let levels = ReasoningEffortPolicy.offered(picked.reasoningLevels ?? [], allowExtreme: allowExtreme)
        guard !levels.isEmpty else {
            return (picked.id, nil)
        }
        let nextEffort: String?
        if let existing = currentEffort,
           let matched = levels.first(where: { $0.lowercased() == existing.lowercased() }) {
            nextEffort = matched
        } else {
            nextEffort = ReasoningEffortPolicy.defaultLevel(
                from: levels,
                preferred: picked.defaultReasoningLevel,
                allowExtreme: allowExtreme
            )
        }
        // If this harness encodes effort in sibling model slugs (e.g. Antigravity gemini-4-neon-high),
        // map to the matching sibling slug for `nextEffort` when present.
        if let nextEffort {
            let resolved = resolveEffortSelection(
                effort: nextEffort,
                currentModel: picked.id,
                availableModels: availableModels
            )
            return (resolved.modelId ?? picked.id, resolved.effort)
        }
        return (picked.id, nextEffort)
    }

    /// Resolves the target model slug and effort when scrubbing or tapping a thinking effort level.
    /// For Antigravity, effort variants are sibling model slugs (e.g. `gemini-4-neon-high` -> `gemini-4-neon-medium`).
    nonisolated static func resolveEffortSelection(
        effort: String,
        currentModel: String?,
        availableModels: [HarnessModelOption]
    ) -> (modelId: String?, effort: String) {
        var targetModel = currentModel
        if let raw = currentModel {
            let lower = raw.lowercased()
            for suf in effortSuffixes where lower.hasSuffix(suf) {
                let candidate = String(raw.dropLast(suf.count)) + "-" + effort.lowercased()
                if let match = availableModels.first(where: { $0.id.lowercased() == candidate.lowercased() }) {
                    targetModel = match.id
                }
                break
            }
        }
        return (targetModel, effort)
    }

    /// Deduplicates sibling effort-suffixed slugs (e.g. Antigravity `gemini-4-neon-high` / `-medium`)
    /// so the Model menu stays clean while the Thinking Effort slider switches the effort variant.
    private var menuModelOptions: [(stem: String, displayLabel: String, representative: HarnessModelOption)] {
        var seen: [String] = []
        var byStem: [String: HarnessModelOption] = [:]
        let activeStem = model.map(Self.baseModelStem)
        for opt in availableModels {
            let stem = Self.baseModelStem(opt.id)
            if byStem[stem] == nil {
                seen.append(stem)
                byStem[stem] = opt
            } else if stem == activeStem && opt.id == model {
                byStem[stem] = opt
            }
        }
        return seen.compactMap { stem in
            guard let rep = byStem[stem] else { return nil }
            return (stem, Self.cleanBaseDisplayLabel(rep.label), rep)
        }
    }

    /// The menu row that stands for the model in use. It follows the same rules as the label
    /// on the pill, so the row with the checkmark is always the model the pill names: the
    /// session's model by its stem, else by a catalog id, label or alias, and for a session
    /// that reports no model, the harness's default.
    nonisolated static func selectedModelStem(model: String?, availableModels: [HarnessModelOption]) -> String? {
        let stems = Set(availableModels.map { baseModelStem($0.id) })
        if let raw = model, !raw.isEmpty {
            let stem = baseModelStem(raw)
            if stems.contains(stem) { return stem }
            return availableModels.first(where: { $0.matches(raw) || $0.matches(stem) }).map { baseModelStem($0.id) }
        }
        let fallback = availableModels.first(where: { $0.isDefault == true }) ?? availableModels.first
        return fallback.map { baseModelStem($0.id) }
    }

    private var currentModelLabel: String {
        if let raw = model, !raw.isEmpty {
            if let match = availableModels.first(where: { $0.matches(raw) }) {
                return Self.cleanBaseDisplayLabel(match.label)
            }
            return Self.cleanBaseDisplayLabel(Self.baseModelStem(raw))
        }
        if let def = availableModels.first(where: { $0.isDefault == true }) ?? availableModels.first {
            return Self.cleanBaseDisplayLabel(def.label)
        }
        return HarnessVisual.forKind(harness).label
    }

    /// The effort the session is using. A session that reports none (most do: a harness only
    /// records an effort that was set explicitly) runs at its model's default, or else the
    /// harness's default. When none of these is known there is no effort to show; the highest
    /// offered level is never assumed.
    nonisolated static func resolvedEffort(
        embedded: String?,
        sessionEffort: String?,
        modelDefault: String?,
        harnessDefault: String?
    ) -> String? {
        for candidate in [embedded, sessionEffort, modelDefault, harnessDefault] {
            if let candidate, !candidate.isEmpty { return candidate }
        }
        return nil
    }

    /// The catalog entry for the active model, or the harness's default model when none is set.
    private var currentModelOption: HarnessModelOption? {
        if let raw = model, !raw.isEmpty {
            return availableModels.first(where: { $0.matches(raw) })
        }
        return availableModels.first(where: { $0.isDefault == true })
    }

    private var activeEffort: String? {
        Self.resolvedEffort(
            embedded: Self.embeddedEffort(from: model),
            sessionEffort: reasoningEffort,
            modelDefault: currentModelOption?.defaultReasoningLevel,
            harnessDefault: harnessDefaultEffort
        )
    }

    private var currentEffortLabel: String? {
        if let embedded = Self.embeddedEffort(from: model) {
            return SHThinkingEffortSlider.displayName(for: embedded)
        }
        guard !reasoningLevels.isEmpty else { return nil }
        return activeEffort.map(SHThinkingEffortSlider.displayName(for:))
    }

    /// Height of every control in the composer's bottom row (and the width of the round ones).
    static let controlSize: CGFloat = SHLayout.controlSize

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

                SHPasteableTextInput(
                    text: $text,
                    placeholder: placeholder,
                    isLocked: dictation.state == .transcribing,
                    scrollToEndToken: scrollToEndToken,
                    focusToken: focusInputToken,
                    onPasteMedia: { handleClipboardPaste() }
                )
                .padding(.horizontal, 16)
                .padding(.top, 19)
                .padding(.bottom, 17)
                .contentShape(Rectangle())
                .onTapGesture {
                    focusInputToken += 1
                }

                HStack(spacing: 8) {
                    attachMenuButton
                    // The pill takes the width its text needs before the flexible gap gets any;
                    // without the priority the gap and the pill split the row and the text truncates.
                    combinedModelEffortPill
                        .layoutPriority(1)
                    Color.clear
                        .frame(minWidth: 4, maxWidth: .infinity, minHeight: Self.controlSize, maxHeight: Self.controlSize)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            focusInputToken += 1
                        }
                    if onTranscribeAudio != nil {
                        micButton
                    }
                    actionButton
                }
                .padding(.horizontal, 11)
                .padding(.bottom, 11)
            }
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 14, coordinateSpace: .local)
                .onEnded { value in
                    let dy = value.translation.height
                    let dx = abs(value.translation.width)
                    if dy > 22 && dy > dx * 1.25 {
                        dismissKeyboard()
                    }
                }
        )
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
            pendingSendMode = nil
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
                Label("Files", systemImage: "folder")
            }
            Button {
                handleClipboardPaste(allowTextFallback: true)
            } label: {
                Label("Paste", systemImage: "doc.on.clipboard")
            }
        } label: {
            SHRoundControlLabel(systemImage: "plus", symbolSize: 16.5)
        }
        .accessibilityLabel("Attach media or file")
        .accessibilityIdentifier("composer.attach")
    }

    @ViewBuilder
    private var combinedModelEffortPill: some View {
        if !availableModels.isEmpty, let onSelectModel {
            let currentStem = Self.selectedModelStem(model: model, availableModels: availableModels)
            let options = menuModelOptions
            SHModelEffortMenu(
                models: options.map { item in
                    SHModelEffortMenu.ModelItem(
                        id: item.stem,
                        label: item.displayLabel,
                        isSelected: currentStem == item.stem
                    )
                },
                efforts: onSelectReasoningEffort == nil ? [] : reasoningLevels.map { level in
                    SHModelEffortMenu.EffortItem(level: level, isSelected: activeEffort?.lowercased() == level.lowercased())
                },
                harness: harness,
                title: currentModelLabel,
                effortLabel: currentEffortLabel,
                accessibilityText: "Switch model and effort",
                identifier: modelMenuIdentifier,
                onSelectModel: { stem in
                    if let match = options.first(where: { $0.stem == stem }) {
                        onSelectModel(match.representative)
                    }
                },
                onSelectEffort: { level in onSelectReasoningEffort?(level) },
                onCommitModelAndEffort: { stem, effort in
                    guard let match = options.first(where: { $0.stem == stem }) else { return }
                    if let onSelectModelAndEffort {
                        onSelectModelAndEffort(match.representative, effort)
                    } else {
                        onSelectModel(match.representative)
                    }
                }
            )
            .equatable()
        } else {
            HStack(spacing: 5) {
                HarnessLogoView(harness: harness, size: 12.5)
                Text(currentModelLabel)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(SHColor.inkMuted)
                    .lineLimit(1)
            }
            .padding(.horizontal, 12)
            .frame(height: ComposerView.controlSize)
            .shRaisedControl(SHColor.surfaceBubble.opacity(0.6), in: Capsule())
        }
    }

    @ViewBuilder
    private var micButton: some View {
        switch dictation.state {
        case .idle:
            if let reason = dictationUnavailableReason {
                // Dictation is not set up on the desktop: the mic is shown dimmed and a tap
                // explains why instead of starting a recording.
                Button {
                    isDictationReasonPresented = true
                } label: {
                    Image(systemName: "mic.slash.fill")
                        .font(.system(size: 15.5, weight: .medium))
                        .foregroundStyle(SHColor.inkFaint)
                        .frame(width: Self.controlSize, height: Self.controlSize)
                        .shRaisedControl(SHColor.surfaceBubble.opacity(0.5), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Voice dictation unavailable")
                .accessibilityHint(reason)
                .accessibilityIdentifier("composer.mic.unavailable")
                .alert("Dictation Isn’t Set Up", isPresented: $isDictationReasonPresented) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text("\(reason).")
                }
            } else {
                Button {
                    triggerHaptic(.light)
                    Task { await handleDictationTap() }
                } label: {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 15.5, weight: .medium))
                        .foregroundStyle(SHColor.inkMuted)
                        .frame(width: Self.controlSize, height: Self.controlSize)
                        .shRaisedControl(SHColor.surfaceBubble, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Start voice dictation")
                .accessibilityIdentifier("composer.mic")
            }

        case .recording:
            Button {
                triggerHaptic(.medium)
                Task { await handleDictationTap() }
            } label: {
                HStack(spacing: 6) {
                    // Level bars and a stop mark; the elapsed time is not shown.
                    SHAudioLevelBars(levels: dictation.levelHistory, tint: SHColor.statusDanger)
                    Image(systemName: "stop.fill")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(SHColor.statusDanger)
                }
                .padding(.horizontal, 13)
                .frame(height: ComposerView.controlSize)
                .shRaisedControl(SHColor.statusDanger.opacity(0.16), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop recording and transcribe")
            .accessibilityIdentifier("composer.mic")

        case .transcribing:
            SHActivityPulse(tint: SHColor.accentInfo, size: 12)
                .frame(width: Self.controlSize, height: Self.controlSize)
                .shRaisedControl(SHColor.surfaceBubble, in: Circle())
                .accessibilityLabel("Transcribing voice dictation")
                .accessibilityIdentifier("composer.mic")
        }
    }

    private func handleDictationTap() async {
        guard let transcribe = onTranscribeAudio else { return }
        let wasRecording = dictation.state == .recording
        let spoken = await dictation.toggleRecording(prewarm: onDictationStart, transcribe: transcribe)
        if let spoken, !spoken.isEmpty {
            text = ComposerDictation.appending(spoken, to: text)
            scrollToEndToken += 1
        }
        guard wasRecording, let mode = pendingSendMode else { return }
        pendingSendMode = nil
        // A failed transcription leaves the composer text as it is and sends nothing.
        if ComposerDictation.shouldSendAfterFinalizing(text: text, hasAttachments: !attachments.isEmpty, errorMessage: dictation.errorMessage) {
            onSend(mode)
        }
    }

    /// Send, finishing any in-progress dictation first so the dictated text is part of the message.
    private func handleSendTap(_ mode: SendMode) {
        switch dictation.state {
        case .idle:
            onSend(mode)
        case .recording:
            guard pendingSendMode == nil else { return }
            pendingSendMode = mode
            Task { await handleDictationTap() }
        case .transcribing:
            // The stop tap's task is already waiting on the transcription and will send.
            pendingSendMode = mode
        }
    }

    private var isFinalizingDictationForSend: Bool { pendingSendMode != nil }

    /// Default tap immediately steers (`SendMode.steer`). Long-press opens a menu to Steer Now or Queue for Later.
    @ViewBuilder
    private var actionButton: some View {
        if showsStopButton {
            Button {
                triggerHaptic(.medium)
                onAbort()
            } label: {
                SHRoundControlLabel(systemImage: "stop.fill", symbolSize: 13, weight: .bold, isProminent: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop agent")
            .accessibilityIdentifier("composer.stop")
        } else {
            let canSend = (hasContent || dictation.state != .idle) && !isSending && !isFinalizingDictationForSend
            ZStack {
                Group {
                    if isSending || isFinalizingDictationForSend {
                        SHActivityPulse(tint: SHColor.surfaceRail, size: 11)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(SHColor.surfaceRail)
                    }
                }
                .frame(width: Self.controlSize, height: Self.controlSize)
                .shRaisedControl(SHColor.inkPrimary, in: Circle())
                .opacity(canSend ? 1.0 : 0.28)

                #if canImport(UIKit)
                if allowsQueueMenu {
                    SHSendMenuButton(
                        isEnabled: canSend,
                        onSteer: {
                            triggerHaptic(.light)
                            handleSendTap(.steer)
                        },
                        onQueue: {
                            triggerHaptic(.light)
                            handleSendTap(.queue)
                        }
                    )
                    .frame(width: Self.controlSize, height: Self.controlSize)
                } else {
                    Button {
                        triggerHaptic(.light)
                        handleSendTap(.steer)
                    } label: {
                        // Color.clear alone takes no taps: the shape makes the whole circle the hit area.
                        Color.clear
                            .frame(width: Self.controlSize, height: Self.controlSize)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                }
                #else
                Button {
                    triggerHaptic(.light)
                    handleSendTap(.steer)
                } label: {
                    Color.clear
                        .frame(width: Self.controlSize, height: Self.controlSize)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                #endif
            }
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("composer.send")
        }
    }


    // MARK: - Clipboard Paste (Images, Videos, Files, and Text)

    private func handleClipboardPaste(allowTextFallback: Bool = false) {
        #if canImport(UIKit)
        let pb = UIPasteboard.general
        let providers = pb.itemProviders

        // 1. Direct UIImage(s) on pasteboard (screenshots, copied photos, browser images)
        if let images = pb.images, !images.isEmpty {
            let picked = Array(images.prefix(4))
            Task {
                for (idx, img) in picked.enumerated() {
                    let jpeg = await Task.detached(priority: .userInitiated) { () -> Data? in
                        guard let raw = img.jpegData(compressionQuality: 0.9) ?? img.pngData() else { return nil }
                        return Self.downscaledJPEG(from: raw, maxDimension: 1600, quality: 0.75) ?? raw
                    }.value
                    if let jpeg {
                        onPickPhotoData(jpeg, "pasted-image-\(idx + 1).jpg")
                    }
                }
            }
            return
        }

        // 2. Videos, PDFs, or generic files via NSItemProvider
        let mediaProviders = providers.filter { prov in
            prov.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
                || prov.hasItemConformingToTypeIdentifier(UTType.video.identifier)
                || prov.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                || prov.hasItemConformingToTypeIdentifier(UTType.pdf.identifier)
                || prov.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
                || ClipboardAttachables.fileTypeIdentifier(in: prov.registeredTypeIdentifiers) != nil
        }
        if !mediaProviders.isEmpty {
            for (idx, prov) in mediaProviders.prefix(4).enumerated() {
                if prov.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
                    || prov.hasItemConformingToTypeIdentifier(UTType.video.identifier) {
                    let typeId = prov.hasItemConformingToTypeIdentifier(UTType.mpeg4Movie.identifier)
                        ? UTType.mpeg4Movie.identifier
                        : UTType.movie.identifier
                    prov.loadFileRepresentation(forTypeIdentifier: typeId) { url, _ in
                        guard let url else { return }
                        let ext = url.pathExtension.isEmpty ? "mov" : url.pathExtension.lowercased()
                        let tmp = FileManager.default.temporaryDirectory
                            .appendingPathComponent("sh-paste-video-\(UUID().uuidString).\(ext)")
                        guard (try? FileManager.default.copyItem(at: url, to: tmp)) != nil else { return }
                        Task {
                            let prepared = await Task.detached(priority: .userInitiated) { () -> (Data, String, String, Data?)? in
                                defer { try? FileManager.default.removeItem(at: tmp) }
                                guard let raw = try? Data(contentsOf: tmp), !raw.isEmpty else { return nil }
                                let mime = ext == "mp4" ? "video/mp4" : "video/quicktime"
                                let thumb = await Self.videoThumbnailJPEG(url: tmp)
                                return (raw, mime, "pasted-video-\(idx + 1).\(ext)", thumb)
                            }.value
                            if let (data, mime, name, thumb) = prepared {
                                await MainActor.run {
                                    onPickFileData?(data, mime, name, thumb)
                                }
                            }
                        }
                    }
                } else if prov.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    prov.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                        guard let data, !data.isEmpty else { return }
                        Task {
                            let jpeg = await Task.detached(priority: .userInitiated) {
                                Self.downscaledJPEG(from: data, maxDimension: 1600, quality: 0.75) ?? data
                            }.value
                            await MainActor.run {
                                onPickPhotoData(jpeg, "pasted-image-\(idx + 1).jpg")
                            }
                        }
                    }
                } else if prov.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
                    let pdfName = (prov.suggestedName?.isEmpty == false ? prov.suggestedName! : "pasted-document-\(idx + 1)") + ".pdf"
                    prov.loadDataRepresentation(forTypeIdentifier: UTType.pdf.identifier) { data, _ in
                        guard let data, !data.isEmpty else { return }
                        Task { @MainActor in
                            onPickFileData?(data, "application/pdf", pdfName, nil)
                        }
                    }
                } else if !prov.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
                          let typeId = ClipboardAttachables.fileTypeIdentifier(in: prov.registeredTypeIdentifiers) {
                    // Any other file placed on the clipboard as data (a zip shared from
                    // another app, for example).
                    let suggested = prov.suggestedName
                    prov.loadFileRepresentation(forTypeIdentifier: typeId) { url, _ in
                        guard let url else { return }
                        let name = ClipboardAttachables.fileName(suggested: suggested, typeIdentifier: typeId, fallbackURL: url, index: idx)
                        let tmp = FileManager.default.temporaryDirectory
                            .appendingPathComponent("sh-paste-\(UUID().uuidString)", isDirectory: true)
                        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
                        let dest = tmp.appendingPathComponent(name)
                        guard (try? FileManager.default.copyItem(at: url, to: dest)) != nil else { return }
                        Task { @MainActor in
                            handleImportedFiles(.success([dest]))
                        }
                    }
                } else if prov.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    prov.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                        let fileURL: URL?
                        if let u = item as? URL {
                            fileURL = u
                        } else if let d = item as? Data {
                            fileURL = URL(dataRepresentation: d, relativeTo: nil)
                        } else {
                            fileURL = nil
                        }
                        guard let fileURL else { return }
                        Task { @MainActor in
                            handleImportedFiles(.success([fileURL]))
                        }
                    }
                }
            }
            return
        }

        // 3. Plain text fallback (used when triggered from the '+' menu)
        if allowTextFallback, let str = pb.string, !str.isEmpty {
            if text.isEmpty {
                text = str
            } else {
                text += (text.hasSuffix(" ") || text.hasSuffix("\n") ? "" : " ") + str
            }
        }
        #endif
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

    private func dismissKeyboard() {
        #if canImport(UIKit)
        let resigned = UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
        if resigned {
            triggerHaptic(.light)
        }
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


// MARK: - Clipboard Items That Attach as Files

/// Decides whether a clipboard item is a file to attach, as opposed to text to insert.
enum ClipboardAttachables {
    /// The type to load when a clipboard item should be attached as a file, or nil when the
    /// item is text, a link, or something the composer already handles (images, video, PDF,
    /// file URLs). An item that offers any text or URL form is treated as text, so copying a
    /// paragraph from a web page never turns into an attachment.
    nonisolated static func fileTypeIdentifier(in registeredTypeIdentifiers: [String]) -> String? {
        let types = registeredTypeIdentifiers.map { ($0, UTType($0)) }
        let isTextLike = types.contains { _, type in
            guard let type else { return false }
            return type.conforms(to: .text) || type.conforms(to: .url)
        }
        guard !isTextLike else { return nil }
        return types.first { id, type in
            guard let type else { return !id.hasPrefix("com.apple.") }
            if type.conforms(to: .image) || type.conforms(to: .movie) || type.conforms(to: .video)
                || type.conforms(to: .pdf) || type.conforms(to: .fileURL) {
                return false
            }
            return type.conforms(to: .data) || type.conforms(to: .item) || id.hasPrefix("dyn.")
        }?.0
    }

    /// A file name for a pasted item: the name the source app suggested, with the extension
    /// its type implies when the name has none.
    nonisolated static func fileName(suggested: String?, typeIdentifier: String, fallbackURL: URL?, index: Int) -> String {
        let trimmed = suggested?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var base = trimmed.isEmpty ? (fallbackURL?.deletingPathExtension().lastPathComponent ?? "") : trimmed
        if base.isEmpty { base = "pasted-file-\(index + 1)" }
        base = base.replacingOccurrences(of: "/", with: "-")
        if !(base as NSString).pathExtension.isEmpty { return base }
        let ext = UTType(typeIdentifier)?.preferredFilenameExtension
            ?? fallbackURL?.pathExtension
            ?? ""
        return ext.isEmpty ? base : "\(base).\(ext)"
    }
}

// MARK: - Paste-Aware Auto-Sizing Composer Input (Supports Pasting Images, Videos, Files & Text)

#if canImport(UIKit)
private final class SHPasteInterceptingTextView: UITextView, UIGestureRecognizerDelegate {
    var onPasteMedia: (() -> Void)?

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        let swipeDown = UISwipeGestureRecognizer(target: self, action: #selector(handleSwipeDownToDismiss))
        swipeDown.direction = .down
        swipeDown.delegate = self
        addGestureRecognizer(swipeDown)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func handleSwipeDownToDismiss() {
        guard isFirstResponder, !isScrollEnabled || contentOffset.y <= 1 else { return }
        resignFirstResponder()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }

    private func clipboardHasAttachableMedia() -> Bool {
        let pb = UIPasteboard.general
        if pb.hasImages { return true }
        return pb.itemProviders.contains { prov in
            prov.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                || prov.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
                || prov.hasItemConformingToTypeIdentifier(UTType.video.identifier)
                || prov.hasItemConformingToTypeIdentifier(UTType.pdf.identifier)
                || prov.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
                || ClipboardAttachables.fileTypeIdentifier(in: prov.registeredTypeIdentifiers) != nil
        }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) && clipboardHasAttachableMedia() {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        if clipboardHasAttachableMedia(), let onPasteMedia {
            onPasteMedia()
            return
        }
        super.paste(sender)
    }
}

private struct SHPasteableTextInput: View {
    @Binding var text: String
    let placeholder: String
    /// While a transcription is in flight the text cannot be edited and a dot spinner shows.
    var isLocked: Bool = false
    var scrollToEndToken: Int = 0
    var focusToken: Int = 0
    let onPasteMedia: () -> Void
    @State private var measuredHeight: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: SHSpacing.xs) {
            ZStack(alignment: .topLeading) {
                if text.isEmpty && !isLocked {
                    Text(placeholder)
                        .font(SHTypography.body)
                        .foregroundStyle(SHColor.inkFaint)
                        .allowsHitTesting(false)
                }
                // The text view stays mounted in every state. Recreating it (as an earlier version
                // did when dictation started from an empty composer) left its measured height stale,
                // so the dictated text drew over the attachments and the toolbar.
                SHPasteableTextViewRepresentable(
                    text: $text,
                    measuredHeight: $measuredHeight,
                    isLocked: isLocked,
                    scrollToEndToken: scrollToEndToken,
                    focusToken: focusToken,
                    onPasteMedia: onPasteMedia
                )
                .frame(height: measuredHeight)
                .clipped()
                .opacity(isLocked ? 0.6 : 1)
                if text.isEmpty && isLocked {
                    SHDotSpinner(tint: SHColor.inkMuted)
                        .frame(height: 22, alignment: .leading)
                        .allowsHitTesting(false)
                        .accessibilityLabel("Transcribing")
                        .accessibilityIdentifier("composer.transcribing")
                }
            }
            if isLocked && !text.isEmpty {
                SHDotSpinner(tint: SHColor.inkMuted)
                    .frame(height: 12, alignment: .leading)
                    .accessibilityLabel("Transcribing")
                    .accessibilityIdentifier("composer.transcribing")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SHPasteableTextViewRepresentable: UIViewRepresentable {
    @Binding var text: String
    @Binding var measuredHeight: CGFloat
    var isLocked: Bool = false
    var scrollToEndToken: Int = 0
    var focusToken: Int = 0
    let onPasteMedia: () -> Void

    private static let minHeight: CGFloat = 22
    private static let maxHeight: CGFloat = 112

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> SHPasteInterceptingTextView {
        let tv = SHPasteInterceptingTextView()
        tv.delegate = context.coordinator
        tv.onPasteMedia = onPasteMedia
        tv.backgroundColor = .clear
        tv.font = UIFont.preferredFont(forTextStyle: .body)
        tv.textColor = UIColor(SHColor.inkPrimary)
        tv.tintColor = UIColor(SHColor.accentInfo)
        tv.keyboardAppearance = .dark
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.isScrollEnabled = false
        tv.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tv.accessibilityIdentifier = "composer.input"
        tv.text = text
        return tv
    }

    func updateUIView(_ uiView: SHPasteInterceptingTextView, context: Context) {
        uiView.onPasteMedia = onPasteMedia
        context.coordinator.parent = self
        if uiView.text != text && uiView.markedTextRange == nil {
            uiView.text = text
        }
        recalcHeight(uiView)
        if context.coordinator.lastFocusToken != focusToken {
            context.coordinator.lastFocusToken = focusToken
            if !isLocked && !uiView.isFirstResponder {
                DispatchQueue.main.async {
                    uiView.becomeFirstResponder()
                }
            }
        }
        if context.coordinator.lastScrollToEndToken != scrollToEndToken {
            context.coordinator.lastScrollToEndToken = scrollToEndToken
            // After the layout pass that sizes the grown text, put the caret at the end and show it.
            DispatchQueue.main.async {
                let end = uiView.endOfDocument
                uiView.selectedTextRange = uiView.textRange(from: end, to: end)
                let length = (uiView.text as NSString).length
                uiView.scrollRangeToVisible(NSRange(location: max(0, length - 1), length: length > 0 ? 1 : 0))
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: SHPasteInterceptingTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? uiView.bounds.width
        guard width > 10 else { return nil }
        let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let clamped = min(Self.maxHeight, max(Self.minHeight, ceil(fitting.height)))
        uiView.isScrollEnabled = fitting.height > Self.maxHeight + 1
        // Keep the SwiftUI frame in step with what the text needs, even when the text changed
        // before the view had a width (recalcHeight cannot measure then).
        if abs(measuredHeight - clamped) > 0.5 {
            DispatchQueue.main.async { measuredHeight = clamped }
        }
        return CGSize(width: width, height: clamped)
    }

    private func recalcHeight(_ tv: UITextView) {
        let width = tv.bounds.width
        guard width > 10 else { return }
        let fitting = tv.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let clamped = min(Self.maxHeight, max(Self.minHeight, ceil(fitting.height)))
        tv.isScrollEnabled = fitting.height > Self.maxHeight + 1
        if abs(measuredHeight - clamped) > 0.5 {
            DispatchQueue.main.async {
                measuredHeight = clamped
            }
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: SHPasteableTextViewRepresentable
        var lastScrollToEndToken: Int
        var lastFocusToken: Int

        init(_ parent: SHPasteableTextViewRepresentable) {
            self.parent = parent
            self.lastScrollToEndToken = parent.scrollToEndToken
            self.lastFocusToken = parent.focusToken
        }

        /// Typing is refused while a transcription is in flight; the keyboard stays up.
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            !parent.isLocked
        }

        func textViewDidChange(_ textView: UITextView) {
            let next = textView.text ?? ""
            if parent.text != next {
                parent.text = next
            }
            parent.recalcHeight(textView)
        }
    }
}
#else
private struct SHPasteableTextInput: View {
    @Binding var text: String
    let placeholder: String
    let onPasteMedia: () -> Void
    var body: some View {
        TextField(placeholder, text: $text, axis: .vertical)
            .lineLimit(1...5)
            .font(SHTypography.body)
            .foregroundStyle(SHColor.inkPrimary)
    }
}
#endif

/// Pure rules for combining dictated text with the composer, kept out of the view for testing.
enum ComposerDictation {
    static func appending(_ spoken: String, to text: String) -> String {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return spoken
        }
        return text.hasSuffix(" ") || text.hasSuffix("\n") ? text + spoken : text + " " + spoken
    }

    /// After send was tapped during dictation: send only when the transcription did not fail
    /// and there is something to send.
    static func shouldSendAfterFinalizing(text: String, hasAttachments: Bool, errorMessage: String?) -> Bool {
        guard errorMessage == nil else { return false }
        return hasAttachments || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// Live mic level bars shown while dictation records: thin rounded bars, newest level on the
/// right, each growing from a short resting height. Same proportions as the YapYap keyboard's
/// waveform (2pt bars, 2.5pt gaps, 3pt minimum height).
struct SHAudioLevelBars: View {
    let levels: [CGFloat]
    let tint: Color
    var height: CGFloat = 14

    var body: some View {
        HStack(alignment: .center, spacing: 2.5) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                Capsule()
                    .fill(tint)
                    .frame(width: 2, height: 3 + max(0, min(1, level)) * (height - 3))
            }
        }
        .frame(height: height)
        .animation(.linear(duration: 0.07), value: levels)
        .accessibilityHidden(true)
    }
}

/// Three small dots that brighten in turn; the "text is on its way" indicator in the composer.
struct SHDotSpinner: View {
    let tint: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20.0, paused: reduceMotion)) { context in
            let phase = context.date.timeIntervalSinceReferenceDate * 1.6
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    let wave = reduceMotion ? 0.5 : (sin((phase - Double(index) * 0.22) * 2 * .pi) + 1) / 2
                    Circle()
                        .fill(tint)
                        .frame(width: 5, height: 5)
                        .opacity(0.3 + 0.7 * wave)
                }
            }
        }
    }
}

/// Stepped discrete Thinking Effort slider displayed at the top of the coalesced Model + Thinking popover.
public struct SHThinkingEffortSlider: View {
    public let levels: [String]
    public let selectedLevel: String?
    public let accentColor: Color
    public let onSelect: (String) -> Void

    @State private var lastHapticIndex: Int?

    public init(
        levels: [String],
        selectedLevel: String?,
        accentColor: Color,
        onSelect: @escaping (String) -> Void
    ) {
        self.levels = levels
        self.selectedLevel = selectedLevel
        self.accentColor = accentColor
        self.onSelect = onSelect
    }

    public nonisolated static func displayName(for level: String) -> String {
        switch level.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "none": return "Off"
        case "off": return "Off"
        case "minimal": return "Minimal"
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "XHigh"
        case "max": return "Max"
        case "ultra": return "Ultra"
        default: return level.capitalized
        }
    }

    public nonisolated static func compactStopLabel(for level: String, totalStops: Int) -> String {
        let lower = level.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch lower {
        case "none", "off": return "Off"
        case "minimal": return totalStops >= 5 ? "Min" : "Minimal"
        case "low": return "Low"
        case "medium": return totalStops >= 4 ? "Med" : "Medium"
        case "high": return "High"
        case "xhigh": return totalStops >= 6 ? "XH" : "XHigh"
        case "max": return "Max"
        case "ultra": return totalStops >= 6 ? "Ult" : "Ultra"
        default: return level.capitalized
        }
    }

    /// Leading x of a stop label: the first and last labels are flush with the row's ends, and a
    /// middle label is centred on its dot at `stopX`, kept inside the row.
    public nonisolated static func stopLabelLeading(
        index: Int, count: Int, stopX: CGFloat, labelWidth: CGFloat, rowWidth: CGFloat
    ) -> CGFloat {
        let maxLeading = max(0, rowWidth - labelWidth)
        if index == 0 { return 0 }
        if index == count - 1 { return maxLeading }
        return min(max(stopX - labelWidth / 2, 0), maxLeading)
    }

    /// Maps a horizontal touch location inside `trackWidth` to the nearest discrete stop index.
    public nonisolated static func nearestStopIndex(x: CGFloat, trackWidth: CGFloat, count: Int) -> Int {
        guard count > 1, trackWidth > 0 else { return 0 }
        let clamped = min(max(x, 0), trackWidth)
        let ratio = clamped / trackWidth
        return min(count - 1, max(0, Int((ratio * CGFloat(count - 1)).rounded())))
    }

    private var selectedIndex: Int {
        guard !levels.isEmpty else { return 0 }
        if let sel = selectedLevel?.lowercased(),
           let idx = levels.firstIndex(where: { $0.lowercased() == sel }) {
            return idx
        }
        return 0
    }

    private var isOffSelection: Bool {
        guard let lvl = selectedLevel?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else {
            return false
        }
        return lvl == "none" || lvl == "off"
    }

    private var isExtremeSelection: Bool {
        guard let lvl = selectedLevel?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else {
            return false
        }
        return lvl == "max" || lvl == "ultra"
    }

    public var body: some View {
        let count = levels.count
        let idx = selectedIndex
        let trackHeight: CGFloat = 32
        let inset: CGFloat = 3
        let knobDiameter: CGFloat = trackHeight - inset * 2
        let knobRadius: CGFloat = knobDiameter / 2
        let travelPadding: CGFloat = inset + knobRadius
        let activeFillTint: Color = isExtremeSelection
            ? SHColor.statusWarning.opacity(0.78)
            : accentColor.opacity(0.76)

        VStack(spacing: 6) {
            GeometryReader { geo in
                let trackWidth = max(trackHeight, geo.size.width)
                let usableWidth = max(1, trackWidth - travelPadding * 2)
                let fraction: CGFloat = count > 1 ? CGFloat(idx) / CGFloat(count - 1) : 1.0
                let thumbX = travelPadding + usableWidth * fraction
                let fillWidth: CGFloat = isOffSelection ? 0 : min(trackWidth, thumbX + knobRadius + inset)

                ZStack(alignment: .leading) {
                    // Recessed Obsidian switch trough (clear right side)
                    Capsule()
                        .fill(
                            SHColor.surfaceCode
                                .shadow(.inner(color: .black.opacity(0.26), radius: 1.5, y: 0.75))
                        )
                        .frame(width: trackWidth, height: trackHeight)

                    // Switch-style filled area to the left of (and wrapping) the knob
                    Capsule()
                        .fill(
                            activeFillTint
                                .shadow(.inner(color: .black.opacity(0.10), radius: 1, y: 0.5))
                        )
                        .frame(width: max(trackHeight, fillWidth), height: trackHeight)
                        .opacity(isOffSelection ? 0 : 1)
                        .animation(.spring(response: 0.22, dampingFraction: 0.86), value: idx)

                    // Discrete stop ticks recessed along the trough
                    if count > 1 {
                        ForEach(0..<count, id: \.self) { stop in
                            if stop != idx {
                                let stopFraction = CGFloat(stop) / CGFloat(count - 1)
                                let stopX = travelPadding + usableWidth * stopFraction
                                Circle()
                                    .fill(stop < idx && !isOffSelection
                                        ? Color.white.opacity(0.36)
                                        : SHColor.inkFaint.opacity(0.45))
                                    .frame(width: 4.5, height: 4.5)
                                    .position(x: stopX, y: trackHeight / 2)
                            }
                        }
                    }

                    // Subtle recessed inner rim (dark top bevel, faint bottom catch-light)
                    Capsule()
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    Color.black.opacity(0.16),
                                    Color.clear,
                                    Color.white.opacity(0.04),
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.75
                        )
                        .frame(width: trackWidth, height: trackHeight)
                        .allowsHitTesting(false)

                    // Elevated iOS-switch-style circular thumb
                    Circle()
                        .fill(
                            SHColor.porcelain
                                .shadow(.inner(color: .white.opacity(0.65), radius: 0.5, y: 0.75))
                        )
                        .frame(width: knobDiameter, height: knobDiameter)
                        .overlay(
                            Circle()
                                .strokeBorder(Color.black.opacity(0.08), lineWidth: 0.5)
                        )
                        .shadow(color: Color.black.opacity(0.14), radius: 1.25, y: 0.5)
                        .position(x: thumbX, y: trackHeight / 2)
                        .animation(.spring(response: 0.22, dampingFraction: 0.86), value: idx)
                }
                .clipShape(Capsule())
                .frame(width: trackWidth, height: trackHeight)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            guard count > 1 else { return }
                            let next = Self.nearestStopIndex(
                                x: value.location.x - travelPadding,
                                trackWidth: usableWidth,
                                count: count
                            )
                            if next != lastHapticIndex && next != idx {
                                lastHapticIndex = next
                                #if canImport(UIKit)
                                UISelectionFeedbackGenerator().selectionChanged()
                                #endif
                                onSelect(levels[next])
                            } else if lastHapticIndex == nil && next != idx {
                                lastHapticIndex = next
                                #if canImport(UIKit)
                                UISelectionFeedbackGenerator().selectionChanged()
                                #endif
                                onSelect(levels[next])
                            }
                        }
                        .onEnded { _ in
                            lastHapticIndex = nil
                        }
                )
            }
            .frame(height: trackHeight)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Thinking effort")
            .accessibilityValue(selectedLevel.map(Self.displayName(for:)) ?? "")
            .accessibilityIdentifier("composer.thinking.slider")
            .accessibilityAdjustableAction { direction in
                guard count > 1 else { return }
                switch direction {
                case .increment:
                    let next = min(count - 1, idx + 1)
                    if next != idx { onSelect(levels[next]) }
                case .decrement:
                    let next = max(0, idx - 1)
                    if next != idx { onSelect(levels[next]) }
                @unknown default:
                    break
                }
            }

            // Tappable stop labels: the end labels sit flush with the track's ends, and each middle
            // label is centred under its own dot (pulled in only if it would run past an end).
            GeometryReader { geo in
                let rowWidth = max(trackHeight, geo.size.width)
                let usableWidth = max(1, rowWidth - travelPadding * 2)
                ZStack(alignment: .topLeading) {
                    ForEach(Array(levels.enumerated()), id: \.offset) { offset, level in
                        let isSelected = offset == idx
                        let stopX = travelPadding + usableWidth * (count > 1 ? CGFloat(offset) / CGFloat(count - 1) : 0)
                        Button {
                            if offset != idx {
                                #if canImport(UIKit)
                                UISelectionFeedbackGenerator().selectionChanged()
                                #endif
                                onSelect(level)
                            }
                        } label: {
                            Text(Self.compactStopLabel(for: level, totalStops: count))
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkFaint)
                                .lineLimit(1)
                                .fixedSize()
                                .frame(height: 18)
                                .contentShape(Rectangle().inset(by: -6))
                        }
                        .buttonStyle(.plain)
                        .alignmentGuide(.leading) { d in
                            -Self.stopLabelLeading(
                                index: offset, count: count, stopX: stopX, labelWidth: d.width, rowWidth: rowWidth
                            )
                        }
                        .accessibilityIdentifier("thinking.stop.\(level.lowercased())")
                    }
                }
                .frame(width: rowWidth, height: 18, alignment: .topLeading)
            }
            .frame(height: 18)
        }
        .frame(height: trackHeight + 6 + 18)
    }
}

/// Coalesced model & thinking-effort selector shared by the live chat composer and the new-thread composer.
///
/// Presents a compact floating Obsidian popover anchored directly above the composer pill, featuring
/// a tactile Thinking Effort slider at the top (whenever the selected model supports thinking levels)
/// and a clean scrollable model list underneath.
///
/// It is `Equatable` on its data only and used with `.equatable()` so background host refreshes
/// never tear down or jump an open popover.
struct SHModelEffortMenu: View, Equatable {
    struct ModelItem: Equatable, Identifiable {
        let id: String
        let label: String
        let isSelected: Bool
    }

    struct EffortItem: Equatable {
        let level: String
        let isSelected: Bool
    }

    enum CommitAction: Equatable {
        case modelAndEffort(modelId: String, effort: String?)
        case effortOnly(String)
    }

    let models: [ModelItem]
    let efforts: [EffortItem]
    let harness: HarnessKind
    let title: String
    let effortLabel: String?
    let accessibilityText: String
    let identifier: String
    let onSelectModel: (String) -> Void
    let onSelectEffort: (String) -> Void
    var onCommitModelAndEffort: ((String, String?) -> Void)? = nil

    @State private var isPopoverPresented: Bool = false
    /// Frozen snapshot captured when the popover opens so background host refreshes/SSE events
    /// can never mutate, flicker, or bounce an open menu. All changes stay local until dismiss.
    @State private var hasActiveDraftSession: Bool = false
    @State private var frozenModels: [ModelItem] = []
    @State private var frozenEfforts: [EffortItem] = []
    @State private var frozenTitle: String = ""
    @State private var frozenEffortLabel: String? = nil
    @State private var initialModelId: String? = nil
    @State private var initialEffort: String? = nil
    /// The popover's pending choices. The popover's content observes this object itself, so
    /// it redraws on a pick even when the system does not refresh it from the presenting view.
    @StateObject private var draft = SHModelEffortDraft()
    /// True from the moment the popover starts closing, so the chip un-presses and shows the
    /// committed values at once instead of after the dismissal animation.
    @State private var isClosing = false

    private var draftEffort: String? {
        get { draft.effort }
        nonmutating set { draft.effort = newValue }
    }
    private var pendingPickedModelId: String? {
        get { draft.pickedModelId }
        nonmutating set { draft.pickedModelId = newValue }
    }

    nonisolated static func == (lhs: SHModelEffortMenu, rhs: SHModelEffortMenu) -> Bool {
        lhs.models == rhs.models
            && lhs.efforts == rhs.efforts
            && lhs.harness == rhs.harness
            && lhs.title == rhs.title
            && lhs.effortLabel == rhs.effortLabel
            && lhs.accessibilityText == rhs.accessibilityText
            && lhs.identifier == rhs.identifier
    }

    /// Computes the single commit action to dispatch when the popover closes, or `nil` when
    /// the user dismissed without changing either model or effort.
    nonisolated static func resolveCommit(
        initialModelId: String?,
        pickedModelId: String?,
        initialEffort: String?,
        draftEffort: String?
    ) -> CommitAction? {
        let effortChanged: Bool = {
            switch (initialEffort?.lowercased(), draftEffort?.lowercased()) {
            case (nil, nil): return false
            case let (a?, b?): return a != b
            default: return true
            }
        }()
        if let pickedModelId {
            let modelChanged = pickedModelId != initialModelId
            if modelChanged {
                return .modelAndEffort(modelId: pickedModelId, effort: draftEffort)
            }
            if effortChanged, let draftEffort {
                return .effortOnly(draftEffort)
            }
            return nil
        }
        if effortChanged, let draftEffort {
            return .effortOnly(draftEffort)
        }
        return nil
    }

    private var liveActiveEffortLevel: String? {
        efforts.first(where: { $0.isSelected })?.level ?? efforts.first?.level
    }

    private var displayedModels: [ModelItem] {
        hasActiveDraftSession ? frozenModels : models
    }

    private var displayedEfforts: [EffortItem] {
        hasActiveDraftSession ? frozenEfforts : efforts
    }

    private var accentColor: Color {
        harness.harnessGroup.map(SHColor.harness) ?? SHColor.accentPrimary
    }

    private func beginDraftSession() {
        frozenModels = models
        frozenEfforts = efforts
        frozenTitle = title
        frozenEffortLabel = effortLabel
        initialModelId = models.first(where: { $0.isSelected })?.id
        initialEffort = liveActiveEffortLevel
        draftEffort = liveActiveEffortLevel
        pendingPickedModelId = nil
        hasActiveDraftSession = true
    }

    private func commitDraftSession() {
        guard hasActiveDraftSession else { return }
        let action = Self.resolveCommit(
            initialModelId: initialModelId,
            pickedModelId: pendingPickedModelId,
            initialEffort: initialEffort,
            draftEffort: draftEffort
        )
        hasActiveDraftSession = false
        pendingPickedModelId = nil

        guard let action else { return }
        switch action {
        case .modelAndEffort(let modelId, let effort):
            if let onCommitModelAndEffort {
                onCommitModelAndEffort(modelId, effort)
            } else {
                onSelectModel(modelId)
                if let effort, effort.lowercased() != initialEffort?.lowercased() {
                    onSelectEffort(effort)
                }
            }
        case .effortOnly(let effort):
            onSelectEffort(effort)
        }
    }
    var body: some View {
        // While the popover is open the chip shows the pending pick and thinking level; they are
        // committed when the popover closes.
        let pickedLabel = pendingPickedModelId.flatMap { id in frozenModels.first(where: { $0.id == id })?.label }
        let pillTitle = hasActiveDraftSession ? (pickedLabel ?? frozenTitle) : title
        let pillEffort = hasActiveDraftSession
            ? (draftEffort.map(SHThinkingEffortSlider.displayName(for:)) ?? frozenEffortLabel)
            : effortLabel

        Button {
            #if canImport(UIKit)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            #endif
            if !isPopoverPresented {
                beginDraftSession()
                isClosing = false
                isPopoverPresented = true
            } else {
                isPopoverPresented = false
            }
        } label: {
            HStack(spacing: 6) {
                HarnessLogoView(harness: harness, size: 14.5)
                Text(pillTitle)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(SHColor.inkPrimary)
                    .lineLimit(1)
                if let pillEffort, !pillEffort.isEmpty {
                    Text(pillEffort)
                        .font(.system(size: 13.5, weight: .regular))
                        .foregroundStyle(SHColor.inkMuted)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(SHColor.inkFaint)
            }
            .padding(.horizontal, 13)
            .frame(height: ComposerView.controlSize)
        }
        .buttonStyle(SHControlPressStyle(fill: SHColor.surfaceBubble, shape: Capsule(), isOn: isPopoverPresented && !isClosing))
        .accessibilityLabel(accessibilityText)
        .accessibilityValue([pillTitle, pillEffort ?? ""].filter { !$0.isEmpty }.joined(separator: " "))
        .accessibilityIdentifier(identifier)
        .popover(
            isPresented: $isPopoverPresented,
            attachmentAnchor: .rect(.rect(CGRect(x: 56, y: 0, width: 1, height: ComposerView.controlSize))),
            arrowEdge: .bottom
        ) {
            popoverContent
                .presentationCompactAdaptation(.popover)
                // No presentationBackground: the system's glass fills the panel and its arrow alike,
                // so the two read as one shape.
        }
        .onChange(of: isPopoverPresented) { _, presented in
            if !presented {
                commitDraftSession()
                isClosing = false
            }
        }
    }

    private var popoverContent: some View {
        SHModelEffortPopoverBody(
            draft: draft,
            activeModels: displayedModels,
            activeEfforts: displayedEfforts,
            initialModelId: initialModelId,
            accentColor: accentColor,
            onWillClose: {
                isClosing = true
                commitDraftSession()
            }
        )
    }
}
/// The model and Thinking popover's content. It observes the draft itself, so a pick or a slider
/// move redraws it directly.
private struct SHModelEffortPopoverBody: View {
    @ObservedObject var draft: SHModelEffortDraft
    @Namespace private var selectionNamespace
    let activeModels: [SHModelEffortMenu.ModelItem]
    let activeEfforts: [SHModelEffortMenu.EffortItem]
    let initialModelId: String?
    let accentColor: Color
    /// Called when the popover starts to close (before its dismissal animation).
    let onWillClose: () -> Void

    var body: some View {
        let activeEffort = draft.effort
        let rowHeight: CGFloat = 46
        let listHeight = min(CGFloat(max(1, activeModels.count)) * rowHeight - 2 + 6, 330)
        // Deterministic height independent of the active effort label so moving the slider
        // never alters preferredContentSize or triggers any popover resize/reflow.
        let thinkingSectionHeight: CGFloat = activeEfforts.isEmpty ? 0 : (14 + 56 + 12)
        // The model list needs no heading; a little space separates it from the Thinking section.
        let modelHeaderHeight: CGFloat = 6
        let totalHeight = thinkingSectionHeight + modelHeaderHeight + listHeight

        return VStack(alignment: .leading, spacing: 0) {
            if !activeEfforts.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    SHThinkingEffortSlider(
                        levels: activeEfforts.map(\.level),
                        selectedLevel: activeEffort,
                        accentColor: accentColor,
                        onSelect: { level in
                            draft.effort = level
                        }
                    )
                }
                .padding(.horizontal, 14)
                .padding(.top, 14)
                .padding(.bottom, 12)
            }

            VStack(alignment: .leading, spacing: 0) {
                Color.clear.frame(height: modelHeaderHeight)

                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 2) {
                            ForEach(activeModels) { item in
                                Button {
                                    #if canImport(UIKit)
                                    UISelectionFeedbackGenerator().selectionChanged()
                                    #endif
                                    // The popover stays open so the slider can still be set for the new
                                    // model; both are committed when the popover closes.
                                    withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) {
                                        draft.pickedModelId = item.id
                                    }
                                } label: {
                                    let isChecked = (draft.pickedModelId ?? initialModelId) == item.id
                                    HStack(spacing: 10) {
                                        Text(item.label)
                                            .font(.system(size: 14.5, weight: isChecked ? .semibold : .regular))
                                            .foregroundStyle(isChecked ? SHColor.inkPrimary : SHColor.inkSecondary)
                                            .lineLimit(1)
                                        Spacer(minLength: 8)
                                        if isChecked {
                                            Image(systemName: "checkmark")
                                                .font(.system(size: 13, weight: .semibold))
                                                .foregroundStyle(accentColor)
                                        }
                                    }
                                    .padding(.horizontal, 12)
                                    .frame(height: rowHeight - 2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background {
                                        // One highlight that slides from row to row, its corners concentric
                                        // with the popover's wherever it sits.
                                        if isChecked {
                                            SHPopoverRowHighlight()
                                                .matchedGeometryEffect(id: "model-selection", in: selectionNamespace)
                                        }
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .id(item.id)
                                .accessibilityAddTraits((draft.pickedModelId ?? initialModelId) == item.id ? .isSelected : [])
                                .accessibilityIdentifier("model.option.\(item.id)")
                            }
                        }
                        // The last row sits the same 6pt from the bottom edge as from the sides,
                        // so its corners follow the popover's.
                        .padding(.horizontal, 6)
                        .padding(.bottom, 6)
                    }
                    .frame(height: listHeight)
                    .onAppear {
                        if let active = activeModels.first(where: { $0.isSelected }) {
                            proxy.scrollTo(active.id, anchor: .center)
                        }
                    }
                }
            }
        }
        .frame(width: 296, height: totalHeight, alignment: .top)
        .animation(nil, value: activeEffort)
        .background(SHWillDisappearHook(action: onWillClose))
    }
}

/// Pending model and thinking level while the model popover is open.
@MainActor
final class SHModelEffortDraft: ObservableObject {
    @Published var pickedModelId: String?
    @Published var effort: String?
}

#if canImport(UIKit)
/// Calls `action` when the hosting view controller is about to disappear, which for a popover is
/// the start of its dismissal rather than the end.
private struct SHWillDisappearHook: UIViewControllerRepresentable {
    let action: () -> Void

    func makeUIViewController(context: Context) -> Controller { Controller(action: action) }
    func updateUIViewController(_ controller: Controller, context: Context) { controller.action = action }

    final class Controller: UIViewController {
        var action: () -> Void
        init(action: @escaping () -> Void) {
            self.action = action
            super.init(nibName: nil, bundle: nil)
        }
        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            action()
        }
    }
}
#else
private struct SHWillDisappearHook: View {
    let action: () -> Void
    var body: some View { Color.clear }
}
#endif

#if canImport(UIKit)
/// Native UIKit button overlay for Send: short tap steers immediately, long press opens
/// the "Steer Now / Queue for Later" UIMenu WITHOUT resigning UITextView first responder,
/// keeping the keyboard anchored in place so the menu never desyncs.
private struct SHSendMenuButton: UIViewRepresentable {
    let isEnabled: Bool
    let onSteer: () -> Void
    let onQueue: () -> Void

    final class Coordinator: NSObject {
        var onSteer: () -> Void
        var onQueue: () -> Void

        init(onSteer: @escaping () -> Void, onQueue: @escaping () -> Void) {
            self.onSteer = onSteer
            self.onQueue = onQueue
        }

        @objc func handlePrimaryTap() {
            onSteer()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onSteer: onSteer, onQueue: onQueue)
    }

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        button.backgroundColor = .clear
        button.showsMenuAsPrimaryAction = false
        button.addTarget(context.coordinator, action: #selector(Coordinator.handlePrimaryTap), for: .touchUpInside)
        applyState(to: button, coordinator: context.coordinator)
        return button
    }

    func updateUIView(_ uiView: UIButton, context: Context) {
        context.coordinator.onSteer = onSteer
        context.coordinator.onQueue = onQueue
        applyState(to: uiView, coordinator: context.coordinator)
    }

    private func applyState(to button: UIButton, coordinator: Coordinator) {
        button.isEnabled = isEnabled
        if isEnabled {
            let steer = UIAction(
                title: "Steer Now",
                image: UIImage(systemName: "arrow.up.circle.fill")
            ) { _ in
                coordinator.onSteer()
            }
            let queue = UIAction(
                title: "Queue for Later",
                image: UIImage(systemName: "text.badge.plus")
            ) { _ in
                coordinator.onQueue()
            }
            button.menu = UIMenu(children: [steer, queue])
        } else {
            button.menu = nil
        }
    }
}
#endif

/// The selected row's highlight in the model popover. On iOS 26 its corners are concentric with
/// the popover's glass container, so a row by an edge follows the popover's corner.
private struct SHPopoverRowHighlight: View {
    var body: some View {
        if #available(iOS 26.0, *) {
            ConcentricRectangle(corners: .concentric(minimum: 10), isUniform: false)
                .fill(Color.white.opacity(0.07))
        } else {
            RoundedRectangle(cornerRadius: SHRadius.concentric(SHRadius.systemPopover, inset: 6), style: .continuous)
                .fill(Color.white.opacity(0.07))
        }
    }
}
