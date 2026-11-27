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
    @State private var isNewFolderAlertPresented: Bool = false
    @State private var newFolderDraft: String = ""
    @State private var isThreadInfoExpanded: Bool = false
    private static var usesGlassPopover: Bool {
        if #available(iOS 26.0, *) { return true }
        return false
    }

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
            return availableModels.first(where: { $0.matches(currentId) })
        }()
        let availableReasoningLevels = currentSession.isMaster ? [] : ReasoningEffortPolicy.offered(
            currentModelOption?.reasoningLevels ?? [],
            allowExtreme: store.allowExtremeReasoning,
            keeping: currentSession.reasoningEffort
        )
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
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if isLoadingInitialTranscript {
                        // Bottom-aligned shimmering skeleton right above the floating composer
                        VStack(spacing: 0) {
                            Spacer(minLength: 16)
                            TranscriptSkeletonView()
                                .padding(.horizontal, SHLayout.screenPad)
                                .padding(.bottom, max(composerHeight + 12, 108))
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(SHColor.surfaceCanvas)
                    } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: store.chatMetrics.messageGap) {
                            Color.clear.frame(height: 8)

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
                                        },
                                        onDismissPending: {
                                            store.dismissPendingMessage(for: session.id, messageId: message.id)
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
                                .padding(.top, messages.last?.role == .assistant ? -(store.chatMetrics.messageGap - store.chatMetrics.blockGap) : 0)
                            }

                            // A problem with this session (the harness failed, the transcript
                            // could not load) is shown here, in its thread.
                            if let notice = store.sessionNotices[session.id] {
                                SessionNoticeRow(notice: notice) { store.dismissSessionNotice(for: session.id) }
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
                    .modifier(SHClearTopScrollEdgeModifier())
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
                        } else if newDistance > 180 && userIsDragging && Date() >= suppressUnpinUntil {
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

                    // Floating scroll-to-bottom button, centered above the composer. It depends on
                    // the pinned flag as well as the distance: while the transcript follows new
                    // output it stays hidden, so growing content at the bottom cannot flash it.
                    let showLatestButton = !isPinnedToBottom && distanceFromBottom > 180 && !messages.isEmpty
                    Group {
                        if showLatestButton {
                            Button {
                                scrollToBottomTrigger += 1
                            } label: {
                                Image(systemName: "arrow.down")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(SHColor.inkPrimary)
                                    .frame(width: 38, height: 38)
                                    .modifier(ScrollToBottomSurface())
                                    .contentShape(Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Scroll to bottom")
                            .accessibilityIdentifier("transcript.latest")
                            .padding(.bottom, max(composerHeight, 84) + 10)
                            .transition(.opacity.combined(with: .scale(scale: 0.9)))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .animation(.easeInOut(duration: 0.16), value: showLatestButton)
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
                harnessDefaultEffort: HarnessGroup(rawValue: currentSession.harnessGroup.rawValue).flatMap { store.catalog?.defaultReasoning(for: $0) },
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
                dictationUnavailableReason: store.dictationUnavailableReason,
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
                    let resolved = ComposerView.resolveModelSelection(
                        picked: modelOption,
                        currentEffort: currentSession.reasoningEffort,
                        availableModels: availableModels,
                        allowExtreme: store.allowExtremeReasoning
                    )
                    Task {
                        await store.setSessionModel(
                            sessionId: session.id,
                            model: resolved.modelId,
                            reasoningEffort: resolved.effort
                        )
                    }
                },
                onSelectReasoningEffort: { effort in
                    let resolved = ComposerView.resolveEffortSelection(
                        effort: effort,
                        currentModel: currentSession.model,
                        availableModels: availableModels
                    )
                    Task {
                        await store.setSessionModel(
                            sessionId: session.id,
                            model: resolved.modelId,
                            reasoningEffort: resolved.effort
                        )
                    }
                },
                onTranscribeAudio: { wavData in
                    try await store.transcribeDictation(wavData: wavData)
                },
                onDictationStart: {
                    await store.prewarmDictation()
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
        .environment(\.shChatMetrics, store.chatMetrics)
        .overlay(alignment: .top) {
            // Before iOS 26 the card drops in below the bar. On iOS 26 it is a Liquid Glass
            // popover that grows out of the title pill (see the toolbar below).
            if isThreadInfoExpanded, !Self.usesGlassPopover {
                ZStack(alignment: .top) {
                    Color.black.opacity(0.32)
                        .ignoresSafeArea()
                        .onTapGesture {
                            withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                                isThreadInfoExpanded = false
                            }
                        }

                    ThreadInfoTopSheet(
                        session: currentSession,
                        stats: transcript?.stats,
                        messageCount: transcript?.totalCount ?? messages.count,
                        isBusy: isBusy,
                        accentTint: store.gaugeTint(for: currentSession.harness),
                        onDismiss: {
                            withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                                isThreadInfoExpanded = false
                            }
                        }
                    )
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
                .zIndex(40)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button {
                    dismissKeyboard()
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                        isThreadInfoExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        HarnessLogoView(harness: currentSession.harness, size: 14)
                        Text(currentSession.displayTitle)
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(SHColor.inkPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8.5, weight: .semibold))
                            .foregroundStyle(SHColor.inkFaint)
                            .rotationEffect(.degrees(isThreadInfoExpanded ? 180 : 0))
                    }
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    .shGlassSurface(in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(currentSession.displayTitle)
                .accessibilityHint("Tap to show thread summary, duration, host, and token usage")
                .accessibilityIdentifier("thread.header.pill")
                .popover(
                    isPresented: Binding(
                        get: { isThreadInfoExpanded && Self.usesGlassPopover },
                        set: { if !$0 { isThreadInfoExpanded = false } }
                    ),
                    attachmentAnchor: .rect(.bounds),
                    arrowEdge: .top
                ) {
                    ThreadInfoTopSheet(
                        session: currentSession,
                        stats: transcript?.stats,
                        messageCount: transcript?.totalCount ?? messages.count,
                        isBusy: isBusy,
                        accentTint: store.gaugeTint(for: currentSession.harness),
                        drawsOwnSurface: false,
                        onDismiss: { isThreadInfoExpanded = false }
                    )
                    .frame(width: 350)
                    .presentationCompactAdaptation(.popover)
                }
            }

            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    sessionActionMenuItems(for: currentSession)
                } label: {
                    if isBusy {
                        SHActivityPulse(tint: store.gaugeTint(for: currentSession.harness), size: 11)
                            .frame(width: 22, height: 22)
                    } else {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(SHColor.inkPrimary)
                    }
                }
                .accessibilityLabel("Session actions")
            }
        }
        .alert(
            "Can’t Attach File",
            isPresented: Binding(
                get: { store.attachmentNotice != nil },
                set: { if !$0 { store.attachmentNotice = nil } }
            )
        ) {
            Button("OK", role: .cancel) { store.attachmentNotice = nil }
        } message: {
            Text(store.attachmentNotice ?? "")
        }
        .alert("Rename Thread", isPresented: $isRenameAlertPresented) {
            TextField("Thread title", text: $renameDraft)
            Button("Save") {
                let nextTitle = renameDraft
                Task { await store.renameSession(currentSession, title: nextTitle) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("New Folder", isPresented: $isNewFolderAlertPresented) {
            TextField("Folder name", text: $newFolderDraft)
            Button("Create & Move") {
                let name = newFolderDraft
                newFolderDraft = ""
                let color = AppStore.defaultFolderColors[store.folders.count % AppStore.defaultFolderColors.count]
                Task {
                    await store.createFolderAndAssign(sessionId: currentSession.id, name: name, color: color)
                }
            }
            Button("Cancel", role: .cancel) {
                newFolderDraft = ""
            }
        }
    }

    // MARK: - Native Toolbar Action Menu

    @ViewBuilder
    private func sessionActionMenuItems(for currentSession: UnifiedSession) -> some View {
        if !currentSession.isMaster {
            Button {
                renameDraft = currentSession.displayTitle
                isRenameAlertPresented = true
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Menu {
                ForEach(store.folders.sorted(by: { $0.order < $1.order })) { folder in
                    Button {
                        Task { await store.assignFolder(sessionId: currentSession.id, folderId: folder.id) }
                    } label: {
                        if currentSession.folderId == folder.id {
                            Label(folder.name, systemImage: "checkmark")
                        } else {
                            Label(folder.name, systemImage: "folder")
                        }
                    }
                }
                if !store.folders.isEmpty {
                    Divider()
                }
                Button {
                    newFolderDraft = ""
                    isNewFolderAlertPresented = true
                } label: {
                    Label("New Folder…", systemImage: "folder.badge.plus")
                }
                if currentSession.folderId != nil {
                    Button(role: .destructive) {
                        Task { await store.assignFolder(sessionId: currentSession.id, folderId: nil) }
                    } label: {
                        Label("Remove from Folder", systemImage: "folder.badge.minus")
                    }
                }
            } label: {
                Label("Move to Folder", systemImage: "folder")
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
                        SHActivityPulse(tint: SHColor.inkSecondary, size: 14)
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
    @Environment(\.shChatMetrics) private var metrics
    let message: UnifiedMessage
    let sessionId: String
    let harness: HarnessKind
    let pendingDeliveryState: PendingOutgoingMessage.DeliveryState?
    let onAnswerQuestion: (String) -> Void
    let onTapImage: (LightboxPayload) -> Void
    let onLoadMedia: ((String) async -> Data?)?
    let onRetryPending: (() -> Void)?
    var onDismissPending: (() -> Void)? = nil

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
                if pendingDeliveryState == nil, let injected = InjectedMessageInfo.classify(message) {
                    InjectedMessageView(info: injected)
                } else {
                    userMessageView
                }
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
                    ExpandableUserBubbleContent(
                        blocks: nonImageBlocks,
                        onAnswerQuestion: onAnswerQuestion,
                        onTapImage: onTapImage,
                        onLoadMedia: onLoadMedia
                    )
                }

                if case .failed(let reason) = pendingDeliveryState {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 10.5))
                        Text("Not delivered ·")
                        Button("Retry") { onRetryPending?() }
                            .buttonStyle(.plain)
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                            .accessibilityIdentifier("message.retry")
                        Text("·")
                        Button("Dismiss") { onDismissPending?() }
                            .buttonStyle(.plain)
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                            .accessibilityIdentifier("message.dismiss")
                    }
                    .font(SHTypography.micro.weight(.medium))
                    .foregroundStyle(SHColor.statusDanger)
                    .padding(.trailing, 4)

                    // Why it was not delivered, in the host's or harness's own words.
                    if !reason.isEmpty, reason != "Message not delivered" {
                        Text(SHErrorPresentation.friendlyMessage(for: reason))
                            .font(SHTypography.micro)
                            .foregroundStyle(SHColor.statusDanger.opacity(0.85))
                            .multilineTextAlignment(.trailing)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.trailing, 4)
                            .accessibilityIdentifier("message.failureReason")
                    }
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
        return VStack(alignment: .leading, spacing: metrics.blockGap) {
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

/// A problem with one session, shown inside its thread: what went wrong in a sentence, the raw
/// error behind a chevron, and Dismiss. It uses the look of the failed-send line.
struct SessionNoticeRow: View {
    let notice: AppStore.SessionNotice
    let onDismiss: () -> Void
    @State private var showsDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 12))
                Text(notice.message)
                    .font(SHTypography.caption.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if notice.detail != notice.message {
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) { showsDetail.toggle() }
                    } label: {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .rotationEffect(.degrees(showsDetail ? 90 : 0))
                            .frame(width: 28, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(showsDetail ? "Hide details" : "Show details")
                }
                Button("Dismiss", action: onDismiss)
                    .buttonStyle(.plain)
                    .font(SHTypography.micro.weight(.medium))
                    .accessibilityIdentifier("session.notice.dismiss")
            }
            if showsDetail {
                Text(notice.detail)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(SHColor.inkSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .foregroundStyle(SHColor.statusDanger)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SHColor.statusDanger.opacity(0.09), in: RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session.notice")
    }
}

private struct SHClearTopScrollEdgeModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.scrollEdgeEffectStyle(.none, for: .top)
        } else {
            content
        }
    }
}

/// Renders a user/steering bubble cleanly, collapsing very long messages to 6 lines with
/// a crisp "Show more" / "Show less" toggle so massive prompts don't hijack the screen.
private struct ExpandableUserBubbleContent: View {
    @Environment(\.shChatMetrics) private var metrics
    let blocks: [UnifiedBlock]
    let onAnswerQuestion: (String) -> Void
    let onTapImage: (LightboxPayload) -> Void
    let onLoadMedia: ((String) async -> Data?)?

    @State private var isExpanded: Bool = false

    private static let collapseCharThreshold = 320
    private static let collapseLineThreshold = 6
    private static let collapsedPreviewLines = 6

    private var combinedPlainText: String {
        blocks.compactMap { block in
            if case .text(let t) = block { return t }
            return nil
        }.joined(separator: "\n")
    }

    private var isCollapsible: Bool {
        let trimmed = combinedPlainText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if trimmed.count > Self.collapseCharThreshold { return true }
        let lineCount = trimmed.components(separatedBy: .newlines).count
        return lineCount > Self.collapseLineThreshold
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if isCollapsible && !isExpanded {
                Text(combinedPlainText.trimmingCharacters(in: .whitespacesAndNewlines))
                    // Same font and spacing as the expanded message, so collapsing never resizes the text.
                    .font(metrics.body)
                    .foregroundStyle(SHColor.inkPrimary)
                    .lineSpacing(metrics.lineSpacing)
                    .lineLimit(Self.collapsedPreviewLines)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            isExpanded = true
                        }
                    }

                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        isExpanded = true
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text("Show more")
                            .font(SHTypography.micro.weight(.semibold))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                    }
                    .foregroundStyle(SHColor.inkSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("message.expand")
            } else {
                VStack(alignment: .trailing, spacing: metrics.blockGap) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
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

                if isCollapsible {
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            isExpanded = false
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text("Show less")
                                .font(SHTypography.micro.weight(.semibold))
                            Image(systemName: "chevron.up")
                                .font(.system(size: 9, weight: .semibold))
                        }
                        .foregroundStyle(SHColor.inkMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("message.collapse")
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .shRaisedSurface(SHColor.surfaceBubble, cornerRadius: SHRadius.bubble, elevation: .bubble)
    }
}

// MARK: - Expandable Thread Info Top Sheet (Tapping Top Thread Pill)

private struct ThreadInfoTopSheet: View {
    let session: UnifiedSession
    let stats: SessionStats?
    let messageCount: Int
    let isBusy: Bool
    let accentTint: Color
    /// False when a system popover hosts the card and provides the glass and dismissal.
    var drawsOwnSurface: Bool = true
    let onDismiss: () -> Void

    private var summaryCopy: String? {
        let candidates = [session.summary, session.lastUserText, session.preview]
        for raw in candidates {
            if let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                return text
            }
        }
        return nil
    }

    private var hostDescription: String {
        if let addr = session.hostAddress, !addr.isEmpty {
            let lbl = session.hostLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return lbl.isEmpty || lbl == addr ? addr : "\(lbl) (\(addr))"
        }
        if let tmux = session.tmuxTarget, !tmux.isEmpty {
            return "Local · tmux \(tmux)"
        }
        if let app = session.originApp {
            return app == .antigravityCli ? "Local · CLI" : "Local · Desktop"
        }
        return "Local machine"
    }

    private var shortCwd: String? {
        let trimmed = session.cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "~" else { return nil }
        if let range = trimmed.range(of: "/Users/") ?? trimmed.range(of: "/home/") {
            let after = trimmed[range.upperBound...]
            if let slash = after.firstIndex(of: "/") {
                return "~" + String(after[slash...])
            }
        }
        return trimmed
    }

    private static func formatDuration(_ totalSeconds: Int) -> String {
        let hrs = totalSeconds / 3600
        let mins = (totalSeconds % 3600) / 60
        if hrs >= 24 {
            let days = hrs / 24
            let remHrs = hrs % 24
            return remHrs > 0 ? "\(days)d \(remHrs)h" : "\(days)d"
        }
        if hrs > 0 {
            return mins > 0 ? "\(hrs)h \(mins)m" : "\(hrs)h"
        }
        return "\(max(1, mins))m"
    }

    private static func formatCost(_ usd: Double) -> String {
        if usd <= 0 { return "$0.00" }
        if usd < 0.01 { return "<$0.01" }
        return String(format: "$%.2f", usd)
    }

    // MARK: Pieces of the duration line, shown as separate rows

    private var startedLabel: String {
        let createdMs = session.createdAt > 0 ? session.createdAt : session.updatedAt
        return UsageMetrics.formatUpdatedAgo(createdMs)
    }

    private var spanLabel: String? {
        let createdMs = session.createdAt > 0 ? session.createdAt : session.updatedAt
        let spanSec = max(0, Int((max(session.updatedAt, createdMs) - createdMs) / 1000.0))
        return spanSec >= 60 ? Self.formatDuration(spanSec) : nil
    }

    private var activityCountLabel: String {
        if let stats, stats.turnCount > 0 {
            return stats.turnCount == 1 ? "1 turn" : "\(stats.turnCount) turns"
        }
        return messageCount == 1 ? "1 message" : "\(messageCount) messages"
    }

    private var modelName: String? {
        let model = session.model?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return model.isEmpty ? nil : model
    }

    private var modelChips: [String] {
        [session.reasoningEffort?.capitalized, session.permissionMode]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private var statusChip: (text: String, color: Color) {
        if isBusy { return ("Working", accentTint) }
        if session.status == .waitingInput { return ("Needs input", SHColor.statusWarning) }
        return ("Idle", SHColor.inkMuted)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SHSpacing.lg) {
            header

            if let summaryCopy {
                Text(summaryCopy)
                    .font(.system(size: 13.5))
                    .foregroundStyle(SHColor.inkSecondary)
                    .lineSpacing(2)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let stats, stats.totalTokens > 0 {
                usageWell(stats)
            }

            detailRows
        }
        .padding(SHSpacing.lg + 2)
        .modifier(SHTopSheetSurface(drawsOwnSurface: drawsOwnSurface))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread.info.sheet")
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            HarnessLogoView(harness: session.harness, size: 20)
                .frame(width: 40, height: 40)
                .background(accentTint.opacity(0.16), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 5) {
                Text(session.displayTitle)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(SHColor.inkPrimary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 7) {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(statusChip.color)
                            .frame(width: 6, height: 6)
                        Text(statusChip.text)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(statusChip.color)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(statusChip.color.opacity(0.14), in: Capsule())

                    Text("Updated \(UsageMetrics.formatUpdatedAgo(session.updatedAt))")
                        .font(.system(size: 11.5))
                        .foregroundStyle(SHColor.inkMuted)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if drawsOwnSurface {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(SHColor.inkMuted)
                        .frame(width: 28, height: 28)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close thread info")
            }
        }
    }

    private func usageWell(_ stats: SessionStats) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let pct = stats.contextUsedPercent, let window = stats.contextWindowTokens {
                let barTint = SHRadialGauge<EmptyView>.resolvedTint(base: accentTint, value: pct)
                VStack(alignment: .leading, spacing: 7) {
                    HStack(alignment: .firstTextBaseline) {
                        Label("Context", systemImage: "square.stack.3d.up")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(SHColor.inkSecondary)
                            .labelStyle(.titleAndIcon)
                        Spacer()
                        Text("\(Int(pct.rounded()))%")
                            .font(.system(size: 13, weight: .semibold).monospacedDigit())
                            .foregroundStyle(SHColor.inkPrimary)
                        Text("\(UsageMetrics.formatTokens(stats.contextUsedTokens)) of \(UsageMetrics.formatTokens(window))")
                            .font(.system(size: 11.5).monospacedDigit())
                            .foregroundStyle(SHColor.inkMuted)
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.09))
                            Capsule()
                                .fill(barTint)
                                .frame(width: max(6, geo.size.width * CGFloat(min(pct, 100) / 100.0)))
                        }
                    }
                    .frame(height: 6)
                }

                Rectangle()
                    .fill(SHColor.lineHairline)
                    .frame(height: 1)
            } else if stats.contextUsedTokens > 0 {
                // The window size is unknown or contradicted by the usage, so show the amount
                // in context without a percentage or bar.
                HStack(alignment: .firstTextBaseline) {
                    Label("Context", systemImage: "square.stack.3d.up")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(SHColor.inkSecondary)
                        .labelStyle(.titleAndIcon)
                    Spacer()
                    Text("\(UsageMetrics.formatTokens(stats.contextUsedTokens)) in use")
                        .font(.system(size: 13, weight: .semibold).monospacedDigit())
                        .foregroundStyle(SHColor.inkPrimary)
                }
                .accessibilityIdentifier("thread.info.contextUnknownWindow")

                Rectangle()
                    .fill(SHColor.lineHairline)
                    .frame(height: 1)
            }

            HStack(alignment: .top, spacing: 0) {
                metricCell(label: "Input", value: UsageMetrics.formatTokens(stats.inputTokens))
                metricDivider
                metricCell(label: "Cached", value: UsageMetrics.formatTokens(stats.cacheReadTokens))
                metricDivider
                metricCell(label: "Output", value: UsageMetrics.formatTokens(stats.outputTokens))
                metricDivider
                metricCell(label: "Est. cost", value: Self.formatCost(stats.estimatedCostUsd))
            }
        }
        .padding(SHSpacing.md + 2)
        .background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous)
                .strokeBorder(Color.white.opacity(0.06), lineWidth: 0.75)
        )
    }

    private var metricDivider: some View {
        Rectangle()
            .fill(SHColor.lineHairline)
            .frame(width: 1, height: 30)
    }

    private func metricCell(label: String, value: String) -> some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.system(size: 14, weight: .semibold).monospacedDigit())
                .foregroundStyle(SHColor.inkPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(label)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(SHColor.inkMuted)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private var detailRows: some View {
        VStack(spacing: 10) {
            detailRow(icon: "clock", label: "Started", value: startedLabel)
            if let spanLabel {
                detailRow(icon: "timer", label: "Active for", value: "\(spanLabel) · \(activityCountLabel)")
            } else {
                detailRow(icon: "bubble.left.and.bubble.right", label: "Activity", value: activityCountLabel)
            }
            detailRow(icon: "desktopcomputer", label: "Host", value: hostDescription)
            if let shortCwd {
                detailRow(icon: "folder", label: "Folder", value: shortCwd, monospaced: true)
            }
            if let branch = session.gitBranch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty {
                detailRow(icon: "arrow.triangle.branch", label: "Branch", value: branch, monospaced: true)
            }
            if let modelName {
                detailRow(icon: "cpu", label: "Model", value: modelName, chips: modelChips)
            }
        }
    }

    /// One labelled fact: icon and label in fixed columns on the left, the value right-aligned.
    private func detailRow(icon: String, label: String, value: String, monospaced: Bool = false, chips: [String] = []) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(SHColor.inkMuted)
                .frame(width: 20)
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(SHColor.inkMuted)
                .lineLimit(1)
                .fixedSize()
            Spacer(minLength: 12)
            Text(value)
                .font(.system(size: 13, weight: .medium, design: monospaced ? .monospaced : .default))
                .foregroundStyle(SHColor.inkPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            ForEach(chips, id: \.self) { chip in
                Text(chip)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(SHColor.inkSecondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(Color.white.opacity(0.09), in: Capsule())
                    .fixedSize()
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The card's background. Inside the iOS 26 popover the system supplies the Liquid Glass, so
/// the card draws nothing of its own there.
private struct SHTopSheetSurface: ViewModifier {
    let drawsOwnSurface: Bool
    func body(content: Content) -> some View {
        if drawsOwnSurface {
            content.modifier(SHTopSheetGlassModifier())
        } else {
            content
        }
    }
}

private struct SHTopSheetGlassModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: SHRadius.panel, style: .continuous))
                .shadow(color: Color.black.opacity(0.45), radius: 18, y: 10)
        } else {
            content
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: SHRadius.panel, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: SHRadius.panel, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.75)
                )
                .shadow(color: Color.black.opacity(0.45), radius: 18, y: 10)
        }
    }
}

/// Round floating surface for the scroll-to-bottom button: Liquid Glass where available.
private struct ScrollToBottomSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Circle())
        } else {
            content
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.white.opacity(0.14), lineWidth: 0.75))
                .shadow(color: Color.black.opacity(0.35), radius: 8, y: 3)
        }
    }
}
