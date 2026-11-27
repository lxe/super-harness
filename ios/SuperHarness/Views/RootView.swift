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
        .onChange(of: store.sessions.count) { _, _ in
            applyPendingInitialRouteIfNeeded()
        }
        .onChange(of: store.pendingInitialSessionId, initial: true) { _, _ in
            applyPendingInitialRouteIfNeeded()
        }
        .onChange(of: store.pendingInitialRoute, initial: true) { _, _ in
            applyPendingInitialRouteIfNeeded()
        }
        .onChange(of: store.detailRoute) { _, newRoute in
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
        .environment(\.openURL, OpenURLAction { url in
            if store.openSessionLink(url) {
                return .handled
            }
            return .systemAction
        })
        .fullScreenCover(item: $store.lightboxPayload) { payload in
            ImageLightboxView(payload: payload) { path in
                await store.loadMediaData(path: path)
            }
        }
    }

    // MARK: - iPad NavigationSplitView

    private var splitLayout: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SessionListView(store: store) { sessionId in
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
              let matched = store.sessions.first(where: { $0.id == targetId }) else {
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
    public let action: () -> Void

    public init(health: ConnectionHealth, isSyncing: Bool = false, action: @escaping () -> Void) {
        self.health = health
        self.isSyncing = isSyncing
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
        Button(action: action) {
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
