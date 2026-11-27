import BackgroundTasks
import CryptoKit
import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif

/// Manages APNs registration, Cloudflare Push Relay sync, notification tap deep-linking,
/// and periodic BGAppRefreshTask background updates.
@MainActor
public final class PushNotificationCoordinator: NSObject {
    public static let shared = PushNotificationCoordinator()
    #if canImport(UIKit)
    /// Non-isolated Objective-C delegate proxy assigned to `UNUserNotificationCenter.current().delegate`.
    /// Using the completion-handler selectors (rather than Swift's `async` bridged shims) guarantees
    /// Apple's `completionHandler` always executes on the main thread and avoids Swift 6's ObjC-async
    /// background-executor crash when tapping a notification.
    public nonisolated static let notificationDelegate = NotificationCenterDelegateProxy()
    #endif
    public static let defaultRelayURL = "https://super-harness-push.lxe-sh.workers.dev"
    public static let bgRefreshTaskId = "com.lxe.superharness.refresh"

    public weak var store: AppStore?
    public private(set) var lastDeviceTokenHex: String?
    public private(set) var lastRegistrationStatus: String = "Not registered"

    private var hasRegisteredBGTask = false
    private var lastAppliedBadgeCount: Int?
    private var pendingNotificationSessionId: String?

    public nonisolated static func extractSessionId(
        userInfo: [AnyHashable: Any],
        threadIdentifier: String
    ) -> String? {
        let explicitId = (userInfo["sessionId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let explicitId, !explicitId.isEmpty {
            return explicitId
        }
        let threadId = threadIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
        if !threadId.isEmpty && threadId != "super-harness" {
            return threadId
        }
        return nil
    }

    public func configure(store: AppStore) {
        self.store = store
        #if canImport(UIKit)
        UNUserNotificationCenter.current().delegate = Self.notificationDelegate
        #endif
        registerBackgroundRefreshIfNeeded()
        setAppIconBadge(store.effectiveAppIconBadgeCount)
        if let pending = pendingNotificationSessionId {
            pendingNotificationSessionId = nil
            store.openSessionFromNotification(pending)
        }
    }

    public func handleNotificationTap(sessionId: String) {
        let trimmed = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if let store {
            pendingNotificationSessionId = nil
            store.openSessionFromNotification(trimmed)
        } else {
            pendingNotificationSessionId = trimmed
        }
    }

    public func setAppIconBadge(_ count: Int) {
        let clamped = max(0, count)
        if lastAppliedBadgeCount == clamped { return }
        lastAppliedBadgeCount = clamped
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        #if canImport(UIKit)
        let center = UNUserNotificationCenter.current()
        Task {
            try? await center.setBadgeCount(clamped)
        }
        #endif
    }

    public func requestAuthorizationAndRegister() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        #if canImport(UIKit)
        if granted {
            UIApplication.shared.registerForRemoteNotifications()
        }
        #endif
        return granted
    }

    public func handleDeviceToken(_ tokenData: Data) {
        let hexToken = tokenData.map { String(format: "%02x", $0) }.joined()
        lastDeviceTokenHex = hexToken
        Task {
            await syncTokenWithRelayAndHost(deviceTokenHex: hexToken)
        }
    }

    public func syncCurrentTokenIfAvailable() {
        guard let token = lastDeviceTokenHex else { return }
        Task {
            await syncTokenWithRelayAndHost(deviceTokenHex: token)
        }
    }

    public func scheduleBackgroundRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: Self.bgRefreshTaskId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    private func registerBackgroundRefreshIfNeeded() {
        guard !hasRegisteredBGTask else { return }
        hasRegisteredBGTask = true
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.bgRefreshTaskId, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in
                PushNotificationCoordinator.shared.scheduleBackgroundRefresh()
                guard let store = PushNotificationCoordinator.shared.store else {
                    refreshTask.setTaskCompleted(success: false)
                    return
                }
                let bgWork = Task { @MainActor in
                    await store.refresh()
                    refreshTask.setTaskCompleted(success: true)
                }
                refreshTask.expirationHandler = {
                    bgWork.cancel()
                    refreshTask.setTaskCompleted(success: false)
                }
            }
        }
    }

    public static func deriveRelayCredentials(mobileToken: String) -> (rid: String, keyData: Data) {
        let keyHash = SHA256.hash(data: Data("super-harness-push-key:\(mobileToken)".utf8))
        let keyData = Data(keyHash)
        let ridHash = SHA256.hash(data: keyData)
        let rid = ridHash.map { String(format: "%02x", $0) }.joined().prefix(32)
        return (String(rid), keyData)
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func syncTokenWithRelayAndHost(deviceTokenHex: String) async {
        guard let store else { return }
        let token = store.bearerToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, store.connectionMode == .live else { return }

        let (rid, keyData) = Self.deriveRelayCredentials(mobileToken: token)
        let relayBase = store.pushRelayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? Self.defaultRelayURL
            : store.pushRelayURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        #if DEBUG
        let apnsEnv = "sandbox"
        #else
        let apnsEnv = "production"
        #endif

        let path = "/v1/devices/\(rid)"
        guard let url = URL(string: "\(relayBase)\(path)") else { return }
        let payload: [String: Any] = [
            "key": Self.base64URL(keyData),
            "device": deviceTokenHex,
            "env": apnsEnv,
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }

        let ts = Int(Date().timeIntervalSince1970)
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let bodyHash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let signMsg = "PUT\n\(path)\n\(ts)\n\(nonce)\n\(bodyHash)"
        let mac = HMAC<SHA256>.authenticationCode(for: Data(signMsg.utf8), using: SymmetricKey(data: keyData))
        let sigHex = mac.map { String(format: "%02x", $0) }.joined()

        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.httpBody = body
        req.timeoutInterval = 12
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(String(ts), forHTTPHeaderField: "x-sh-time")
        req.setValue(nonce, forHTTPHeaderField: "x-sh-nonce")
        req.setValue(sigHex, forHTTPHeaderField: "x-sh-sig")

        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(code) {
                lastRegistrationStatus = "Connected to Push Relay"
            } else {
                lastRegistrationStatus = "Relay HTTP \(code)"
            }
        } catch {
            lastRegistrationStatus = "Relay offline"
        }

        // Always notify the desktop host of our rid + relayUrl so it can push on completions/questions.
        await store.registerPushDeviceOnHost(
            rid: rid,
            relayUrl: relayBase,
            enabled: store.pushNotificationsEnabled,
            badgeEnabled: store.appIconBadgeEnabled
        )
    }
}

#if canImport(UIKit)
private struct UncheckedSendableClosure<T>: @unchecked Sendable {
    let call: T
}

public final class NotificationCenterDelegateProxy: NSObject, UNUserNotificationCenterDelegate, Sendable {
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let options: UNNotificationPresentationOptions = [.banner, .sound, .badge]
        if Thread.isMainThread {
            completionHandler(options)
        } else {
            let box = UncheckedSendableClosure(call: completionHandler)
            DispatchQueue.main.async {
                box.call(options)
            }
        }
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let content = response.notification.request.content
        let sessionId = PushNotificationCoordinator.extractSessionId(
            userInfo: content.userInfo,
            threadIdentifier: content.threadIdentifier
        )
        let box = UncheckedSendableClosure(call: completionHandler)
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                if let sessionId {
                    PushNotificationCoordinator.shared.handleNotificationTap(sessionId: sessionId)
                }
                box.call()
            }
        } else {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if let sessionId {
                        PushNotificationCoordinator.shared.handleNotificationTap(sessionId: sessionId)
                    }
                    box.call()
                }
            }
        }
    }
}

public final class SuperHarnessAppDelegate: NSObject, UIApplicationDelegate {
    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Assign the notification center delegate before launch completes so iOS delivers
        // cold-launch notification taps to `userNotificationCenter(_:didReceive:withCompletionHandler:)`.
        UNUserNotificationCenter.current().delegate = PushNotificationCoordinator.notificationDelegate
        return true
    }
    public func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            PushNotificationCoordinator.shared.handleDeviceToken(deviceToken)
        }
    }

    public func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Simulator or unsigned builds may not support APNs; fail silently.
    }

    public func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { @MainActor in
            if let store = PushNotificationCoordinator.shared.store {
                await store.refresh()
                store.syncAppIconBadge()
                completionHandler(.newData)
            } else {
                completionHandler(.noData)
            }
        }
    }
}
#endif
