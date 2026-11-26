import SwiftUI

/// Interactive Super Harness Component & Pattern Library showcase.
/// Open from Host Settings -> Design System & Patterns.
public struct DesignSystemCatalogView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var sampleCommandsExpanded = false
    @State private var sampleRunningExpanded = false

    public init() {}

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    section("Floating Liquid Glass Chrome") {
                        HStack {
                            SHGlassCircleButton(systemImage: "chevron.left", accessibilityLabel: "Back") {}
                            Spacer()
                            SHFloatingTitlePill(title: "Orble secret copy", subtitle: "orble")
                            Spacer()
                            SHGlassActionCapsule(isBusy: true, accentColor: SHColor.brandAntigravity) {
                                Button("Pin Session") {}
                                Button("Refresh") {}
                            }
                        }
                        .padding(12)
                        .background(SHColor.surfaceSubtle)
                        .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
                    }

                    section("Inline Command & Activity Rows") {
                        VStack(alignment: .leading, spacing: SHLayout.itemGap) {
                            SHInlineDisclosureRow(
                                icon: "list.bullet",
                                title: "Ran 4 commands",
                                isExpanded: sampleCommandsExpanded
                            ) {
                                sampleCommandsExpanded.toggle()
                            }
                            if sampleCommandsExpanded {
                                Text("go test ./cmd/orble/... — passed in 1.4s")
                                    .font(SHTypography.monoSmall)
                                    .foregroundStyle(SHColor.inkMuted)
                                    .padding(.leading, 21)
                            }
                            SHInlineDisclosureRow(
                                icon: "terminal",
                                title: "Running",
                                trailingBadge: "2/4",
                                tint: SHColor.brandAntigravity,
                                isSpinning: true,
                                isExpanded: sampleRunningExpanded
                            ) {
                                sampleRunningExpanded.toggle()
                            }
                        }
                        .padding(12)
                        .background(SHColor.surfaceSubtle)
                        .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
                    }

                    section("Compact Attachment Thumbnails") {
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

                    section("Grounded Composer Pattern (Steer Default / Long-Press Queue)") {
                        SHComposerSurface {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Type / for commands or ask anything…")
                                    .font(SHTypography.body)
                                    .foregroundStyle(SHColor.inkFaint)
                                    .padding(.horizontal, 14)
                                    .padding(.top, 12)
                                HStack(spacing: 8) {
                                    Image(systemName: "plus")
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(SHColor.inkSecondary)
                                        .frame(width: 30, height: 30)
                                        .background(SHColor.surfaceBubble, in: Circle())
                                    HStack(spacing: 5) {
                                        HarnessLogoView(harness: .antigravity, size: 13)
                                        Text("Gemini 4 Neon")
                                            .font(.system(size: 12, weight: .medium))
                                            .foregroundStyle(SHColor.inkPrimary)
                                        Text("Medium")
                                            .font(.system(size: 12, weight: .regular))
                                            .foregroundStyle(SHColor.inkMuted)
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(SHColor.surfaceBubble, in: Capsule())
                                    Spacer()
                                    Image(systemName: "mic.fill")
                                        .font(.system(size: 13))
                                        .foregroundStyle(SHColor.inkMuted)
                                        .frame(width: 30, height: 30)
                                        .background(SHColor.surfaceBubble, in: Circle())
                                    Image(systemName: "arrow.up")
                                        .font(.system(size: 13.5, weight: .bold))
                                        .foregroundStyle(SHColor.surfaceRail)
                                        .frame(width: 30, height: 30)
                                        .background(SHColor.inkPrimary, in: Circle())
                                }
                                .padding(.horizontal, 12)
                                .padding(.bottom, 10)
                            }
                        }
                    }

                    section("GFM Markdown Formatting") {
                        SHMarkdownView(text: """
                        ### Release Summary
                        Updated `cmd/orble` and **MarkdownRenderer.swift** with ~~legacy~~ accurate GFM support:
                        - [x] Headings, lists, blockquotes & task items
                        - [x] Tables with column alignment

                        | Metric | Before | After |
                        | :--- | :---: | ---: |
                        | Dictation | 320 KB | **40 KB** |
                        | SSE idle | 4.7 MB | **110 B** |

                        > Inline `code` chips, bold emphasis, and [links](https://github.com/lxe/super-harness) stay crisp.
                        """)
                        .padding(12)
                        .background(SHColor.surfaceSubtle)
                        .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
                    }

                    section("Obsidian Surface & Brand Tokens") {
                        HStack(spacing: 8) {
                            swatch("Canvas", SHColor.surfaceCanvas)
                            swatch("Subtle", SHColor.surfaceSubtle)
                            swatch("Raised", SHColor.surfaceRaised)
                            swatch("Bubble", SHColor.surfaceBubble)
                        }
                        HStack(spacing: 8) {
                            swatch("Agy", SHColor.brandAntigravity)
                            swatch("Codex", SHColor.brandCodex)
                            swatch("Claude", SHColor.brandClaude)
                            swatch("Muse", SHColor.brandMuse)
                        }
                    }
                }
                .padding(SHLayout.screenPad)
            }
            .background(SHColor.surfaceCanvas)
            .navigationTitle("Design System")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: SHLayout.blockGap) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(SHColor.inkMuted)
            content()
        }
    }

    private func swatch(_ name: String, _ color: Color) -> some View {
        VStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(color)
                .frame(height: 36)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5))
            Text(name)
                .font(.system(size: 10.5))
                .foregroundStyle(SHColor.inkMuted)
        }
        .frame(maxWidth: .infinity)
    }
}
