import SwiftUI

@main
struct SuperHarnessApp: App {
    #if canImport(UIKit)
    @UIApplicationDelegateAdaptor(SuperHarnessAppDelegate.self) private var appDelegate
    #endif
    @State private var store = AppStore()
    @Environment(\.scenePhase) private var scenePhase

    private func requestPushIfPaired() async {
        guard store.pushNotificationsEnabled, store.canReceivePushes else { return }
        _ = await PushNotificationCoordinator.shared.requestAuthorizationAndRegister()
    }

    var body: some Scene {
        WindowGroup {
            RootView(store: store)
                .preferredColorScheme(.dark)
                .tint(SHColor.accentPrimary)
                .task {
                    PushNotificationCoordinator.shared.configure(store: store)
                    await store.bootstrap()
                    await requestPushIfPaired()
                }
                // Notifications come from the paired desktop, so the permission prompt waits
                // until there is one: not on the pairing screen, and not in the demo.
                .onChange(of: store.canReceivePushes) { _, _ in
                    Task { await requestPushIfPaired() }
                }
                .onChange(of: scenePhase) { _, newPhase in
                    if newPhase == .background {
                        PushNotificationCoordinator.shared.scheduleBackgroundRefresh()
                    }
                }
        }
    }
}
