import AVKit
import SwiftUI

public struct RootView: View {
    @Bindable var store: AppStore
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var navigationPath: [DetailRoute] = []
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    public init(store: AppStore) {
        self.store = store
    }

    public var body: some View {
        Group {
            if store.needsPairing {
                // A fresh install, or a phone the desktop unpaired: nothing else is reachable
                // until it is paired.
                PairingView(store: store)
            } else if sizeClass == .regular {
                splitLayout
            } else {
                compactLayout
            }
        }
        .background(SHColor.surfaceCanvas.ignoresSafeArea())
        .onChange(of: scenePhase) { oldPhase, newPhase in
            if newPhase == .background {
                Task { await store.handleScenePhaseChanged(.background) }
            } else if newPhase == .active, oldPhase == .background || oldPhase == .inactive {
                Task { await store.handleScenePhaseChanged(.active) }
            }
        }
        .onChange(of: store.sessions.map(\.id)) { _, _ in
            applyPendingInitialRouteIfNeeded()
        }
        .onChange(of: store.pendingInitialSessionId, initial: true) { _, _ in
            applyPendingInitialRouteIfNeeded()
        }
        .onChange(of: store.pendingInitialRoute, initial: true) { _, _ in
            applyPendingInitialRouteIfNeeded()
        }
        .onChange(of: store.detailRoute, initial: true) { _, newRoute in
            guard sizeClass != .regular else { return }
            if let newRoute {
                if navigationPath.last != newRoute {
                    navigationPath = [newRoute]
                }
            } else if !navigationPath.isEmpty {
                navigationPath = []
            }
        }
        .onChange(of: navigationPath) { oldPath, newPath in
            guard sizeClass != .regular else { return }
            if !oldPath.isEmpty && newPath.isEmpty && store.detailRoute != nil {
                store.clearDetailRoute()
            }
        }
        .sheet(isPresented: $store.isUsageSheetPresented) {
            UsageSheetView(store: store, initialTarget: store.usageSheetTarget)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $store.isHostSettingsSheetPresented) {
            HostConnectionSheet(store: store)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $store.isAddMachineSheetPresented) {
            PairingView(store: store, isAdditional: true)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .environment(\.openURL, OpenURLAction { url in
            if store.openSessionLink(url) || store.openFileLink(url) {
                return .handled
            }
            return .systemAction
        })
        .sheet(item: $store.filePreviewTarget) { target in
            FilePreviewSheet(store: store, initialTarget: target)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .fullScreenCover(item: Binding(
            get: { store.lightboxPayload.flatMap { $0.isVideo ? nil : $0 } },
            set: { store.lightboxPayload = $0 }
        )) { payload in
            ImageLightboxView(payload: payload) { path in
                await store.loadMediaData(path: path)
            }
        }
        // A tapped video opens in the system player (AVPlayerViewController), streamed from the
        // host's copy of the attachment, rather than in the image lightbox.
        .onChange(of: store.lightboxPayload?.id) { _, _ in
            guard let payload = store.lightboxPayload, payload.isVideo else { return }
            store.lightboxPayload = nil
            guard let path = payload.path, let stream = store.mediaStreamRequest(path: path) else { return }
            SHVideoPlayerPresenter.present(url: stream.url, headers: stream.headers)
        }
    }

    // MARK: - iPad NavigationSplitView

    private var splitLayout: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SessionListView(store: store, keepsSelectionHighlight: true) { sessionId in
                store.selectSession(sessionId)
            }
            .navigationSplitViewColumnWidth(min: 310, ideal: 350, max: 420)
        } detail: {
            detailContent(for: store.detailRoute ?? store.activeSession.map { .session($0.id) })
        }
        .navigationSplitViewStyle(.balanced)
    }

    // MARK: - iPhone NavigationStack

    private var compactLayout: some View {
        NavigationStack(path: $navigationPath) {
            SessionListView(store: store) { sessionId in
                store.selectSession(sessionId)
                let route = DetailRoute.session(sessionId)
                if navigationPath.last != route {
                    navigationPath = [route]
                }
            }
            .navigationDestination(for: DetailRoute.self) { route in
                detailContent(for: route)
            }
        }
    }

    @ViewBuilder
    private func detailContent(for route: DetailRoute?) -> some View {
        switch route {
        case .draft(let harness):
            DraftChatView(store: store, initialHarness: harness) { newSessionId in
                store.selectSession(newSessionId)
                if sizeClass != .regular {
                    navigationPath = [.session(newSessionId)]
                }
            }
        case .session(let sessionId):
            if let session = store.sessions.first(where: { $0.id == sessionId }) {
                SessionDetailView(store: store, session: session)
            } else {
                emptyDetailView
            }
        case nil:
            emptyDetailView
        }
    }

    private func applyPendingInitialRouteIfNeeded() {
        if let initialRoute = store.pendingInitialRoute {
            store.pendingInitialRoute = nil
            store.detailRoute = initialRoute
            if sizeClass != .regular, navigationPath.last != initialRoute {
                navigationPath = [initialRoute]
            }
            return
        }

        guard let targetId = store.pendingInitialSessionId,
              let matched = store.sessions.first(where: { $0.id == targetId || $0.nativeId == targetId }) else {
            return
        }
        store.pendingInitialSessionId = nil
        store.selectSession(matched.id)
        if sizeClass != .regular, navigationPath.last != .session(matched.id) {
            navigationPath = [.session(matched.id)]
        }
    }

    private var emptyDetailView: some View {
        VStack(spacing: SHSpacing.md) {
            HarnessLogoView(harness: .master, size: 34)
            Text("Select a Session")
                .font(SHTypography.title)
                .foregroundStyle(SHColor.inkPrimary)
            Text("Pick any Antigravity, Codex, Claude, or Master session to inspect its live transcript.")
                .font(SHTypography.caption)
                .foregroundStyle(SHColor.inkMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SHColor.surfaceCanvas)
    }
}

// MARK: - Subtle Connection Status Pill

/// The Superharness mark in the top bar. It opens Settings, and its glyph is the status: the
/// mark when all is well, sync arrows while the app is fetching from the host, and a yellow
/// warning mark when the host cannot be reached. It morphs between these.
public struct ConnectionStatusPill: View {
    public let health: ConnectionHealth
    public var isSyncing: Bool = false
    /// With two or more machines the button opens a menu: the machines, then Settings.
    public var machines: [PairedMachine] = []
    public var activeMachineId: String = ""
    public var onSwitchMachine: (String) -> Void = { _ in }
    public var onPairAnother: () -> Void = {}
    public let action: () -> Void

    public init(
        health: ConnectionHealth,
        isSyncing: Bool = false,
        machines: [PairedMachine] = [],
        activeMachineId: String = "",
        onSwitchMachine: @escaping (String) -> Void = { _ in },
        onPairAnother: @escaping () -> Void = {},
        action: @escaping () -> Void
    ) {
        self.health = health
        self.isSyncing = isSyncing
        self.machines = machines
        self.activeMachineId = activeMachineId
        self.onSwitchMachine = onSwitchMachine
        self.onPairAnother = onPairAnother
        self.action = action
    }

    public enum Glyph: Equatable, Sendable {
        case settings, syncing, problem

        public var symbolName: String {
            switch self {
            case .settings: return "gearshape"
            case .syncing: return "arrow.triangle.2.circlepath"
            case .problem: return "exclamationmark.triangle.fill"
            }
        }
    }

    /// How long the host must stay unreachable before the warning appears. Returning from the
    /// background always starts with a dropped connection that is restored within a second or
    /// two; the sync arrows cover that, so the warning does not flash.
    public static let problemGrace: Duration = .seconds(4)

    /// Set once the host has been unreachable for `problemGrace`.
    @State private var offlineConfirmed = false

    /// A confirmed problem outranks syncing: while the host is unreachable the app keeps
    /// retrying, and the warning should stay put instead of alternating with the sync arrows.
    /// Until the problem is confirmed, the app is reconnecting, which reads as syncing.
    nonisolated public static func glyph(health: ConnectionHealth, isSyncing: Bool, offlineConfirmed: Bool = true) -> Glyph {
        if case .offline = health { return offlineConfirmed ? .problem : .syncing }
        if isSyncing || health == .connecting { return .syncing }
        return .settings
    }

    private var isOffline: Bool {
        if case .offline = health { return true }
        return false
    }

    public var body: some View {
        let glyph = Self.debugForcedGlyph ?? Self.glyph(health: health, isSyncing: isSyncing, offlineConfirmed: offlineConfirmed)
        Group {
            if machines.count > 1 {
                Menu {
                    Section("Machines") {
                        ForEach(machines) { machine in
                            Button {
                                onSwitchMachine(machine.id)
                            } label: {
                                if machine.id == activeMachineId {
                                    Label(machine.displayName, systemImage: "checkmark")
                                } else {
                                    Text(machine.displayName)
                                }
                            }
                        }
                    }
                    Button(action: onPairAnother) {
                        Label("Pair Another Machine", systemImage: "plus")
                    }
                    Button(action: action) {
                        Label("Settings", systemImage: "gearshape")
                    }
                } label: {
                    glyphView(glyph)
                }
            } else {
                Button(action: action) {
                    glyphView(glyph)
                }
            }
        }
        .accessibilityLabel("Settings · \(accessibilityStatus(glyph))")
        .accessibilityIdentifier("header.status")
        .accessibilityValue(String(describing: glyph))
        .task(id: isOffline) {
            guard isOffline else {
                offlineConfirmed = false
                return
            }
            try? await Task.sleep(for: Self.problemGrace)
            if !Task.isCancelled { offlineConfirmed = true }
        }
    }

    private func glyphView(_ glyph: Glyph) -> some View {
        ZStack {
            if glyph == .settings {
                SHToolbarLogo()
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
            } else {
                Image(systemName: glyph.symbolName)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(glyph == .problem ? SHColor.statusWarning : SHColor.porcelain)
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.rotate, options: .repeat(.continuous), isActive: glyph == .syncing)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
        }
        .frame(width: 30, height: 30)
        .contentShape(Circle())
        .animation(.spring(response: 0.32, dampingFraction: 0.8), value: glyph)
    }

    /// UI checks set `SH_DEBUG_STATUS_GLYPH` to `syncing` or `problem` to show that state.
    private static let debugForcedGlyph: Glyph? = {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["SH_DEBUG_STATUS_GLYPH"] {
        case "syncing": return .syncing
        case "problem": return .problem
        default: return nil
        }
        #else
        return nil
        #endif
    }()

    private func accessibilityStatus(_ glyph: Glyph) -> String {
        switch glyph {
        case .settings: return health.label
        case .syncing: return "Syncing"
        case .problem: return "Host unreachable"
        }
    }
}

/// Presents the system video player full screen, with its own close button, scrubbing and
/// Picture in Picture. The player streams the file with range requests, so long clips start
/// playing before they finish downloading.
@MainActor
enum SHVideoPlayerPresenter {
    static func present(url: URL, headers: [String: String]) {
        let asset = AVURLAsset(url: url, options: headers.isEmpty ? nil : ["AVURLAssetHTTPHeaderFieldsKey": headers])
        let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        let controller = AVPlayerViewController()
        controller.player = player
        controller.modalPresentationStyle = .fullScreen
        guard let presenter = topViewController() else { return }
        presenter.present(controller, animated: true) { player.play() }
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
        var top = window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}

// MARK: - Mobile Host File Preview Sheet

private struct FilePreviewSheet: View {
    let store: AppStore
    let initialTarget: FilePreviewTarget

    @Environment(\.dismiss) private var dismiss
    @State private var navStack: [FilePreviewTarget] = []
    @State private var preview: FilePreviewData? = nil
    @State private var imageData: Data? = nil
    @State private var isLoading: Bool = true
    @State private var loadError: String? = nil
    @State private var showRawMarkdown: Bool = false
    @State private var wrapLines: Bool = false
    @State private var copiedFeedback: String? = nil

    private var activeTarget: FilePreviewTarget {
        navStack.last ?? initialTarget
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                pathBreadcrumbBar
                Divider().overlay(SHColor.lineSubtle)
                contentBody
            }
            .background(SHColor.surfaceCanvas)
            .navigationTitle(activeTarget.fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if navStack.count > 1 {
                        Button {
                            navStack.removeLast()
                        } label: {
                            HStack(spacing: 3) {
                                Image(systemName: "chevron.left")
                                Text("Back")
                            }
                        }
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if preview?.kind == "markdown" {
                        Button {
                            showRawMarkdown.toggle()
                        } label: {
                            Image(systemName: showRawMarkdown ? "doc.richtext" : "chevron.left.forwardslash.chevron.right")
                        }
                        .accessibilityLabel(showRawMarkdown ? "Rendered Markdown" : "Raw Source")
                    } else if preview?.kind == "code" {
                        Button {
                            wrapLines.toggle()
                        } label: {
                            Image(systemName: wrapLines ? "text.alignleft" : "arrow.left.and.right.text.vertical")
                        }
                        .accessibilityLabel(wrapLines ? "Disable Line Wrap" : "Wrap Lines")
                    }

                    Menu {
                        Button {
                            copyWithFeedback(activeTarget.path, label: "Path copied")
                        } label: {
                            Label("Copy Path", systemImage: "doc.on.doc")
                        }
                        if let content = preview?.content, !content.isEmpty {
                            Button {
                                copyWithFeedback(content, label: "Contents copied")
                            } label: {
                                Label("Copy File Contents", systemImage: "doc.plaintext")
                            }
                        }
                        let parentPath = (activeTarget.path as NSString).deletingLastPathComponent
                        if !parentPath.isEmpty && parentPath != activeTarget.path {
                            Button {
                                navigateTo(FilePreviewTarget(path: parentPath))
                            } label: {
                                Label("Open Parent Folder", systemImage: "folder")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }

                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .onAppear {
            if navStack.isEmpty {
                navStack = [initialTarget]
            }
        }
        .task(id: activeTarget.id) {
            await loadActiveTarget()
        }
    }

    private var pathBreadcrumbBar: some View {
        Button {
            copyWithFeedback(activeTarget.path, label: "Path copied")
        } label: {
            HStack(spacing: 8) {
                Image(systemName: preview?.isDirectory == true ? "folder.fill" : "doc.text")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(SHColor.inkMuted)
                Text(activeTarget.path)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(SHColor.inkSecondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 6)
                if let copiedFeedback {
                    Text(copiedFeedback)
                        .font(SHTypography.micro.weight(.semibold))
                        .foregroundStyle(SHColor.statusSuccess)
                } else if let meta = metadataPill {
                    Text(meta)
                        .font(SHTypography.micro.monospacedDigit())
                        .foregroundStyle(SHColor.inkFaint)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(SHColor.surfaceBubble.opacity(0.65))
        }
        .buttonStyle(.plain)
    }

    private var metadataPill: String? {
        if let s = activeTarget.startLine {
            if let e = activeTarget.endLine, e > s {
                return "L\(s)–L\(e)"
            }
            return "L\(s)"
        }
        guard let preview else { return nil }
        if preview.isDirectory {
            return "\(preview.entries?.count ?? 0) items"
        }
        var parts: [String] = []
        if let lc = preview.lineCount, lc > 0 {
            parts.append("\(lc) lines")
        }
        if preview.sizeBytes > 0 {
            parts.append(ByteCountFormatter.string(fromByteCount: Int64(preview.sizeBytes), countStyle: .file))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var contentBody: some View {
        if isLoading {
            VStack(spacing: 12) {
                ProgressView()
                Text("Loading \(activeTarget.fileName)…")
                    .font(SHTypography.caption)
                    .foregroundStyle(SHColor.inkMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorText = loadError ?? preview?.error {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 28))
                    .foregroundStyle(SHColor.statusWarning)
                Text("Couldn't preview file")
                    .font(SHTypography.label.weight(.semibold))
                    .foregroundStyle(SHColor.inkPrimary)
                Text(errorText)
                    .font(SHTypography.caption)
                    .foregroundStyle(SHColor.inkMuted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let preview {
            switch preview.kind {
            case "directory":
                directoryView(preview.entries ?? [])
            case "image":
                imagePreviewView
            case "markdown" where !showRawMarkdown:
                ScrollView {
                    SHMarkdownView(text: preview.content ?? "", isUserBubble: false)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, SHLayout.screenPad)
                        .padding(.vertical, 14)
                }
            case "code", "markdown":
                codePreviewView(
                    content: preview.content ?? "",
                    highlightStart: activeTarget.startLine ?? preview.startLine,
                    highlightEnd: activeTarget.endLine ?? preview.endLine
                )
            default:
                VStack(spacing: 12) {
                    Image(systemName: "doc.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(SHColor.inkMuted)
                    Text(preview.name)
                        .font(SHTypography.label.weight(.semibold))
                        .foregroundStyle(SHColor.inkPrimary)
                    Text("Binary file (\(ByteCountFormatter.string(fromByteCount: Int64(preview.sizeBytes), countStyle: .file)))")
                        .font(SHTypography.caption)
                        .foregroundStyle(SHColor.inkMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func codePreviewView(content: String, highlightStart: Int?, highlightEnd: Int?) -> some View {
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let gutterWidth = CGFloat(max(3, String(lines.count).count)) * 8.5 + 14
        let effectiveEnd = highlightEnd ?? highlightStart

        return ScrollViewReader { proxy in
            ScrollView(wrapLines ? [.vertical] : [.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { idx, line in
                        let lineNum = idx + 1
                        let isHighlighted: Bool = {
                            guard let s = highlightStart, let e = effectiveEnd else { return false }
                            return lineNum >= s && lineNum <= e
                        }()
                        HStack(alignment: .top, spacing: 0) {
                            Text("\(lineNum)")
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundStyle(isHighlighted ? SHColor.brandAntigravity : SHColor.inkFaint)
                                .frame(width: gutterWidth, alignment: .trailing)
                                .padding(.trailing, 10)
                                .padding(.vertical, 1.5)
                            Text(line.isEmpty ? " " : line)
                                .font(.system(size: 12.5, design: .monospaced))
                                .foregroundStyle(SHColor.inkPrimary)
                                .fixedSize(horizontal: !wrapLines, vertical: true)
                                .padding(.trailing, 16)
                                .padding(.vertical, 1.5)
                                .textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(isHighlighted ? SHColor.brandAntigravity.opacity(0.16) : Color.clear)
                        .overlay(alignment: .leading) {
                            if isHighlighted {
                                Rectangle()
                                    .fill(SHColor.brandAntigravity)
                                    .frame(width: 2.5)
                            }
                        }
                        .id(lineNum)
                    }
                }
                .padding(.vertical, 10)
            }
            .onAppear {
                if let targetLine = highlightStart, targetLine > 1, targetLine <= lines.count {
                    DispatchQueue.main.async {
                        proxy.scrollTo(targetLine, anchor: .center)
                    }
                }
            }
        }
    }

    private func directoryView(_ entries: [FilePreviewDirectoryEntry]) -> some View {
        List(entries) { entry in
            Button {
                navigateTo(FilePreviewTarget(path: entry.path))
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: entry.isDirectory ? "folder.fill" : "doc.text")
                        .font(.system(size: 15))
                        .foregroundStyle(entry.isDirectory ? SHColor.brandAntigravity : SHColor.inkMuted)
                        .frame(width: 22)
                    Text(entry.name)
                        .font(SHTypography.body)
                        .foregroundStyle(SHColor.inkPrimary)
                        .lineLimit(1)
                    Spacer()
                    if let size = entry.sizeBytes, !entry.isDirectory {
                        Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                            .font(SHTypography.micro.monospacedDigit())
                            .foregroundStyle(SHColor.inkFaint)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(SHColor.inkFaint)
                }
            }
            .listRowBackground(SHColor.surfaceCanvas)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }

    @ViewBuilder
    private var imagePreviewView: some View {
        if let imageData, let uiImage = UIImage(data: imageData) {
            SHZoomableImageView(image: uiImage)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
        } else {
            VStack(spacing: 10) {
                ProgressView()
                Text("Loading image…")
                    .font(SHTypography.caption)
                    .foregroundStyle(SHColor.inkMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func navigateTo(_ target: FilePreviewTarget) {
        showRawMarkdown = false
        navStack.append(target)
    }

    private func loadActiveTarget() async {
        isLoading = true
        loadError = nil
        preview = nil
        imageData = nil
        let target = activeTarget
        do {
            let result = try await store.fetchFilePreview(
                path: target.path,
                startLine: target.startLine,
                endLine: target.endLine
            )
            preview = result
            isLoading = false
            if result.kind == "image" {
                imageData = await store.loadMediaData(path: result.path)
            }
        } catch {
            loadError = error.localizedDescription
            isLoading = false
        }
    }

    private func copyWithFeedback(_ value: String, label: String) {
        UIPasteboard.general.string = value
        copiedFeedback = label
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            if copiedFeedback == label { copiedFeedback = nil }
        }
    }
}
