import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

public struct SessionDetailView: View {
    @Bindable var store: AppStore
    public let session: UnifiedSession
    @Environment(\.dismiss) private var dismiss

    @State private var isPinnedToBottom: Bool = true
    @State private var distanceFromBottom: CGFloat = 0
    @State private var userIsDragging: Bool = false
    @State private var sendTrigger: Int = 0
    @State private var isLoadingEarlier: Bool = false
    @State private var scrollToBottomTrigger: Int = 0
    @State private var scrollPosition = ScrollPosition(edge: .bottom)
    @State private var anchoredSessionId: String? = nil
    @State private var suppressUnpinUntil: Date = .distantPast
    @State private var stableQueuedMessages: [QueuedMessageItem] = []
    @State private var composerHeight: CGFloat = 96
    @State private var isRenameAlertPresented: Bool = false
    @State private var renameDraft: String = "" 

    public init(store: AppStore, session: UnifiedSession) {
        self.store = store
        self.session = session
    }

    public var body: some View {
        let currentSession = store.sessions.first(where: { $0.id == session.id }) ?? session
        let transcript = store.transcriptsBySessionId[session.id]
        let messages = store.messages(for: session.id)
        let isLoadingInitialTranscript = (transcript == nil && messages.isEmpty)
        let liveActivity = transcript?.liveActivity
        let isBusy = store.isSessionBusy(session.id)
        let isStreaming = store.streamingMessagesBySessionId[session.id] != nil
        let availableModels: [HarnessModelOption] = {
            guard !currentSession.isMaster, let group = currentSession.harness.harnessGroup else { return [] }
            return store.catalog?.models(for: group) ?? []
        }()
        let currentModelOption: HarnessModelOption? = {
            guard !availableModels.isEmpty else { return nil }
            guard let currentId = currentSession.model else {
                return availableModels.first(where: { $0.isDefault == true }) ?? availableModels.first
            }
            return availableModels.first(where: { $0.id == currentId || $0.label == currentId })
        }()
        let availableReasoningLevels = currentSession.isMaster ? [] : (currentModelOption?.reasoningLevels ?? [])
        let harnessKind = currentSession.harness

        // Strict invariant: never show harness-internal transient steering handoffs (source == "native")
        // or items already in the main chat lane. Only explicitly queued messages (source != "native") appear.
        let filteredQueued: [QueuedMessageItem] = {
            guard let raw = liveActivity?.queuedMessages, !raw.isEmpty else { return [] }
            let loadedUserTexts: Set<String> = Set(
                messages.filter { $0.role == .user }.map { msg in
                    msg.blocks.compactMap { if case .text(let t) = $0 { return t }; return nil }
                        .joined(separator: "\n")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                }
            )
            return raw.filter { item in
                if item.source.lowercased() == "native" { return false }
                let trimmed = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
                return !trimmed.isEmpty && !loadedUserTexts.contains(trimmed)
            }
        }()
        let filteredQueuedKey = filteredQueued.map(\.id).joined(separator: "|")

        ZStack(alignment: .bottom) {
            ZStack(alignment: .top) {
                ZStack(alignment: .bottomTrailing) {
                    Group {
                    if isLoadingInitialTranscript {
                        // Bottom-aligned shimmering skeleton right above the floating composer
                        VStack(spacing: 0) {
                            Spacer(minLength: SHLayout.headerHeight)
                            TranscriptSkeletonView()
                                .padding(.horizontal, SHLayout.screenPad)
                                .padding(.bottom, max(composerHeight + 12, 108))
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(SHColor.surfaceCanvas)
                    } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: SHLayout.messageGap) {
                            // Top spacer so first message clears the floating Liquid Glass header pills.
                            Color.clear.frame(height: SHLayout.headerHeight)

                            if transcript?.hasMore == true {
                                loadEarlierButton
                            }

                            if messages.isEmpty {
                                emptyTranscriptView(for: currentSession)
                            } else {
                                ForEach(messages) { message in
                                    let pendingState = store.pendingDeliveryState(for: session.id, messageId: message.id)
                                    MessageBubbleView(
                                        message: message,
                                        sessionId: session.id,
                                        harness: harnessKind,
                                        pendingDeliveryState: pendingState,
                                        onAnswerQuestion: { answer in
                                            store.submitMessage(for: session.id, text: answer, attachments: [], mode: .steer)
                                            sendTrigger += 1
                                        },
                                        onTapImage: { payload in
                                            store.lightboxPayload = payload
                                        },
                                        onLoadMedia: { path in
                                            await store.loadMediaData(path: path, maxWidth: 320)
                                        },
                                        onRetryPending: {
                                            store.retryPendingMessage(for: session.id, messageId: message.id)
                                        }
                                    )
                                    .equatable()
                                    .id(message.id)
                                }
                            }

                            // Scrollable inline activity row — equalized 8pt rhythm below assistant blocks.
                            if let activity = liveActivity,
                               activity.isWorking || !(activity.steps?.isEmpty ?? true) || !(activity.runningTasks?.isEmpty ?? true) {
                                LiveStepsBarView(
                                    activity: activity,
                                    accentColor: SHColor.harness(currentSession.harness)
                                )
                                .padding(.top, messages.last?.role == .assistant ? -(SHLayout.messageGap - SHLayout.blockGap) : 0)
                            }

                            // Manually queued tray inside transcript (never native steering echoes).
                            if !stableQueuedMessages.isEmpty {
                                QueuedMessagesTrayView(items: stableQueuedMessages)
                            }

                            // Dynamic bottom clearance so last message clears the floating composer
                            // while scrolled content glides smoothly behind its rounded corners.
                            Color.clear
                                .frame(height: max(composerHeight + 10, 102))
                                .id("transcript-bottom")
                        }
                        .padding(.horizontal, SHLayout.screenPad)
                        .transaction { $0.animation = nil }
                    }
                    .accessibilityIdentifier("transcript.scroll")
                    .scrollPosition($scrollPosition)
                    .defaultScrollAnchor(.bottom, for: .initialOffset)
                    .defaultScrollAnchor(.bottom, for: .sizeChanges)
                    .scrollDismissesKeyboard(.never)
                    .background(SHColor.surfaceCanvas)
                    .onScrollPhaseChange { _, newPhase in
                        userIsDragging = (newPhase == .interacting || newPhase == .decelerating)
                    }
                    .onScrollGeometryChange(for: CGFloat.self) { geo in
                        max(0, geo.contentSize.height - geo.visibleRect.maxY)
                    } action: { oldDistance, newDistance in
                        distanceFromBottom = newDistance
                        if newDistance <= 80 {
                            if !isPinnedToBottom { isPinnedToBottom = true }
                        } else if newDistance > 220 && userIsDragging && newDistance > oldDistance + 0.5 && Date() >= suppressUnpinUntil {
                            if isPinnedToBottom { isPinnedToBottom = false }
                        }
                    }
                    .onAppear {
                        anchorBottomIfNeeded(sessionId: session.id, hasMessages: !messages.isEmpty)
                    }
                    .onChange(of: session.id) { _, newId in
                        anchoredSessionId = nil
                        isPinnedToBottom = true
                        distanceFromBottom = 0
                        userIsDragging = false
                        stableQueuedMessages = []
                        anchorBottomIfNeeded(sessionId: newId, hasMessages: !messages.isEmpty)
                    }
                    .onChange(of: messages.isEmpty) { _, isEmpty in
                        if !isEmpty {
                            anchorBottomIfNeeded(sessionId: session.id, hasMessages: true)
                        }
                    }
                    .onChange(of: messages.count) { oldCount, newCount in
                        guard newCount > oldCount, isPinnedToBottom, !userIsDragging else { return }
                        snapToBottomWithoutAnimation()
                    }
                    .onChange(of: sendTrigger) { _, _ in
                        suppressUnpinUntil = Date().addingTimeInterval(0.8)
                        userIsDragging = false
                        isPinnedToBottom = true
                        distanceFromBottom = 0
                        snapToBottomWithoutAnimation()
                    }
                    .onChange(of: scrollToBottomTrigger) { _, _ in
                        suppressUnpinUntil = Date().addingTimeInterval(0.8)
                        userIsDragging = false
                        isPinnedToBottom = true
                        distanceFromBottom = 0
                        withAnimation(.easeOut(duration: 0.22)) {
                            scrollPosition.scrollTo(edge: .bottom)
                        }
                    }
                    .task(id: filteredQueuedKey) {
                        stableQueuedMessages = filteredQueued
                    }
                    } // end else (!isLoadingInitialTranscript)
                    }
                    .task(id: session.id) {
                        isPinnedToBottom = true
                        distanceFromBottom = 0
                        userIsDragging = false
                        if let group = currentSession.harness.harnessGroup {
                            Task { await store.refreshCatalogIfNeeded(for: group) }
                        }
                        if store.transcriptsBySessionId[session.id] == nil {
                            await store.loadTranscript(for: session.id)
                        }
                        anchorBottomIfNeeded(sessionId: session.id, hasMessages: !store.messages(for: session.id).isEmpty)
                    }

                    // Floating "↓ Latest" pill — only shown when scrolled high up (>220pt).
                    let showLatestButton = !isPinnedToBottom && distanceFromBottom > 220 && !messages.isEmpty
                    Group {
                        if showLatestButton {
                            Button {
                                scrollToBottomTrigger += 1
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: "arrow.down")
                                        .font(.system(size: 11, weight: .bold))
                                    Text("Latest")
                                        .font(SHTypography.micro.weight(.semibold))
                                }
                                .foregroundStyle(SHColor.inkPrimary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(.ultraThinMaterial, in: Capsule())
                                .overlay(Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 0.75))
                                .shadow(color: Color.black.opacity(0.4), radius: 8, y: 3)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("transcript.latest")
                            .padding(.trailing, SHLayout.screenPad)
                            .padding(.bottom, max(composerHeight, 84) + 8)
                            .transition(.opacity.combined(with: .scale(scale: 0.92)))
                        }
                    }
                    .animation(.easeInOut(duration: 0.16), value: showLatestButton)
                }

                // Floating Liquid Glass Header Pills over subtle top fade
                floatingHeader(for: currentSession, isBusy: isBusy)
            }

            // Grounded Composer — ALWAYS anchored flush at bottom (above keyboard when open),
            // never floating with transcript bleeding underneath.
            ComposerView(
                session: currentSession,
                text: Binding(
                    get: { store.draftInputs[session.id] ?? "" },
                    set: { store.draftInputs[session.id] = $0 }
                ),
                attachments: store.draftAttachments[session.id] ?? [],
                uploadingAttachmentIds: store.uploadingAttachmentIds,
                availableModels: availableModels,
                reasoningLevels: availableReasoningLevels,
                isSending: false,
                isStreaming: isStreaming,
                isAgentBusy: isBusy,
                onPickPhotoData: { data, filename in
                    Task { await store.addAttachment(for: session.id, jpegData: data, filename: filename) }
                },
                onPickFileData: { data, mimeType, filename, previewData in
                    Task {
                        await store.addFileAttachment(
                            for: session.id,
                            data: data,
                            mimeType: mimeType,
                            filename: filename,
                            previewImageData: previewData
                        )
                    }
                },
                onRemoveAttachment: { attId in
                    store.removeAttachment(for: session.id, attachmentId: attId)
                },
                onTapAttachment: { att in
                    store.lightboxPayload = LightboxPayload(
                        title: att.name,
                        dataUrl: att.previewDataUrl,
                        path: att.path
                    )
                },
                onSelectModel: { modelOption in
                    let nextEffort: String?
                    if let levels = modelOption.reasoningLevels, !levels.isEmpty {
                        if let existing = currentSession.reasoningEffort, levels.contains(existing) {
                            nextEffort = existing
                        } else {
                            nextEffort = levels.last
                        }
                    } else {
                        nextEffort = nil
                    }
                    Task {
                        await store.setSessionModel(
                            sessionId: session.id,
                            model: modelOption.id,
                            reasoningEffort: nextEffort
                        )
                    }
                },
                onSelectReasoningEffort: { effort in
                    // For Antigravity, effort variants are sibling model slugs (e.g. gemini-4-neon-high -> gemini-4-neon-medium).
                    var targetModel = currentSession.model
                    if let raw = currentSession.model {
                        let suffixes = ["-low", "-medium", "-high", "-xhigh", "-max"]
                        let lower = raw.lowercased()
                        for suf in suffixes where lower.hasSuffix(suf) {
                            let candidate = String(raw.dropLast(suf.count)) + "-" + effort.lowercased()
                            if availableModels.contains(where: { $0.id.lowercased() == candidate.lowercased() }) {
                                targetModel = candidate
                            }
                            break
                        }
                    }
                    Task {
                        await store.setSessionModel(
                            sessionId: session.id,
                            model: targetModel,
                            reasoningEffort: effort
                        )
                    }
                },
                onTranscribeAudio: { wavData in
                    try await store.transcribeDictation(wavData: wavData)
                },
                onSend: { mode in
                    if store.submitMessage(for: session.id, mode: mode) != nil {
                        sendTrigger += 1
                    }
                },
                onAbort: {
                    Task { await store.abortRun(for: session.id) }
                }
            )
            .padding(.horizontal, SHSpacing.md)
            .padding(.top, SHSpacing.xs)
            .padding(.bottom, SHSpacing.sm)
            .background(alignment: .bottom) {
                LinearGradient(
                    stops: [
                        .init(color: SHColor.surfaceCanvas.opacity(0.0), location: 0.0),
                        .init(color: SHColor.surfaceCanvas.opacity(0.68), location: 0.42),
                        .init(color: SHColor.surfaceCanvas.opacity(0.95), location: 1.0),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .padding(.top, -18)
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
            }
            .onGeometryChange(for: CGFloat.self) { geo in
                geo.size.height
            } action: { newHeight in
                if abs(newHeight - composerHeight) > 0.5 {
                    composerHeight = newHeight
                }
            }
        }
        .background(SHColor.surfaceCanvas)
        .background(InteractivePopGestureEnabler())
        .toolbar(.hidden, for: .navigationBar)
        .alert("Rename Thread", isPresented: $isRenameAlertPresented) {
            TextField("Thread title", text: $renameDraft)
            Button("Save") {
                let nextTitle = renameDraft
                Task { await store.renameSession(currentSession, title: nextTitle) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    // MARK: - Floating Liquid Glass Top Chrome

    private func floatingHeader(for currentSession: UnifiedSession, isBusy: Bool) -> some View {
        HStack(spacing: 8) {
            SHGlassCircleButton(systemImage: "chevron.left", accessibilityLabel: "Back") {
                dismiss()
            }

            Spacer(minLength: 4)

            SHFloatingTitlePill(
                title: currentSession.displayTitle,
                harness: currentSession.harness
            ) {
                dismissKeyboard()
            }

            Spacer(minLength: 4)

            SHGlassActionCapsule(
                isBusy: isBusy,
                accentColor: SHColor.harness(currentSession.harness)
            ) {
                if !currentSession.isMaster {
                    Button {
                        renameDraft = currentSession.displayTitle
                        isRenameAlertPresented = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    Button {
                        Task { await store.togglePin(currentSession) }
                    } label: {
                        Label(currentSession.pinned ? "Unpin" : "Pin", systemImage: currentSession.pinned ? "pin.slash" : "pin")
                    }
                    Button {
                        Task { await store.togglePinToTop(currentSession) }
                    } label: {
                        Label(currentSession.pinnedToTop ? "Unpin from Top" : "Pin to Top", systemImage: "arrow.up.to.line")
                    }
                    Divider()
                }
                Button {
                    Task { await store.loadTranscript(for: session.id) }
                } label: {
                    Label("Refresh Transcript", systemImage: "arrow.clockwise")
                }
                if let group = currentSession.harness.harnessGroup {
                    Button {
                        store.openUsageSheet(for: group)
                    } label: {
                        Label("\(group.title) Usage", systemImage: "chart.bar.xaxis")
                    }
                }
                if !currentSession.isMaster {
                    Divider()
                    Button {
                        Task {
                            await store.toggleHideSession(currentSession)
                            dismiss()
                        }
                    } label: {
                        Label(currentSession.hidden ? "Unhide Session" : "Hide Session", systemImage: currentSession.hidden ? "eye" : "eye.slash")
                    }
                    Button(role: .destructive) {
                        Task {
                            await store.archiveSession(currentSession)
                            dismiss()
                        }
                    } label: {
                        Label("Archive Session", systemImage: "archivebox")
                    }
                }
            }
        }
        .padding(.horizontal, SHLayout.screenPad)
        .padding(.top, 6)
        .padding(.bottom, 10)
        .background(
            LinearGradient(
                colors: [
                    SHColor.surfaceCanvas.opacity(0.95),
                    SHColor.surfaceCanvas.opacity(0.72),
                    SHColor.surfaceCanvas.opacity(0.0),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
            .allowsHitTesting(false)
        )
    }

    // MARK: - Bottom Anchor Helpers

    private func anchorBottomIfNeeded(sessionId: String, hasMessages: Bool) {
        guard hasMessages, anchoredSessionId != sessionId else { return }
        anchoredSessionId = sessionId
        suppressUnpinUntil = Date().addingTimeInterval(0.6)
        isPinnedToBottom = true
        distanceFromBottom = 0
        snapToBottomWithoutAnimation()
        Task { @MainActor in
            await Task.yield()
            guard isPinnedToBottom, !userIsDragging else { return }
            snapToBottomWithoutAnimation()
        }
    }

    private func snapToBottomWithoutAnimation() {
        var tx = Transaction()
        tx.disablesAnimations = true
        withTransaction(tx) {
            scrollPosition.scrollTo(edge: .bottom)
        }
    }

    private func dismissKeyboard() {
        #if canImport(UIKit)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
    }

    private var loadEarlierButton: some View {
        HStack {
            Spacer()
            Button {
                guard !isLoadingEarlier else { return }
                Task {
                    isLoadingEarlier = true
                    defer { isLoadingEarlier = false }
                    await store.loadEarlierMessages(for: session.id)
                }
            } label: {
                HStack(spacing: 6) {
                    if isLoadingEarlier {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.up.circle")
                            .font(.system(size: 12))
                    }
                    Text(isLoadingEarlier ? "Loading earlier…" : "Load earlier messages")
                        .font(SHTypography.micro.weight(.medium))
                }
                .foregroundStyle(SHColor.inkSecondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(SHColor.surfaceSubtle, in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(isLoadingEarlier)
            Spacer()
        }
    }

    private func emptyTranscriptView(for currentSession: UnifiedSession) -> some View {
        VStack(spacing: SHSpacing.md) {
            HarnessLogoView(harness: currentSession.harness, size: 30)
            Text("Ready to collaborate")
                .font(SHTypography.heading)
                .foregroundStyle(SHColor.inkPrimary)
            Text("Send a message, voice note, or attach media below.")
                .font(SHTypography.caption)
                .foregroundStyle(SHColor.inkMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 56)
    }
}

// MARK: - Single Message Renderer with Trace & Thumbnail Coalescing

private struct MessageBubbleView: View, Equatable {
    let message: UnifiedMessage
    let sessionId: String
    let harness: HarnessKind
    let pendingDeliveryState: PendingOutgoingMessage.DeliveryState?
    let onAnswerQuestion: (String) -> Void
    let onTapImage: (LightboxPayload) -> Void
    let onLoadMedia: ((String) async -> Data?)?
    let onRetryPending: (() -> Void)?

    nonisolated static func == (lhs: MessageBubbleView, rhs: MessageBubbleView) -> Bool {
        lhs.message == rhs.message
            && lhs.sessionId == rhs.sessionId
            && lhs.harness == rhs.harness
            && lhs.pendingDeliveryState == rhs.pendingDeliveryState
    }

    var body: some View {
        Group {
            switch message.role {
            case .user:
                userMessageView
            case .assistant, .system:
                assistantMessageView
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message.\(message.id)")
        .onAppear {
            if message.id.hasPrefix("pending-") {
                PerfLogger.markPendingBubbleRendered(sessionId: sessionId, messageId: message.id)
            }
        }
    }

    private var userMessageView: some View {
        let imageItems: [SHAttachmentThumbItem] = message.blocks.enumerated().compactMap { idx, block in
            guard case .image(let path, let name, let dataUrl) = block else { return nil }
            let title = name ?? ((path as NSString).lastPathComponent.isEmpty ? "Image" : (path as NSString).lastPathComponent)
            return SHAttachmentThumbItem(
                id: "\(message.id)-img-\(idx)",
                name: title,
                path: path,
                mimeType: "image/jpeg",
                dataUrl: dataUrl
            )
        }
        let nonImageBlocks = message.blocks.filter {
            if case .image = $0 { return false }
            return true
        }

        return HStack {
            Spacer(minLength: 42)
            VStack(alignment: .trailing, spacing: 6) {
                if !imageItems.isEmpty {
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        SHAttachmentThumbStrip(
                            items: imageItems,
                            thumbSize: SHLayout.thumbSize,
                            onTap: { item in
                                onTapImage(LightboxPayload(title: item.name, dataUrl: item.dataUrl, path: item.path))
                            },
                            onLoadMedia: onLoadMedia
                        )
                        .fixedSize(horizontal: imageItems.count <= 3, vertical: false)
                    }
                }

                if !nonImageBlocks.isEmpty {
                    VStack(alignment: .trailing, spacing: SHLayout.blockGap) {
                        ForEach(Array(nonImageBlocks.enumerated()), id: \.offset) { _, block in
                            UnifiedBlockView(
                                block: block,
                                isUserBubble: true,
                                onAnswerQuestion: onAnswerQuestion,
                                onTapImage: onTapImage,
                                onLoadMedia: onLoadMedia
                            )
                            .equatable()
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(SHColor.surfaceBubble)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }

                if case .failed = pendingDeliveryState {
                    Button {
                        onRetryPending?()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "exclamationmark.circle.fill")
                                .font(.system(size: 10.5))
                            Text("Not delivered · Retry")
                                .font(SHTypography.micro.weight(.medium))
                        }
                        .foregroundStyle(SHColor.statusDanger)
                        .padding(.trailing, 4)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("message.retry")
                }
            }
        }
    }

    private var assistantMessageView: some View {
        let segments = CoalescedSegment.coalesce(message.blocks)
        let timestampLabel: String? = message.timestamp > 0 ? UsageMetrics.formatUpdatedAgo(message.timestamp) : nil
        let lastTraceIndex: Int? = segments.indices.last { idx in
            if case .traceGroup = segments[idx] { return true }
            return false
        }
        return VStack(alignment: .leading, spacing: SHLayout.blockGap) {
            ForEach(Array(segments.enumerated()), id: \.offset) { idx, segment in
                switch segment {
                case .single(let block):
                    UnifiedBlockView(
                        block: block,
                        isUserBubble: false,
                        onAnswerQuestion: onAnswerQuestion,
                        onTapImage: onTapImage,
                        onLoadMedia: onLoadMedia
                    )
                    .equatable()

                case .traceGroup(let traceBlocks):
                    CollapsedTraceGroupView(
                        blocks: traceBlocks,
                        trailingMeta: idx == lastTraceIndex ? timestampLabel : nil,
                        onAnswerQuestion: onAnswerQuestion,
                        onTapImage: onTapImage,
                        onLoadMedia: onLoadMedia
                    )
                    .equatable()

                case .imageGroup(let imgBlocks):
                    let items: [SHAttachmentThumbItem] = imgBlocks.enumerated().compactMap { idx, block in
                        guard case .image(let path, let name, let dataUrl) = block else { return nil }
                        let title = name ?? ((path as NSString).lastPathComponent.isEmpty ? "Image" : (path as NSString).lastPathComponent)
                        return SHAttachmentThumbItem(
                            id: "\(message.id)-aimg-\(idx)",
                            name: title,
                            path: path,
                            mimeType: "image/jpeg",
                            dataUrl: dataUrl
                        )
                    }
                    SHAttachmentThumbStrip(
                        items: items,
                        thumbSize: SHLayout.thumbSize,
                        onTap: { item in
                            onTapImage(LightboxPayload(title: item.name, dataUrl: item.dataUrl, path: item.path))
                        },
                        onLoadMedia: onLoadMedia
                    )
                }
            }
        }
    }
}


// MARK: - Native Left-Edge Swipe Back Gesture (Restored when Navigation Bar is Hidden)

#if canImport(UIKit)
private struct InteractivePopGestureEnabler: UIViewControllerRepresentable {
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        weak var navigationController: UINavigationController?

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let nav = navigationController else { return false }
            return nav.viewControllers.count > 1
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIViewController(context: Context) -> UIViewController {
        UIViewController()
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {
        DispatchQueue.main.async {
            guard let nav = uiViewController.navigationController else { return }
            context.coordinator.navigationController = nav
            nav.interactivePopGestureRecognizer?.isEnabled = true
            nav.interactivePopGestureRecognizer?.delegate = context.coordinator
        }
    }
}
#else
private struct InteractivePopGestureEnabler: View {
    var body: some View { EmptyView() }
}
#endif
