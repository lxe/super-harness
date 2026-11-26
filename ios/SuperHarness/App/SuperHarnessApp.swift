import SwiftUI

@main
struct SuperHarnessApp: App {
    @State private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView(store: store)
                .preferredColorScheme(.dark)
                .tint(SHColor.accentPrimary)
                .task {
                    await store.bootstrap()
                }
        }
    }
}
