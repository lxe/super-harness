import SwiftUI

@main
struct SuperHarnessApp: App {
    #if canImport(UIKit)
    @UIApplicationDelegateAdaptor(SuperHarnessAppDelegate.self) private var appDelegate
    #endif
    @State private var store = AppStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(store: store)
                .preferredColorScheme(.dark)
                .tint(SHColor.accentPrimary)
                .task {
                    PushNotificationCoordinator.shared.configure(store: store)
                    await store.bootstrap()
                    if store.pushNotificationsEnabled {
                        _ = await PushNotificationCoordinator.shared.requestAuthorizationAndRegister()
                    }
                }
                .onChange(of: scenePhase) { _, newPhase in
                    if newPhase == .background {
                        PushNotificationCoordinator.shared.scheduleBackgroundRefresh()
                    }
                }
        }
    }
}
