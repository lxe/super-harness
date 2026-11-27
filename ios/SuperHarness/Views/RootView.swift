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
            if sizeClass == .regular {
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

public struct ConnectionStatusPill: View {
    public let health: ConnectionHealth
    public let action: () -> Void

    public init(health: ConnectionHealth, action: @escaping () -> Void) {
        self.health = health
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            // A gear for settings with the connection state as a dot on its corner. The logo
            // itself lives in the middle of the bar.
            Image(systemName: "gearshape")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(SHColor.inkSecondary)
                .frame(width: 28, height: 28)
                .overlay(alignment: .topTrailing) {
                    Circle()
                        .fill(dotColor)
                        .frame(width: 7, height: 7)
                        .overlay(Circle().strokeBorder(SHColor.surfaceCanvas.opacity(0.9), lineWidth: 1))
                        .offset(x: -2, y: 3)
                }
                .contentShape(Circle())
        }
        .accessibilityLabel("Connection and settings · \(health.label)")
        .accessibilityIdentifier("header.status")
    }

    private var dotColor: Color {
        switch health {
        case .demo: return SHColor.inkMuted
        case .connecting: return SHColor.statusWarning
        case .connected: return SHColor.statusSuccess
        case .offline: return SHColor.statusDanger
        }
    }
}
