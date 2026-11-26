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

    public init(store: AppStore) {
        self.store = store
        _isDemoMode = State(initialValue: store.connectionMode == .demo)
        _hostURL = State(initialValue: store.hostURLString)
        _token = State(initialValue: store.bearerToken)
        _dictationURL = State(initialValue: store.dictationURLOverride)
        _dictationToken = State(initialValue: store.dictationTokenOverride)
    }

    public var body: some View {
        NavigationStack {
            Form {
                // Prominent Demo Mode Toggle
                Section {
                    Toggle(isOn: $isDemoMode) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Demo Mode")
                                .font(SHTypography.label.weight(.semibold))
                                .foregroundStyle(SHColor.inkPrimary)
                            Text("Explore offline fixtures for Master, Antigravity, Codex, Claude, and Muse with simulated streaming.")
                                .font(SHTypography.micro)
                                .foregroundStyle(SHColor.inkMuted)
                        }
                    }
                    .tint(SHColor.brandMaster)
                } header: {
                    Text("Mode")
                }
                .listRowBackground(SHColor.surfaceSubtle)

                // Live Host Configuration
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Host URL (Tailscale or LAN)")
                            .font(SHTypography.micro)
                            .foregroundStyle(SHColor.inkMuted)
                        TextField("http://100.64.0.10:47890", text: $hostURL)
                            .font(SHTypography.mono)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    .padding(.vertical, 2)

                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("Bearer Token (Stored in Keychain)")
                                .font(SHTypography.micro)
                                .foregroundStyle(SHColor.inkMuted)
                            Spacer()
                            Button(revealToken ? "Hide" : "Show") {
                                revealToken.toggle()
                            }
                            .font(SHTypography.micro.weight(.medium))
                            .foregroundStyle(SHColor.accentPrimary)
                        }

                        if revealToken {
                            TextField("Paste host control token", text: $token)
                                .font(SHTypography.mono)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        } else {
                            SecureField("Paste host control token", text: $token)
                                .font(SHTypography.mono)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                    .padding(.vertical, 2)

                    Button {
                        Task { await runConnectionTest() }
                    } label: {
                        HStack {
                            if isTesting {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "bolt.horizontal.circle")
                            }
                            Text(isTesting ? "Testing connection…" : "Test Connection")
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
                    Text("Desktop Control Server")
                } footer: {
                    Text("Local networking is enabled so Tailscale (100.x.y.z) and LAN (192.168.x.x) hosts work directly without TLS setup.")
                        .foregroundStyle(SHColor.inkFaint)
                }
                .listRowBackground(SHColor.surfaceSubtle)
                .opacity(isDemoMode ? 0.55 : 1.0)

                // Dictation (YapYap) Configuration
                Section {
                    HStack(spacing: 10) {
                        Circle()
                            .fill(dictationDotColor)
                            .frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(dictationStatusHeadline)
                                .font(SHTypography.label.weight(.medium))
                                .foregroundStyle(SHColor.inkPrimary)
                            if let sub = dictationStatusDetail {
                                Text(sub)
                                    .font(SHTypography.micro)
                                    .foregroundStyle(SHColor.inkMuted)
                                    .lineLimit(2)
                            }
                        }
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

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Custom Dictation Server URL (Optional)")
                            .font(SHTypography.micro)
                            .foregroundStyle(SHColor.inkMuted)
                        TextField("Uses host YapYap config by default", text: $dictationURL)
                            .font(SHTypography.mono)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    .padding(.vertical, 2)

                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("Dictation Bearer Token (Optional)")
                                .font(SHTypography.micro)
                                .foregroundStyle(SHColor.inkMuted)
                            Spacer()
                            Button(revealDictationToken ? "Hide" : "Show") {
                                revealDictationToken.toggle()
                            }
                            .font(SHTypography.micro.weight(.medium))
                            .foregroundStyle(SHColor.accentPrimary)
                        }

                        if revealDictationToken {
                            TextField("Optional YapYap token", text: $dictationToken)
                                .font(SHTypography.mono)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        } else {
                            SecureField("Optional YapYap token", text: $dictationToken)
                                .font(SHTypography.mono)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                    .padding(.vertical, 2)
                } header: {
                    Text("Dictation (YapYap)")
                } footer: {
                    Text("Leave blank to proxy through your Linux host's ~/.config/yapyap/config.toml automatically.")
                        .foregroundStyle(SHColor.inkFaint)
                }
                .listRowBackground(SHColor.surfaceSubtle)

                // Detected Harnesses & Remote Control Toggles
                Section("Detected Harnesses") {
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

                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Text(h.name)
                                            .font(SHTypography.label.weight(.semibold))
                                            .foregroundStyle(SHColor.inkPrimary)
                                        if let ver = h.version {
                                            Text("v\(ver)")
                                                .font(SHTypography.monoSmall)
                                                .foregroundStyle(SHColor.inkFaint)
                                        }
                                    }
                                    Text("\(h.activeSessionCount) active · \(h.totalSessionCount) total · \(h.daemonRunning ? "daemon on" : "daemon off")")
                                        .font(SHTypography.micro)
                                        .foregroundStyle(SHColor.inkMuted)
                                }

                                Spacer()

                                if h.capabilities.canControlDaemon {
                                    Toggle(
                                        "",
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
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }
                .listRowBackground(SHColor.surfaceSubtle)

                Section {
                    Toggle("Task & Input Push Alerts", isOn: Binding(
                        get: { store.pushNotificationsEnabled },
                        set: { store.setPushNotificationsEnabled($0) }
                    ))
                    HStack {
                        Text("Push Relay")
                            .foregroundStyle(SHColor.inkSecondary)
                        Spacer()
                        Text(PushNotificationCoordinator.shared.lastRegistrationStatus)
                            .font(SHTypography.micro)
                            .foregroundStyle(SHColor.inkMuted)
                    }
                    Button {
                        Task {
                            isSendingTestPush = true
                            let ok = await store.sendTestPushNotification()
                            isSendingTestPush = false
                            testPushFeedback = ok ? "Test push sent" : "Push relay not deployed yet"
                        }
                    } label: {
                        HStack {
                            Label("Send Test Notification", systemImage: "bell.badge")
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
                    Text("Push Notifications & Background Sync")
                } footer: {
                    Text("Delivers APNs alerts via Cloudflare Push Relay when an agent finishes a task or asks for input, plus periodic background session refreshes.")
                }

                Section("Component & Pattern Library") {
                    Button {
                        showDesignCatalog = true
                    } label: {
                        Label("Open Design System Catalog", systemImage: "square.grid.2x2")
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

    private var dictationDotColor: Color {
        guard let st = store.dictationStatus else { return SHColor.inkFaint }
        if st.healthy { return SHColor.statusSuccess }
        return st.configured ? SHColor.statusDanger : SHColor.statusWarning
    }

    private var dictationStatusHeadline: String {
        guard let st = store.dictationStatus else { return "Checking YapYap…" }
        if st.healthy {
            if let model = st.model, !model.isEmpty {
                return "Connected · \(model)"
            }
            return "Connected"
        }
        if st.configured {
            return "Unreachable"
        }
        return "Not configured on host"
    }

    private var dictationStatusDetail: String? {
        guard let st = store.dictationStatus else { return nil }
        if let err = st.error, !err.isEmpty { return err }
        return st.url
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
