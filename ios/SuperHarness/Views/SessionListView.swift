import SwiftUI

// MARK: - Session Row Subtitle Formatting

public enum SessionRowFormatting {
    private static let redundantProjectNames: Set<String> = [
        "antigravity",
        "codex",
        "claude",
        "claude cli",
        "claude tmux",
        "claude desktop",
        "muse",
        "master",
        "super harness",
    ]

    /// Returns a clean project name suitable for a session subtitle, suppressing
    /// redundant harness/app names since the official harness logo already identifies it.
    public static func cleanProjectName(for session: UnifiedSession) -> String? {
        let trimmed = session.projectName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if redundantProjectNames.contains(trimmed.lowercased()) {
            return nil
        }
        return trimmed
    }

    /// Suppresses preview text when it is empty or duplicates the session title.
    public static func cleanPreview(for session: UnifiedSession) -> String? {
        let rawPreview = session.preview.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawPreview.isEmpty else { return nil }

        let normPreview = normalize(rawPreview)
        let normTitle = normalize(session.displayTitle)
        guard !normPreview.isEmpty else { return nil }

        if normPreview == normTitle || normTitle.hasPrefix(normPreview) {
            return nil
        }
        if normPreview.hasPrefix(normTitle) {
            let suffix = normPreview.dropFirst(normTitle.count)
                .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
            if suffix.isEmpty {
                return nil
            }
        }
        return rawPreview
    }

    private static func normalize(_ value: String) -> String {
        value
            .lowercased()
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

public struct SessionListView: View {
    @AppStorage("sh.collapsedSections") private var collapsedSectionsRaw: String = ""

    private var collapsedSectionIds: Set<String> {
        Set(collapsedSectionsRaw.split(separator: "\n").map(String.init))
    }

    private func toggleCollapsed(_ id: String) {
        var ids = collapsedSectionIds
        if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
        collapsedSectionsRaw = ids.sorted().joined(separator: "\n")
    }

    @Bindable var store: AppStore
    public let onSelectSession: (String) -> Void

    public init(store: AppStore, onSelectSession: @escaping (String) -> Void) {
        self.store = store
        self.onSelectSession = onSelectSession
    }

    public var body: some View {
        Group {
            if (store.isBootstrapping || !store.hasCompletedBootstrap) && store.sessions.isEmpty {
                SessionListSkeletonView()
            } else {
                sessionListContent
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarLeading) {
                ConnectionStatusPill(health: store.connectionHealth) {
                    store.isHostSettingsSheetPresented = true
                }

                if let master = store.masterSession {
                    let isMasterBusy = store.isSessionBusy(master.id)
                    Button {
                        onSelectSession(master.id)
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "sparkles")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(SHColor.brandMaster)
                            Text("Master")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(SHColor.inkPrimary)
                                .lineLimit(1)
                            if isMasterBusy {
                                ProgressView()
                                    .controlSize(.mini)
                                    .tint(SHColor.brandMaster)
                                    .scaleEffect(0.75)
                            }
                        }
                        .padding(.horizontal, 6)
                        .fixedSize(horizontal: true, vertical: false)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Master Orchestrator")
                    .accessibilityIdentifier("header.master")
                }
            }

            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    store.openUsageSheet(for: store.selectedHarnessFilter)
                } label: {
                    Image(systemName: "chart.bar.xaxis")
                        .foregroundStyle(SHColor.inkSecondary)
                }
                .accessibilityLabel("Usage Quotas")

                Menu {
                    Section("Group Sessions By") {
                        ForEach(SidebarGroupBy.allCases) { mode in
                            Button {
                                store.groupBy = mode
                            } label: {
                                Label(mode.label, systemImage: store.groupBy == mode ? "checkmark" : mode.symbolName)
                            }
                        }
                    }
                    Section("Visibility") {
                        Toggle("Show Archived", isOn: $store.showArchived)
                        Toggle("Show Hidden", isOn: $store.showHidden)
                    }
                    Section {
                        Button {
                            store.isHostSettingsSheetPresented = true
                        } label: {
                            Label("Host Connection", systemImage: "server.rack")
                        }
                    }
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                        .foregroundStyle(SHColor.inkSecondary)
                }
                .accessibilityLabel("Grouping and Filters")

                Button {
                    store.openDraftChat(for: store.selectedHarnessFilter)
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(SHColor.inkPrimary)
                }
                .accessibilityLabel("New Chat")
            }
        }
    }

    private var sessionListContent: some View {
        List {
            // Subtle error banner if live host had an issue
            if let error = store.lastError {
                Section {
                    HStack(spacing: SHSpacing.sm) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(SHColor.statusWarning)
                            .font(.system(size: 13))
                        Text(error)
                            .font(SHTypography.micro)
                            .foregroundStyle(SHColor.inkSecondary)
                            .lineLimit(2)
                        Spacer()
                        Button {
                            store.lastError = nil
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(SHColor.inkMuted)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.vertical, 6)
                }
                .listRowBackground(SHColor.surfacePopover)
            }



            // Horizontal harness switcher pills with live quota bar & quick '+' button
            Section {
                HarnessSwitcherStrip(store: store)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }

            // Globally Pinned-to-Top section
            let topPinned = store.pinnedToTopSessions
            if !topPinned.isEmpty {
                Section {
                    ForEach(topPinned) { session in
                        sessionRowButton(session)
                    }
                } header: {
                    HStack(spacing: 6) {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(SHColor.brandMaster)
                        Text("PINNED TO TOP")
                            .font(SHTypography.micro.weight(.semibold))
                            .foregroundStyle(SHColor.inkMuted)
                    }
                    .padding(.bottom, 2)
                }
            }

            // Grouped session sections
            let sections = store.groupedSections
            if sections.isEmpty && !store.isBootstrapping && store.hasCompletedBootstrap {
                Section {
                    VStack(spacing: SHSpacing.sm) {
                        Image(systemName: "tray")
                            .font(.system(size: 24))
                            .foregroundStyle(SHColor.inkFaint)
                        Text("No matching sessions")
                            .font(SHTypography.label)
                            .foregroundStyle(SHColor.inkSecondary)
                        Text("Adjust your filter or start a new session.")
                            .font(SHTypography.micro)
                            .foregroundStyle(SHColor.inkMuted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, SHSpacing.xxl)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
            } else {
                ForEach(sections) { section in
                    if section.isHeadless {
                        Section {
                            ForEach(section.sessions) { session in
                                sessionRowButton(session, hideProjectSubtitle: false)
                            }
                        }
                    } else {
                        let isCollapsed = collapsedSectionIds.contains(section.id)
                        Section {
                            if !isCollapsed {
                                ForEach(section.sessions) { session in
                                    sessionRowButton(session, hideProjectSubtitle: section.isProjectOrSectionGroup)
                                }
                            }
                        } header: {
                            Button {
                                withAnimation(.easeInOut(duration: 0.18)) {
                                    toggleCollapsed(section.id)
                                }
                            } label: {
                            HStack(spacing: 7) {
                                if let group = section.harnessGroup {
                                    HarnessLogoView(group: group, size: 13)
                                } else if let hex = section.accentHex {
                                    Circle()
                                        .fill(Color(cssHex: hex))
                                        .frame(width: 7, height: 7)
                                } else if section.isProjectOrSectionGroup {
                                    Image(systemName: "folder")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundStyle(SHColor.inkMuted)
                                }
                                Text(section.isProjectOrSectionGroup ? section.title : section.title.uppercased())
                                    .font(SHTypography.micro.weight(.semibold))
                                    .foregroundStyle(SHColor.inkMuted)
                                    .textCase(section.isProjectOrSectionGroup ? nil : .uppercase)
                                    .lineLimit(1)
                                if store.isAnyWorking(in: section) {
                                    ProgressView()
                                        .controlSize(.mini)
                                        .tint(section.harnessGroup.map(SHColor.harness) ?? SHColor.inkSecondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(SHColor.inkFaint)
                                    .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                            }
                            .padding(.bottom, 2)
                            .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("section.header.\(section.id)")
                            .accessibilityValue(isCollapsed ? "collapsed" : "expanded")
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(12)
        .contentMargins(.top, 4, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .background(SHColor.surfaceRail)
        .searchable(
            text: $store.searchQuery,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: "Search sessions, branches, projects"
        )
        .refreshable {
            await store.refresh()
        }
    }

    @ViewBuilder
    private func sessionRowButton(_ session: UnifiedSession, hideProjectSubtitle: Bool = false) -> some View {
        let isSelected = store.selectedSessionId == session.id
        let isBusy = store.isSessionBusy(session.id)

        Button {
            onSelectSession(session.id)
        } label: {
            SessionListRow(
                session: session,
                isBusy: isBusy,
                hideProjectSubtitle: hideProjectSubtitle
            )
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(
                RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous)
                    .fill(isSelected ? SHColor.surfaceRaised : SHColor.surfaceSubtle)
            )
            .contentShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
        }
        .buttonStyle(.plain)
        // Each row is its own rounded card so swipe actions slide a rounded shape instead of a hard edge.
        .listRowInsets(EdgeInsets(top: 3, leading: 0, bottom: 3, trailing: 0))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                Task { await store.togglePin(session) }
            } label: {
                Label(session.pinned ? "Unpin" : "Pin", systemImage: session.pinned ? "pin.slash" : "pin")
            }
            .tint(SHColor.brandMaster)

            Button {
                Task { await store.togglePinToTop(session) }
            } label: {
                Label(session.pinnedToTop ? "Unpin Top" : "Pin Top", systemImage: "arrow.up.to.line")
            }
            .tint(SHColor.brandAntigravity)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await store.archiveSession(session) }
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .tint(SHColor.statusDanger)

            Button {
                Task { await store.toggleHideSession(session) }
            } label: {
                Label(session.hidden ? "Unhide" : "Hide", systemImage: session.hidden ? "eye" : "eye.slash")
            }
            .tint(SHColor.inkFaint)
        }
        .contextMenu {
            Button {
                Task { await store.togglePin(session) }
            } label: {
                Label(session.pinned ? "Unpin" : "Pin", systemImage: session.pinned ? "pin.slash" : "pin")
            }
            Button {
                Task { await store.togglePinToTop(session) }
            } label: {
                Label(session.pinnedToTop ? "Remove from Top" : "Pin to Top", systemImage: "arrow.up.to.line")
            }
            Divider()
            Button {
                Task { await store.toggleHideSession(session) }
            } label: {
                Label(session.hidden ? "Unhide Session" : "Hide Session", systemImage: session.hidden ? "eye" : "eye.slash")
            }
            Button(role: .destructive) {
                Task { await store.archiveSession(session) }
            } label: {
                Label("Archive Session", systemImage: "archivebox")
            }
        }
    }
}

// MARK: - Master Row

private struct MasterSessionRow: View {
    let session: UnifiedSession
    let isSelected: Bool
    let isBusy: Bool

    var body: some View {
        HStack(spacing: 13) {
            ZStack {
                RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous)
                    .fill(SHColor.brandMaster.opacity(0.11))
                    .frame(width: 36, height: 36)
                HarnessLogoView(harness: .master, size: 19)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(session.displayTitle)
                        .font(SHTypography.heading)
                        .foregroundStyle(SHColor.inkPrimary)
                        .lineLimit(1)
                    Spacer()
                    if isBusy {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(SHColor.brandMaster)
                    } else {
                        Text(UsageMetrics.formatUpdatedAgo(session.updatedAt))
                            .font(SHTypography.micro)
                            .foregroundStyle(SHColor.inkFaint)
                    }
                }
                if let preview = SessionRowFormatting.cleanPreview(for: session) {
                    Text(preview)
                        .font(SHTypography.caption)
                        .foregroundStyle(SHColor.inkMuted)
                        .lineLimit(1)
                } else {
                    Text("Cross-harness orchestrator")
                        .font(SHTypography.caption)
                        .foregroundStyle(SHColor.inkMuted)
                        .lineLimit(1)
                }
            }
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Horizontal Harness Switcher Strip

private struct HarnessSwitcherStrip: View {
    @Bindable var store: AppStore

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                allPill

                ForEach(HarnessGroup.allCases) { group in
                    harnessPill(group)
                }
            }
            .padding(.trailing, 4)
            .padding(.vertical, 2)
        }
    }

    private var allPill: some View {
        let isSelected = store.selectedHarnessFilter == nil
        return Button {
            withAnimation(.easeInOut(duration: 0.16)) {
                store.selectedHarnessFilter = nil
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "square.grid.2x2")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkMuted)
                    Text("All")
                        .font(SHTypography.caption.weight(.semibold))
                        .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkSecondary)
                    Text("\(store.sessions.filter { !$0.isMaster && !$0.hidden && $0.status != .archived }.count)")
                        .font(SHTypography.micro.monospacedDigit())
                        .foregroundStyle(SHColor.inkFaint)
                }
                ObsidianProgressBar(
                    value: averageBarPercent,
                    tint: SHColor.inkSecondary,
                    height: 3
                )
                .frame(width: 56, height: 4)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .background(isSelected ? SHColor.surfaceBubble : SHColor.surfaceSubtle)
            .overlay(
                RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous)
                    .stroke(isSelected ? SHColor.lineSubtle : Color.clear, lineWidth: 0.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func harnessPill(_ group: HarnessGroup) -> some View {
        let isSelected = store.selectedHarnessFilter == group
        let summary = store.usage?[group]
        let barPct = summary?.barPercent ?? UsageMetrics.pickHeroWindow(summary?.windows ?? []).hero?.usedPercent
        let brand = SHColor.harness(group)
        let working = store.isAnyWorking(for: group)

        return HStack(spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.16)) {
                    store.selectedHarnessFilter = isSelected ? nil : group
                }
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        HarnessLogoView(group: group, size: 14)
                        Text(group.title)
                            .font(SHTypography.caption.weight(.semibold))
                            .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkSecondary)
                        if working {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(brand)
                        } else {
                            Text("\(store.activeCount(for: group))")
                                .font(SHTypography.micro.monospacedDigit())
                                .foregroundStyle(SHColor.inkFaint)
                        }
                    }
                    ObsidianProgressBar(
                        value: barPct,
                        tint: brand,
                        estimated: summary?.barIsEstimated ?? false,
                        height: 3
                    )
                    .frame(width: 82, height: 4)
                }
            }
            .buttonStyle(.plain)

            // Quick '+' new chat button for this harness
            Button {
                store.openDraftChat(for: group)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(brand)
                    .frame(width: 26, height: 26)
                    .background(brand.opacity(0.12))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New \(group.title) session")
        }
        .padding(.leading, 13)
        .padding(.trailing, 8)
        .padding(.vertical, 10)
        .background(isSelected ? brand.opacity(0.14) : SHColor.surfaceSubtle)
        .overlay(
            RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous)
                .stroke(isSelected ? brand.opacity(0.35) : Color.clear, lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
    }

    private var averageBarPercent: Double? {
        guard let usage = store.usage else { return nil }
        let vals = usage.allSummaries.compactMap { $0.barPercent ?? UsageMetrics.pickHeroWindow($0.windows).hero?.usedPercent }
        guard !vals.isEmpty else { return nil }
        return vals.reduce(0, +) / Double(vals.count)
    }
}

// MARK: - Session Row

private struct SessionListRow: View {
    let session: UnifiedSession
    let isBusy: Bool
    let hideProjectSubtitle: Bool

    var body: some View {
        let vis = HarnessVisual.forKind(session.harness)
        let project = hideProjectSubtitle ? nil : SessionRowFormatting.cleanProjectName(for: session)
        let branch = session.gitBranch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasBranch = !(branch?.isEmpty ?? true)
        let showsSecondLine = project != nil || hasBranch || session.status == .waitingInput

        HStack(alignment: .center, spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous)
                    .fill(vis.color.opacity(0.10))
                    .frame(width: 32, height: 32)
                    .overlay(
                        HarnessLogoView(harness: session.harness, size: 17)
                    )

                if session.status == .waitingInput {
                    SHQuestionBadge()
                        .offset(x: 4, y: 4)
                } else if session.isLive && !isBusy {
                    SHMiniRobotBadge()
                        .offset(x: 4, y: 4)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .center, spacing: 6) {
                    if session.pinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(SHColor.inkFaint)
                    }
                    Text(session.displayTitle)
                        .font(SHTypography.label.weight(.medium))
                        .foregroundStyle(SHColor.inkPrimary)
                        .lineLimit(showsSecondLine ? 1 : 2)
                    Spacer(minLength: 6)
                    if isBusy {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(vis.color)
                            .frame(width: 14, height: 14)
                    } else {
                        Text(UsageMetrics.formatUpdatedAgo(session.updatedAt))
                            .font(SHTypography.micro.monospacedDigit())
                            .foregroundStyle(SHColor.inkFaint)
                    }
                }

                if showsSecondLine {
                    HStack(spacing: 8) {
                        if let project {
                            Text(project)
                                .font(SHTypography.micro)
                                .foregroundStyle(SHColor.inkFaint)
                                .lineLimit(1)
                        }

                        if let branch, !branch.isEmpty {
                            Label(branch, systemImage: "arrow.triangle.branch")
                                .font(SHTypography.micro)
                                .foregroundStyle(SHColor.inkFaint)
                                .lineLimit(1)
                        }

                        if session.status == .waitingInput {
                            Text("Input needed")
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(SHColor.statusWarning)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .background(SHColor.statusWarning.opacity(0.14))
                                .clipShape(Capsule())
                        }
                    }
                }
            }
        }
        .contentShape(Rectangle())
    }
}
