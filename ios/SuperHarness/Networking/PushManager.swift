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
    public static let defaultRelayURL = "https://super-harness-push.lxe-sh.workers.dev"
    public static let bgRefreshTaskId = "com.lxe.superharness.refresh"

    public weak var store: AppStore?
    public private(set) var lastDeviceTokenHex: String?
    public private(set) var lastRegistrationStatus: String = "Not registered"

    private var hasRegisteredBGTask = false

    public func configure(store: AppStore) {
        self.store = store
        #if canImport(UIKit)
        UNUserNotificationCenter.current().delegate = self
        #endif
        registerBackgroundRefreshIfNeeded()
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
        await store.registerPushDeviceOnHost(rid: rid, relayUrl: relayBase, enabled: store.pushNotificationsEnabled)
    }
}

#if canImport(UIKit)
extension PushNotificationCoordinator: UNUserNotificationCenterDelegate {
    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        if let sessionId = userInfo["sessionId"] as? String, !sessionId.isEmpty {
            await MainActor.run {
                PushNotificationCoordinator.shared.store?.selectSession(sessionId)
            }
        }
    }
}

public final class SuperHarnessAppDelegate: NSObject, UIApplicationDelegate {
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
                completionHandler(.newData)
            } else {
                completionHandler(.noData)
            }
        }
    }
}
#endif
