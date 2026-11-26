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

/// Clean inline Draft Chat view pushed directly onto the main navigation stack
/// (or shown in iPad's detail column) — no modal form sheet.
public struct DraftChatView: View {
    @Bindable var store: AppStore
    public let initialHarness: StartHarnessKind
    public let onSessionCreated: (String) -> Void

    @State private var selectedHarness: StartHarnessKind
    @State private var selectedProjectPath: String
    @State private var selectedModelId: String = ""
    @State private var selectedReasoning: String = ""
    @State private var remoteControl: Bool = false
    @State private var promptText: String = ""
    @State private var attachments: [ImageAttachment] = []
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var isStarting: Bool = false
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
        _selectedHarness = State(initialValue: initialHarness)
        let scoped = DraftProjectFilter.projects(for: initialHarness.harnessGroup, in: store.catalog)
        let defaultPath = scoped.first?.path ?? store.settings.defaultNewSessionCwd
        _selectedProjectPath = State(initialValue: defaultPath)
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
        currentModel?.reasoningLevels ?? []
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
        !promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    public var body: some View {
        ZStack {
            SHColor.surfaceCanvas.ignoresSafeArea()

            // Calm, spacious empty chat canvas
            VStack(spacing: SHSpacing.md) {
                HarnessLogoView(harness: selectedHarness.kind, size: 38)

                VStack(spacing: 4) {
                    Text(selectedHarness.label)
                        .font(SHTypography.title)
                        .foregroundStyle(SHColor.inkPrimary)

                    HStack(spacing: 6) {
                        Text(projectDisplayName)
                        if let model = currentModel {
                            Text("·")
                                .foregroundStyle(SHColor.inkFaint)
                            Text(model.label)
                        }
                        if !selectedReasoning.isEmpty && !reasoningLevels.isEmpty {
                            Text("·")
                                .foregroundStyle(SHColor.inkFaint)
                            Text(selectedReasoning.capitalized)
                        }
                    }
                    .font(SHTypography.caption)
                    .foregroundStyle(SHColor.inkMuted)
                    .lineLimit(1)
                }
            }
            .padding(.horizontal, SHSpacing.xl)
            .padding(.bottom, 72)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            isInputFocused = false
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: SHSpacing.sm) {
                configPillsStrip
                composerDock
            }
            .padding(.horizontal, SHSpacing.md)
            .padding(.bottom, SHSpacing.sm)
            .padding(.top, SHSpacing.xs)
            .background(
                LinearGradient(
                    colors: [SHColor.surfaceCanvas.opacity(0.0), SHColor.surfaceCanvas.opacity(0.96), SHColor.surfaceCanvas],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
        }
        .navigationTitle("New Chat")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            syncProjectForCurrentHarness()
            syncModelAndEffort()
        }
        .onChange(of: initialHarness) { _, next in
            selectedHarness = next
            syncProjectForCurrentHarness()
            syncModelAndEffort()
        }
        .onChange(of: selectedHarness) { _, _ in
            syncProjectForCurrentHarness()
            syncModelAndEffort()
        }
        .onChange(of: selectedModelId) { _, _ in syncReasoningForCurrentModel() }
        .onDisappear {
            if dictation.state == .recording {
                dictation.cancel()
            }
        }
    }

    // MARK: - Compact Borderless Picker Strip Above Composer

    private var configPillsStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // 1. Engine / Harness Menu
                Menu {
                    ForEach(StartHarnessKind.allCases) { kind in
                        Button {
                            selectedHarness = kind
                        } label: {
                            if selectedHarness == kind {
                                Label(kind.label, systemImage: "checkmark")
                            } else {
                                Text(kind.label)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        HarnessLogoView(harness: selectedHarness.kind, size: 13)
                        Text(selectedHarness.label)
                            .font(SHTypography.micro.weight(.semibold))
                            .foregroundStyle(SHColor.inkPrimary)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(SHColor.inkFaint)
                    }
                    .padding(.horizontal, 11)
                    .padding(.vertical, 7)
                    .background(SHColor.surfaceSubtle)
                    .clipShape(Capsule())
                }
                .accessibilityLabel("Select harness")

                // 2. Model Menu
                if !availableModels.isEmpty {
                    Menu {
                        ForEach(availableModels) { model in
                            Button {
                                selectedModelId = model.id
                            } label: {
                                if selectedModelId == model.id {
                                    Label(model.label, systemImage: "checkmark")
                                } else {
                                    Text(model.label)
                                }
                            }
                        }
                    } label: {
                        menuPillLabel(
                            icon: "cpu",
                            text: currentModel?.label ?? "Model"
                        )
                    }
                    .accessibilityLabel("Select model")
                }

                // 3. Thinking / Reasoning Effort Menu
                if !reasoningLevels.isEmpty {
                    Menu {
                        ForEach(reasoningLevels, id: \.self) { level in
                            Button {
                                selectedReasoning = level
                            } label: {
                                if selectedReasoning == level {
                                    Label(level.capitalized, systemImage: "checkmark")
                                } else {
                                    Text(level.capitalized)
                                }
                            }
                        }
                    } label: {
                        menuPillLabel(
                            icon: "sparkles",
                            text: selectedReasoning.isEmpty ? "Effort" : selectedReasoning.capitalized,
                            tint: SHColor.harness(selectedHarness.harnessGroup)
                        )
                    }
                    .accessibilityLabel("Select thinking effort")
                }

                // 4. Project Menu (filtered per harness group)
                Menu {
                    if !availableProjects.isEmpty {
                        ForEach(availableProjects) { project in
                            Button {
                                selectedProjectPath = project.path
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
                            selectedProjectPath = store.settings.defaultNewSessionCwd
                        } label: {
                            Label(projectDisplayName, systemImage: "checkmark")
                        }
                    }
                } label: {
                    menuPillLabel(icon: "folder", text: projectDisplayName)
                }
                .accessibilityLabel("Select project")

                // 5. Optional Remote toggle pill for Claude
                if selectedHarness.harnessGroup == .claude {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) {
                            remoteControl.toggle()
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: remoteControl ? "antenna.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right.slash")
                                .font(.system(size: 11, weight: .medium))
                            Text("Remote")
                                .font(SHTypography.micro.weight(.medium))
                        }
                        .foregroundStyle(remoteControl ? SHColor.brandClaude : SHColor.inkMuted)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 7)
                        .background(remoteControl ? SHColor.brandClaude.opacity(0.14) : SHColor.surfaceSubtle)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Toggle remote control")
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func menuPillLabel(icon: String, text: String, tint: Color? = nil) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(tint ?? SHColor.inkMuted)
            Text(text)
                .font(SHTypography.micro.weight(.medium))
                .foregroundStyle(SHColor.inkSecondary)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(SHColor.inkFaint)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(SHColor.surfaceSubtle)
        .clipShape(Capsule())
    }

    // MARK: - Chat Input Dock (Matched to ComposerView)

    private var composerDock: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(attachments) { att in
                            ZStack(alignment: .topTrailing) {
                                Group {
                                    if let uiImage = DataURLImageDecoder.decode(att.previewDataUrl) {
                                        Image(uiImage: uiImage)
                                            .resizable()
                                            .scaledToFill()
                                    } else {
                                        ZStack {
                                            SHColor.surfaceSubtle
                                            Image(systemName: "photo")
                                                .foregroundStyle(SHColor.inkMuted)
                                        }
                                    }
                                }
                                .frame(width: 54, height: 54)
                                .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))

                                Button {
                                    attachments.removeAll(where: { $0.id == att.id })
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 16))
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(SHColor.inkPrimary, SHColor.surfaceRail)
                                }
                                .buttonStyle(.plain)
                                .offset(x: 4, y: -4)
                            }
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

            TextField("Message \(selectedHarness.label)…", text: $promptText, axis: .vertical)
                .focused($isInputFocused)
                .lineLimit(1...6)
                .font(SHTypography.body)
                .foregroundStyle(SHColor.inkPrimary)
                .padding(.horizontal, 14)
                .padding(.top, 11)
                .padding(.bottom, 8)
                .accessibilityIdentifier("composer.input")

            HStack(spacing: 10) {
                PhotosPicker(
                    selection: $selectedPhotoItems,
                    maxSelectionCount: 4,
                    matching: .images
                ) {
                    Image(systemName: "photo.badge.plus")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(SHColor.inkMuted)
                        .frame(width: 30, height: 30)
                        .contentShape(Rectangle())
                }
                .onChange(of: selectedPhotoItems) { _, newItems in
                    guard !newItems.isEmpty else { return }
                    Task {
                        for (index, item) in newItems.enumerated() {
                            if let data = try? await item.loadTransferable(type: Data.self) {
                                let jpeg = Self.compressedJPEG(from: data) ?? data
                                let dataUrl = "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
                                attachments.append(
                                    ImageAttachment(
                                        name: "photo-\(index + 1).jpg",
                                        mimeType: "image/jpeg",
                                        previewDataUrl: dataUrl
                                    )
                                )
                            }
                        }
                        selectedPhotoItems = []
                    }
                }
                .accessibilityLabel("Attach image")

                HStack(spacing: 6) {
                    HarnessLogoView(harness: selectedHarness.kind, size: 13)
                    Text(currentModel?.label ?? selectedHarness.label)
                        .font(SHTypography.micro)
                        .foregroundStyle(SHColor.inkMuted)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)

                draftMicButton

                Button {
                    Task { await startAndSend() }
                } label: {
                    Group {
                        if isStarting {
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
                    .background(SHColor.inkPrimary)
                    .opacity(hasContent && !isStarting ? 1.0 : 0.25)
                    .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!hasContent || isStarting)
                .accessibilityLabel("Start chat and send")
                .accessibilityIdentifier("composer.send")
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 10)
        }
        .background(SHColor.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.xl, style: .continuous))
    }

    // MARK: - Dictation Button

    @ViewBuilder
    private var draftMicButton: some View {
        switch dictation.state {
        case .idle:
            Button {
                #if canImport(UIKit)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                #endif
                Task { await handleDraftDictationTap() }
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
                .padding(.vertical, 6)
                .background(SHColor.statusDanger.opacity(0.16))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop recording and transcribe")
            .accessibilityIdentifier("composer.mic")

        case .transcribing:
            ProgressView()
                .controlSize(.mini)
                .tint(SHColor.brandAntigravity)
                .frame(width: 30, height: 30)
                .background(SHColor.surfaceSubtle)
                .clipShape(Circle())
                .accessibilityIdentifier("composer.mic")
        }
    }

    private func handleDraftDictationTap() async {
        let spoken = await dictation.toggleRecording { wavData in
            try await store.transcribeDictation(wavData: wavData)
        }
        guard let spoken, !spoken.isEmpty else { return }
        let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            promptText = spoken
        } else {
            promptText = promptText.hasSuffix(" ") || promptText.hasSuffix("\n") ? promptText + spoken : promptText + " " + spoken
        }
    }

    // MARK: - Actions & Sync

    private func syncProjectForCurrentHarness() {
        let scoped = availableProjects
        guard !scoped.isEmpty else { return }
        if !scoped.contains(where: { $0.path == selectedProjectPath }) {
            selectedProjectPath = scoped[0].path
        }
    }

    private func syncModelAndEffort() {
        let models = availableModels
        if let def = models.first(where: { $0.isDefault == true }) ?? models.first {
            selectedModelId = def.id
        } else {
            selectedModelId = ""
        }
        syncReasoningForCurrentModel()
    }

    private func syncReasoningForCurrentModel() {
        let levels = reasoningLevels
        guard !levels.isEmpty else {
            selectedReasoning = ""
            return
        }
        let preferred = currentModel?.defaultReasoningLevel
            ?? store.catalog?.defaultReasoning(for: selectedHarness.harnessGroup)
            ?? "high"
        selectedReasoning = levels.contains(preferred) ? preferred : (levels.last ?? "")
    }

    private func startAndSend() async {
        let trimmedPrompt = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty || !attachments.isEmpty else { return }

        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif

        isStarting = true
        defer { isStarting = false }

        let cwd = selectedProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let req = StartSessionRequest(
            harness: selectedHarness,
            cwd: cwd.isEmpty ? store.settings.defaultNewSessionCwd : cwd,
            prompt: trimmedPrompt.isEmpty ? nil : trimmedPrompt,
            model: selectedModelId.isEmpty ? nil : selectedModelId,
            reasoningEffort: selectedReasoning.isEmpty ? nil : selectedReasoning,
            remoteControl: (selectedHarness.harnessGroup == .claude && remoteControl) ? true : nil
        )

        if let newId = await store.startSession(req) {
            if !attachments.isEmpty {
                let pending = attachments
                store.submitMessage(for: newId, text: "", attachments: pending)
            }
            onSessionCreated(newId)
        }
    }

    private static func compressedJPEG(from data: Data) -> Data? {
        #if canImport(UIKit)
        guard let img = UIImage(data: data) else { return nil }
        return img.jpegData(compressionQuality: 0.78)
        #else
        return data
        #endif
    }
}
