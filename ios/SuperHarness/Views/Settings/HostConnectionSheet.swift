import SwiftUI

/// The Settings sheet. It mirrors what the desktop app lets you set: nothing here is a
/// phone-only switch for something the desktop controls, and host internals are not shown.
///
/// Every row uses the same icon column, so icons, labels and separators line up across sections.
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

    public init(store: AppStore) {
        self.store = store
    }

    /// Width of the leading icon column and the gap after it. Separators start at the label.
    private static let iconColumn: CGFloat = 30
    private static let iconGap: CGFloat = 12
    private static var labelInset: CGFloat { iconColumn + iconGap }

    public var body: some View {
        NavigationStack {
            Form {
                // Before pairing only the developer options are relevant.
                if !store.needsPairing {
                    desktopSection
                    appearanceSection
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
            row(
                icon: "desktopcomputer",
                title: store.pairedHostName.isEmpty ? "Desktop" : store.pairedHostName,
                detail: store.connectionMode == .demo ? "Demo mode is on" : desktopAddress
            ) {
                if store.connectionMode == .live {
                    Text(store.connectionHealth.label)
                        .font(SHTypography.caption.weight(.medium))
                        .foregroundStyle(store.connectionHealth == .connected ? SHColor.statusSuccess : SHColor.inkMuted)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("settings.desktop")

            if store.isPaired {
                Button {
                    Task { await runConnectionTest() }
                } label: {
                    row(
                        icon: "bolt.horizontal",
                        title: isTesting ? "Testing…" : "Test Connection",
                        detail: testResult?.message,
                        detailColor: testResultColor
                    ) {
                        if isTesting {
                            SHActivityPulse(tint: SHColor.inkSecondary, size: 16)
                        }
                    }
                }
                .disabled(isTesting)

                Button {
                    isUnpairConfirmationPresented = true
                } label: {
                    row(icon: "xmark.circle", title: "Unpair", tint: SHColor.statusDanger) { EmptyView() }
                }
                .accessibilityIdentifier("settings.unpair")
            }
        } header: {
            sectionHeader("Desktop")
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    private var testResultColor: Color {
        guard let testResult else { return SHColor.inkMuted }
        return testResult.ok ? SHColor.statusSuccess : SHColor.statusDanger
    }

    // MARK: - Chat Appearance

    private var appearanceSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Text("Text Size")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(SHColor.inkPrimary)
                SHChoiceBar(
                    options: ChatTextSize.allCases.map { ($0, $0 == .extraLarge ? "X-Large" : $0.label) },
                    selection: $store.chatTextSize
                )
                .accessibilityIdentifier("settings.chatTextSize")
            }
            .padding(.vertical, 2)
            .listRowSeparator(.hidden)

            VStack(alignment: .leading, spacing: 10) {
                Text("Spacing")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(SHColor.inkPrimary)
                SHChoiceBar(
                    options: ChatDensity.allCases.map { ($0, $0.label) },
                    selection: $store.chatDensity
                )
                .accessibilityIdentifier("settings.chatDensity")
            }
            .padding(.vertical, 2)
            .listRowSeparator(.hidden)

            // Live sample drawn with the chosen size and spacing.
            SHMarkdownView(
                text: "The tests pass and the build is ready to install.\n\n- Chat text follows this size.\n- Lines and paragraphs follow this spacing.",
                isUserBubble: false
            )
            .environment(\.shChatMetrics, store.chatMetrics)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(SHColor.surfaceCanvas, in: RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
            .padding(.vertical, 2)
            .listRowSeparator(.hidden)
            .accessibilityIdentifier("settings.chatPreview")
        } header: {
            sectionHeader("Chat Appearance")
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    // MARK: - Harnesses

    /// The desktop's own "Enable <harness>" switches (settings.enabledHarnesses).
    private var harnessSection: some View {
        Section {
            ForEach(store.harnessOrder) { group in
                let detection = store.harnesses.first { $0.id == group }
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
                .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + Self.labelInset }
                .accessibilityIdentifier("settings.harness.\(group.rawValue)")
            }
        } header: {
            sectionHeader("Harnesses")
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    // MARK: - Thinking Effort

    private var reasoningSection: some View {
        Section {
            Toggle(isOn: $store.allowExtremeReasoning) {
                iconLabel(
                    icon: "brain",
                    title: "Max and Ultra Effort",
                    detail: store.allowExtremeReasoning ? "Offered in the effort menu" : "Hidden from the effort menu"
                )
            }
            .tint(SHColor.toggleOn)
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + Self.labelInset }
            .accessibilityIdentifier("settings.extremeReasoning")
        } header: {
            sectionHeader("Thinking Effort")
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
                iconLabel(icon: "bell", title: "Push Alerts", detail: PushNotificationCoordinator.shared.lastRegistrationStatus)
            }
            .tint(SHColor.toggleOn)
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + Self.labelInset }

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
            .disabled(isSendingTestPush || store.connectionMode != .live)
        } header: {
            sectionHeader("Notifications")
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
                iconLabel(icon: "play.rectangle", title: "Demo Mode", detail: "Sample sessions")
            }
            .tint(SHColor.toggleOn)
            .disabled(isApplyingDemoMode)
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + Self.labelInset }
            .accessibilityIdentifier("settings.demoMode")

            Button {
                showDesignCatalog = true
            } label: {
                row(icon: "square.grid.2x2", title: "Design System Catalog") {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(SHColor.inkFaint)
                }
            }
        } header: {
            sectionHeader("Developer")
        }
        .listRowBackground(SHColor.surfaceSubtle)
    }

    // MARK: - Row building blocks

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(SHColor.inkMuted)
            .textCase(nil)
    }

    /// Title with one optional quiet line under it.
    private func rowLabel(_ title: String, detail: String?, tint: Color = SHColor.inkPrimary, detailColor: Color = SHColor.inkMuted) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(tint)
                .lineLimit(1)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(SHTypography.caption)
                    .foregroundStyle(detailColor)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    /// Icon in the fixed leading column, then the label.
    private func iconLabel(icon: String, title: String, detail: String? = nil, tint: Color = SHColor.inkPrimary, detailColor: Color = SHColor.inkMuted) -> some View {
        HStack(spacing: Self.iconGap) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(tint == SHColor.inkPrimary ? SHColor.inkSecondary : tint)
                .frame(width: Self.iconColumn, height: Self.iconColumn)
            rowLabel(title, detail: detail, tint: tint, detailColor: detailColor)
        }
    }

    /// The one row layout: icon column, label, optional trailing content. Its separator starts
    /// at the label, the same as every other row.
    private func row<Trailing: View>(
        icon: String,
        title: String,
        detail: String? = nil,
        tint: Color = SHColor.inkPrimary,
        detailColor: Color = SHColor.inkMuted,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: 8) {
            iconLabel(icon: icon, title: title, detail: detail, tint: tint, detailColor: detailColor)
            Spacer(minLength: 8)
            trailing()
        }
        .frame(minHeight: 36)
        .contentShape(Rectangle())
        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + Self.labelInset }
    }

    private func runConnectionTest() async {
        isTesting = true
        defer { isTesting = false }
        testResult = await store.testHostConnection(urlString: store.hostURLString, token: store.bearerToken)
    }
}

/// A full-height row of choices, one selected: the same job as a segmented control, at a size
/// that is comfortable to tap and read.
struct SHChoiceBar<Value: Hashable>: View {
    let options: [(value: Value, label: String)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let isSelected = option.value == selection
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { selection = option.value }
                } label: {
                    Text(option.label)
                        .font(.system(size: 15, weight: isSelected ? .semibold : .regular))
                        .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .background(
                            isSelected ? Color.white.opacity(0.14) : Color.clear,
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(4)
        .background(SHColor.surfaceCanvas, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
}
