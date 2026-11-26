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

    /// Short label for the machine a session runs on: the last IPv4 octet (".3"),
    /// or the first label of a host name. Mirrors `hostBadgeLabel` on the desktop sidebar.
    public static func hostBadgeLabel(_ address: String?) -> String? {
        guard let address else { return nil }
        var host = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if let at = host.lastIndex(of: "@") {
            host = String(host[host.index(after: at)...])
        }
        guard !host.isEmpty else { return nil }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        let isIPv4 = parts.count == 4 && parts.allSatisfy { part in
            (1...3).contains(part.count) && part.allSatisfy { $0.isASCII && $0.isNumber }
        }
        if isIPv4, let last = parts.last {
            return ".\(last)"
        }
        let first = String((parts.first ?? "").prefix(8))
        return first.isEmpty ? nil : first
    }

    public static func hostAccessibilityLabel(address: String, label: String?) -> String {
        let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return "Running on \(trimmed.isEmpty ? address : trimmed) (\(address))"
    }

    /// Second line of a session row: the start of the person's latest message when the host
    /// reports it, otherwise the session preview.
    public static func subtitle(for session: UnifiedSession) -> String? {
        if let last = session.lastUserText {
            let oneLine = normalizeWhitespace(last)
            if !oneLine.isEmpty { return oneLine }
        }
        return cleanPreview(for: session).map(normalizeWhitespace)
    }

    /// True when every word of the query appears in the session's title, last message,
    /// preview, project, working directory, branch or tags.
    public static func matches(_ session: UnifiedSession, query: String) -> Bool {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return true }
        let hay = [
            session.displayTitle, session.lastUserText ?? "", session.preview, session.projectName,
            session.cwd, session.gitBranch ?? "", session.tags.joined(separator: " "),
        ].joined(separator: " ").lowercased()
        return words.allSatisfy { hay.contains($0) }
    }

    private static func normalizeWhitespace(_ value: String) -> String {
        value
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
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
    @State private var renamingSession: UnifiedSession? = nil
    @State private var renameDraft: String = ""
    @State private var isNewFolderAlertPresented: Bool = false
    @State private var newFolderDraft: String = ""
    @State private var newFolderAssignSessionId: String? = nil
    @State private var renamingFolder: SessionFolder? = nil
    @State private var renameFolderDraft: String = ""
    @State private var isManageFoldersPresented: Bool = false
    @State private var isSearchActive: Bool = false
    @State private var isErrorDetailExpanded: Bool = false
    @FocusState private var isSearchFieldFocused: Bool

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
        .alert(
            "Rename Thread",
            isPresented: Binding(
                get: { renamingSession != nil },
                set: { if !$0 { renamingSession = nil } }
            )
        ) {
            TextField("Thread title", text: $renameDraft)
            Button("Save") {
                if let target = renamingSession {
                    let nextTitle = renameDraft
                    renamingSession = nil
                    Task { await store.renameSession(target, title: nextTitle) }
                }
            }
            Button("Cancel", role: .cancel) {
                renamingSession = nil
            }
        }
        .alert("New Folder", isPresented: $isNewFolderAlertPresented) {
            TextField("Folder name", text: $newFolderDraft)
            Button("Create") {
                let name = newFolderDraft
                let assignId = newFolderAssignSessionId
                newFolderDraft = ""
                newFolderAssignSessionId = nil
                let color = AppStore.defaultFolderColors[store.folders.count % AppStore.defaultFolderColors.count]
                Task {
                    if let sid = assignId {
                        await store.createFolderAndAssign(sessionId: sid, name: name, color: color)
                    } else {
                        _ = await store.createFolder(name: name, color: color)
                        if store.groupBy != .folders {
                            await store.setGroupBy(.folders)
                        }
                    }
                }
            }
            Button("Cancel", role: .cancel) {
                newFolderDraft = ""
                newFolderAssignSessionId = nil
            }
        }
        .alert(
            "Rename Folder",
            isPresented: Binding(
                get: { renamingFolder != nil },
                set: { if !$0 { renamingFolder = nil } }
            )
        ) {
            TextField("Folder name", text: $renameFolderDraft)
            Button("Save") {
                if let target = renamingFolder {
                    let nextName = renameFolderDraft
                    renamingFolder = nil
                    Task { await store.renameFolder(id: target.id, name: nextName) }
                }
            }
            Button("Cancel", role: .cancel) {
                renamingFolder = nil
            }
        }
        .sheet(isPresented: $isManageFoldersPresented) {
            ManageFoldersSheet(store: store)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                ConnectionStatusPill(health: store.connectionHealth) {
                    store.isHostSettingsSheetPresented = true
                }
            }

            if #available(iOS 26.0, *) {
                ToolbarSpacer(.fixed, placement: .topBarLeading)
            }

            if let master = store.masterSession {
                ToolbarItem(placement: .topBarLeading) {
                    let isMasterBusy = store.isSessionBusy(master.id)
                    Button {
                        onSelectSession(master.id)
                    } label: {
                        ZStack {
                            if isMasterBusy {
                                SHActivityPulse(tint: SHColor.brandMaster, size: 15)
                            } else {
                                Image(systemName: "sparkles")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(SHColor.brandMaster)
                            }
                        }
                        .frame(width: 28, height: 28)
                        .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Master Orchestrator")
                    .accessibilityIdentifier("header.master")
                }
            }

            // Search is its own glass circle, set apart from the usage/filter/new-chat group.
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    if isSearchActive {
                        closeSearch()
                    } else {
                        withAnimation(.easeOut(duration: 0.18)) { isSearchActive = true }
                        isSearchFieldFocused = true
                    }
                } label: {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(isSearchActive ? SHColor.brandMaster : SHColor.inkSecondary)
                }
                .accessibilityLabel("Search sessions")
                .accessibilityIdentifier("header.search")
            }

            if #available(iOS 26.0, *) {
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
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
                                Task { await store.setGroupBy(mode) }
                            } label: {
                                Label(mode.label, systemImage: store.groupBy == mode ? "checkmark" : mode.symbolName)
                            }
                        }
                    }
                    Section("Folders") {
                        Button {
                            newFolderAssignSessionId = nil
                            newFolderDraft = ""
                            isNewFolderAlertPresented = true
                        } label: {
                            Label("New Folder…", systemImage: "folder.badge.plus")
                        }
                        Button {
                            isManageFoldersPresented = true
                        } label: {
                            Label("Manage Folders", systemImage: "folder")
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

    private func closeSearch() {
        isSearchFieldFocused = false
        store.searchQuery = ""
        withAnimation(.easeOut(duration: 0.18)) { isSearchActive = false }
    }

    /// The search box that drops into the list under the top bar. Typing filters the list
    /// in place; the X clears the filter and removes the box.
    private var inlineSearchField: some View {
        HStack(spacing: SHSpacing.sm) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(SHColor.inkMuted)
            TextField("Search sessions, messages, projects", text: $store.searchQuery)
                .font(SHTypography.body)
                .foregroundStyle(SHColor.inkPrimary)
                .tint(SHColor.brandMaster)
                .focused($isSearchFieldFocused)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("search.field")
            Button {
                closeSearch()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 17))
                    .foregroundStyle(SHColor.inkMuted)
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close search")
            .accessibilityIdentifier("search.close")
        }
        .padding(.leading, SHSpacing.lg)
        .padding(.trailing, SHSpacing.sm)
        .frame(height: 44)
        .modifier(SearchGlassModifier(shape: Capsule()))
        .padding(.horizontal, SHSpacing.lg)
        .padding(.top, SHSpacing.xs)
        .padding(.bottom, SHSpacing.sm)
    }

    private var sessionListContent: some View {
        List {
            // Subtle error banner if live host had an issue
            if let error = store.lastError {
                Section {
                    let presented = SHErrorPresentation.present(error, technicalDetail: store.lastErrorDetail)
                    VStack(alignment: .leading, spacing: SHSpacing.sm) {
                        HStack(spacing: SHSpacing.sm) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(SHColor.statusWarning)
                                .font(.system(size: 13))
                            Text(presented.message)
                                .font(SHTypography.micro)
                                .foregroundStyle(SHColor.inkSecondary)
                                .lineLimit(2)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(SHColor.inkFaint)
                                .rotationEffect(.degrees(isErrorDetailExpanded ? 90 : 0))
                            Spacer()
                            Button {
                                store.lastError = nil
                                isErrorDetailExpanded = false
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(SHColor.inkMuted)
                                    .frame(width: 24, height: 24)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Dismiss")
                        }
                        if isErrorDetailExpanded {
                            Text(presented.detail)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(SHColor.inkMuted)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.15)) { isErrorDetailExpanded.toggle() }
                    }
                    .accessibilityIdentifier("list.errorBanner")
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(SHColor.surfacePopover, in: RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
            }



            // Harness switcher: icon-only chips with radial quota gauges
            Section {
                HarnessSwitcherStrip(store: store)
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }

            // Globally Pinned-to-Top section
            let topPinned = store.pinnedToTopSessions
            if !topPinned.isEmpty {
                Section {
                    HStack(spacing: 6) {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(SHColor.brandMaster)
                        Text("PINNED TO TOP")
                            .font(SHTypography.micro.weight(.semibold))
                            .foregroundStyle(SHColor.inkMuted)
                        Spacer()
                    }
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 4, trailing: 20))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    ForEach(topPinned) { session in
                        sessionRowButton(session)
                    }
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
                                sessionRowButton(session)
                            }
                        }
                    } else {
                        let isCollapsed = collapsedSectionIds.contains(section.id)
                        Section {
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
                                    let preserveCase = section.isProjectOrSectionGroup || section.folderId != nil
                                    Text(preserveCase ? section.title : section.title.uppercased())
                                        .font(SHTypography.micro.weight(.semibold))
                                        .foregroundStyle(SHColor.inkMuted)
                                        .lineLimit(1)
                                    if section.folderId != nil {
                                        Text("\(section.sessions.count)")
                                            .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                                            .foregroundStyle(SHColor.inkFaint)
                                    }
                                    if store.isAnyWorking(in: section) {
                                        SHActivityPulse(tint: section.harnessGroup.map(SHColor.harness) ?? SHColor.inkSecondary, size: 11)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 10, weight: .semibold))
                                        .foregroundStyle(SHColor.inkFaint)
                                        .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("section.header.\(section.id)")
                            .accessibilityValue(isCollapsed ? "collapsed" : "expanded")
                            .contextMenu {
                                if let fid = section.folderId,
                                   let folder = store.folders.first(where: { $0.id == fid }) {
                                    Button {
                                        renameFolderDraft = folder.name
                                        renamingFolder = folder
                                    } label: {
                                        Label("Rename Folder", systemImage: "pencil")
                                    }
                                    Button(role: .destructive) {
                                        Task { await store.deleteFolder(id: folder.id) }
                                    } label: {
                                        Label("Delete Folder", systemImage: "trash")
                                    }
                                }
                            }
                            .listRowInsets(EdgeInsets(top: 14, leading: 20, bottom: 4, trailing: 20))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)

                            if !isCollapsed {
                                if section.sessions.isEmpty && section.folderId != nil {
                                    Text("No threads yet · Long-press any thread to move here")
                                        .font(SHTypography.micro)
                                        .foregroundStyle(SHColor.inkFaint)
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 10)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .background(
                                            RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous)
                                                .strokeBorder(SHColor.lineHairline, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                                        )
                                        .listRowInsets(EdgeInsets(top: 3, leading: 16, bottom: 3, trailing: 16))
                                        .listRowBackground(Color.clear)
                                        .listRowSeparator(.hidden)
                                } else {
                                    ForEach(section.sessions) { session in
                                        sessionRowButton(session)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .safeAreaInset(edge: .top, spacing: 0) {
            if isSearchActive {
                inlineSearchField
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .contentMargins(.top, 4, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .background(SHColor.surfaceRail)
        .refreshable {
            await store.refresh()
        }
    }

    @ViewBuilder
    private func sessionRowButton(_ session: UnifiedSession) -> some View {
        let isSelected = store.selectedSessionId == session.id
        let isBusy = store.isSessionBusy(session.id)

        Button {
            onSelectSession(session.id)
        } label: {
            SessionListRow(
                session: session,
                isBusy: isBusy
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
        .listRowInsets(EdgeInsets(top: 3, leading: 16, bottom: 3, trailing: 16))
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
                renameDraft = session.displayTitle
                renamingSession = session
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Menu {
                ForEach(store.folders.sorted(by: { $0.order < $1.order })) { folder in
                    Button {
                        Task { await store.assignFolder(sessionId: session.id, folderId: folder.id) }
                    } label: {
                        if session.folderId == folder.id {
                            Label(folder.name, systemImage: "checkmark")
                        } else {
                            Label(folder.name, systemImage: "folder")
                        }
                    }
                }
                if !store.folders.isEmpty {
                    Divider()
                }
                Button {
                    newFolderAssignSessionId = session.id
                    newFolderDraft = ""
                    isNewFolderAlertPresented = true
                } label: {
                    Label("New Folder…", systemImage: "folder.badge.plus")
                }
                if session.folderId != nil {
                    Button(role: .destructive) {
                        Task { await store.assignFolder(sessionId: session.id, folderId: nil) }
                    } label: {
                        Label("Remove from Folder", systemImage: "folder.badge.minus")
                    }
                }
            } label: {
                Label("Move to Folder", systemImage: "folder")
            }
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
                        SHActivityPulse(tint: SHColor.brandMaster, size: 14)
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

// MARK: - Harness Switcher (icon-only radial gauges, matches desktop sidebar)

private struct HarnessSwitcherStrip: View {
    @Bindable var store: AppStore

    var body: some View {
        // Five equal cells that always fit the row width; no horizontal scrolling.
        HStack(spacing: 4) {
            allChip
            ForEach(HarnessGroup.allCases) { group in
                harnessChip(group)
            }
        }
        .padding(6)
        .background(SHColor.surfaceSubtle)
        .overlay(
            RoundedRectangle(cornerRadius: SHRadius.xl, style: .continuous)
                .stroke(SHColor.lineHairline, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.xl, style: .continuous))
        .padding(.vertical, 2)
    }

    private var allChip: some View {
        let isSelected = store.selectedHarnessFilter == nil
        let working = HarnessGroup.allCases.contains { store.isAnyWorking(for: $0) }
        return Button {
            withAnimation(.easeInOut(duration: 0.16)) {
                store.selectedHarnessFilter = nil
            }
        } label: {
            chipCell(isSelected: isSelected) {
                SHRadialGauge(
                    value: peakBarPercent,
                    tint: SHColor.inkSecondary,
                    estimated: true,
                    isWorking: working,
                    isActive: isSelected
                ) {
                    Text("All")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkMuted)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("All harnesses")
        .accessibilityValue(gaugeAccessibilityValue(percent: peakBarPercent, working: working))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .contextMenu {
            Button {
                store.openUsageSheet(for: nil)
            } label: {
                Label("Usage", systemImage: "chart.bar")
            }
        }
    }

    private func harnessChip(_ group: HarnessGroup) -> some View {
        let isSelected = store.selectedHarnessFilter == group
        let summary = store.usage?[group]
        let barPct = summary?.barPercent ?? UsageMetrics.pickHeroWindow(summary?.windows ?? []).hero?.usedPercent
        let working = store.isAnyWorking(for: group)

        return Button {
            withAnimation(.easeInOut(duration: 0.16)) {
                store.selectedHarnessFilter = isSelected ? nil : group
            }
        } label: {
            chipCell(isSelected: isSelected) {
                SHRadialGauge(
                    value: barPct,
                    tint: SHColor.harness(group),
                    estimated: summary?.barIsEstimated ?? false,
                    isWorking: working,
                    isActive: isSelected
                ) {
                    HarnessLogoView(group: group, size: 15)
                        .opacity(isSelected ? 1 : 0.8)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(group.title)
        .accessibilityValue(gaugeAccessibilityValue(percent: barPct, working: working))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        // The chip no longer carries its own '+'; long-press keeps the per-harness shortcuts.
        .contextMenu {
            Button {
                store.openDraftChat(for: group)
            } label: {
                Label("New \(group.title) Session", systemImage: "plus")
            }
            Button {
                store.openUsageSheet(for: group)
            } label: {
                Label("\(group.title) Usage", systemImage: "chart.bar")
            }
        }
    }

    private func chipCell<Content: View>(isSelected: Bool, @ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .background(isSelected ? Color.white.opacity(0.11) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
    }

    private func gaugeAccessibilityValue(percent: Double?, working: Bool) -> String {
        var parts: [String] = []
        if let percent { parts.append("\(Int(percent.rounded())) percent of quota used") }
        if working { parts.append("working") }
        return parts.joined(separator: ", ")
    }

    /// Desktop's "All" gauge shows the highest quota use across harnesses.
    private var peakBarPercent: Double? {
        guard let usage = store.usage else { return nil }
        return usage.allSummaries
            .compactMap { $0.barPercent ?? UsageMetrics.pickHeroWindow($0.windows).hero?.usedPercent }
            .max()
    }
}

// MARK: - Session Row

private struct SessionListRow: View {
    let session: UnifiedSession
    let isBusy: Bool

    var body: some View {
        let vis = HarnessVisual.forKind(session.harness)
        let hostBadge = SessionRowFormatting.hostBadgeLabel(session.hostAddress)
        let subtitle = SessionRowFormatting.subtitle(for: session)

        HStack(alignment: .center, spacing: 12) {
            RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous)
                .fill(vis.color.opacity(0.10))
                .frame(width: 32, height: 32)
                .overlay(
                    HarnessLogoView(harness: session.harness, size: 17)
                )

            VStack(alignment: .leading, spacing: 3) {
                Text(session.displayTitle)
                    .font(SHTypography.label.weight(.medium))
                    .foregroundStyle(SHColor.inkPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                if hostBadge != nil || subtitle != nil {
                    HStack(alignment: .center, spacing: 6) {
                        if let hostBadge, let address = session.hostAddress {
                            Text(hostBadge)
                                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                .foregroundStyle(SHColor.inkSecondary)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(
                                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                                        .fill(SHColor.surfaceRaised)
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                                        .stroke(SHColor.lineHairline, lineWidth: 1)
                                )
                                .fixedSize()
                                .accessibilityLabel(SessionRowFormatting.hostAccessibilityLabel(address: address, label: session.hostLabel))
                        }
                        if let subtitle {
                            Text(subtitle)
                                .font(SHTypography.micro)
                                .foregroundStyle(SHColor.inkMuted)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                }
            }

            Spacer(minLength: 6)

            if isBusy {
                SHActivityPulse(tint: vis.color, size: 11)
                    .frame(width: 14, height: 14)
            } else if session.status == .waitingInput {
                Image(systemName: "questionmark.circle.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(SHColor.statusWarning)
                    .accessibilityLabel("Question pending")
            } else {
                Text(UsageMetrics.formatUpdatedAgo(session.updatedAt))
                    .font(SHTypography.micro.monospacedDigit())
                    .foregroundStyle(SHColor.inkFaint)
            }
        }
        .contentShape(Rectangle())
    }
}


// MARK: - Manage Folders Sheet

private struct ManageFoldersSheet: View {
    @Bindable var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var newName: String = ""
    @State private var selectedColor: String = AppStore.defaultFolderColors[0]
    @State private var renamingFolder: SessionFolder? = nil
    @State private var renameDraft: String = ""

    var body: some View {
        NavigationStack {
            List {
                Section("Create Folder") {
                    HStack(spacing: 10) {
                        Circle()
                            .fill(Color(cssHex: selectedColor))
                            .frame(width: 12, height: 12)
                        TextField("Folder name (e.g. Super Harness)", text: $newName)
                            .foregroundStyle(SHColor.inkPrimary)
                            .submitLabel(.done)
                            .onSubmit { createCurrent() }
                        Button("Add") {
                            createCurrent()
                        }
                        .font(SHTypography.caption.weight(.semibold))
                        .foregroundStyle(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? SHColor.inkFaint : SHColor.brandAntigravity)
                        .disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .listRowBackground(SHColor.surfaceSubtle)

                    HStack(spacing: 12) {
                        ForEach(AppStore.defaultFolderColors, id: \.self) { hex in
                            Button {
                                selectedColor = hex
                            } label: {
                                Circle()
                                    .fill(Color(cssHex: hex))
                                    .frame(width: 24, height: 24)
                                    .overlay {
                                        if selectedColor == hex {
                                            Circle()
                                                .strokeBorder(Color.white, lineWidth: 2)
                                                .padding(-3)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 4)
                    .listRowBackground(SHColor.surfaceSubtle)
                }

                Section("Folders") {
                    let ordered = store.folders.sorted { $0.order < $1.order }
                    if ordered.isEmpty {
                        Text("No folders yet. Create one above or ask Master Orchestrator to organize your threads.")
                            .font(SHTypography.caption)
                            .foregroundStyle(SHColor.inkMuted)
                            .listRowBackground(SHColor.surfaceSubtle)
                    } else {
                        ForEach(ordered) { folder in
                            let count = store.sessions.filter { !$0.isMaster && !$0.hidden && $0.status != .archived && $0.folderId == folder.id }.count
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(Color(cssHex: folder.color))
                                    .frame(width: 10, height: 10)
                                Text(folder.name)
                                    .font(SHTypography.body)
                                    .foregroundStyle(SHColor.inkPrimary)
                                Spacer()
                                Text("\(count)")
                                    .font(SHTypography.monoSmall)
                                    .foregroundStyle(SHColor.inkMuted)
                            }
                            .listRowBackground(SHColor.surfaceSubtle)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { await store.deleteFolder(id: folder.id) }
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                                Button {
                                    renameDraft = folder.name
                                    renamingFolder = folder
                                } label: {
                                    Label("Rename", systemImage: "pencil")
                                }
                                .tint(SHColor.brandAntigravity)
                            }
                            .contextMenu {
                                Button {
                                    renameDraft = folder.name
                                    renamingFolder = folder
                                } label: {
                                    Label("Rename", systemImage: "pencil")
                                }
                                Button(role: .destructive) {
                                    Task { await store.deleteFolder(id: folder.id) }
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(SHColor.surfaceCanvas)
            .navigationTitle("Folders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if store.groupBy != .folders {
                        Button("Group by Folders") {
                            Task {
                                await store.setGroupBy(.folders)
                                dismiss()
                            }
                        }
                        .font(SHTypography.caption.weight(.semibold))
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
            .alert(
                "Rename Folder",
                isPresented: Binding(
                    get: { renamingFolder != nil },
                    set: { if !$0 { renamingFolder = nil } }
                )
            ) {
                TextField("Folder name", text: $renameDraft)
                Button("Save") {
                    if let target = renamingFolder {
                        let next = renameDraft
                        renamingFolder = nil
                        Task { await store.renameFolder(id: target.id, name: next) }
                    }
                }
                Button("Cancel", role: .cancel) {
                    renamingFolder = nil
                }
            }
        }
    }

    private func createCurrent() {
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let color = selectedColor
        newName = ""
        Task { _ = await store.createFolder(name: trimmed, color: color) }
    }
}

// MARK: - Search Field Glass

private struct SearchGlassModifier<S: Shape>: ViewModifier {
    let shape: S

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: shape)
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(Color.white.opacity(0.14), lineWidth: 0.75))
        }
    }
}

// MARK: - Friendly Error Presentation

/// Turns a raw error string into a sentence a person can act on, and keeps the raw text
/// (plus any technical detail the store recorded) for the expanded developer view.
public enum SHErrorPresentation {
    public static func present(_ raw: String, technicalDetail: String? = nil) -> (message: String, detail: String) {
        let detail = [raw, technicalDetail ?? ""]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .reduce(into: [String]()) { acc, part in if !acc.contains(part) { acc.append(part) } }
            .joined(separator: "\n")
        return (friendlyMessage(for: raw + " " + (technicalDetail ?? "")), detail)
    }

    public static func friendlyMessage(for raw: String) -> String {
        let text = raw.lowercased()
        func has(_ needles: String...) -> Bool { needles.contains { text.contains($0) } }

        if has("timed out", "timeout", "-1001") {
            return "Your host took too long to answer. It may be asleep or on a slow connection."
        }
        if has("offline", "internet connection", "-1009") {
            return "This phone is offline. Check Wi-Fi, cellular or Tailscale."
        }
        if has("could not connect", "connection refused", "cannot connect", "-1004", "network connection was lost", "-1005") {
            return "Can't reach your host. Check that Super Harness is running there."
        }
        if has("hostname could not be found", "cannot find host", "-1003") {
            return "Can't find your host. Check the address in Host Connection."
        }
        if has("401", "403", "unauthorized", "forbidden", "invalid token") {
            return "Your host refused this phone. Pair again in Host Connection."
        }
        if has("ssl", "certificate", "secure connection", "-1200") {
            return "Couldn't make a secure connection to your host."
        }
        if has("not delivered", "failed to send") {
            return "Your message wasn't delivered. Tap it to retry."
        }
        if has("failed to start") {
            return "The new session didn't start."
        }
        if has("http 5", "status 5", "500", "502", "503", "internal server error") {
            return "Your host hit a problem handling that. Try again."
        }
        if has("decod", "json", "keynotfound", "typemismatch", "data couldn’t be read", "data couldn't be read") {
            return "Your host sent something this app version doesn't understand."
        }
        return "Something went wrong talking to your host."
    }
}
