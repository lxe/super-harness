import SwiftUI

public struct HostConnectionSheet: View {
    @Bindable var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var isTesting: Bool = false
    @State private var isApplyingDemoMode: Bool = false
    @State private var isUnpairConfirmationPresented: Bool = false
    @State private var testResult: ConnectionTestResult?
    @State private var isSendingTestPush: Bool = false
    @State private var testPushFeedback: String?
    @State private var showDesignCatalog: Bool = false
    @State private var showHarnessDetails: Bool = false

    public init(store: AppStore) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            Form {
                // Before pairing only the developer options are relevant.
                if !store.needsPairing {
                    desktopSection
                    appearanceSection
                    dictationSection
                    harnessSection
                    reasoningSection
                    notificationSection
                }
                developerSection
            }
            .scrollContentBackground(.hidden)
            .background(SHColor.surfaceCanvas)
            .tint(SHColor.inkPrimary)
            .sheet(isPresented: $showDesignCatalog) {
                DesignSystemCatalogView()
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("settings.done")
                }
            }
            .confirmationDialog(
                "Unpair from \(desktopDisplayName)?",
                isPresented: $isUnpairConfirmationPresented,
                titleVisibility: .visible
            ) {
                Button("Unpair", role: .destructive) {
                    Task { await store.unpairFromDesktop() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This phone forgets the desktop. To use it again, pair from the desktop’s Settings → Mobile.")
            }
            .task {
                if store.dictationStatus == nil, !store.needsPairing {
                    await store.refreshDictationStatus()
                }
            }
        }
    }

    // MARK: - Desktop

    private var desktopDisplayName: String {
        store.pairedHostName.isEmpty ? "this desktop" : store.pairedHostName
    }

    /// The address without the scheme, e.g. "100.64.0.3:47890".
    private var desktopAddress: String {
        let raw = store.hostURLString
        guard let url = URL(string: raw), let host = url.host else { return raw }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    private var desktopSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(SHColor.inkSecondary)
                    .frame(width: 32, height: 32)
                    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
                rowLabel(
                    store.pairedHostName.isEmpty ? "Desktop" : store.pairedHostName,
                    detail: store.connectionMode == .demo ? "Demo mode is on" : desktopAddress
                )
                Spacer(minLength: 8)
                if store.connectionMode == .live {
                    Text(store.connectionHealth.label)
                        .font(SHTypography.micro.weight(.medium))
                        .foregroundStyle(store.connectionHealth == .connected ? SHColor.statusSuccess : SHColor.inkMuted)
                }
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("settings.desktop")

            if store.isPaired {
                Button {
                    Task { await runConnectionTest() }
                } label: {
                    HStack(spacing: 10) {
                        actionLabel(isTesting ? "Testing…" : "Test Connection", icon: "bolt.horizontal")
                        Spacer()
                        if isTesting {
                            SHActivityPulse(tint: SHColor.inkSecondary, size: 16)
                        }
                    }
                }
                .disabled(isTesting)

                if let result = testResult {
                    HStack(spacing: 8) {
                        Image(systemName: result.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundStyle(result.ok ? SHColor.statusSuccess : SHColor.statusDanger)
                        Text(result.message)
                            .font(SHTypography.micro)
                            .foregroundStyle(result.ok ? SHColor.statusSuccess : SHColor.statusDanger)
                    }
                }

                Button(role: .destructive) {
                    isUnpairConfirmationPresented = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "xmark.circle")
                            .font(.system(size: 14, weight: .medium))
                            .frame(width: 22)
                        Text("Unpair")
                            .font(SHTypography.label)
                    }
                    .foregroundStyle(SHColor.statusDanger)
                }
                .accessibilityIdentifier("settings.unpair")
            }
        } header: {
            sectionHeader("Desktop", icon: "desktopcomputer")
        } footer: {
            Text("Pair or revoke phones in Super Harness on the desktop, under Settings → Mobile.")
                .foregroundStyle(SHColor.inkFaint)
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    // MARK: - Developer

    private var developerSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { store.connectionMode == .demo },
                set: { enabled in
                    isApplyingDemoMode = true
                    Task {
                        await store.setDemoMode(enabled)
                        isApplyingDemoMode = false
                    }
                }
            )) {
                rowLabel("Demo Mode", detail: "Sample sessions, no desktop needed")
            }
            .tint(SHColor.toggleOn)
            .disabled(isApplyingDemoMode)
            .accessibilityIdentifier("settings.demoMode")

            Button {
                showDesignCatalog = true
            } label: {
                actionLabel("Design System Catalog", icon: "square.grid.2x2")
            }
        } header: {
            sectionHeader("Developer", icon: "hammer")
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    // MARK: - Chat Appearance

    private var appearanceSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                rowLabel("Text Size", detail: nil)
                Picker("Text Size", selection: $store.chatTextSize) {
                    ForEach(ChatTextSize.allCases) { size in
                        Text(size == .extraLarge ? "XL" : size.label).tag(size)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("settings.chatTextSize")
            }
            .padding(.vertical, 4)

            VStack(alignment: .leading, spacing: 8) {
                rowLabel("Spacing", detail: nil)
                Picker("Spacing", selection: $store.chatDensity) {
                    ForEach(ChatDensity.allCases) { density in
                        Text(density.label).tag(density)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("settings.chatDensity")
            }
            .padding(.vertical, 4)

            // Live sample drawn with the chosen size and spacing.
            VStack(alignment: .leading, spacing: store.chatMetrics.blockGap) {
                Text("Preview")
                    .font(SHTypography.micro)
                    .foregroundStyle(SHColor.inkMuted)
                SHMarkdownView(
                    text: "The tests pass and the build is ready to install.\n\n- Chat text follows this size.\n- Lines and messages follow this spacing.",
                    isUserBubble: false
                )
                .environment(\.shChatMetrics, store.chatMetrics)
            }
            .padding(.vertical, 4)
            .accessibilityIdentifier("settings.chatPreview")
        } header: {
            sectionHeader("Chat Appearance", icon: "textformat.size")
        } footer: {
            Text("Applies to messages in every chat on this device.")
                .foregroundStyle(SHColor.inkFaint)
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    // MARK: - Dictation

    private var dictationSection: some View {
        Section {
            HStack(spacing: 10) {
                Circle()
                    .fill(dictationDotColor)
                    .frame(width: 8, height: 8)
                rowLabel(dictationStatusHeadline, detail: dictationStatusDetail)
                Spacer()
                Button {
                    Task { await store.refreshDictationStatus() }
                } label: {
                    if store.isCheckingDictation {
                        SHActivityPulse(tint: SHColor.inkSecondary, size: 16)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(SHColor.inkSecondary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Check dictation")
            }
            .padding(.vertical, 2)
            .accessibilityIdentifier("settings.dictation")
        } header: {
            sectionHeader("Dictation", icon: "mic")
        } footer: {
            Text("Dictation runs through your desktop. Choose the dictation server in Super Harness on the desktop, under Settings → Dictation.")
                .foregroundStyle(SHColor.inkFaint)
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
        if st.healthy { return "Ready" }
        return st.configured ? "Dictation server unreachable" : "Not set up"
    }

    /// One quiet line under the status: the error when there is one, otherwise the model's
    /// short name ("OpenVINO/whisper-large-v3-turbo-fp16-ov" → "whisper-large-v3-turbo-fp16-ov").
    /// The full model id and server URL live under Advanced.
    private var dictationStatusDetail: String? {
        guard let st = store.dictationStatus else { return nil }
        if !st.configured { return AppStore.dictationSetupMessage }
        if let err = st.error, !err.isEmpty { return err }
        if st.healthy, let model = st.model, !model.isEmpty {
            return model.split(separator: "/").last.map(String.init) ?? model
        }
        return nil
    }

    // MARK: - Harnesses

    private var harnessSection: some View {
        Section {
            if store.harnesses.isEmpty {
                Text("No harnesses detected yet.")
                    .font(SHTypography.caption)
                    .foregroundStyle(SHColor.inkMuted)
            } else {
                ForEach(store.harnesses) { h in
                    HStack(spacing: 12) {
                        HarnessLogoView(group: h.id, size: 18)
                            .frame(width: 32, height: 32)
                            .background(Color.white.opacity(0.06))
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
                        .tint(SHColor.toggleOn)
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
        } header: {
            sectionHeader("Harnesses", icon: "square.stack.3d.up")
        } footer: {
            Text("The switch turns a harness's remote control on or off.")
                .foregroundStyle(SHColor.inkFaint)
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    private func harnessDetail(_ h: HarnessDetection) -> String {
        var parts: [String] = []
        if let ver = h.version, !ver.isEmpty {
            // Hosts report either a bare number ("1.5.18") or a full banner ("codex-cli 0.172.0").
            parts.append(ver.first?.isNumber == true ? "v\(ver)" : ver)
        }
        parts.append(h.daemonRunning ? "daemon on" : "daemon off")
        if !h.capabilities.canControlDaemon { parts.append("no remote toggle") }
        return parts.joined(separator: " · ")
    }

    // MARK: - Thinking Effort

    private var reasoningSection: some View {
        Section {
            Toggle(isOn: $store.allowExtremeReasoning) {
                rowLabel("Max and Ultra Effort", detail: store.allowExtremeReasoning ? "Offered in the effort menu" : "Hidden; nothing starts at Max or Ultra")
            }
            .tint(SHColor.toggleOn)
            .accessibilityIdentifier("settings.extremeReasoning")
        } header: {
            sectionHeader("Thinking Effort", icon: "brain")
        }
        .listRowBackground(SHColor.surfaceSubtle)
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
            .tint(SHColor.toggleOn)

            Button {
                Task {
                    isSendingTestPush = true
                    let ok = await store.sendTestPushNotification()
                    isSendingTestPush = false
                    testPushFeedback = ok ? "Test push sent" : "Push relay not deployed yet"
                }
            } label: {
                HStack {
                    actionLabel("Send Test Alert", icon: "bell.badge")
                    Spacer()
                    if isSendingTestPush {
                        SHActivityPulse(tint: SHColor.inkSecondary, size: 16)
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
            sectionHeader("Notifications", icon: "bell")
        } footer: {
            Text("Alerts when an agent finishes or asks for input, plus background session refresh.")
                .foregroundStyle(SHColor.inkFaint)
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    // MARK: - Row building blocks

    /// Section title with a small icon; every section uses this so the page reads as one list.
    private func sectionHeader(_ title: String, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
            Text(title)
                .font(.system(size: 12, weight: .semibold))
        }
        .foregroundStyle(SHColor.inkMuted)
        .textCase(nil)
    }

    /// A tappable row: neutral icon, primary-coloured title.
    private func actionLabel(_ title: String, icon: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(SHColor.inkSecondary)
                .frame(width: 22)
            Text(title)
                .font(SHTypography.label)
                .foregroundStyle(SHColor.inkPrimary)
        }
    }

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

    private func runConnectionTest() async {
        isTesting = true
        defer { isTesting = false }
        testResult = await store.testHostConnection(urlString: store.hostURLString, token: store.bearerToken)
    }
}
