import SwiftUI

public struct NewSessionSheet: View {
    @Bindable var store: AppStore
    @Environment(\.dismiss) private var dismiss
    public let onCreated: (String) -> Void

    @State private var selectedHarness: StartHarnessKind
    @State private var selectedProjectPath: String
    @State private var selectedModelId: String = ""
    @State private var selectedReasoning: String = ""
    @State private var titleText: String = ""
    @State private var promptText: String = ""
    @State private var remoteControl: Bool = false
    @State private var tmuxSessionName: String = ""
    @State private var isCreating: Bool = false

    public init(
        store: AppStore,
        initialHarness: StartHarnessKind = .antigravity,
        onCreated: @escaping (String) -> Void
    ) {
        self.store = store
        self.onCreated = onCreated
        _selectedHarness = State(initialValue: initialHarness)
        let defaultPath = store.catalog?.projects.first?.path ?? store.settings.defaultNewSessionCwd
        _selectedProjectPath = State(initialValue: defaultPath)
    }

    private var availableModels: [HarnessModelOption] {
        store.catalog?.models(for: selectedHarness.harnessGroup) ?? []
    }

    private var currentModel: HarnessModelOption? {
        availableModels.first(where: { $0.id == selectedModelId }) ?? availableModels.first
    }

    private var reasoningLevels: [String] {
        currentModel?.reasoningLevels ?? ["low", "medium", "high"]
    }

    public var body: some View {
        NavigationStack {
            Form {
                // Harness Picker Grid
                Section("Harness") {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach(StartHarnessKind.allCases) { kind in
                            harnessCard(kind)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
                    .listRowBackground(Color.clear)
                }

                // Workspace / Project
                Section("Project Directory") {
                    if let projects = store.catalog?.projects, !projects.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(projects) { project in
                                    let isSelected = selectedProjectPath == project.path
                                    Button {
                                        selectedProjectPath = project.path
                                    } label: {
                                        HStack(spacing: 5) {
                                            Image(systemName: "folder.fill")
                                                .font(.system(size: 11))
                                            Text(project.name)
                                                .font(SHTypography.caption.weight(.medium))
                                        }
                                        .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkMuted)
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 7)
                                        .background(isSelected ? SHColor.surfaceBubble : SHColor.surfaceRaised)
                                        .clipShape(Capsule())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                    }

                    TextField("/path/to/project", text: $selectedProjectPath)
                        .font(SHTypography.mono)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .listRowBackground(SHColor.surfaceSubtle)

                // Model & Thinking / Reasoning Effort
                Section("Model & Thinking Effort") {
                    if !availableModels.isEmpty {
                        Picker("Model", selection: $selectedModelId) {
                            ForEach(availableModels) { model in
                                Text(model.label).tag(model.id)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(SHColor.inkPrimary)

                        if let desc = currentModel?.description {
                            Text(desc)
                                .font(SHTypography.micro)
                                .foregroundStyle(SHColor.inkMuted)
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Reasoning Effort")
                                .font(SHTypography.caption.weight(.medium))
                                .foregroundStyle(SHColor.inkSecondary)
                            Spacer()
                            Text(selectedReasoning.uppercased())
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .foregroundStyle(SHColor.harness(selectedHarness.harnessGroup))
                        }

                        HStack(spacing: 6) {
                            ForEach(reasoningLevels, id: \.self) { level in
                                let isChosen = selectedReasoning == level
                                let accent = SHColor.harness(selectedHarness.harnessGroup)
                                Button {
                                    selectedReasoning = level
                                } label: {
                                    Text(level.capitalized)
                                        .font(SHTypography.micro.weight(.semibold))
                                        .foregroundStyle(isChosen ? SHColor.inkPrimary : SHColor.inkMuted)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 8)
                                        .background(isChosen ? accent.opacity(0.20) : SHColor.surfaceRaised)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: SHRadius.sm, style: .continuous)
                                                .stroke(isChosen ? accent.opacity(0.40) : Color.clear, lineWidth: 0.5)
                                        )
                                        .clipShape(RoundedRectangle(cornerRadius: SHRadius.sm, style: .continuous))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                .listRowBackground(SHColor.surfaceSubtle)

                // Prompt & Optional Details
                Section("Initial Prompt (Optional)") {
                    TextField("Session title (optional)", text: $titleText)
                        .font(SHTypography.body)
                    TextField("What should this agent work on?", text: $promptText, axis: .vertical)
                        .lineLimit(3...6)
                        .font(SHTypography.body)
                }
                .listRowBackground(SHColor.surfaceSubtle)

                // Remote Control / tmux
                Section("Session Options") {
                    Toggle("Enable Remote Control", isOn: $remoteControl)
                        .tint(SHColor.accentPrimary)

                    if selectedHarness == .claudeTmux {
                        TextField("tmux session name (e.g. claude-work)", text: $tmuxSessionName)
                            .font(SHTypography.mono)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }
                .listRowBackground(SHColor.surfaceSubtle)
            }
            .scrollContentBackground(.hidden)
            .background(SHColor.surfaceRail)
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await createSession() }
                    } label: {
                        if isCreating {
                            SHActivityPulse(tint: SHColor.accentPrimary, size: 16)
                        } else {
                            Text("Start")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(selectedProjectPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCreating)
                }
            }
            .onAppear { syncModelAndEffort() }
            .onChange(of: selectedHarness) { _, _ in syncModelAndEffort() }
            .onChange(of: selectedModelId) { _, _ in syncReasoningForCurrentModel() }
        }
    }

    private func harnessCard(_ kind: StartHarnessKind) -> some View {
        let isSelected = selectedHarness == kind
        let color = SHColor.harness(kind.kind)
        return Button {
            selectedHarness = kind
        } label: {
            HStack(spacing: 9) {
                HarnessLogoView(harness: kind.kind, size: 17)
                Text(kind.label)
                    .font(SHTypography.caption.weight(.semibold))
                    .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkSecondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 13)
            .background(isSelected ? color.opacity(0.15) : SHColor.surfaceSubtle)
            .overlay(
                RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous)
                    .stroke(isSelected ? color.opacity(0.40) : Color.clear, lineWidth: 0.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
        }
        .buttonStyle(.plain)
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
        let preferred = currentModel?.defaultReasoningLevel
            ?? store.catalog?.defaultReasoning(for: selectedHarness.harnessGroup)
            ?? "high"
        if levels.contains(preferred) {
            selectedReasoning = preferred
        } else {
            selectedReasoning = levels.last ?? "medium"
        }
    }

    private func createSession() async {
        isCreating = true
        defer { isCreating = false }
        let req = StartSessionRequest(
            harness: selectedHarness,
            cwd: selectedProjectPath.trimmingCharacters(in: .whitespacesAndNewlines),
            title: titleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : titleText,
            prompt: promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : promptText,
            model: selectedModelId.isEmpty ? nil : selectedModelId,
            reasoningEffort: selectedReasoning.isEmpty ? nil : selectedReasoning,
            remoteControl: remoteControl ? true : nil,
            tmuxSessionName: tmuxSessionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : tmuxSessionName
        )
        if let sid = await store.startSession(req) {
            dismiss()
            onCreated(sid)
        }
    }
}
