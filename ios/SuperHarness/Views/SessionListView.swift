import SwiftUI
import UIKit
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

    public struct FormattedSubtitle: Equatable, Sendable {
        public let isDone: Bool
        public let text: String
    }

    /// Splits a leading `Done:` marker from a host summary so rows can render a small checkmark
    /// icon instead of repeating "Done:" on every finished thread.
    public static func formattedSubtitle(for session: UnifiedSession) -> FormattedSubtitle? {
        guard let raw = subtitle(for: session) else { return nil }
        if let summary = session.summary, !normalizeWhitespace(summary).isEmpty,
           raw.lowercased().hasPrefix("done:") {
            let rest = raw.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if !rest.isEmpty {
                return FormattedSubtitle(isDone: true, text: rest)
            }
        }
        return FormattedSubtitle(isDone: false, text: raw)
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
    /// Strips a leading "Superharness " prefix when followed by more text so multiple
    /// Superharness threads stay distinguishable inside narrow pills.
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
    /// A chat being dragged toward the pinned area: which one, and where the finger is.
    @State private var pinDrag: PinDragState?
    /// Where each pinned row is on screen, for working out the drop position.
    @State private var pinnedRowFrames: [String: CGRect] = [:]
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
    /// True when the list sits beside the open chat (iPad split view), where the open chat's
    /// row stays highlighted. The host says so explicitly: inside a split view's sidebar the
    /// size class is compact, the same as on iPhone, so it cannot tell the two apart.
    private let keepsSelectionHighlight: Bool

    public init(store: AppStore, keepsSelectionHighlight: Bool = false, onSelectSession: @escaping (String) -> Void) {
        self.keepsSelectionHighlight = keepsSelectionHighlight
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
            // Left: the Superharness mark in its own glass bubble. It opens Settings and is the
            // app's status light: it turns into sync arrows while fetching from the host and a
            // warning mark when the host cannot be reached.
            ToolbarItem(placement: .topBarLeading) {
                ConnectionStatusPill(
                    health: store.connectionHealth,
                    isSyncing: store.isSyncing,
                    machines: store.machines,
                    activeMachineId: store.activeMachineId,
                    onSwitchMachine: { id in Task { await store.switchMachine(to: id) } },
                    onPairAnother: { store.isAddMachineSheetPresented = true }
                ) {
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

    // MARK: Drag a chat into the pinned chats

    /// The pinned rows on screen, top to bottom.
    private var orderedPinnedFrames: [CGRect] {
        store.pinnedToTopSessions.compactMap { pinnedRowFrames[$0.id] }
    }

    /// Where the dragged chat would land, or nil when the finger is not over the pinned area.
    private var pinDropIndex: Int? {
        guard let pinDrag else { return nil }
        return PinDragState.dropIndex(y: pinDrag.location.y, pinnedFrames: orderedPinnedFrames)
    }

    private func finishPinDrag(commit: Bool) {
        let drag = pinDrag
        let index = pinDropIndex
        withAnimation(.easeOut(duration: 0.15)) { pinDrag = nil }
        guard commit, let drag, let index else { return }
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        #endif
        Task { await store.pinSession(drag.sessionId, atVisibleIndex: index) }
    }

    /// The floating label that follows the finger, and the line that marks the drop position.
    @ViewBuilder
    private var pinDragOverlay: some View {
        if let pinDrag {
            let frames = orderedPinnedFrames
            let index = pinDropIndex
            // Positions are in screen coordinates; `origin` converts them to this overlay's.
            GeometryReader { geometry in
                let origin = geometry.frame(in: .global).origin
                ZStack(alignment: .topLeading) {
                    if let index, let lineY = PinDragState.lineY(index: index, pinnedFrames: frames) {
                        Capsule()
                            .fill(SHColor.inkPrimary)
                            .frame(height: 3)
                            .padding(.horizontal, 20)
                            .offset(y: lineY - origin.y - 1.5)
                            .accessibilityIdentifier("pindrag.line")
                    }
                    HStack(spacing: 7) {
                        Image(systemName: index == nil ? "hand.draw" : "pin.fill")
                            .font(.system(size: 12, weight: .semibold))
                        Text(pinDrag.title)
                            .font(SHTypography.label.weight(.medium))
                            .lineLimit(1)
                    }
                    .foregroundStyle(SHColor.inkPrimary)
                    .padding(.horizontal, 14)
                    .frame(height: 40)
                    .frame(maxWidth: 260)
                    .fixedSize(horizontal: true, vertical: false)
                    .modifier(SHGlassSurfaceModifier(shape: Capsule()))
                    .offset(
                        x: max(12, pinDrag.location.x - origin.x - 60),
                        y: pinDrag.location.y - origin.y - 58
                    )
                    .accessibilityIdentifier("pindrag.ghost")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .allowsHitTesting(false)
        }
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
        .overlay(alignment: .topLeading) { pinDragOverlay }
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
            VStack(spacing: 6) {
                // The machine's name appears for a moment after switching machines.
                if let notice = store.machineSwitchNotice {
                    HStack(spacing: 6) {
                        Image(systemName: "desktopcomputer")
                            .font(.system(size: 11, weight: .semibold))
                        Text(notice)
                            .font(SHTypography.micro.weight(.semibold))
                            .lineLimit(1)
                    }
                    .foregroundStyle(SHColor.inkPrimary)
                    .padding(.horizontal, 12)
                    .frame(height: 28)
                    .modifier(SHGlassSurfaceModifier(shape: Capsule()))
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Now showing \(notice)")
                    .accessibilityIdentifier("machine.notice")
                }
                HarnessSwitcherStrip(store: store)
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 6)
            .animation(.easeOut(duration: 0.2), value: store.machineSwitchNotice)
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
        // Persistent selection highlight only belongs in iPad split view; on iPhone's
        // NavigationStack the list is full-screen, so rows only highlight while pressed.
        let isSelected = keepsSelectionHighlight && store.selectedSessionId == session.id
        let isBusy = store.isSessionBusy(session.id)

        Button {
            onSelectSession(session.id)
        } label: {
            SessionListRow(
                session: session,
                isBusy: isBusy,
                isPinned: isPinned || session.pinned || session.pinnedToTop,
                // With one harness selected every row is that harness, so the logo adds nothing.
                showsHarnessLogo: store.selectedHarnessFilter == nil
            )
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .contentShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
            // Hold an unpinned chat briefly, then drag it up into the pinned chats to pin it.
            // The recognizer sits inside the button's content: attached around the button it
            // never sees the touch.
            .modifier(PinDragSource(
                session: isPinned ? nil : session,
                onChange: { location in
                    pinDrag = PinDragState(sessionId: session.id, title: session.displayTitle, location: location)
                },
                onEnd: { finishPinDrag(commit: $0) }
            ))
        }
        .buttonStyle(SHRowTapButtonStyle(isSelected: isSelected))
        // Pinned rows report where they are, so a drag knows where it would land. This sits
        // before the list-row modifiers: applied after them it cancels the row's clear
        // background and hidden separator.
        .modifier(PinnedRowFrameReporter(sessionId: isPinned ? session.id : nil) { frame in
            pinnedRowFrames[session.id] = frame
        })
        .opacity(pinDrag?.sessionId == session.id ? 0.35 : 1)
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

/// Decides what a sideways swipe on the dock means.
enum MachineSwipe {
    /// 1 for the next machine (swipe left), -1 for the previous (swipe right), 0 for neither.
    /// The swipe must be mostly horizontal and either travel far enough or be flicked.
    nonisolated static func direction(translation: CGSize, predicted: CGSize) -> Int {
        let dx = translation.width
        guard abs(dx) > abs(translation.height) * 1.5 else { return 0 }
        let far = abs(dx) >= 56
        let flicked = abs(dx) >= 24 && abs(predicted.width) >= 140
        guard far || flicked else { return 0 }
        return dx < 0 ? 1 : -1
    }

    /// The dock follows the finger at a third of its travel, up to 36 points.
    nonisolated static func followOffset(for dx: CGFloat) -> CGFloat {
        max(-36, min(36, dx * 0.33))
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
    /// Lifting the finger at the end of a drag also ends a touch on the gauge's button; taps
    /// are ignored until this time so a reorder does not change the selected harness.
    @State private var ignoreTapsUntil: Date = .distantPast
    /// Set when a gauge was held and released without being dragged: shows its shortcuts.
    @State private var shortcutsHarness: HarnessGroup?
    /// How far the dock follows a sideways swipe that switches machines.
    @State private var machineSwipeOffset: CGFloat = 0

    private static let cellSpacing: CGFloat = 4
    private static let stripPadding: CGFloat = 6
    private static let cellDiameter: CGFloat = 52
    /// Six circular gauges still fit side by side on a phone; beyond that the dock scrolls.
    /// There is no "All" gauge: with no harness selected nothing is highlighted and every
    /// harness is shown, and tapping the selected gauge deselects it.
    private static let maxFittedSlots = 6
    private static let stripSpace = "harnessStrip"

    private var totalSlots: Int {
        max(1, store.harnessOrder.count)
    }

    private var needsHorizontalScroll: Bool {
        totalSlots > Self.maxFittedSlots
    }

    private var canSwipeMachines: Bool {
        store.machines.count > 1 && !needsHorizontalScroll
    }

    private var cellWidth: CGFloat {
        Self.cellDiameter
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
                .frame(maxWidth: .infinity)
            } else {
                chipsRow
                    .padding(.horizontal, Self.stripPadding)
                    .padding(.vertical, 6)
                    .coordinateSpace(name: Self.stripSpace)
            }
        }
        // The same plain Liquid Glass capsule as the top bar's pills, hugging the circular gauges.
        .modifier(SHGlassSurfaceModifier(shape: Capsule()))
        .offset(x: machineSwipeOffset)
        // With two or more machines, a sideways swipe on the dock shows the next or previous
        // machine. The dock follows the finger a little and springs back. A dock that scrolls
        // sideways (more than six harnesses) keeps the swipe for scrolling.
        .simultaneousGesture(
            DragGesture(minimumDistance: 18)
                .onChanged { value in
                    guard canSwipeMachines, drag == nil else { return }
                    guard abs(value.translation.width) > abs(value.translation.height) else { return }
                    machineSwipeOffset = MachineSwipe.followOffset(for: value.translation.width)
                }
                .onEnded { value in
                    let direction = canSwipeMachines && drag == nil
                        ? MachineSwipe.direction(translation: value.translation, predicted: value.predictedEndTranslation)
                        : 0
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.75)) { machineSwipeOffset = 0 }
                    guard direction != 0 else { return }
                    ignoreTapsUntil = Date().addingTimeInterval(0.4)
                    triggerSelectionHaptic()
                    Task { await store.switchMachine(offset: direction) }
                }
        )
        .accessibilityAction(named: "Next Machine") { Task { await store.switchMachine(offset: 1) } }
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
        // A small dot marks a harness with an update waiting or running.
        .overlay(alignment: .topTrailing) {
            if store.needsUpdateAttention(group) {
                Circle()
                    .fill(SHColor.statusWarning)
                    .frame(width: 8, height: 8)
                    .overlay(Circle().stroke(SHColor.surfaceRail, lineWidth: 1.5))
                    .offset(x: -7, y: 7)
            }
        }
        .onTapGesture {
            guard Date() >= ignoreTapsUntil else { return }
            withAnimation(.easeInOut(duration: 0.16)) {
                store.selectedHarnessFilter = isSelected ? nil : group
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(store.needsUpdateAttention(group) ? "\(group.title), update available" : group.title)
        .accessibilityValue(gaugeAccessibilityValue(percent: barPct, working: working))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func chipCell<Content: View>(isSelected: Bool, @ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(width: Self.cellDiameter, height: Self.cellDiameter)
            // Selected: a flat neutral circular fill hugging the gauge, matching top-bar controls.
            .background(isSelected ? Color.white.opacity(0.14) : Color.clear)
            .clipShape(Circle())
            .contentShape(Circle())
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
    /// Height of the right slot in every state (time, working mark, question mark).
    private static let trailingSlotHeight: CGFloat = 18

    var body: some View {
        let hostBadge = SessionRowFormatting.hostBadgeLabel(session.hostAddress)
        let subtitle = SessionRowFormatting.formattedSubtitle(for: session)

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

                // The right slot. A working thread shows the animated mark in place of the time,
                // alongside its shimmering title. The time stays in the layout, invisible, so the
                // slot keeps its width and the title truncates the same whether the thread is
                // working or idle; the fixed height keeps the row from changing height.
                if session.status == .waitingInput && !isBusy {
                    Image(systemName: "questionmark.circle.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(SHColor.statusWarning)
                        .frame(height: Self.trailingSlotHeight)
                        .accessibilityLabel("Question pending")
                } else {
                    HStack(spacing: 6) {
                        Text(UsageMetrics.formatUpdatedAgo(session.updatedAt))
                            .font(SHTypography.micro.monospacedDigit())
                            .foregroundStyle(session.isUnread ? SHColor.inkSecondary : SHColor.inkFaint)
                            .fixedSize()
                            .opacity(isBusy ? 0 : 1)
                            .accessibilityHidden(isBusy)
                            .overlay(alignment: .trailing) {
                                if isBusy {
                                    SHWorkingMark(tint: SHColor.porcelain, size: 15)
                                        .accessibilityIdentifier("row.working")
                                }
                            }
                        if session.isUnread {
                            Circle()
                                .fill(SHColor.inkPrimary)
                                .frame(width: 7, height: 7)
                                .accessibilityLabel("Unread")
                                .accessibilityIdentifier("row.unread")
                        }
                    }
                    .frame(height: Self.trailingSlotHeight)
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
                        HStack(alignment: .center, spacing: 4) {
                            if subtitle.isDone {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 9.5, weight: .semibold))
                                    .foregroundStyle(SHColor.inkFaint)
                                    .accessibilityLabel("Done")
                            }
                            Text(subtitle.text)
                                .font(SHTypography.micro)
                                .foregroundStyle(SHColor.inkMuted)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
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
                        TextField("Folder name (e.g. Superharness)", text: $newName)
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
            return "Can't reach your host. Check that Superharness is running there."
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
        // What the host or the harness said, when it said something readable, beats any
        // general wording of ours.
        if let said = hostMessage(in: raw) {
            return said
        }
        if has("http 5", "status 5", "500", "502", "503", "internal server error") {
            return "Your host hit a problem handling that. Try again."
        }
        if has("decod", "json", "keynotfound", "typemismatch", "data couldn’t be read", "data couldn't be read") {
            return "Your host sent something this app version doesn't understand."
        }
        return "Something went wrong talking to your host."
    }

    /// The readable message inside an error from the host: the `error` field of a JSON reply
    /// ("HTTP 500: {"ok":false,"error":"…"}"), or a plain sentence the host or harness sent.
    /// Nil for system errors and anything that is not a sentence a person can use.
    public static func hostMessage(in raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = text.range(of: #"^HTTP \d{3}:\s*"#, options: .regularExpression) {
            text.removeSubrange(range)
        }
        if let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end,
           let object = try? JSONSerialization.jsonObject(with: Data(text[start...end].utf8)) as? [String: Any] {
            guard let said = (object["error"] ?? object["message"]) as? String else { return nil }
            text = said.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // A sentence, not a code or a stack: has a space, is not huge, and is not one of the
        // system's own network descriptions, which have clearer wording above.
        guard text.count >= 8, text.count <= 400, text.contains(" "),
              !text.hasPrefix("<"), !text.lowercased().contains("nsurlerrordomain"),
              !text.lowercased().hasPrefix("the operation couldn"),
              !text.lowercased().hasPrefix("response decoding error") else { return nil }
        return text
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

/// A chat being dragged toward the pinned area.
struct PinDragState: Equatable {
    var sessionId: String
    var title: String
    var location: CGPoint

    /// The position among the pinned rows for a finger at `y`, or nil when the finger is not
    /// over the pinned area. With no pinned rows yet, the top band of the list is the target.
    nonisolated static func dropIndex(y: CGFloat, pinnedFrames: [CGRect], slack: CGFloat = 28, emptyTop: CGFloat = 100, emptyBand: CGFloat = 150) -> Int? {
        guard let first = pinnedFrames.first, let last = pinnedFrames.last else {
            return y < emptyTop + emptyBand ? 0 : nil
        }
        guard y >= first.minY - slack, y <= last.maxY + slack else { return nil }
        return pinnedFrames.filter { $0.midY < y }.count
    }

    /// Where to draw the insertion line for `index`.
    nonisolated static func lineY(index: Int, pinnedFrames: [CGRect]) -> CGFloat? {
        guard !pinnedFrames.isEmpty else { return 118 }
        if index <= 0 { return pinnedFrames[0].minY - 2 }
        if index >= pinnedFrames.count { return pinnedFrames[pinnedFrames.count - 1].maxY + 2 }
        return (pinnedFrames[index - 1].maxY + pinnedFrames[index].minY) / 2
    }
}

/// Reports a pinned row's frame in screen coordinates.
private struct PinnedRowFrameReporter: ViewModifier {
    let sessionId: String?
    let onFrame: (CGRect) -> Void

    func body(content: Content) -> some View {
        if sessionId != nil {
            content.onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { onFrame($0) }
        } else {
            content
        }
    }
}

/// Attaches the hold-then-move recognizer to an unpinned row.
private struct PinDragSource: ViewModifier {
    let session: UnifiedSession?
    let onChange: (CGPoint) -> Void
    let onEnd: (_ commit: Bool) -> Void

    func body(content: Content) -> some View {
        if session != nil {
            content.gesture(HoldThenMoveGesture(onChange: onChange, onEnd: onEnd))
        } else {
            content
        }
    }
}

/// Recognizes "hold briefly, then move". It leaves the other gestures on a row alone: a quick
/// swipe fails it at once so the list scrolls, and holding still fails it just before the
/// context menu would open, so the menu still appears.
final class HoldThenMoveRecognizer: UIGestureRecognizer {
    static let holdBeforeMove: TimeInterval = 0.2
    static let giveUpStill: TimeInterval = 0.42
    static let quickSwipeDistance: CGFloat = 9
    static let dragDistance: CGFloat = 4

    private var startTime: TimeInterval = 0
    private var startPoint: CGPoint = .zero
    private var stillTimer: Timer?

    /// What a touch that has moved `distance` after `elapsed` seconds means.
    enum Verdict { case wait, scroll, drag }
    nonisolated static func verdict(elapsed: TimeInterval, distance: CGFloat) -> Verdict {
        if elapsed < holdBeforeMove { return distance > quickSwipeDistance ? .scroll : .wait }
        return distance > dragDistance ? .drag : .wait
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard touches.count == 1, let touch = touches.first, state == .possible else {
            state = .failed
            return
        }
        startTime = touch.timestamp
        startPoint = touch.location(in: view?.window)
        stillTimer?.invalidate()
        stillTimer = Timer.scheduledTimer(withTimeInterval: Self.giveUpStill, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.state == .possible else { return }
                self.state = .failed
            }
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let touch = touches.first else { return }
        if state == .began || state == .changed {
            state = .changed
            return
        }
        guard state == .possible else { return }
        let point = touch.location(in: view?.window)
        let distance = hypot(point.x - startPoint.x, point.y - startPoint.y)
        switch Self.verdict(elapsed: touch.timestamp - startTime, distance: distance) {
        case .wait: break
        case .scroll: finish(.failed)
        case .drag:
            stillTimer?.invalidate()
            state = .began
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        finish(state == .began || state == .changed ? .ended : .failed)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        finish(state == .began || state == .changed ? .cancelled : .failed)
    }

    private func finish(_ next: UIGestureRecognizer.State) {
        stillTimer?.invalidate()
        stillTimer = nil
        state = next
    }

    override func reset() {
        stillTimer?.invalidate()
        stillTimer = nil
    }
}

private struct HoldThenMoveGesture: UIGestureRecognizerRepresentable {
    let onChange: (CGPoint) -> Void
    let onEnd: (_ commit: Bool) -> Void

    func makeUIGestureRecognizer(context: Context) -> HoldThenMoveRecognizer {
        HoldThenMoveRecognizer()
    }

    func handleUIGestureRecognizerAction(_ recognizer: HoldThenMoveRecognizer, context: Context) {
        switch recognizer.state {
        case .began, .changed:
            // Screen coordinates: a named coordinate space set on the List is not visible
            // from inside its rows.
            onChange(context.converter.location(in: .global))
        case .ended:
            onEnd(true)
        case .cancelled, .failed:
            onEnd(false)
        default:
            break
        }
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

/// The Superharness mark shown in the middle of the session list's top bar.
struct SHToolbarLogo: View {
    var body: some View {
        // The porcelain mark, a single-colour template tinted porcelain white.
        Image("SuperHarnessLogo")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(SHColor.porcelain)
            .frame(width: 26, height: 26)
            .accessibilityLabel("Superharness")
            .accessibilityIdentifier("header.logo")
    }
}
