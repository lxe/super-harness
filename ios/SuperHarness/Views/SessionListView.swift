import SwiftUI
import UniformTypeIdentifiers

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
        "pi",
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

    /// Second line of a session row: the host's one-line "what this thread is doing / last did"
    /// summary when available, otherwise the start of the person's latest message, otherwise preview.
    public static func subtitle(for session: UnifiedSession) -> String? {
        if let summary = session.summary {
            let oneLine = normalizeWhitespace(summary)
            if !oneLine.isEmpty { return oneLine }
        }
        if let last = session.lastUserText {
            let oneLine = normalizeWhitespace(last)
            if !oneLine.isEmpty { return oneLine }
        }
        return cleanPreview(for: session).map(normalizeWhitespace)
    }

    /// True when every word of the query appears in the session's title, summary, last message,
    /// preview, project, working directory, branch or tags.
    public static func matches(_ session: UnifiedSession, query: String) -> Bool {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return true }
        let hay = [
            session.displayTitle, session.summary ?? "", session.lastUserText ?? "", session.preview, session.projectName,
            session.cwd, session.gitBranch ?? "", session.tags.joined(separator: " "),
        ].joined(separator: " ").lowercased()
        return words.allSatisfy { hay.contains($0) }
    }

    /// Compact 1-token label for a collapsed pinned-session pill (5 per row).
    /// Strips a leading "Super Harness " prefix when followed by more text so multiple
    /// Super Harness threads stay distinguishable inside narrow pills.
    /// Sessions split into rows of `perRow` for the pinned pill grid. Every session is in
    /// exactly one row, in order.
    public static func pillRows(of sessions: [UnifiedSession], perRow: Int) -> [[UnifiedSession]] {
        guard perRow > 0 else { return sessions.isEmpty ? [] : [sessions] }
        return stride(from: 0, to: sessions.count, by: perRow).map {
            Array(sessions[$0..<min($0 + perRow, sessions.count)])
        }
    }

    public static func compactPillLabel(for session: UnifiedSession) -> String {
        let raw = normalizeWhitespace(session.displayTitle)
        guard !raw.isEmpty else { return session.harness.rawValue.capitalized }
        let lower = raw.lowercased()
        let stripped: String
        if lower.hasPrefix("super harness ") && raw.count > "super harness ".count {
            stripped = String(raw.dropFirst("super harness ".count)).trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            stripped = raw
        }
        return stripped.isEmpty ? raw : stripped
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
            // Left: the Super Harness mark in its own glass bubble. It opens Settings and is the
            // app's status light: it turns into sync arrows while fetching from the host and a
            // warning mark when the host cannot be reached.
            ToolbarItem(placement: .topBarLeading) {
                ConnectionStatusPill(health: store.connectionHealth, isSyncing: store.isSyncing) {
                    store.isHostSettingsSheetPresented = true
                }
            }

            // Right: every other control in one pill.
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let master = store.masterSession {
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
                    .accessibilityLabel("Master Orchestrator")
                    .accessibilityIdentifier("header.master")
                }

                Button {
                    if isSearchActive {
                        closeSearch()
                    } else {
                        withAnimation(.easeOut(duration: 0.18)) { isSearchActive = true }
                        isSearchFieldFocused = true
                    }
                } label: {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(isSearchActive ? SHColor.inkPrimary : SHColor.inkSecondary)
                }
                .accessibilityLabel("Search sessions")
                .accessibilityIdentifier("header.search")

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
                .tint(SHColor.inkPrimary)
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
        .modifier(SHGlassSurfaceModifier(shape: Capsule()))
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



            // Globally Pinned-to-Top section (headless — no header)
            let topPinned = store.pinnedToTopSessions
            if !topPinned.isEmpty {
                Section {
                    ForEach(topPinned) { session in
                        sessionRowButton(session, isPinned: true)
                    }
                    // Hold a pinned chat and drag it to reorder the pins.
                    .onMove { offsets, destination in
                        store.movePinned(fromOffsets: offsets, toOffset: destination)
                    }
                    // Drop any other chat here to pin it at that position.
                    .onInsert(of: [SessionDragItem.type]) { index, providers in
                        SessionDragItem.loadSessionId(from: providers) { sessionId in
                            Task { await store.pinSession(sessionId, atVisibleIndex: index) }
                        }
                    }
                }
            }

            // Grouped session sections
            let sections = store.groupedSections
            if sections.isEmpty && topPinned.isEmpty && !store.isBootstrapping && store.hasCompletedBootstrap {
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
                                    // Section titles never carry a harness logo; folders keep
                                    // their colour dot and project groups their folder glyph.
                                    if let hex = section.accentHex {
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
                                    // The chevron sits right after the title.
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 9.5, weight: .semibold))
                                        .foregroundStyle(SHColor.inkFaint)
                                        .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                                    if store.isAnyWorking(in: section) {
                                        SHActivityPulse(tint: section.harnessGroup.map(SHColor.harness) ?? SHColor.inkSecondary, size: 11)
                                    }
                                    Spacer(minLength: 0)
                                }
                                // The padding is inside the button so the whole band is tappable.
                                .padding(.top, 18)
                                .padding(.bottom, 5)
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
                            .listRowInsets(EdgeInsets(top: 3, leading: 20, bottom: 0, trailing: 20))
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
        // Rows size to their content. The default 44 pt minimum made every section header a
        // tall, mostly empty row, which is where the loose spacing between sections came from.
        .environment(\.defaultMinListRowHeight, 0)
        .safeAreaInset(edge: .top, spacing: 0) {
            if isSearchActive {
                inlineSearchField
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HarnessSwitcherStrip(store: store)
                .padding(.horizontal, 12)
                .padding(.top, 6)
                .padding(.bottom, 6)
        }
        .contentMargins(.top, 4, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .background(SHColor.surfaceRail)
        .refreshable {
            await store.refresh()
        }
    }

    @ViewBuilder
    private func sessionRowButton(_ session: UnifiedSession, isPinned: Bool = false) -> some View {
        let isSelected = store.selectedSessionId == session.id
        let isBusy = store.isSessionBusy(session.id)

        Button {
            onSelectSession(session.id)
        } label: {
            SessionListRow(
                session: session,
                isBusy: isBusy,
                isPinned: isPinned,
                // With one harness selected every row is that harness, so the logo adds nothing.
                showsHarnessLogo: store.selectedHarnessFilter == nil
            )
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .contentShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
        }
        .buttonStyle(SHRowTapButtonStyle(isSelected: isSelected))
        .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                Task { await store.togglePin(session) }
            } label: {
                Label(session.pinned ? "Unpin" : "Pin", systemImage: session.pinned ? "pin.slash" : "pin")
            }
            .tint(SHColor.surfaceRaised)

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
                Task { await store.setUnread(sessionId: session.id, unread: !session.isUnread) }
            } label: {
                if session.isUnread {
                    Label("Mark as Read", systemImage: "envelope.open")
                } else {
                    Label("Mark as Unread", systemImage: "envelope.badge")
                }
            }
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
                    SHShimmerText(text: session.displayTitle, font: SHTypography.heading, isActive: isBusy)
                    Spacer()
                    if isBusy {
                        EmptyView()
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

// MARK: - Session Row Tap Feedback

private struct SHRowTapButtonStyle: ButtonStyle {
    let isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous)
                    .fill(
                        configuration.isPressed
                            ? Color.white.opacity(0.08)
                            : (isSelected ? SHColor.surfaceRaised : Color.clear)
                    )
            )
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: - Harness Switcher (fixed bottom Liquid Glass dock, matches desktop sidebar)

private struct HarnessSwitcherStrip: View {
    @Bindable var store: AppStore

    /// A gauge being dragged: which harness, and where the finger is inside the strip.
    private struct DragState: Equatable {
        var harness: HarnessGroup
        var x: CGFloat
    }

    @State private var drag: DragState?
    @State private var stripWidth: CGFloat = 0
    /// Lifting the finger at the end of a drag also ends a touch on the gauge's button; taps
    /// are ignored until this time so a reorder does not change the selected harness.
    @State private var ignoreTapsUntil: Date = .distantPast
    /// Set when a gauge was held and released without being dragged: shows its shortcuts.
    @State private var shortcutsHarness: HarnessGroup?

    private static let cellSpacing: CGFloat = 4
    private static let stripPadding: CGFloat = 6
    private static let scrollableCellWidth: CGFloat = 66
    /// Six gauges still fit side by side on a phone; beyond that the dock scrolls. There is no
    /// "All" gauge: with no harness selected nothing is highlighted and every harness is shown,
    /// and tapping the selected gauge deselects it.
    private static let maxFittedSlots = 6
    private static let stripSpace = "harnessStrip"

    private var totalSlots: Int {
        max(1, store.harnessOrder.count)
    }

    private var needsHorizontalScroll: Bool {
        totalSlots > Self.maxFittedSlots
    }

    private var cellWidth: CGFloat {
        if needsHorizontalScroll {
            return Self.scrollableCellWidth
        }
        let gaps = CGFloat(max(0, totalSlots - 1)) * Self.cellSpacing
        return max(1, (stripWidth - Self.stripPadding * 2 - gaps) / CGFloat(totalSlots))
    }

    /// Centre of the cell at `slot` (the harness's index in the order), in strip coordinates.
    private func cellCenter(slot: Int) -> CGFloat {
        Self.stripPadding + cellWidth / 2 + CGFloat(slot) * (cellWidth + Self.cellSpacing)
    }

    private var chipsRow: some View {
        HStack(spacing: Self.cellSpacing) {
            ForEach(Array(store.harnessOrder.enumerated()), id: \.element) { index, group in
                let isDragged = drag?.harness == group
                harnessChip(group)
                    .scaleEffect(isDragged ? 1.14 : 1)
                    .shadow(color: .black.opacity(isDragged ? 0.45 : 0), radius: 8, y: 3)
                    .offset(x: isDragged ? (drag?.x ?? 0) - cellCenter(slot: index) : 0)
                    .zIndex(isDragged ? 1 : 0)
                    .gesture(
                        HarnessHoldDragGesture(
                            spaceName: Self.stripSpace,
                            onChange: { x in drag = DragState(harness: group, x: x) },
                            onEnd: { moved in
                                drag = nil
                                // Held and let go in place: offer the gauge's shortcuts.
                                if moved < 10 { shortcutsHarness = group }
                            }
                        )
                    )
            }
        }
        .animation(.easeInOut(duration: 0.18), value: store.harnessOrder)
        .animation(.easeOut(duration: 0.15), value: drag?.harness)
    }

    var body: some View {
        // Full-width Liquid Glass bottom dock. Distributes evenly up to 5 slots and scrolls
        // horizontally automatically as more harnesses are added.
        // The drag coordinate space is the padded row itself, not the dock: once the dock
        // scrolls sideways, positions measured against the dock would be off by the scroll
        // offset and a dragged gauge would land in the wrong slot.
        Group {
            if needsHorizontalScroll {
                ScrollView(.horizontal, showsIndicators: false) {
                    chipsRow
                        .padding(.horizontal, Self.stripPadding)
                        .padding(.vertical, 6)
                        .coordinateSpace(name: Self.stripSpace)
                }
            } else {
                chipsRow
                    .padding(.horizontal, Self.stripPadding)
                    .padding(.vertical, 6)
                    .coordinateSpace(name: Self.stripSpace)
            }
        }
        .frame(maxWidth: .infinity)
        // The same plain Liquid Glass capsule as the top bar's pills: no added sheen, rim or
        // drop shadow.
        .modifier(SHGlassSurfaceModifier(shape: Capsule()))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { stripWidth = $0 }
        .onChange(of: drag) { _, state in
            ignoreTapsUntil = Date().addingTimeInterval(0.5)
            guard let state else { return }
            // The harness slot under the finger takes the dragged gauge.
            let raw = Int(((state.x - Self.stripPadding) / (cellWidth + Self.cellSpacing)).rounded(.down))
            let targetIndex = min(max(raw, 0), store.harnessOrder.count - 1)
            let target = store.harnessOrder[targetIndex]
            if target != state.harness {
                store.moveHarness(state.harness, onto: target)
                triggerSelectionHaptic()
            }
        }
        .onChange(of: drag?.harness) { old, new in
            if old == nil, new != nil { triggerSelectionHaptic() }
        }
        .confirmationDialog(
            shortcutsHarness?.title ?? "",
            isPresented: Binding(get: { shortcutsHarness != nil }, set: { if !$0 { shortcutsHarness = nil } }),
            titleVisibility: .visible,
            presenting: shortcutsHarness
        ) { group in
            Button("New \(group.title) Session") { store.openDraftChat(for: group) }
            Button("\(group.title) Usage") { store.openUsageSheet(for: group) }
        } message: { _ in
            Text("Hold and drag a gauge to reorder the harnesses.")
        }
    }

    private func triggerSelectionHaptic() {
        #if canImport(UIKit)
        UISelectionFeedbackGenerator().selectionChanged()
        #endif
    }

    private func harnessChip(_ group: HarnessGroup) -> some View {
        let isSelected = store.selectedHarnessFilter == group
        let summary = store.usage?[group]
        let barPct = summary?.barPercent ?? UsageMetrics.pickHeroWindow(summary?.windows ?? []).hero?.usedPercent
        let working = store.isAnyWorking(for: group)

        // A plain tappable view, not a Button: a Button keeps the whole touch to itself, so the
        // hold-to-drag recognizer attached around it would never see the press.
        let tint = SHColor.harness(group)
        return Group {
            chipCell(isSelected: isSelected) {
                SHRadialGauge(
                    value: barPct,
                    tint: tint,
                    estimated: summary?.barIsEstimated ?? false,
                    isWorking: working,
                    isActive: isSelected,
                    size: 38
                ) {
                    HarnessLogoView(group: group, size: 17)
                        .opacity(isSelected ? 1 : 0.82)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard Date() >= ignoreTapsUntil else { return }
            withAnimation(.easeInOut(duration: 0.16)) {
                store.selectedHarnessFilter = isSelected ? nil : group
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(group.title)
        .accessibilityValue(gaugeAccessibilityValue(percent: barPct, working: working))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func chipCell<Content: View>(isSelected: Bool, @ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(
                minWidth: needsHorizontalScroll ? Self.scrollableCellWidth : nil,
                maxWidth: needsHorizontalScroll ? Self.scrollableCellWidth : .infinity
            )
            .frame(height: 52)
            // Selected: a flat neutral fill, like a pressed control in the top bar. No harness
            // tint (a selected Muse gauge read as a purple pill) and no gradient or rim.
            .background(isSelected ? Color.white.opacity(0.14) : Color.clear)
            .clipShape(Capsule())
            .contentShape(Capsule())
    }

    private func gaugeAccessibilityValue(percent: Double?, working: Bool) -> String {
        var parts: [String] = []
        if let percent { parts.append("\(Int(percent.rounded())) percent of quota used") }
        if working { parts.append("working") }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Session Row

private struct SessionListRow: View {
    let session: UnifiedSession
    let isBusy: Bool
    var isPinned: Bool = false
    var showsHarnessLogo: Bool = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let vis = HarnessVisual.forKind(session.harness)
        let hostBadge = SessionRowFormatting.hostBadgeLabel(session.hostAddress)
        let subtitle = SessionRowFormatting.subtitle(for: session)

        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .center, spacing: 7) {
                if showsHarnessLogo {
                    HarnessLogoView(harness: session.harness, size: 15)
                        .frame(width: 16, height: 16)
                }

                if isPinned {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(SHColor.inkSecondary)
                }

                SHShimmerText(
                    text: session.displayTitle,
                    font: SHTypography.label.weight(.medium),
                    isActive: isBusy
                )

                Spacer(minLength: 8)

                // A working thread is shown by its shimmering title, so the right slot keeps the time.
                // With Reduce Motion on, the shimmer is still, so a small dot marks the thread instead.
                if isBusy && reduceMotion {
                    Circle()
                        .fill(vis.color)
                        .frame(width: 7, height: 7)
                        .accessibilityLabel("Working")
                } else if session.status == .waitingInput && !isBusy {
                    Image(systemName: "questionmark.circle.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(SHColor.statusWarning)
                        .accessibilityLabel("Question pending")
                } else {
                    HStack(spacing: 6) {
                        Text(UsageMetrics.formatUpdatedAgo(session.updatedAt))
                            .font(SHTypography.micro.monospacedDigit())
                            .foregroundStyle(session.isUnread ? SHColor.inkSecondary : SHColor.inkFaint)
                            .fixedSize()
                        if session.isUnread {
                            Circle()
                                .fill(SHColor.inkPrimary)
                                .frame(width: 7, height: 7)
                                .accessibilityLabel("Unread")
                                .accessibilityIdentifier("row.unread")
                        }
                    }
                }
            }

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
                .frame(maxWidth: .infinity, alignment: .leading)
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

// MARK: - Liquid Glass Surface

private struct SHGlassSurfaceModifier<S: Shape>: ViewModifier {
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

// MARK: - Working Title Shimmer

/// A one-line title that shows activity by itself: while `isActive`, a soft band of light
/// sweeps across the letters. It matches the desktop `.sh-working-shimmer` (muted grey to
/// near-white and back, one sweep every 2.6 seconds, eased in and out).
struct SHShimmerText: View {
    let text: String
    let font: Font
    let isActive: Bool
    var period: Double = 2.6

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let dim = Color(red: 161 / 255, green: 166 / 255, blue: 179 / 255).opacity(0.72)
    private static let bright = Color(red: 244 / 255, green: 245 / 255, blue: 247 / 255).opacity(0.96)

    /// Centre of the bright band at `time`, in units of the text width. It travels from just
    /// left of the text to just right of it, eased in and out, then starts again.
    nonisolated static func bandCenter(at time: Double, period: Double) -> Double {
        let linear = (time / period).truncatingRemainder(dividingBy: 1)
        let progress = linear < 0 ? linear + 1 : linear
        let eased = 0.5 - 0.5 * cos(progress * .pi)
        return -0.6 + eased * 2.2
    }

    var body: some View {
        if isActive && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let center = Self.bandCenter(at: context.date.timeIntervalSinceReferenceDate, period: period)
                label.foregroundStyle(
                    LinearGradient(
                        colors: [Self.dim, Self.bright, Self.dim],
                        startPoint: UnitPoint(x: center - 0.6, y: 0.5),
                        endPoint: UnitPoint(x: center + 0.6, y: 0.5)
                    )
                )
            }
            .accessibilityLabel("\(text), working")
        } else {
            label.foregroundStyle(SHColor.inkPrimary)
        }
    }

    private var label: some View {
        Text(text)
            .font(font)
            .lineLimit(1)
            .truncationMode(.tail)
    }
}

/// What a dragged chat row carries: its session id as text, with a prefix so text dragged in
/// from elsewhere is not mistaken for a chat.
enum SessionDragItem {
    static let type = UTType.plainText
    static let prefix = "superharness-session:"

    static func provider(for sessionId: String) -> NSItemProvider {
        NSItemProvider(object: (prefix + sessionId) as NSString)
    }

    nonisolated static func sessionId(from text: String) -> String? {
        guard text.hasPrefix(prefix) else { return nil }
        let id = String(text.dropFirst(prefix.count))
        return id.isEmpty ? nil : id
    }

    static func loadSessionId(from providers: [NSItemProvider], completion: @escaping @MainActor (String) -> Void) {
        guard let provider = providers.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else { return }
        _ = provider.loadObject(ofClass: NSString.self) { object, _ in
            guard let text = object as? String, let id = sessionId(from: text) else { return }
            Task { @MainActor in completion(id) }
        }
    }
}

/// Makes a row draggable when it has a session id to carry.
private struct SessionDragSource: ViewModifier {
    let sessionId: String?

    func body(content: Content) -> some View {
        if let sessionId {
            content.onDrag { SessionDragItem.provider(for: sessionId) }
        } else {
            content
        }
    }
}

/// Hold a gauge for a moment, then drag it. This is a UIKit long press rather than a SwiftUI
/// long-press-then-drag sequence because the SwiftUI sequence, attached to a view inside a
/// horizontal ScrollView, stops the ScrollView from scrolling at all. A UIKit long press lets
/// a quick swipe scroll the dock and only claims the touch once the hold has lasted.
private struct HarnessHoldDragGesture: UIGestureRecognizerRepresentable {
    let spaceName: String
    /// Finger position along the dock row while the gauge is held.
    let onChange: (CGFloat) -> Void
    /// Called when the finger lifts, with the farthest horizontal distance it travelled.
    let onEnd: (CGFloat) -> Void

    final class Coordinator {
        var startX: CGFloat = 0
        var farthest: CGFloat = 0
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let recognizer = UILongPressGestureRecognizer()
        recognizer.minimumPressDuration = 0.28
        recognizer.allowableMovement = 12
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        let x = context.converter.location(in: .named(spaceName)).x
        switch recognizer.state {
        case .began:
            context.coordinator.startX = x
            context.coordinator.farthest = 0
            onChange(x)
        case .changed:
            context.coordinator.farthest = max(context.coordinator.farthest, abs(x - context.coordinator.startX))
            onChange(x)
        case .ended:
            onEnd(context.coordinator.farthest)
        case .cancelled, .failed:
            onEnd(.infinity)
        default:
            break
        }
    }
}

/// The Super Harness mark shown in the middle of the session list's top bar.
struct SHToolbarLogo: View {
    var body: some View {
        // The porcelain mark, a single-colour template tinted porcelain white.
        Image("SuperHarnessLogo")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(SHColor.porcelain)
            .frame(width: 26, height: 26)
            .accessibilityLabel("Super Harness")
            .accessibilityIdentifier("header.logo")
    }
}
