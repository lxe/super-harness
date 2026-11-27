import PhotosUI
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
/// The page itself is the setup surface: pick the harness (and project) from the cards, then the
/// composer at the bottom carries one combined model + thinking-effort pill, like `ComposerView`.
/// Text, attachments and the chosen setup live in `AppStore`, so leaving the page (back button or
/// swipe) never discards them; they are cleared only after the session has been started.
public struct DraftChatView: View {
    @Bindable var store: AppStore
    public let initialHarness: StartHarnessKind
    public let onSessionCreated: (String) -> Void

    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var isPhotoPickerPresented: Bool = false
    @State private var isStarting: Bool = false
    @State private var didApplyInitialHarness: Bool = false
    @State private var dictation = DictationController()
    @FocusState private var isInputFocused: Bool

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
        DraftProjectFilter.projects(for: selectedHarness.harnessGroup, in: store.catalog)
    }

    private var availableModels: [HarnessModelOption] {
        store.catalog?.models(for: selectedHarness.harnessGroup) ?? []
    }

    private var currentModel: HarnessModelOption? {
        availableModels.first(where: { $0.id == selectedModelId }) ?? availableModels.first
    }

    private var reasoningLevels: [String] {
        ReasoningEffortPolicy.offered(currentModel?.reasoningLevels ?? [], allowExtreme: store.allowExtremeReasoning)
    }

    private var projectDisplayName: String {
        if let match = store.catalog?.projects.first(where: { $0.path == selectedProjectPath }) {
            return match.name
        }
        let trimmed = selectedProjectPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmed.isEmpty || trimmed == "~" { return "Workspace" }
        return (trimmed as NSString).lastPathComponent
    }

    private var hasContent: Bool {
        !promptText.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
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
                composerDock
            }
            .padding(.horizontal, SHSpacing.md)
            .padding(.bottom, SHSpacing.sm)
            .padding(.top, SHSpacing.xs)
        }
        .navigationTitle("New Chat")
        .navigationBarTitleDisplayMode(.inline)
        .photosPicker(
            isPresented: $isPhotoPickerPresented,
            selection: $selectedPhotoItems,
            maxSelectionCount: 4,
            matching: .images
        )
        .onChange(of: selectedPhotoItems) { _, newItems in
            guard !newItems.isEmpty else { return }
            let items = newItems
            selectedPhotoItems = []
            handlePickedPhotos(items)
        }
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
        .onDisappear {
            if dictation.state == .recording {
                dictation.cancel()
            }
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

    // MARK: - Composer (same surface and controls as ComposerView)

    private var composerDock: some View {
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
                                isUploading: false
                            )
                        },
                        thumbSize: SHLayout.composerThumbSize,
                        onTap: { item in
                            if let match = attachments.first(where: { $0.id == item.id }) {
                                store.lightboxPayload = LightboxPayload(
                                    title: match.name,
                                    dataUrl: match.previewDataUrl,
                                    path: match.path
                                )
                            }
                        },
                        onRemove: { id in
                            store.draftAttachments[draftKey]?.removeAll(where: { $0.id == id })
                        }
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

                TextField("Message \(Self.cardTitle(selectedHarness))…", text: promptText, axis: .vertical)
                    .focused($isInputFocused)
                    .lineLimit(1...6)
                    .font(SHTypography.body)
                    .foregroundStyle(SHColor.inkPrimary)
                    .padding(.horizontal, 15)
                    .padding(.top, 15)
                    .padding(.bottom, 12)
                    .accessibilityIdentifier("composer.input")

                HStack(spacing: 8) {
                    Button {
                        isPhotoPickerPresented = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(SHColor.inkSecondary)
                            .frame(width: 32, height: 32)
                            .background(SHColor.surfaceBubble, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Attach image")
                    .accessibilityIdentifier("composer.attach")

                    modelEffortPill

                    Spacer(minLength: 4)

                    draftMicButton
                    sendButton
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
            }
        }
    }

    /// One pill for model and thinking effort, mirroring the regular composer.
    @ViewBuilder
    private var modelEffortPill: some View {
        if !availableModels.isEmpty {
            SHModelEffortMenu(
                models: availableModels.map { model in
                    SHModelEffortMenu.ModelItem(id: model.id, label: model.label, isSelected: currentModel?.id == model.id)
                },
                efforts: reasoningLevels.map { level in
                    SHModelEffortMenu.EffortItem(level: level, isSelected: selectedReasoning == level)
                },
                harness: selectedHarness.kind,
                title: currentModel?.label ?? selectedHarness.label,
                effortLabel: reasoningLevels.isEmpty ? nil : selectedReasoning.capitalized,
                accessibilityText: "Select model and effort",
                identifier: "draft.model",
                onSelectModel: { modelId in
                    store.newThreadConfig.modelId = modelId
                    syncReasoningForCurrentModel()
                },
                onSelectEffort: { level in
                    store.newThreadConfig.reasoning = level
                }
            )
            .equatable()
        } else {
            HStack(spacing: 5) {
                HarnessLogoView(harness: selectedHarness.kind, size: 12.5)
                Text(selectedHarness.label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(SHColor.inkMuted)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(SHColor.surfaceBubble.opacity(0.6), in: Capsule())
        }
    }

    private var sendButton: some View {
        Button {
            Task { await startAndSend() }
        } label: {
            Group {
                if isStarting {
                    SHActivityPulse(tint: SHColor.surfaceRail, size: 16)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(SHColor.surfaceRail)
                }
            }
            .frame(width: 32, height: 32)
            .background(SHColor.inkPrimary)
            .opacity(hasContent && !isStarting ? 1.0 : 0.25)
            .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!hasContent || isStarting)
        .accessibilityLabel("Start chat and send")
        .accessibilityIdentifier("composer.send")
    }

    // MARK: - Dictation Button

    @ViewBuilder
    private var draftMicButton: some View {
        switch dictation.state {
        case .idle:
            if let reason = store.dictationUnavailableReason {
                // Dictation is not set up on the desktop: a tap explains why.
                Button {
                    dictation.errorMessage = reason
                } label: {
                    Image(systemName: "mic.slash.fill")
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(SHColor.inkFaint)
                        .frame(width: 32, height: 32)
                        .background(SHColor.surfaceBubble.opacity(0.5), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Voice dictation unavailable")
                .accessibilityHint(reason)
                .accessibilityIdentifier("composer.mic.unavailable")
            } else {
                Button {
                    #if canImport(UIKit)
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    #endif
                    Task { await handleDraftDictationTap() }
                } label: {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(SHColor.inkMuted)
                        .frame(width: 32, height: 32)
                        .background(SHColor.surfaceBubble, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Start voice dictation")
                .accessibilityIdentifier("composer.mic")
            }

        case .recording:
            Button {
                #if canImport(UIKit)
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                #endif
                Task { await handleDraftDictationTap() }
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
                .frame(height: 32)
                .background(SHColor.statusDanger.opacity(0.16))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop recording and transcribe")
            .accessibilityIdentifier("composer.mic")

        case .transcribing:
            SHActivityPulse(tint: SHColor.accentInfo, size: 16)
                .frame(width: 32, height: 32)
                .background(SHColor.surfaceBubble, in: Circle())
                .accessibilityIdentifier("composer.mic")
        }
    }

    private func handleDraftDictationTap() async {
        let spoken = await dictation.toggleRecording(
            prewarm: { await store.prewarmDictation() },
            transcribe: { audioData in
                try await store.transcribeDictation(wavData: audioData)
            }
        )
        guard let spoken, !spoken.isEmpty else { return }
        let current = promptText.wrappedValue
        if current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            promptText.wrappedValue = spoken
        } else {
            promptText.wrappedValue = current.hasSuffix(" ") || current.hasSuffix("\n") ? current + spoken : current + " " + spoken
        }
    }

    // MARK: - Actions & Sync

    private func selectHarness(_ kind: StartHarnessKind) {
        if store.newThreadConfig.harness != kind {
            store.newThreadConfig.harness = kind
        }
        syncSetupForCurrentHarness()
    }

    /// Keeps the saved project, model and effort when they are valid for the selected harness,
    /// and falls back to that harness's defaults when they are not.
    private func syncSetupForCurrentHarness() {
        let projects = availableProjects
        if projects.isEmpty {
            if selectedProjectPath.isEmpty {
                store.newThreadConfig.projectPath = store.settings.defaultNewSessionCwd
            }
        } else if !projects.contains(where: { $0.path == selectedProjectPath }) {
            store.newThreadConfig.projectPath = projects[0].path
        }

        let models = availableModels
        if !models.contains(where: { $0.id == selectedModelId }) {
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
        guard !levels.contains(selectedReasoning) else { return }
        let preferred = currentModel?.defaultReasoningLevel
            ?? store.catalog?.defaultReasoning(for: selectedHarness.harnessGroup)
            ?? "high"
        store.newThreadConfig.reasoning = ReasoningEffortPolicy.defaultLevel(
            from: levels, preferred: preferred, allowExtreme: store.allowExtremeReasoning
        ) ?? ""
    }

    private func handlePickedPhotos(_ items: [PhotosPickerItem]) {
        Task {
            for (index, item) in items.enumerated() {
                guard let rawData = try? await item.loadTransferable(type: Data.self) else { continue }
                let dataUrl = await Task.detached(priority: .userInitiated) {
                    let jpeg = ComposerView.downscaledJPEG(from: rawData, maxDimension: 1600, quality: 0.75) ?? rawData
                    return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
                }.value
                var current = store.draftAttachments[draftKey] ?? []
                current.append(
                    ImageAttachment(
                        name: "photo-\(current.count + index + 1).jpg",
                        mimeType: "image/jpeg",
                        previewDataUrl: dataUrl
                    )
                )
                store.draftAttachments[draftKey] = current
            }
        }
    }

    private func startAndSend() async {
        let trimmedPrompt = promptText.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let pendingAttachments = attachments
        guard !trimmedPrompt.isEmpty || !pendingAttachments.isEmpty else { return }

        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif

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
