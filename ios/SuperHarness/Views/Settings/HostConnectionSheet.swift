import SwiftUI

public struct HostConnectionSheet: View {
    @Bindable var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var isDemoMode: Bool
    @State private var hostURL: String
    @State private var token: String
    @State private var revealToken: Bool = false
    @State private var dictationURL: String
    @State private var dictationToken: String
    @State private var revealDictationToken: Bool = false
    @State private var isTesting: Bool = false
    @State private var isSaving: Bool = false
    @State private var testResult: ConnectionTestResult?
    @State private var isSendingTestPush: Bool = false
    @State private var testPushFeedback: String?
    @State private var showDesignCatalog: Bool = false
    @State private var showDictationAdvanced: Bool
    @State private var showHarnessDetails: Bool = false

    public init(store: AppStore) {
        self.store = store
        _isDemoMode = State(initialValue: store.connectionMode == .demo)
        _hostURL = State(initialValue: store.hostURLString)
        _token = State(initialValue: store.bearerToken)
        _dictationURL = State(initialValue: store.dictationURLOverride)
        _dictationToken = State(initialValue: store.dictationTokenOverride)
        // Custom dictation settings stay visible when they are in use.
        _showDictationAdvanced = State(
            initialValue: !store.dictationURLOverride.isEmpty || !store.dictationTokenOverride.isEmpty
        )
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle(isOn: $isDemoMode) {
                        rowLabel("Demo Mode", detail: "Offline sample sessions")
                    }
                    .tint(SHColor.brandMaster)
                }
                .listRowBackground(SHColor.surfaceSubtle)

                hostSection
                dictationSection
                harnessSection
                notificationSection

                Section("Developer") {
                    Button {
                        showDesignCatalog = true
                    } label: {
                        Label("Design System Catalog", systemImage: "square.grid.2x2")
                    }
                }
                .listRowBackground(SHColor.surfaceSubtle)
            }
            .sheet(isPresented: $showDesignCatalog) {
                DesignSystemCatalogView()
            }
            .navigationTitle("Host Connection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await saveAndClose() }
                    } label: {
                        if isSaving {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Save")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(isSaving)
                }
            }
            .task {
                if store.dictationStatus == nil {
                    await store.refreshDictationStatus()
                }
            }
        }
    }

    // MARK: - Host

    private var hostSection: some View {
        Section {
            labeledField("URL") {
                TextField("http://100.64.0.10:47890", text: $hostURL)
                    .keyboardType(.URL)
            }

            secretField("Token", placeholder: "Host control token", text: $token, isRevealed: $revealToken)

            Button {
                Task { await runConnectionTest() }
            } label: {
                HStack {
                    if isTesting {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "bolt.horizontal.circle")
                    }
                    Text(isTesting ? "Testing…" : "Test Connection")
                        .fontWeight(.medium)
                }
                .foregroundStyle(SHColor.brandAntigravity)
            }
            .disabled(isTesting || hostURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if let result = testResult {
                HStack(spacing: 8) {
                    Image(systemName: result.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(result.ok ? SHColor.statusSuccess : SHColor.statusDanger)
                    Text(result.message)
                        .font(SHTypography.micro)
                        .foregroundStyle(result.ok ? SHColor.statusSuccess : SHColor.statusDanger)
                }
            }
        } header: {
            Text("Host")
        } footer: {
            Text("Tailscale or LAN address. The token is stored in Keychain.")
                .foregroundStyle(SHColor.inkFaint)
        }
        .listRowBackground(SHColor.surfaceSubtle)
        .opacity(isDemoMode ? 0.55 : 1.0)
    }

    // MARK: - Dictation

    private var dictationSection: some View {
        Section("Dictation") {
            HStack(spacing: 10) {
                Circle()
                    .fill(dictationDotColor)
                    .frame(width: 8, height: 8)
                rowLabel(dictationStatusHeadline, detail: dictationStatusDetail)
                Spacer()
                Button {
                    Task {
                        await store.refreshDictationStatus(
                            overrideURL: dictationURL,
                            overrideToken: dictationToken
                        )
                    }
                } label: {
                    if store.isCheckingDictation {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(SHColor.inkSecondary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Check dictation server")
            }
            .padding(.vertical, 2)

            SHInlineDisclosureRow(
                icon: "slider.horizontal.3",
                title: "Advanced",
                isExpanded: showDictationAdvanced
            ) {
                withAnimation { showDictationAdvanced.toggle() }
            }

            if showDictationAdvanced {
                if let st = store.dictationStatus, st.healthy {
                    if let model = st.model, !model.isEmpty {
                        detailRow("Model", value: model)
                    }
                    if let url = st.url, !url.isEmpty {
                        detailRow("Server", value: url)
                    }
                }

                labeledField("Custom Server URL") {
                    TextField("Host YapYap config", text: $dictationURL)
                        .keyboardType(.URL)
                }

                secretField(
                    "Custom Token",
                    placeholder: "Optional",
                    text: $dictationToken,
                    isRevealed: $revealDictationToken
                )

                Text("Leave both blank to use the host's ~/.config/yapyap/config.toml.")
                    .font(SHTypography.micro)
                    .foregroundStyle(SHColor.inkFaint)
            }
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    private var dictationDotColor: Color {
        guard let st = store.dictationStatus else { return SHColor.inkFaint }
        if st.healthy { return SHColor.statusSuccess }
        return st.configured ? SHColor.statusDanger : SHColor.statusWarning
    }

    private var dictationStatusHeadline: String {
        guard let st = store.dictationStatus else { return "Checking…" }
        if st.healthy { return "Connected" }
        return st.configured ? "Unreachable" : "Not configured on host"
    }

    /// One quiet line under the status: the error when there is one, otherwise the model's
    /// short name ("OpenVINO/whisper-large-v3-turbo-fp16-ov" → "whisper-large-v3-turbo-fp16-ov").
    /// The full model id and server URL live under Advanced.
    private var dictationStatusDetail: String? {
        guard let st = store.dictationStatus else { return nil }
        if let err = st.error, !err.isEmpty { return err }
        if st.healthy, let model = st.model, !model.isEmpty {
            return model.split(separator: "/").last.map(String.init) ?? model
        }
        return st.url
    }

    // MARK: - Harnesses

    private var harnessSection: some View {
        Section("Harnesses") {
            if store.harnesses.isEmpty {
                Text("No harnesses detected yet.")
                    .font(SHTypography.caption)
                    .foregroundStyle(SHColor.inkMuted)
            } else {
                ForEach(store.harnesses) { h in
                    HStack(spacing: 12) {
                        HarnessLogoView(group: h.id, size: 18)
                            .frame(width: 32, height: 32)
                            .background(SHColor.harness(h.id).opacity(0.10))
                            .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))

                        rowLabel(h.id.title, detail: "\(h.activeSessionCount) active · \(h.totalSessionCount) total")

                        Spacer()

                        // Every row gets the same trailing switch. Harnesses whose daemon the
                        // host cannot control show it disabled instead of leaving a gap.
                        Toggle(
                            "\(h.id.title) remote control",
                            isOn: Binding(
                                get: { h.remoteControlEnabled },
                                set: { enabled in
                                    Task {
                                        await store.controlHarness(
                                            h.id,
                                            action: enabled ? .startRemote : .stopRemote
                                        )
                                    }
                                }
                            )
                        )
                        .labelsHidden()
                        .tint(SHColor.harness(h.id))
                        .disabled(!h.capabilities.canControlDaemon)
                    }
                    .padding(.vertical, 2)
                }

                SHInlineDisclosureRow(
                    icon: "info.circle",
                    title: "Details",
                    isExpanded: showHarnessDetails
                ) {
                    withAnimation { showHarnessDetails.toggle() }
                }

                if showHarnessDetails {
                    ForEach(store.harnesses) { h in
                        detailRow(h.name, value: harnessDetail(h))
                    }
                }
            }
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    private func harnessDetail(_ h: HarnessDetection) -> String {
        var parts: [String] = []
        if let ver = h.version, !ver.isEmpty { parts.append("v\(ver)") }
        parts.append(h.daemonRunning ? "daemon on" : "daemon off")
        if !h.capabilities.canControlDaemon { parts.append("no remote toggle") }
        return parts.joined(separator: " · ")
    }

    // MARK: - Notifications

    private var notificationSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { store.pushNotificationsEnabled },
                set: { store.setPushNotificationsEnabled($0) }
            )) {
                rowLabel("Push Alerts", detail: PushNotificationCoordinator.shared.lastRegistrationStatus)
            }
            .tint(SHColor.accentPrimary)

            Button {
                Task {
                    isSendingTestPush = true
                    let ok = await store.sendTestPushNotification()
                    isSendingTestPush = false
                    testPushFeedback = ok ? "Test push sent" : "Push relay not deployed yet"
                }
            } label: {
                HStack {
                    Label("Send Test", systemImage: "bell.badge")
                    Spacer()
                    if isSendingTestPush {
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .disabled(isSendingTestPush || store.connectionMode != .live)

            if let testPushFeedback {
                Text(testPushFeedback)
                    .font(SHTypography.micro)
                    .foregroundStyle(SHColor.inkMuted)
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("Alerts when an agent finishes or asks for input, plus background session refresh.")
                .foregroundStyle(SHColor.inkFaint)
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    // MARK: - Row building blocks

    /// Primary line plus one optional quiet secondary line, each kept to a single line.
    private func rowLabel(_ title: String, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(SHTypography.label.weight(.semibold))
                .foregroundStyle(SHColor.inkPrimary)
                .lineLimit(1)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(SHTypography.micro)
                    .foregroundStyle(SHColor.inkMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    /// Read-only reference row used inside disclosures (full model ids, versions).
    private func detailRow(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(SHTypography.micro)
                .foregroundStyle(SHColor.inkMuted)
            Text(value)
                .font(SHTypography.monoSmall)
                .foregroundStyle(SHColor.inkSecondary)
                .textSelection(.enabled)
        }
        .padding(.vertical, 2)
    }

    private func labeledField<Field: View>(
        _ title: String,
        @ViewBuilder trailing: () -> some View = { EmptyView() },
        @ViewBuilder field: () -> Field
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                    .font(SHTypography.micro)
                    .foregroundStyle(SHColor.inkMuted)
                Spacer()
                trailing()
            }
            field()
                .font(SHTypography.mono)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.vertical, 2)
    }

    private func secretField(
        _ title: String,
        placeholder: String,
        text: Binding<String>,
        isRevealed: Binding<Bool>
    ) -> some View {
        labeledField(title) {
            Button(isRevealed.wrappedValue ? "Hide" : "Show") {
                isRevealed.wrappedValue.toggle()
            }
            .buttonStyle(.borderless)
            .font(SHTypography.micro.weight(.medium))
            .foregroundStyle(SHColor.accentPrimary)
        } field: {
            if isRevealed.wrappedValue {
                TextField(placeholder, text: text)
            } else {
                SecureField(placeholder, text: text)
            }
        }
    }

    private func runConnectionTest() async {
        isTesting = true
        defer { isTesting = false }
        testResult = await store.testHostConnection(urlString: hostURL, token: token)
    }

    private func saveAndClose() async {
        isSaving = true
        defer { isSaving = false }
        await store.saveDictationOverrides(url: dictationURL, token: dictationToken)
        await store.applyConnectionSettings(
            mode: isDemoMode ? .demo : .live,
            urlString: hostURL,
            token: token
        )
        dismiss()
    }
}
