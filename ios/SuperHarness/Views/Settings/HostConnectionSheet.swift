import SwiftUI

/// The Settings sheet. It lists the machines this phone is paired with and mirrors what the
/// desktop app lets you set: nothing here is a phone-only switch for something the desktop
/// controls, and host internals are not shown.
///
/// Layout follows the rest of the app: a quiet section title, then one raised card per section.
/// Every row uses the same icon column, so icons, labels and dividers line up across cards.
public struct HostConnectionSheet: View {
    @Bindable var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var isTesting: Bool = false
    @State private var isApplyingDemoMode: Bool = false
    @State private var machinePendingUnpair: PairedMachine?
    @State private var isPairingSheetPresented: Bool = false
    @State private var testResult: ConnectionTestResult?
    @State private var isSendingTestPush: Bool = false
    @State private var testPushFeedback: String?
    @State private var showDesignCatalog: Bool = false

    public init(store: AppStore) {
        self.store = store
    }

    /// Width of the leading icon column and the gap after it. Dividers start at the label.
    private static let iconColumn = SHCardMetrics.iconColumn
    private static let iconGap = SHCardMetrics.iconGap
    fileprivate static let rowInset = SHCardMetrics.rowInset
    private static var labelInset: CGFloat { SHCardMetrics.labelInset }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    // Before pairing only the developer options are relevant.
                    if !store.needsPairing {
                        machinesSection
                        appearanceSection
                        harnessSection
                        reasoningSection
                        notificationSection
                    }
                    developerSection
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 32)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .background(SHColor.surfaceCanvas)
            .tint(SHColor.inkPrimary)
            .sheet(isPresented: $showDesignCatalog) {
                DesignSystemCatalogView()
            }
            .sheet(isPresented: $isPairingSheetPresented) {
                PairingView(store: store, isAdditional: true)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            // A finished pairing changes the machine being shown: close the pairing sheet.
            .onChange(of: store.activeMachineId) { _, _ in
                isPairingSheetPresented = false
                testResult = nil
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
                "Unpair from \(machinePendingUnpair?.displayName ?? "this machine")?",
                isPresented: Binding(get: { machinePendingUnpair != nil }, set: { if !$0 { machinePendingUnpair = nil } }),
                titleVisibility: .visible,
                presenting: machinePendingUnpair
            ) { machine in
                Button("Unpair", role: .destructive) {
                    Task { await store.unpairMachine(machine.id) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("This phone forgets the machine. To use it again, pair from Settings → Mobile in Superharness on that machine.")
            }
        }
    }

    // MARK: - Machines

    private var machinesSection: some View {
        section("Machines") {
            if store.machines.isEmpty {
                // A connection without a machine entry: the demo, or a preview.
                row(icon: "desktopcomputer", title: store.pairedHostName.isEmpty ? "Desktop" : store.pairedHostName,
                    detail: store.connectionMode == .demo ? "Demo mode is on" : nil) { EmptyView() }
                    .accessibilityIdentifier("settings.desktop")
            }
            ForEach(Array(store.machines.enumerated()), id: \.element.id) { index, machine in
                if index > 0 { divider }
                machineRow(machine)
            }
            divider
            Button {
                isPairingSheetPresented = true
            } label: {
                row(icon: "plus", title: store.machines.isEmpty ? "Pair a Machine" : "Pair Another Machine") { EmptyView() }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings.pairAnother")
        }
    }

    private func machineRow(_ machine: PairedMachine) -> some View {
        let isActive = machine.id == store.activeMachineId
        let status: String? = {
            guard isActive else { return nil }
            if store.connectionMode == .demo { return "Demo" }
            return store.connectionHealth.label
        }()
        let detail: String = {
            if isActive, isTesting { return "Testing…" }
            if isActive, let message = testResult?.message { return message }
            return machine.address
        }()
        return HStack(spacing: 4) {
            Button {
                guard !isActive else { return }
                Task { await store.switchMachine(to: machine.id) }
            } label: {
                HStack(spacing: 8) {
                    iconLabel(
                        icon: "desktopcomputer",
                        title: machine.displayName,
                        detail: detail,
                        tint: SHColor.inkPrimary,
                        detailColor: isActive && testResult != nil && !isTesting ? testResultColor : SHColor.inkMuted
                    )
                    Spacer(minLength: 8)
                    if let status {
                        HStack(spacing: 5) {
                            Circle()
                                .fill(isActive && store.connectionHealth == .connected && store.connectionMode == .live
                                      ? SHColor.statusSuccess : SHColor.inkFaint)
                                .frame(width: 7, height: 7)
                            Text(status)
                                .font(SHTypography.caption.weight(.medium))
                                .foregroundStyle(SHColor.inkSecondary)
                        }
                    }
                }
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isActive ? .isSelected : [])
            .accessibilityIdentifier(isActive ? "settings.desktop" : "settings.machine.\(machine.id)")

            Menu {
                if !isActive {
                    Button {
                        Task { await store.switchMachine(to: machine.id) }
                    } label: {
                        Label("Switch to This Machine", systemImage: "arrow.left.arrow.right")
                    }
                } else if store.connectionMode == .live {
                    Button {
                        Task { await runConnectionTest() }
                    } label: {
                        Label("Test Connection", systemImage: "bolt.horizontal")
                    }
                }
                Button(role: .destructive) {
                    machinePendingUnpair = machine
                } label: {
                    Label("Unpair", systemImage: "xmark.circle")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(SHColor.inkMuted)
                    .frame(width: 36, height: 40)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("\(machine.displayName) options")
            .accessibilityIdentifier("settings.machineMenu.\(machine.id)")
        }
        .padding(.leading, Self.rowInset)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
    }

    private var testResultColor: Color {
        guard let testResult else { return SHColor.inkMuted }
        return testResult.ok ? SHColor.statusSuccess : SHColor.statusDanger
    }

    // MARK: - Chat Appearance

    private var appearanceSection: some View {
        section("Chat Appearance") {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Text Size")
                        .font(SHTypography.label)
                        .foregroundStyle(SHColor.inkSecondary)
                    SHChoiceBar(
                        options: ChatTextSize.allCases.map { ($0, $0 == .extraLarge ? "X-Large" : $0.label) },
                        selection: $store.chatTextSize
                    )
                    .accessibilityIdentifier("settings.chatTextSize")
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Spacing")
                        .font(SHTypography.label)
                        .foregroundStyle(SHColor.inkSecondary)
                    SHChoiceBar(
                        options: ChatDensity.allCases.map { ($0, $0.label) },
                        selection: $store.chatDensity
                    )
                    .accessibilityIdentifier("settings.chatDensity")
                }
                // Live sample drawn with the chosen size and spacing.
                SHMarkdownView(
                    text: "The tests pass and the build is ready to install.\n\n- Chat text follows this size.\n- Lines and paragraphs follow this spacing.",
                    isUserBubble: false
                )
                .environment(\.shChatMetrics, store.chatMetrics)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .shRecessedWell(cornerRadius: SHRadius.md)
                .accessibilityIdentifier("settings.chatPreview")
            }
            .padding(Self.rowInset)
        }
    }

    // MARK: - Harnesses

    /// The desktop's own "Enable <harness>" switches (settings.enabledHarnesses).
    private var harnessSection: some View {
        section("Harnesses") {
            ForEach(Array(store.harnessOrder.enumerated()), id: \.element) { index, group in
                let detection = store.harnesses.first { $0.id == group }
                if index > 0 { divider }
                Toggle(isOn: Binding(
                    get: { store.isHarnessEnabled(group) },
                    set: { enabled in Task { await store.setHarnessEnabled(group, enabled: enabled) } }
                )) {
                    HStack(spacing: Self.iconGap) {
                        HarnessLogoView(group: group, size: 19)
                            .frame(width: Self.iconColumn, height: Self.iconColumn)
                        rowLabel(
                            group.title,
                            detail: detection.map { "\($0.activeSessionCount) active · \($0.totalSessionCount) total" }
                        )
                    }
                }
                .tint(SHColor.toggleOn)
                .modifier(RowPadding())
                .accessibilityIdentifier("settings.harness.\(group.rawValue)")
                // The harness's update, if it has one: version change, Update button, progress.
                if HarnessUpdateRow.content(info: detection?.update, job: store.harnessUpdateJobs[group]) != .none {
                    HarnessUpdateRow(store: store, group: group)
                        .padding(.leading, Self.labelInset)
                        .padding(.trailing, Self.rowInset)
                        .padding(.bottom, 10)
                }
            }
        }
    }

    // MARK: - Thinking Effort

    private var reasoningSection: some View {
        section("Thinking Effort") {
            Toggle(isOn: $store.allowExtremeReasoning) {
                iconLabel(
                    icon: "brain",
                    title: "Max and Ultra Effort",
                    detail: store.allowExtremeReasoning ? "Offered in the effort menu" : "Hidden from the effort menu"
                )
            }
            .tint(SHColor.toggleOn)
            .modifier(RowPadding())
            .accessibilityIdentifier("settings.extremeReasoning")
        }
    }

    // MARK: - Notifications

    private var notificationSection: some View {
        section("Notifications") {
            Toggle(isOn: Binding(
                get: { store.pushNotificationsEnabled },
                set: { store.setPushNotificationsEnabled($0) }
            )) {
                iconLabel(icon: "bell", title: "Push Alerts", detail: PushNotificationCoordinator.shared.lastRegistrationStatus)
            }
            .tint(SHColor.toggleOn)
            .modifier(RowPadding())

            divider

            Toggle(isOn: Binding(
                get: { store.appIconBadgeEnabled },
                set: { store.setAppIconBadgeEnabled($0) }
            )) {
                iconLabel(
                    icon: "app.badge",
                    title: "App Icon Badge",
                    detail: store.appIconBadgeEnabled
                        ? (store.unreadSessionCount > 0 ? "\(store.unreadSessionCount) unread" : "Shows unread session count")
                        : "Off"
                )
            }
            .tint(SHColor.toggleOn)
            .modifier(RowPadding())
            .accessibilityIdentifier("settings.appIconBadge")

            divider

            Button {
                Task {
                    isSendingTestPush = true
                    let ok = await store.sendTestPushNotification()
                    isSendingTestPush = false
                    testPushFeedback = ok ? "Test alert sent" : "The test alert could not be sent"
                }
            } label: {
                row(icon: "bell.badge", title: "Send Test Alert", detail: testPushFeedback) {
                    if isSendingTestPush {
                        SHActivityPulse(tint: SHColor.inkSecondary, size: 16)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(isSendingTestPush || store.connectionMode != .live)
            .opacity(store.connectionMode != .live ? 0.45 : 1)
        }
    }

    // MARK: - Developer

    private var developerSection: some View {
        section("Developer") {
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
                iconLabel(icon: "play.rectangle", title: "Demo Mode", detail: "Sample sessions")
            }
            .tint(SHColor.toggleOn)
            .disabled(isApplyingDemoMode)
            .modifier(RowPadding())
            .accessibilityIdentifier("settings.demoMode")

            divider

            Button {
                showDesignCatalog = true
            } label: {
                row(icon: "square.grid.2x2", title: "Design System Catalog") {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(SHColor.inkFaint)
                }
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Building blocks (thin names for the shared card pieces)

    private func section<Content: View>(_ title: String, @ViewBuilder content: @escaping () -> Content) -> some View {
        SHSectionCard(title, content: content)
    }

    private var divider: some View { SHCardDivider() }

    private typealias RowPadding = SHCardRowPadding

    private func rowLabel(_ title: String, detail: String?, tint: Color = SHColor.inkPrimary, detailColor: Color = SHColor.inkMuted) -> some View {
        SHCardRowLabel(title: title, detail: detail, tint: tint, detailColor: detailColor)
    }

    private func iconLabel(icon: String, title: String, detail: String? = nil, tint: Color = SHColor.inkPrimary, detailColor: Color = SHColor.inkMuted) -> some View {
        SHCardIconLabel(icon: icon, title: title, detail: detail, tint: tint, detailColor: detailColor)
    }

    private func row<Trailing: View>(
        icon: String,
        title: String,
        detail: String? = nil,
        tint: Color = SHColor.inkPrimary,
        detailColor: Color = SHColor.inkMuted,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) -> some View {
        SHCardRow(icon: icon, title: title, detail: detail, tint: tint, detailColor: detailColor, trailing: trailing)
    }

    private func runConnectionTest() async {
        isTesting = true
        defer { isTesting = false }
        testResult = await store.testHostConnection(urlString: store.hostURLString, token: store.bearerToken)
    }
}
