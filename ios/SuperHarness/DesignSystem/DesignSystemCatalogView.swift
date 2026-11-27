import SwiftUI

/// The Superharness pattern library. Open from Settings -> Developer -> Design System Catalog.
///
/// Every sample here is the component the app itself draws, fed with sample data, so the
/// catalog cannot drift from the app: a change to a component shows up here too. Anything the
/// app does not use has no place in it.
public struct DesignSystemCatalogView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var density: ChatDensity = .comfortable
    @State private var liveStepExpanded = false
    @State private var audioLevels: [CGFloat] = [0.2, 0.7, 0.45, 0.9, 0.3, 0.6, 0.15]

    public init() {}

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 30) {
                    colorSection
                    typographySection
                    shapeSection
                    surfaceSection
                    activitySection
                    sessionListSection
                    chatSection
                    composerSection
                    settingsSection
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 40)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .background(SHColor.surfaceCanvas)
            .tint(SHColor.inkPrimary)
            .navigationTitle("Design System")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("catalog.done")
                }
            }
        }
    }

    // MARK: - Colour

    private var colorSection: some View {
        group("Colour", note: "One cool obsidian hue for every surface, four inks for text, and colour only where it carries meaning: a harness, a status, or information.") {
            pattern("Surfaces, darkest to lightest") {
                swatchGrid([
                    ("Code", SHColor.surfaceCode), ("Rail", SHColor.surfaceRail),
                    ("Canvas", SHColor.surfaceCanvas), ("Subtle", SHColor.surfaceSubtle),
                    ("Popover", SHColor.surfacePopover), ("Raised", SHColor.surfaceRaised),
                    ("Bubble", SHColor.surfaceBubble), ("Hover", SHColor.surfaceHover),
                ])
            }
            pattern("Ink") {
                swatchGrid([
                    ("Primary", SHColor.inkPrimary), ("Secondary", SHColor.inkSecondary),
                    ("Muted", SHColor.inkMuted), ("Faint", SHColor.inkFaint),
                ])
            }
            pattern("Harnesses") {
                HStack(spacing: 8) {
                    ForEach(Self.harnessKinds, id: \.self) { kind in
                        VStack(spacing: 6) {
                            HarnessLogoView(harness: kind, size: 22)
                            RoundedRectangle(cornerRadius: 3, style: .continuous)
                                .fill(SHColor.harness(kind))
                                .frame(height: 6)
                            Text(HarnessVisual.forKind(kind).shortLabel)
                                .font(.system(size: 10.5))
                                .foregroundStyle(SHColor.inkMuted)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            pattern("Status and accents") {
                swatchGrid([
                    ("Success", SHColor.statusSuccess), ("Warning", SHColor.statusWarning),
                    ("Danger", SHColor.statusDanger), ("Info", SHColor.accentInfo),
                    ("Accent", SHColor.accentPrimary), ("Porcelain", SHColor.porcelain),
                    ("Switch on", SHColor.toggleOn),
                ])
            }
            pattern("Lines") {
                VStack(spacing: 10) {
                    lineSample("Hairline", SHColor.lineHairline)
                    lineSample("Subtle", SHColor.lineSubtle)
                    lineSample("Strong", SHColor.lineStrong)
                }
            }
        }
    }

    // MARK: - Typography

    private var typographySection: some View {
        group("Typography", note: "The system font throughout. Chat text also scales with the Text Size setting.") {
            VStack(alignment: .leading, spacing: 10) {
                typeSample("Hero number", "28 semibold", SHTypography.heroNumber, sample: "82%")
                typeSample("Title", "18 semibold", SHTypography.title)
                typeSample("Heading", "16 semibold", SHTypography.heading)
                typeSample("Body", "15 regular", SHTypography.body)
                typeSample("Label", "14.5 medium", SHTypography.label)
                typeSample("Caption", "13.5 regular", SHTypography.caption)
                typeSample("Micro", "12.5 regular", SHTypography.micro)
                typeSample("Mono", "12.5 mono", SHTypography.mono, sample: "npm run build")
                typeSample("Mono small", "11.5 mono", SHTypography.monoSmall, sample: "exit 0 · 1.4s")
            }
        }
    }

    // MARK: - Shape and spacing

    private var shapeSection: some View {
        group("Shape and Spacing", note: "Corners are continuous. Chips use small radii, cards large, and the bubble and composer the two largest.") {
            pattern("Corner radius") {
                HStack(alignment: .bottom, spacing: 8) {
                    radiusSample("sm", SHRadius.sm)
                    radiusSample("md", SHRadius.md)
                    radiusSample("lg", SHRadius.lg)
                    radiusSample("xl", SHRadius.xl)
                    radiusSample("bubble", SHRadius.bubble)
                    radiusSample("panel", SHRadius.panel)
                }
            }
            pattern("Spacing") {
                HStack(alignment: .bottom, spacing: 10) {
                    spacingSample("xxs", SHSpacing.xxs)
                    spacingSample("xs", SHSpacing.xs)
                    spacingSample("sm", SHSpacing.sm)
                    spacingSample("md", SHSpacing.md)
                    spacingSample("lg", SHSpacing.lg)
                    spacingSample("xl", SHSpacing.xl)
                    spacingSample("xxl", SHSpacing.xxl)
                    Spacer(minLength: 0)
                }
            }
        }
    }

    // MARK: - Surfaces

    private var surfaceSection: some View {
        group("Surfaces", note: "Content in the scroll area is raised or recessed and has no border. Controls that float over content are Liquid Glass.") {
            pattern("Raised: card, bubble, tile") {
                HStack(spacing: 10) {
                    surfaceSample("Card").shRaisedSurface(SHColor.surfacePopover, cornerRadius: SHRadius.lg, elevation: .card)
                    surfaceSample("Bubble").shRaisedSurface(SHColor.surfaceBubble, cornerRadius: SHRadius.bubble, elevation: .bubble)
                    surfaceSample("Tile").shRaisedSurface(SHColor.surfaceSubtle, cornerRadius: SHRadius.md, elevation: .tile)
                }
            }
            pattern("Recessed well: terminal, diff and tool output") {
                Text("$ git status --short\n M ios/SuperHarness/Views/SessionListView.swift")
                    .font(SHTypography.monoSmall)
                    .foregroundStyle(SHColor.inkSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .shRecessedWell(cornerRadius: SHRadius.md)
            }
            pattern("Liquid Glass: dock, header pills, New Chat") {
                HStack(spacing: 10) {
                    HStack(spacing: 7) {
                        HarnessLogoView(harness: .codex, size: 14)
                        Text("Fix pairing retry")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(SHColor.inkPrimary)
                    }
                    .padding(.horizontal, 13)
                    .frame(height: 38)
                    .shGlassSurface(in: Capsule())

                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(SHColor.inkPrimary)
                        .frame(width: 44, height: 44)
                        .shGlassSurface(in: Circle())
                    Spacer(minLength: 0)
                }
                .padding(14)
                .frame(maxWidth: .infinity)
                .background(
                    LinearGradient(
                        colors: [SHColor.brandCodex.opacity(0.35), SHColor.accentInfo.opacity(0.3), SHColor.brandClaude.opacity(0.3)],
                        startPoint: .leading,
                        endPoint: .trailing
                    ),
                    in: RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous)
                )
            }
        }
    }

    // MARK: - Activity and status

    private var activitySection: some View {
        group("Activity and Status", note: "Work in progress is shown by the animated mark and by a shimmer on the title. Nothing spins.") {
            pattern("Working mark") {
                HStack(spacing: 22) {
                    SHWorkingMark(tint: SHColor.porcelain, size: 15)
                    SHWorkingMark(tint: SHColor.porcelain, size: 22)
                    SHWorkingMark(tint: SHColor.accentInfo, size: 22)
                    SHToolbarLogo()
                    Spacer(minLength: 0)
                }
            }
            pattern("Working title shimmer") {
                SHShimmerText(text: "Refactoring the pairing flow", font: SHTypography.label.weight(.medium), isActive: true)
            }
            pattern("Quota gauge: idle, working, near the limit, at the limit") {
                HStack(spacing: 18) {
                    gauge(.codex, value: 34)
                    gauge(.claudeCli, value: 58, isWorking: true)
                    gauge(.antigravity, value: 86)
                    gauge(.pi, value: 97)
                    Spacer(minLength: 0)
                }
            }
            pattern("Usage bar with pace mark") {
                VStack(spacing: 10) {
                    ObsidianProgressBar(value: 42, tint: SHColor.brandCodex, pacePercent: 55)
                    ObsidianProgressBar(value: 88, tint: SHColor.brandClaude, pacePercent: 60)
                    ObsidianProgressBar(value: 97, tint: SHColor.accentInfo)
                }
            }
            pattern("Connection glyphs in the top-left button") {
                HStack(spacing: 18) {
                    glyphSample(.settings, "Connected", SHColor.inkPrimary)
                    glyphSample(.syncing, "Syncing", SHColor.inkPrimary)
                    glyphSample(.problem, "Unreachable", SHColor.statusWarning)
                    Spacer(minLength: 0)
                }
            }
        }
    }

    // MARK: - Session list

    private var sessionListSection: some View {
        group("Session List", note: "A row is a title line and one quiet line under it. The right slot holds the time, the working mark, or a question mark.") {
            VStack(alignment: .leading, spacing: 14) {
                SessionListRow(session: Self.sampleSession("idle", .codex, "Fix pairing retry", summary: "Done: retries now back off and stop after five tries"), isBusy: false)
                SessionListRow(session: Self.sampleSession("busy", .claudeCli, "Refactor the session store", summary: "Reading AppStore.swift"), isBusy: true)
                SessionListRow(session: Self.sampleSession("ask", .antigravity, "Ship the release notes", summary: "Which version number should this use?", status: .waitingInput), isBusy: false)
                SessionListRow(session: Self.sampleSession("unread", .pi, "Benchmark the tokenizer", summary: "Three runs finished", unread: true), isBusy: false, isPinned: true)
            }
            .padding(.horizontal, 4)
        }
    }

    // MARK: - Chat

    private var chatSection: some View {
        group("Chat", note: "The assistant's text sits on the canvas; the user's message is a raised bubble. Steps collapse to one line and open in place.") {
            pattern("Density") {
                SHChoiceBar(options: ChatDensity.allCases.map { ($0, $0.label) }, selection: $density)
            }
            VStack(alignment: .leading, spacing: density.messageGap) {
                HStack {
                    Spacer(minLength: 48)
                    block(.text(text: "Make the retry back off, and add a test for it."), isUserBubble: true)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .shRaisedSurface(SHColor.surfaceBubble, cornerRadius: SHRadius.bubble, elevation: .bubble)
                }

                VStack(alignment: .leading, spacing: density.blockGap) {
                    CollapsedTraceGroupView(
                        blocks: Self.traceBlocks,
                        trailingMeta: "12s",
                        onAnswerQuestion: { _ in },
                        onTapImage: { _ in }
                    )
                    block(.text(text: Self.sampleMarkdown))
                }

                pattern("Live step, while a turn is running") {
                    SHInlineDisclosureRow(
                        icon: "apple.terminal",
                        title: "Running xcodebuild test",
                        isShimmering: true,
                        isExpanded: liveStepExpanded
                    ) { liveStepExpanded.toggle() }
                }
                pattern("Thinking") {
                    block(.thinking(text: "The retry loop has no upper bound, so a dead host keeps the radio awake. **Cap it at five tries.**", summary: "Planning the retry cap"))
                }
                pattern("Command") {
                    block(.command(command: "xcodebuild test -scheme SuperHarness", cwd: "~/Developer/super-harness/ios", output: "Test Suite 'All tests' passed.\nExecuted 108 tests, with 0 failures in 4.2 seconds", exitCode: 0, durationMs: 4200, status: "completed"))
                }
                pattern("File change") {
                    block(.fileChange(changes: [
                        FileChangeEntry(path: "ios/SuperHarness/Networking/PairingClient.swift", kind: "update", diff: "@@ -41,3 +41,4 @@\n-        try await Task.sleep(for: .seconds(1))\n+        let delay = min(pow(2, Double(attempt)), 30)\n+        try await Task.sleep(for: .seconds(delay))"),
                    ], status: "completed"))
                }
                pattern("Tool call and web search") {
                    VStack(alignment: .leading, spacing: density.blockGap) {
                        block(.toolCall(name: "read_file", server: "filesystem", args: "{\"path\": \"ios/project.yml\"}", output: "MARKETING_VERSION: \"1.0\"", status: "completed", durationMs: 38))
                        block(.webSearch(query: "URLSession exponential backoff", url: "https://developer.apple.com/documentation/foundation/urlsession"))
                    }
                }
                pattern("Question") {
                    block(.question(questions: [QuestionItem(question: "Which version number should this use?", options: ["1.0.1", "1.1"])], answered: false))
                }
                pattern("Notice from the harness") {
                    block(.notice(title: "Context compacted", detail: "Earlier messages were summarised to make room."))
                }
                pattern("Error in the thread") {
                    SessionNoticeRow(
                        notice: AppStore.SessionNotice(
                            message: "Pi could not reach its model server at 127.0.0.1:8080",
                            detail: "HTTP 502: connect ECONNREFUSED 127.0.0.1:8080"
                        ),
                        onDismiss: {}
                    )
                }
                pattern("Attachments") {
                    SHAttachmentThumbStrip(
                        items: [
                            SHAttachmentThumbItem(id: "1", name: "screenshot.jpg", mimeType: "image/jpeg"),
                            SHAttachmentThumbItem(id: "2", name: "demo.mp4", mimeType: "video/mp4"),
                            SHAttachmentThumbItem(id: "3", name: "architecture.pdf", mimeType: "application/pdf", sizeBytes: 428_000),
                            SHAttachmentThumbItem(id: "4", name: "trace.json", mimeType: "application/json", sizeBytes: 18_400, isUploading: true),
                        ],
                        onRemove: { _ in }
                    )
                }
            }
            .environment(\.shChatMetrics, SHChatMetrics(density: density))
        }
    }

    // MARK: - Composer

    private var composerSection: some View {
        group("Composer", note: "One raised panel. Quiet round controls for secondary actions and one prominent control for the main action.") {
            SHComposerSurface {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Ask anything")
                        .font(SHTypography.body)
                        .foregroundStyle(SHColor.inkFaint)
                        .padding(.horizontal, 14)
                        .padding(.top, 13)
                    HStack(spacing: 8) {
                        SHRoundControlLabel(systemImage: "plus", symbolSize: 16.5)
                        SHModelEffortMenu(
                            models: [
                                .init(id: "a", label: "GPT-5.5", isSelected: true),
                                .init(id: "b", label: "GPT-5.5 Mini", isSelected: false),
                            ],
                            efforts: [.init(level: "medium", isSelected: true), .init(level: "high", isSelected: false)],
                            harness: .codex,
                            title: "GPT-5.5",
                            effortLabel: "Medium",
                            accessibilityText: "Model and thinking effort",
                            identifier: "catalog.model",
                            onSelectModel: { _ in },
                            onSelectEffort: { _ in }
                        )
                        Spacer(minLength: 0)
                        SHRoundControlLabel(systemImage: "mic.fill", symbolSize: 15, weight: .medium)
                        SHRoundControlLabel(systemImage: "arrow.up", symbolSize: 16, weight: .bold, isProminent: true)
                    }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
                }
            }
            pattern("Dictation: listening, then transcribing") {
                HStack(spacing: 24) {
                    SHAudioLevelBars(levels: audioLevels, tint: SHColor.statusDanger)
                    SHDotSpinner(tint: SHColor.inkSecondary)
                    Spacer(minLength: 0)
                }
                .task {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .milliseconds(140))
                        audioLevels = audioLevels.map { _ in CGFloat.random(in: 0.1...1) }
                    }
                }
            }
        }
    }

    // MARK: - Settings

    private var settingsSection: some View {
        group("Settings and Sheets", note: "A quiet title above one raised card. Rows share an icon column, and dividers start at the label.") {
            SHSectionCard("Machines") {
                SHCardRow(icon: "desktopcomputer", title: "archlinux", detail: "archlinux.tail6026.ts.net") {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(SHColor.inkSecondary)
                }
                SHCardDivider()
                SHCardRow(icon: "bell", title: "Notifications", detail: "Finished chats and questions") {
                    Toggle("", isOn: .constant(true))
                        .labelsHidden()
                        .tint(SHColor.toggleOn)
                }
                SHCardDivider()
                SHCardRow(icon: "plus", title: "Pair Another Machine") {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(SHColor.inkFaint)
                }
                SHCardDivider()
                SHCardRow(icon: "trash", title: "Unpair", tint: SHColor.statusDanger) { EmptyView() }
            }
        }
    }

    // MARK: - Catalog layout

    /// One part of the library: a title, a sentence on the rule, then the samples.
    private func group<Content: View>(_ title: String, note: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(SHTypography.title)
                    .foregroundStyle(SHColor.inkPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text(note)
                    .font(SHTypography.caption)
                    .foregroundStyle(SHColor.inkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            content()
        }
    }

    /// One named sample.
    private func pattern<Content: View>(_ name: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(name)
                .font(SHTypography.micro.weight(.medium))
                .foregroundStyle(SHColor.inkFaint)
            content()
        }
    }

    private func block(_ block: UnifiedBlock, isUserBubble: Bool = false) -> some View {
        UnifiedBlockView(block: block, isUserBubble: isUserBubble, onAnswerQuestion: { _ in }, onTapImage: { _ in })
    }

    private func swatchGrid(_ items: [(String, Color)]) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 10) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                VStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous)
                        .fill(item.1)
                        .frame(height: 36)
                        .overlay(
                            RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous)
                                .strokeBorder(SHColor.lineSubtle, lineWidth: 0.5)
                        )
                    Text(item.0)
                        .font(.system(size: 10.5))
                        .foregroundStyle(SHColor.inkMuted)
                        .lineLimit(1)
                }
            }
        }
    }

    private func lineSample(_ name: String, _ color: Color) -> some View {
        HStack(spacing: 12) {
            Text(name)
                .font(SHTypography.micro)
                .foregroundStyle(SHColor.inkMuted)
                .frame(width: 64, alignment: .leading)
            Rectangle().fill(color).frame(height: 1)
        }
    }

    private func typeSample(_ name: String, _ spec: String, _ font: Font, sample: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(sample ?? name)
                .font(font)
                .foregroundStyle(SHColor.inkPrimary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(sample == nil ? spec : "\(name) · \(spec)")
                .font(SHTypography.monoSmall)
                .foregroundStyle(SHColor.inkFaint)
                .lineLimit(1)
        }
    }

    private func radiusSample(_ name: String, _ radius: CGFloat) -> some View {
        VStack(spacing: 5) {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(SHColor.surfaceBubble)
                .frame(height: 46)
            Text("\(name) \(Int(radius))")
                .font(.system(size: 10.5))
                .foregroundStyle(SHColor.inkMuted)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
    }

    private func spacingSample(_ name: String, _ value: CGFloat) -> some View {
        VStack(spacing: 5) {
            Rectangle()
                .fill(SHColor.accentInfo.opacity(0.7))
                .frame(width: value, height: 24)
            Text("\(name) \(Int(value))")
                .font(.system(size: 10.5))
                .foregroundStyle(SHColor.inkMuted)
                .fixedSize()
        }
    }

    private func surfaceSample(_ name: String) -> some View {
        Text(name)
            .font(SHTypography.caption.weight(.medium))
            .foregroundStyle(SHColor.inkSecondary)
            .frame(maxWidth: .infinity)
            .frame(height: 56)
    }

    private func gauge(_ kind: HarnessKind, value: Double, isWorking: Bool = false) -> some View {
        SHRadialGauge(value: value, tint: SHColor.harness(kind), isWorking: isWorking, isActive: isWorking, size: 40) {
            HarnessLogoView(harness: kind, size: 17)
        }
    }

    private func glyphSample(_ glyph: ConnectionStatusPill.Glyph, _ name: String, _ color: Color) -> some View {
        VStack(spacing: 6) {
            Image(systemName: glyph.symbolName)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(color)
                .frame(height: 22)
            Text(name)
                .font(.system(size: 10.5))
                .foregroundStyle(SHColor.inkMuted)
        }
    }

    // MARK: - Sample data

    private static let harnessKinds: [HarnessKind] = [.codex, .claudeCli, .antigravity, .muse, .pi, .master]

    private static func sampleSession(
        _ id: String,
        _ harness: HarnessKind,
        _ title: String,
        summary: String,
        status: SessionStatus = .idle,
        unread: Bool = false
    ) -> UnifiedSession {
        UnifiedSession(
            id: "catalog-\(id)",
            harness: harness,
            title: title,
            preview: summary,
            cwd: "/Users/dev/super-harness",
            status: status,
            updatedAt: (Date().timeIntervalSince1970 - 540) * 1000,
            summary: summary,
            unread: unread
        )
    }

    private static let traceBlocks: [UnifiedBlock] = [
        .thinking(text: "Find where the retry delay is set.", summary: "Locating the retry loop"),
        .command(command: "rg \"Task.sleep\" ios/SuperHarness/Networking", cwd: nil, output: "PairingClient.swift:42:        try await Task.sleep(for: .seconds(1))", exitCode: 0, durationMs: 120, status: "completed"),
        .fileChange(changes: [FileChangeEntry(path: "ios/SuperHarness/Networking/PairingClient.swift", kind: "update", diff: nil)], status: "completed"),
        .command(command: "xcodebuild test -only-testing:SuperHarnessTests/PairingTests", cwd: nil, output: "Executed 14 tests, with 0 failures", exitCode: 0, durationMs: 9300, status: "completed"),
    ]

    private static let sampleMarkdown = """
    The retry now **backs off** and stops after five tries.

    - Delay doubles each time, capped at `30s`
    - A new test covers the cap

    | Try | Delay |
    | :-- | --: |
    | 1 | 2s |
    | 5 | 30s |

    ```swift
    let delay = min(pow(2, Double(attempt)), 30)
    ```

    > Pairing itself is unchanged.
    """
}
