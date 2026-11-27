import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Per-harness project filtering helper (falls back to all projects only if empty).
public enum DraftProjectFilter {
    public static func projects(for group: HarnessGroup, in catalog: HarnessCatalog?) -> [HarnessProjectOption] {
        guard let all = catalog?.projects, !all.isEmpty else { return [] }
        let matched = all.filter { $0.harnesses.contains(group) }
        return matched.isEmpty ? all : matched
    }
}

/// New Chat page pushed onto the main navigation stack (or shown in iPad's detail column).
///
/// The page itself is the setup surface: pick the harness (and project) from the cards, while
/// the bottom dock renders the exact same `ComposerView` used by live chat threads — sharing
/// dictation, send-while-dictating finalization, media/file attachments, clipboard paste, and
/// the coalesced Model + Thinking slider popover.
/// Text, attachments and the chosen setup live in `AppStore`, so leaving the page (back button or
/// swipe) never discards them; they are cleared only after the session has been started.
public struct DraftChatView: View {
    @Bindable var store: AppStore
    public let initialHarness: StartHarnessKind
    public let onSessionCreated: (String) -> Void

    @State private var isStarting: Bool = false
    @State private var didApplyInitialHarness: Bool = false

    public init(
        store: AppStore,
        initialHarness: StartHarnessKind = .antigravity,
        onSessionCreated: @escaping (String) -> Void
    ) {
        self.store = store
        self.initialHarness = initialHarness
        self.onSessionCreated = onSessionCreated
    }

    // MARK: - Draft state (owned by the store so it survives navigation)

    private var draftKey: String { AppStore.newThreadDraftKey }
    private var selectedHarness: StartHarnessKind { store.newThreadConfig.harness }
    private var selectedModelId: String { store.newThreadConfig.modelId }
    private var selectedReasoning: String { store.newThreadConfig.reasoning }
    private var selectedProjectPath: String { store.newThreadConfig.projectPath }
    private var attachments: [ImageAttachment] { store.draftAttachments[draftKey] ?? [] }

    private var promptText: Binding<String> {
        Binding(
            get: { store.draftInputs[draftKey] ?? "" },
            set: { store.draftInputs[draftKey] = $0 }
        )
    }

    private var availableProjects: [HarnessProjectOption] {
        let filtered = DraftProjectFilter.projects(for: selectedHarness.harnessGroup, in: store.catalog)
        let current = selectedProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !current.isEmpty, !filtered.contains(where: { $0.path == current }) else {
            return filtered
        }
        // Keep a project pre-selected from the Projects list visible even when switching to a
        // harness that hasn't opened a thread in that directory yet.
        let custom = HarnessProjectOption(
            name: projectDisplayName,
            path: current,
            harnesses: [selectedHarness.harnessGroup]
        )
        return [custom] + filtered
    }

    private var availableModels: [HarnessModelOption] {
        store.catalog?.models(for: selectedHarness.harnessGroup) ?? []
    }

    private var currentModel: HarnessModelOption? {
        if !selectedModelId.isEmpty,
           let match = availableModels.first(where: { $0.matches(selectedModelId) }) {
            return match
        }
        return availableModels.first(where: { $0.isDefault == true }) ?? availableModels.first
    }

    private var reasoningLevels: [String] {
        ReasoningEffortPolicy.offered(
            currentModel?.reasoningLevels ?? [],
            allowExtreme: store.allowExtremeReasoning,
            keeping: selectedReasoning.isEmpty ? nil : selectedReasoning
        )
    }

    private var projectDisplayName: String {
        if let match = store.catalog?.projects.first(where: { $0.path == selectedProjectPath }) {
            return match.name
        }
        let trimmed = selectedProjectPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmed.isEmpty || trimmed == "~" { return "Workspace" }
        return (trimmed as NSString).lastPathComponent
    }

    public var body: some View {
        GeometryReader { viewport in
            ScrollView {
                // The hero is centred in whatever height the cards leave free, and the cards
                // sit just above the composer, within reach of the thumb.
                VStack(spacing: SHSpacing.md) {
                    Spacer(minLength: SHSpacing.lg)
                    hero
                    Spacer(minLength: SHSpacing.lg)
                    harnessGrid
                    optionsCard
                }
                .padding(.horizontal, SHSpacing.lg)
                .padding(.vertical, SHSpacing.md)
                .frame(minHeight: viewport.size.height)
            }
            .defaultScrollAnchor(.bottom)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(SHColor.surfaceCanvas.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: SHSpacing.sm) {
                // Why the new session did not start, shown where it was being started.
                if let notice = store.sessionNotices[AppStore.newThreadDraftKey] {
                    SessionNoticeRow(notice: notice) { store.dismissSessionNotice(for: AppStore.newThreadDraftKey) }
                }
                ComposerView(
                    harness: selectedHarness.kind,
                    model: selectedModelId.isEmpty ? currentModel?.id : selectedModelId,
                    reasoningEffort: selectedReasoning.isEmpty ? nil : selectedReasoning,
                    placeholder: "Message \(Self.cardTitle(selectedHarness))…",
                    allowsQueueMenu: false,
                    modelMenuIdentifier: "draft.model",
                    text: promptText,
                    attachments: attachments,
                    uploadingAttachmentIds: store.uploadingAttachmentIds,
                    availableModels: availableModels,
                    reasoningLevels: reasoningLevels,
                    harnessDefaultEffort: store.catalog?.defaultReasoning(for: selectedHarness.harnessGroup),
                    isSending: isStarting,
                    isStreaming: false,
                    isAgentBusy: false,
                    onPickPhotoData: { data, filename in
                        Task { await store.addAttachment(for: draftKey, jpegData: data, filename: filename) }
                    },
                    onPickFileData: { data, mimeType, filename, previewData in
                        Task {
                            await store.addFileAttachment(
                                for: draftKey,
                                data: data,
                                mimeType: mimeType,
                                filename: filename,
                                previewImageData: previewData
                            )
                        }
                    },
                    dictationUnavailableReason: store.dictationUnavailableReason,
                    onRemoveAttachment: { attId in
                        store.removeAttachment(for: draftKey, attachmentId: attId)
                    },
                    onTapAttachment: { att in
                        store.lightboxPayload = LightboxPayload(
                            title: att.name,
                            dataUrl: att.previewDataUrl,
                            path: att.path
                        )
                    },
                    onSelectModel: { modelOption in
                        let resolved = ComposerView.resolveModelSelection(
                            picked: modelOption,
                            currentEffort: selectedReasoning.isEmpty ? nil : selectedReasoning,
                            availableModels: availableModels,
                            allowExtreme: store.allowExtremeReasoning
                        )
                        store.newThreadConfig.modelId = resolved.modelId
                        store.newThreadConfig.reasoning = resolved.effort ?? ""
                    },
                    onSelectReasoningEffort: { effort in
                        let resolved = ComposerView.resolveEffortSelection(
                            effort: effort,
                            currentModel: selectedModelId.isEmpty ? currentModel?.id : selectedModelId,
                            availableModels: availableModels
                        )
                        if let nextModel = resolved.modelId {
                            store.newThreadConfig.modelId = nextModel
                        }
                        store.newThreadConfig.reasoning = resolved.effort
                    },
                    onSelectModelAndEffort: { modelOption, draftedEffort in
                        let resolved = ComposerView.resolveModelSelection(
                            picked: modelOption,
                            currentEffort: draftedEffort ?? (selectedReasoning.isEmpty ? nil : selectedReasoning),
                            availableModels: availableModels,
                            allowExtreme: store.allowExtremeReasoning
                        )
                        store.newThreadConfig.modelId = resolved.modelId
                        store.newThreadConfig.reasoning = resolved.effort ?? ""
                    },
                    onTranscribeAudio: { wavData in
                        try await store.transcribeDictation(wavData: wavData)
                    },
                    onDictationStart: {
                        await store.prewarmDictation()
                    },
                    onSend: { _ in
                        Task { await startAndSend() }
                    },
                    onAbort: {}
                )
            }
            .padding(.horizontal, SHSpacing.md)
            .padding(.bottom, SHSpacing.sm)
            .padding(.top, SHSpacing.xs)
        }
        .navigationTitle("New Chat")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            // The route's harness applies once per visit; after that the user's pick on this page wins.
            if !didApplyInitialHarness {
                didApplyInitialHarness = true
                selectHarness(initialHarness)
            }
            syncSetupForCurrentHarness()
        }
        .onChange(of: initialHarness) { _, next in
            selectHarness(next)
        }
        .onChange(of: store.catalog) { _, _ in
            syncSetupForCurrentHarness()
        }
    }

    // MARK: - Harness Picker (on the page)

    /// The selected harness's logo on a raised tile, with a title that names it.
    private var hero: some View {
        VStack(spacing: 10) {
            HarnessLogoView(harness: selectedHarness.kind, size: 24)
                .frame(width: 48, height: 48)
                .shRaisedSurface(SHColor.surfacePopover, cornerRadius: SHRadius.lg, elevation: .card)
                .id(selectedHarness)
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
            Text("Start a new \(Self.cardTitle(selectedHarness)) thread")
                .font(SHTypography.title)
                .foregroundStyle(SHColor.inkPrimary)
                .multilineTextAlignment(.center)
                .contentTransition(.opacity)
            Text("Choose a project and model below, then send your first message.")
                .font(SHTypography.caption)
                .foregroundStyle(SHColor.inkMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 300)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("draft.hero")
    }

    /// New Claude chats always start in tmux, so the card says just "Claude".
    static func cardTitle(_ kind: StartHarnessKind) -> String {
        kind.harnessGroup == .claude ? "Claude" : kind.label
    }

    static func cardCaption(_ kind: StartHarnessKind) -> String {
        switch kind {
        case .antigravity: return "Direct ACP conversation"
        case .codex: return "OpenAI Codex thread"
        case .claudeCli, .claudeTmux: return "tmux + remote control"
        case .muse: return "Headless exec, resumable"
        case .pi: return "Pi RPC session, steerable"
        }
    }

    /// The harnesses as raised cards, two to a row. An odd one out takes a full row.
    private var harnessGrid: some View {
        let kinds = StartHarnessKind.pickable
        let rows = stride(from: 0, to: kinds.count, by: 2).map { Array(kinds[$0..<min($0 + 2, kinds.count)]) }
        return VStack(spacing: 10) {
            ForEach(rows, id: \.self) { row in
                HStack(spacing: 10) {
                    ForEach(row) { kind in
                        harnessCard(kind)
                    }
                }
            }
        }
    }

    private func harnessCard(_ kind: StartHarnessKind) -> some View {
        let isSelected = selectedHarness == kind
        return Button {
            #if canImport(UIKit)
            UISelectionFeedbackGenerator().selectionChanged()
            #endif
            withAnimation(.easeInOut(duration: 0.18)) {
                selectHarness(kind)
            }
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    HarnessLogoView(harness: kind.kind, size: 17)
                        .frame(width: 18, height: 18)
                    Text(Self.cardTitle(kind))
                        .font(SHTypography.label.weight(.semibold))
                        .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkSecondary)
                        .lineLimit(1)
                }
                Text(Self.cardCaption(kind))
                    .font(SHTypography.micro)
                    .foregroundStyle(isSelected ? SHColor.inkMuted : SHColor.inkFaint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .shRaisedSurface(
                isSelected ? SHColor.surfaceBubble : SHColor.surfaceSubtle,
                cornerRadius: SHRadius.lg,
                elevation: isSelected ? .card : .tile
            )
            .contentShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(Self.cardTitle(kind)), \(Self.cardCaption(kind))")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("draft.harness.\(kind.rawValue)")
    }

    private var optionsCard: some View {
        VStack(spacing: 0) {
            Menu {
                if !availableProjects.isEmpty {
                    ForEach(availableProjects) { project in
                        Button {
                            store.newThreadConfig.projectPath = project.path
                        } label: {
                            if selectedProjectPath == project.path {
                                Label(project.name, systemImage: "checkmark")
                            } else {
                                Text(project.name)
                            }
                        }
                    }
                } else {
                    Button {
                        store.newThreadConfig.projectPath = store.settings.defaultNewSessionCwd
                    } label: {
                        Label(projectDisplayName, systemImage: "checkmark")
                    }
                }
            } label: {
                HStack(spacing: 12) {
                    optionIcon("folder")
                    Text("Project")
                        .font(SHTypography.label)
                        .foregroundStyle(SHColor.inkSecondary)
                    Spacer(minLength: 8)
                    Text(projectDisplayName)
                        .font(SHTypography.label)
                        .foregroundStyle(SHColor.inkPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(SHColor.inkFaint)
                }
                .padding(.horizontal, 12)
                .frame(height: 50)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Select project")
            .accessibilityIdentifier("draft.project")

            if selectedHarness.harnessGroup == .claude {
                Rectangle()
                    .fill(SHColor.lineHairline)
                    .frame(height: 1)
                    .padding(.leading, 56)
                Toggle(isOn: $store.newThreadConfig.remoteControl) {
                    HStack(spacing: 12) {
                        optionIcon("antenna.radiowaves.left.and.right")
                        Text("Remote Control")
                            .font(SHTypography.label)
                            .foregroundStyle(SHColor.inkSecondary)
                    }
                }
                .tint(SHColor.toggleOn)
                .padding(.horizontal, 12)
                .frame(height: 50)
                .accessibilityLabel("Toggle remote control")
            }
        }
        .shRaisedSurface(SHColor.surfaceSubtle, cornerRadius: SHRadius.lg, elevation: .tile)
    }

    private func optionIcon(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(SHColor.inkMuted)
            .frame(width: 32, height: 32)
    }

    // MARK: - Actions & Sync

    private func selectHarness(_ kind: StartHarnessKind) {
        if store.newThreadConfig.harness != kind {
            store.newThreadConfig.harness = kind
        }
        syncSetupForCurrentHarness()
    }

    /// Keeps an explicitly chosen project across harness switches (including one pre-selected by
    /// long-tapping a project section), and syncs the model & reasoning defaults for the harness.
    private func syncSetupForCurrentHarness() {
        let currentPath = selectedProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if currentPath.isEmpty {
            let projects = DraftProjectFilter.projects(for: selectedHarness.harnessGroup, in: store.catalog)
            if let first = projects.first {
                store.newThreadConfig.projectPath = first.path
            } else {
                store.newThreadConfig.projectPath = store.settings.defaultNewSessionCwd
            }
        }

        let models = availableModels
        if !models.contains(where: { $0.matches(selectedModelId) }) {
            let fallback = models.first(where: { $0.isDefault == true }) ?? models.first
            let nextId = fallback?.id ?? ""
            if selectedModelId != nextId {
                store.newThreadConfig.modelId = nextId
            }
        }
        syncReasoningForCurrentModel()
    }

    private func syncReasoningForCurrentModel() {
        let levels = reasoningLevels
        guard !levels.isEmpty else {
            if !selectedReasoning.isEmpty {
                store.newThreadConfig.reasoning = ""
            }
            return
        }
        if let matched = levels.first(where: { $0.lowercased() == selectedReasoning.lowercased() }) {
            if selectedReasoning != matched {
                store.newThreadConfig.reasoning = matched
            }
            return
        }
        let preferred = currentModel?.defaultReasoningLevel
            ?? store.catalog?.defaultReasoning(for: selectedHarness.harnessGroup)
            ?? "high"
        store.newThreadConfig.reasoning = ReasoningEffortPolicy.defaultLevel(
            from: levels, preferred: preferred, allowExtreme: store.allowExtremeReasoning
        ) ?? ""
    }

    private func startAndSend() async {
        let trimmedPrompt = promptText.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let pendingAttachments = attachments
        guard !trimmedPrompt.isEmpty || !pendingAttachments.isEmpty else { return }

        isStarting = true
        defer { isStarting = false }

        let config = store.newThreadConfig
        let cwd = config.projectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let req = StartSessionRequest(
            harness: config.harness,
            cwd: cwd.isEmpty ? store.settings.defaultNewSessionCwd : cwd,
            prompt: trimmedPrompt.isEmpty ? nil : trimmedPrompt,
            model: config.modelId.isEmpty ? nil : config.modelId,
            reasoningEffort: config.reasoning.isEmpty ? nil : config.reasoning,
            remoteControl: (config.harness.harnessGroup == .claude && config.remoteControl) ? true : nil
        )

        // The draft is cleared only once the host has accepted the new session.
        if let newId = await store.startSession(req) {
            store.clearNewThreadDraft()
            if !pendingAttachments.isEmpty {
                store.submitMessage(for: newId, text: "", attachments: pendingAttachments)
            }
            onSessionCreated(newId)
        }
    }
}
