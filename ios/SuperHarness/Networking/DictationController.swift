import AVFoundation
import Foundation
import Observation

private struct UncheckedRecorderBox: @unchecked Sendable {
    let recorder: AVAudioRecorder
}

/// Serializes AVAudioSession and AVAudioRecorder hardware setup off the main thread
/// so UI state updates remain instantaneous and Bluetooth AirPods never flip into HFP call mode.
private final class DictationAudioCoordinator: @unchecked Sendable {
    static let shared = DictationAudioCoordinator()

    private let queue = DispatchQueue(label: "com.lxe.superharness.dictation-audio", qos: .userInitiated)
    private var isSessionConfigured = false
    private var activeGeneration: UInt64 = 0

    func startRecorder(fileURL: URL) async throws -> (UncheckedRecorderBox, UInt64) {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.activeGeneration &+= 1
                let generation = self.activeGeneration
                do {
                    let session = AVAudioSession.sharedInstance()
                    if !self.isSessionConfigured {
                        try session.setCategory(.record, mode: .default, options: [])
                        self.isSessionConfigured = true
                    }
                    try session.setActive(true)

                    let aacSettings: [String: Any] = [
                        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                        AVSampleRateKey: 16_000.0,
                        AVNumberOfChannelsKey: 1,
                        AVEncoderBitRateKey: 24_000,
                        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
                    ]
                    let wavSettings: [String: Any] = [
                        AVFormatIDKey: Int(kAudioFormatLinearPCM),
                        AVSampleRateKey: 16_000.0,
                        AVNumberOfChannelsKey: 1,
                        AVLinearPCMBitDepthKey: 16,
                        AVLinearPCMIsBigEndianKey: false,
                        AVLinearPCMIsFloatKey: false,
                    ]

                    var startedRecorder: AVAudioRecorder?
                    if let aacRecorder = try? AVAudioRecorder(url: fileURL, settings: aacSettings) {
                        aacRecorder.isMeteringEnabled = true
                        if aacRecorder.prepareToRecord(), aacRecorder.record() {
                            startedRecorder = aacRecorder
                        }
                    }
                    if startedRecorder == nil {
                        // Fallback to 16 kHz mono WAV if AAC encoder is unavailable (e.g. simulator audio device)
                        let fallbackURL = fileURL.deletingPathExtension().appendingPathExtension("wav")
                        let wavRecorder = try AVAudioRecorder(url: fallbackURL, settings: wavSettings)
                        wavRecorder.isMeteringEnabled = true
                        wavRecorder.prepareToRecord()
                        guard wavRecorder.record() else {
                            try? session.setActive(false, options: .notifyOthersOnDeactivation)
                            throw NSError(
                                domain: "DictationController",
                                code: -1,
                                userInfo: [NSLocalizedDescriptionKey: "Unable to start audio recording."]
                            )
                        }
                        startedRecorder = wavRecorder
                    }

                    continuation.resume(returning: (UncheckedRecorderBox(recorder: startedRecorder!), generation))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func deactivateInBackground(generation: UInt64?) {
        queue.async {
            if let generation, generation != self.activeGeneration {
                return
            }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}

/// Records 16 kHz mono 16-bit PCM WAV audio on iOS and sends it to the host's
/// YapYap dictation proxy (`/api/dictate`).
@MainActor
@Observable
public final class DictationController {
    public enum State: Equatable, Sendable {
        case idle
        case recording
        case transcribing
    }

    public var state: State = .idle
    public var elapsedSeconds: TimeInterval = 0
    public var normalizedLevel: CGFloat = 0
    /// The most recent mic levels (0...1), oldest first, smoothed for the live level bars.
    public var levelHistory: [CGFloat] = DictationController.silentHistory

    public nonisolated static let levelBarCount = 7

    /// Maps recorder power (dBFS) to a 0...1 bar level. Everything quieter than -38 dB (room
    /// noise, a fan, distant talk) reads as zero, and the curve keeps low levels small so the
    /// bars move for a voice near the phone and stay nearly flat otherwise.
    public nonisolated static func displayLevel(decibels: Float) -> CGFloat {
        let floorDb: Float = -38
        let ceilingDb: Float = -6
        let linear = (max(floorDb, min(ceilingDb, decibels)) - floorDb) / (ceilingDb - floorDb)
        return CGFloat(pow(Double(linear), 1.6))
    }
    public nonisolated static let silentHistory = [CGFloat](repeating: 0, count: 7)

    /// Shifts a new mic level into the history. A rising level is followed quickly and a
    /// falling one decays slowly, the same response the YapYap keyboard's waveform uses.
    public nonisolated static func advancing(_ history: [CGFloat], with level: CGFloat) -> [CGFloat] {
        let clamped = max(0, min(1, level))
        let previous = history.last ?? 0
        let response: CGFloat = clamped > previous ? 0.78 : 0.36
        var next = Array(history.dropFirst())
        next.append(previous + (clamped - previous) * response)
        return next
    }
    public var errorMessage: String?

    private static var cachedMicPermissionGranted: Bool = false

    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?
    private var activeGeneration: UInt64?
    private var activeSessionToken: UUID?
    private var startTask: Task<Bool, Never>?
    private var startedAt: Date?
    private var meterTask: Task<Void, Never>?

    public init() {}

    public var formattedDuration: String {
        let total = max(0, Int(elapsedSeconds.rounded(.down)))
        let mins = total / 60
        let secs = total % 60
        return String(format: "%d:%02d", mins, secs)
    }

    /// `prewarm` runs in the background the moment recording starts, so the caller can open the
    /// network path to the dictation server while the user is still speaking.
    public func toggleRecording(
        prewarm: (@MainActor () async -> Void)? = nil,
        transcribe: @escaping (Data) async throws -> String
    ) async -> String? {
        switch state {
        case .idle:
            if let prewarm {
                Task { await prewarm() }
            }
            await startRecording()
            return nil
        case .recording:
            return await stopAndTranscribe(transcribe: transcribe)
        case .transcribing:
            return nil
        }
    }

    public func startRecording() async {
        guard state == .idle else { return }
        PerfLogger.markMicTapped()
        errorMessage = nil

        // Fast-path cached/already-granted permission check without suspending.
        if !Self.cachedMicPermissionGranted {
            switch AVAudioApplication.shared.recordPermission {
            case .granted:
                Self.cachedMicPermissionGranted = true
            case .denied:
                errorMessage = "Microphone access denied. Enable Microphone in iOS Settings."
                return
            case .undetermined:
                break
            @unknown default:
                break
            }
        }

        // Optimistically switch to recording UI immediately on tap.
        let token = UUID()
        // Must use .m4a extension so CoreAudio allows kAudioFormatMPEG4AAC instead of failing over to WAV.
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("sh-dictation-\(token.uuidString).m4a")

        activeSessionToken = token
        recordingURL = fileURL
        startedAt = Date()
        elapsedSeconds = 0
        normalizedLevel = 0
        levelHistory = Self.silentHistory
        state = .recording
        startMeterLoop()

        let task = Task<Bool, Never> { [weak self] in
            guard let self else { return false }
            if !Self.cachedMicPermissionGranted {
                let granted = await self.requestMicrophonePermission()
                guard self.activeSessionToken == token else { return false }
                guard granted else {
                    self.rollbackFailedStart(token: token, message: "Microphone access denied. Enable Microphone in iOS Settings.")
                    return false
                }
                Self.cachedMicPermissionGranted = true
            }

            do {
                let (box, generation) = try await DictationAudioCoordinator.shared.startRecorder(fileURL: fileURL)
                guard self.activeSessionToken == token else {
                    box.recorder.stop()
                    try? FileManager.default.removeItem(at: fileURL)
                    DictationAudioCoordinator.shared.deactivateInBackground(generation: generation)
                    return false
                }
                self.recorder = box.recorder
                self.recordingURL = box.recorder.url
                self.activeGeneration = generation
                PerfLogger.markRecordingStarted()
                return true
            } catch {
                self.rollbackFailedStart(token: token, message: error.localizedDescription)
                return false
            }
        }

        startTask = task
        _ = await task.value
    }

    public func stopAndTranscribe(transcribe: @escaping (Data) async throws -> String) async -> String? {
        guard state == .recording else { return nil }
        PerfLogger.markStopTapped()
        meterTask?.cancel()
        meterTask = nil

        let pendingStart = startTask
        startTask = nil
        if recorder == nil, let pendingStart {
            _ = await pendingStart.value
        }

        let generation = activeGeneration
        activeGeneration = nil
        activeSessionToken = nil

        recorder?.stop()
        recorder = nil

        #if DEBUG
        let debugTestWavData: Data? = {
            guard let path = ProcessInfo.processInfo.environment["SH_DICTATION_TEST_WAV"]?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                  !path.isEmpty,
                  let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
                  data.count > 44 else {
                return nil
            }
            return data
        }()
        #else
        let debugTestWavData: Data? = nil
        #endif

        guard let fileURL = recordingURL else {
            DictationAudioCoordinator.shared.deactivateInBackground(generation: generation)
            if let debugTestWavData {
                return await runTranscription(wavData: debugTestWavData, transcribe: transcribe)
            }
            state = .idle
            elapsedSeconds = 0
            normalizedLevel = 0
            return nil
        }

        // Read WAV immediately and kick off upload while deactivating audio session in the background.
        var wavData: Data
        do {
            wavData = try Data(contentsOf: fileURL)
        } catch {
            cleanupRecordingFile()
            DictationAudioCoordinator.shared.deactivateInBackground(generation: generation)
            if let debugTestWavData {
                return await runTranscription(wavData: debugTestWavData, transcribe: transcribe)
            }
            errorMessage = "Failed to read recorded audio."
            state = .idle
            elapsedSeconds = 0
            normalizedLevel = 0
            return nil
        }
        cleanupRecordingFile()
        DictationAudioCoordinator.shared.deactivateInBackground(generation: generation)

        if let debugTestWavData {
            wavData = debugTestWavData
        }

        guard wavData.count > 128 else {
            state = .idle
            elapsedSeconds = 0
            normalizedLevel = 0
            return nil
        }

        return await runTranscription(wavData: wavData, transcribe: transcribe)
    }

    private func runTranscription(
        wavData: Data,
        transcribe: @escaping (Data) async throws -> String
    ) async -> String? {
        state = .transcribing
        normalizedLevel = 0
        defer {
            state = .idle
            elapsedSeconds = 0
        }

        do {
            let text = try await transcribe(wavData)
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            PerfLogger.markTranscriptionReturned(charCount: trimmed.count)
            if trimmed.isEmpty {
                errorMessage = "No speech detected."
                return nil
            }
            return trimmed
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    public func cancel() {
        let generation = activeGeneration
        activeGeneration = nil
        activeSessionToken = nil
        startTask?.cancel()
        startTask = nil
        meterTask?.cancel()
        meterTask = nil
        recorder?.stop()
        recorder = nil
        cleanupRecordingFile()
        DictationAudioCoordinator.shared.deactivateInBackground(generation: generation)
        state = .idle
        elapsedSeconds = 0
        normalizedLevel = 0
    }

    private func rollbackFailedStart(token: UUID, message: String) {
        guard activeSessionToken == token else { return }
        activeSessionToken = nil
        startTask = nil
        meterTask?.cancel()
        meterTask = nil
        recorder?.stop()
        recorder = nil
        cleanupRecordingFile()
        errorMessage = message
        state = .idle
        elapsedSeconds = 0
        normalizedLevel = 0
    }

    private func startMeterLoop() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 70_000_000)
                guard !Task.isCancelled, let self, self.state == .recording else { break }
                if let startedAt = self.startedAt {
                    self.elapsedSeconds = Date().timeIntervalSince(startedAt)
                }
                if let rec = self.recorder {
                    rec.updateMeters()
                    let db = rec.averagePower(forChannel: 0)
                    self.normalizedLevel = Self.displayLevel(decibels: db)
                }
                #if DEBUG
                // The Simulator records silence; SH_DICTATION_FAKE_LEVELS drives the bars for UI checks.
                if ProcessInfo.processInfo.environment["SH_DICTATION_FAKE_LEVELS"] != nil {
                    self.normalizedLevel = CGFloat(abs(sin(self.elapsedSeconds * 9.0)) * (0.45 + 0.55 * abs(sin(self.elapsedSeconds * 2.3))))
                }
                #endif
                self.levelHistory = Self.advancing(self.levelHistory, with: self.normalizedLevel)
            }
        }
    }

    private func cleanupRecordingFile() {
        if let url = recordingURL {
            try? FileManager.default.removeItem(at: url)
            recordingURL = nil
        }
    }

    private func requestMicrophonePermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
