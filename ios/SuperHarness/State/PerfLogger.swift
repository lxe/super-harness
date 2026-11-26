import Foundation
import OSLog

/// Lightweight DEBUG-only performance logger using `Logger` and `OSSignposter`
/// (`subsystem: "com.lxe.superharness", category: "perf"`). Compiles to no-ops in Release builds.
@MainActor
public enum PerfLogger {
    #if DEBUG
    private static let logger = Logger(subsystem: "com.lxe.superharness", category: "perf")
    private static let signposter = OSSignposter(logger: logger)

    private static var lastSendAtBySessionId: [String: CFAbsoluteTime] = [:]
    private static var loggedFirstAssistantForSend: Set<String> = []
    private static var micTapAt: CFAbsoluteTime?
    private static var stopTapAt: CFAbsoluteTime?
    #endif

    public static func markSendTapped(sessionId: String) {
        #if DEBUG
        lastSendAtBySessionId[sessionId] = CFAbsoluteTimeGetCurrent()
        loggedFirstAssistantForSend.remove(sessionId)
        signposter.emitEvent("send_tapped", "\(sessionId, privacy: .public)")
        logger.debug("PERF mark=send_tapped session=\(sessionId, privacy: .public)")
        #endif
    }

    public static func markPendingBubbleRendered(sessionId: String, messageId: String) {
        #if DEBUG
        let elapsedMs = elapsedSinceSendMs(sessionId: sessionId)
        signposter.emitEvent("pending_bubble_rendered", "\(messageId, privacy: .public) elapsed_ms=\(elapsedMs)")
        logger.debug("PERF mark=pending_bubble_rendered session=\(sessionId, privacy: .public) id=\(messageId, privacy: .public) elapsed_ms=\(elapsedMs)")
        #endif
    }

    public static func markFirstTranscriptPushWithUserMessage(sessionId: String, pendingId: String) {
        #if DEBUG
        let elapsedMs = elapsedSinceSendMs(sessionId: sessionId)
        signposter.emitEvent("first_transcript_user_message", "\(pendingId, privacy: .public) elapsed_ms=\(elapsedMs)")
        logger.debug("PERF mark=first_transcript_user_message session=\(sessionId, privacy: .public) pending=\(pendingId, privacy: .public) elapsed_ms=\(elapsedMs)")
        #endif
    }

    public static func markFirstAssistantContentIfNeeded(sessionId: String) {
        #if DEBUG
        guard lastSendAtBySessionId[sessionId] != nil,
              !loggedFirstAssistantForSend.contains(sessionId) else {
            return
        }
        loggedFirstAssistantForSend.insert(sessionId)
        let elapsedMs = elapsedSinceSendMs(sessionId: sessionId)
        signposter.emitEvent("first_assistant_content", "\(sessionId, privacy: .public) elapsed_ms=\(elapsedMs)")
        logger.debug("PERF mark=first_assistant_content session=\(sessionId, privacy: .public) elapsed_ms=\(elapsedMs)")
        #endif
    }

    public static func markMicTapped() {
        #if DEBUG
        micTapAt = CFAbsoluteTimeGetCurrent()
        signposter.emitEvent("mic_tapped")
        logger.debug("PERF mark=mic_tapped")
        #endif
    }

    public static func markRecordingStarted() {
        #if DEBUG
        let elapsedMs = micTapAt.map { Int(((CFAbsoluteTimeGetCurrent() - $0) * 1000.0).rounded()) } ?? 0
        signposter.emitEvent("recording_started", "elapsed_ms=\(elapsedMs)")
        logger.debug("PERF mark=recording_started elapsed_ms=\(elapsedMs)")
        #endif
    }

    public static func markStopTapped() {
        #if DEBUG
        stopTapAt = CFAbsoluteTimeGetCurrent()
        signposter.emitEvent("stop_tapped")
        logger.debug("PERF mark=stop_tapped")
        #endif
    }

    public static func markTranscriptionReturned(charCount: Int) {
        #if DEBUG
        let elapsedMs = stopTapAt.map { Int(((CFAbsoluteTimeGetCurrent() - $0) * 1000.0).rounded()) } ?? 0
        signposter.emitEvent("transcription_returned", "elapsed_ms=\(elapsedMs) chars=\(charCount)")
        logger.debug("PERF mark=transcription_returned elapsed_ms=\(elapsedMs) chars=\(charCount)")
        #endif
    }

    #if DEBUG
    private static func elapsedSinceSendMs(sessionId: String) -> Int {
        guard let start = lastSendAtBySessionId[sessionId] else { return 0 }
        return max(0, Int(((CFAbsoluteTimeGetCurrent() - start) * 1000.0).rounded()))
    }
    #endif
}
