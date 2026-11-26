import SwiftUI

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
    /// Brief window after our own programmatic scroll (send / Latest) during which momentum
    /// from a previous fling can never unpin the transcript.
    @State private var suppressUnpinUntil: Date = .distantPast

    public init(store: AppStore, session: UnifiedSession) {
        self.store = store
        self.session = session
    }

    public var body: some View {
        // Compute currentSession once per body evaluation (never inside per-message loops).
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

        ZStack(alignment: .bottomTrailing) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    metadataHeaderStrip(for: currentSession)

                    if transcript?.hasMore == true {
                        loadEarlierButton
                    }

                    if isLoadingInitialTranscript {
                        TranscriptSkeletonView()
                    } else if messages.isEmpty {
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
                                    store.submitMessage(for: session.id, text: answer, attachments: [])
                                    sendTrigger += 1
                                },
                                onTapImage: { payload in
                                    store.lightboxPayload = payload
                                },
                                onLoadMedia: { path in
                                    await store.loadMediaData(path: path)
                                },
                                onRetryPending: {
                                    store.retryPendingMessage(for: session.id, messageId: message.id)
                                }
                            )
                            .equatable()
                            .id(message.id)
                        }
                    }

                    if let activity = liveActivity,
                       activity.isWorking || !(activity.steps?.isEmpty ?? true) || !(activity.runningTasks?.isEmpty ?? true) {
                        LiveStepsBarView(
                            activity: activity,
                            accentColor: SHColor.harness(currentSession.harness)
                        )
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("transcript-bottom")
                }
                .padding(.horizontal, SHSpacing.lg)
                .padding(.top, SHSpacing.md)
                .padding(.bottom, SHSpacing.lg)
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
            // Measure exact content distance below the visible viewport using visibleRect
            // (avoids double-counting safeAreaInset bottom height).
            .onScrollGeometryChange(for: CGFloat.self) { geo in
                max(0, geo.contentSize.height - geo.visibleRect.maxY)
            } action: { oldDistance, newDistance in
                distanceFromBottom = newDistance
                if newDistance <= 80 {
                    if !isPinnedToBottom { isPinnedToBottom = true }
                } else if newDistance > 220 && userIsDragging && newDistance > oldDistance + 0.5 && Date() >= suppressUnpinUntil {
                    // Only a user gesture scrolling meaningfully up into history unpins.
                    if isPinnedToBottom { isPinnedToBottom = false }
                }
            }
            .onChange(of: messages.count) { oldCount, newCount in
                guard newCount > oldCount, isPinnedToBottom, !userIsDragging else { return }
                scrollPosition.scrollTo(edge: .bottom)
            }
            .onChange(of: sendTrigger) { _, _ in
                suppressUnpinUntil = Date().addingTimeInterval(0.8)
                userIsDragging = false
                isPinnedToBottom = true
                distanceFromBottom = 0
                scrollPosition.scrollTo(edge: .bottom)
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
            .task(id: session.id) {
                isPinnedToBottom = true
                distanceFromBottom = 0
                userIsDragging = false
                if store.transcriptsBySessionId[session.id] == nil {
                    await store.loadTranscript(for: session.id)
                }
            }

            // Floating "↓ Latest" pill — appears only when scrolled >220pt up into history;
            // automatically hides as soon as the user scrolls within 80pt of the bottom or taps it.
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
                        .background(SHColor.surfacePopover.opacity(0.95))
                        .clipShape(Capsule())
                        .shadow(color: Color.black.opacity(0.4), radius: 8, y: 3)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("transcript.latest")
                    .padding(.trailing, SHSpacing.lg)
                    .padding(.bottom, SHSpacing.sm)
                    .transition(.opacity.combined(with: .scale(scale: 0.92)))
                }
            }
            .animation(.easeInOut(duration: 0.16), value: showLatestButton)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: SHSpacing.sm) {
                if let queued = liveActivity?.queuedMessages, !queued.isEmpty {
                    QueuedMessagesTrayView(items: queued)
                        .padding(.horizontal, SHSpacing.md)
                }

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
                            if let cur = currentSession.reasoningEffort, levels.contains(cur) {
                                nextEffort = cur
                            } else {
                                nextEffort = modelOption.defaultReasoningLevel ?? levels.last
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
                        Task {
                            await store.setSessionModel(
                                sessionId: session.id,
                                model: currentSession.model,
                                reasoningEffort: effort
                            )
                        }
                    },
                    onTranscribeAudio: { wavData in
                        try await store.transcribeDictation(wavData: wavData)
                    },
                    onSend: {
                        if store.submitMessage(for: session.id) != nil {
                            sendTrigger += 1
                        }
                    },
                    onAbort: {
                        Task { await store.abortRun(for: session.id) }
                    }
                )
                .padding(.horizontal, SHSpacing.md)
                .padding(.bottom, SHSpacing.sm)
                .padding(.top, SHSpacing.xs)
            }
            .background(
                LinearGradient(
                    colors: [SHColor.surfaceCanvas.opacity(0.0), SHColor.surfaceCanvas.opacity(0.96), SHColor.surfaceCanvas],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
        }
        .navigationTitle(currentSession.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    #if canImport(UIKit)
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    #endif
                }
                .font(SHTypography.micro.weight(.semibold))
                .foregroundStyle(SHColor.inkSecondary)
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(SHColor.harness(currentSession.harness))
                }
                Menu {
                    if !currentSession.isMaster {
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
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(SHColor.inkSecondary)
                }
            }
        }
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
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.up.circle")
                            .font(.system(size: 12))
                    }
                    Text(isLoadingEarlier ? "Loading earlier…" : "Load earlier messages")
                        .font(SHTypography.micro.weight(.medium))
                }
                .foregroundStyle(SHColor.inkMuted)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(SHColor.surfaceSubtle)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(isLoadingEarlier)
            Spacer()
        }
    }

    private func metadataHeaderStrip(for currentSession: UnifiedSession) -> some View {
        let vis = HarnessVisual.forKind(currentSession.harness)
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: SHSpacing.sm) {
                HStack(spacing: 6) {
                    HarnessLogoView(harness: currentSession.harness, size: 13)
                    Text(vis.label)
                        .font(SHTypography.micro.weight(.semibold))
                        .foregroundStyle(vis.color)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(vis.color.opacity(0.12))
                .clipShape(Capsule())

                if let model = currentSession.model, !model.isEmpty {
                    metaChip(icon: "cpu", text: model)
                }

                if let branch = currentSession.gitBranch, !branch.isEmpty {
                    metaChip(icon: "arrow.triangle.branch", text: branch)
                }

                if let project = SessionRowFormatting.cleanProjectName(for: currentSession) {
                    metaChip(icon: "folder", text: project)
                }

                if let tmux = currentSession.tmuxTarget ?? currentSession.tmuxSessionName, !tmux.isEmpty {
                    metaChip(icon: "terminal", text: tmux)
                }
            }
        }
    }

    private func metaChip(icon: String, text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(SHColor.inkFaint)
            Text(text)
                .font(SHTypography.micro)
                .foregroundStyle(SHColor.inkMuted)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(SHColor.surfaceSubtle)
        .clipShape(Capsule())
    }

    private func emptyTranscriptView(for currentSession: UnifiedSession) -> some View {
        VStack(spacing: SHSpacing.md) {
            HarnessLogoView(harness: currentSession.harness, size: 32)
            Text("Ready to collaborate")
                .font(SHTypography.heading)
                .foregroundStyle(SHColor.inkPrimary)
            Text("Send a prompt or attach a screenshot below.")
                .font(SHTypography.caption)
                .foregroundStyle(SHColor.inkMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 56)
    }
}

// MARK: - Single Message Renderer with Trace Coalescing

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
        HStack {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 5) {
                VStack(alignment: .trailing, spacing: SHSpacing.sm) {
                    ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
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
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background(SHColor.surfaceBubble)
                .clipShape(RoundedRectangle(cornerRadius: SHRadius.xl, style: .continuous))

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
        return VStack(alignment: .leading, spacing: SHSpacing.md) {
            // Subtle speaker header
            HStack(spacing: 7) {
                HarnessLogoView(harness: harness, size: 14)
                Text(message.harnessMeta?.model ?? HarnessVisual.forKind(harness).label)
                    .font(SHTypography.micro.weight(.semibold))
                    .foregroundStyle(SHColor.inkSecondary)
                if message.streaming == true {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(SHColor.harness(harness))
                }
                Spacer()
                if message.timestamp > 0 {
                    Text(UsageMetrics.formatUpdatedAgo(message.timestamp))
                        .font(SHTypography.micro)
                        .foregroundStyle(SHColor.inkFaint)
                }
            }

            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
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
                case .traceGroup(let blocks):
                    CollapsedTraceGroupView(
                        blocks: blocks,
                        onAnswerQuestion: onAnswerQuestion,
                        onTapImage: onTapImage,
                        onLoadMedia: onLoadMedia
                    )
                    .equatable()
                }
            }

            if let err = message.error, !err.isEmpty {
                HStack(spacing: 7) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(SHColor.statusDanger)
                    Text(err)
                        .font(SHTypography.caption)
                        .foregroundStyle(SHColor.statusDanger)
                }
                .padding(12)
                .background(SHColor.statusDanger.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
            }
        }
    }
}
