import SwiftUI

// MARK: - Calm Obsidian Skeleton Pulse

/// Loading treatment for skeleton placeholders: the whole placeholder breathes slowly between
/// two opacities. There is no moving highlight band, so nothing sweeps across the bars.
public struct ObsidianShimmerModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init() {}

    public func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let period: Double = 1.8
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
                // Cosine ease: 1.0 → 0.55 → 1.0 over one period.
                let level = 0.775 + 0.225 * cos(phase * 2 * .pi)
                content.opacity(level)
            }
        }
    }
}

public extension View {
    func obsidianShimmer() -> some View {
        modifier(ObsidianShimmerModifier())
    }
}

private struct SkeletonBar: View {
    var width: CGFloat? = nil
    var height: CGFloat = 12
    var cornerRadius: CGFloat = 6

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(SHColor.surfaceRaised)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

// MARK: - 1. Session List Skeleton

public struct SessionListSkeletonView: View {
    public init() {}

    private let rowTitleWidths: [CGFloat] = [175, 210, 150, 195, 165, 220, 140]
    private let rowSubtitleWidths: [CGFloat] = [120, 155, 95, 140, 110, 160, 105]

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                // Master row skeleton
                HStack(spacing: 13) {
                    SkeletonBar(width: 36, height: 36, cornerRadius: SHRadius.md)
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            SkeletonBar(width: 150, height: 13)
                            Spacer()
                            SkeletonBar(width: 34, height: 10)
                        }
                        SkeletonBar(width: 195, height: 11)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .background(SHColor.surfaceSubtle)
                .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
                .padding(.horizontal, 16)

                // Horizontal harness switcher pill skeletons
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        skeletonPill(width: 82, showPlus: false)
                        skeletonPill(width: 136, showPlus: true)
                        skeletonPill(width: 122, showPlus: true)
                        skeletonPill(width: 126, showPlus: true)
                    }
                    .padding(.horizontal, 16)
                }

                // Grouped session rows skeleton
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        SkeletonBar(width: 86, height: 10, cornerRadius: 5)
                        Spacer()
                        SkeletonBar(width: 18, height: 10, cornerRadius: 5)
                    }
                    .padding(.horizontal, 28)

                    VStack(spacing: 0) {
                        ForEach(0..<rowTitleWidths.count, id: \.self) { index in
                            HStack(alignment: .top, spacing: 13) {
                                SkeletonBar(width: 34, height: 34, cornerRadius: SHRadius.md)
                                VStack(alignment: .leading, spacing: 7) {
                                    HStack {
                                        SkeletonBar(width: rowTitleWidths[index], height: 13)
                                        Spacer()
                                        SkeletonBar(width: 30, height: 10)
                                    }
                                    SkeletonBar(width: rowSubtitleWidths[index], height: 11)
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 13)

                            if index < rowTitleWidths.count - 1 {
                                Divider()
                                    .overlay(SHColor.lineHairline)
                                    .padding(.leading, 63)
                            }
                        }
                    }
                    .background(SHColor.surfaceSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
                    .padding(.horizontal, 16)
                }
            }
            .padding(.vertical, 12)
            .obsidianShimmer()
        }
        .background(SHColor.surfaceRail)
        .accessibilityLabel("Loading sessions")
    }

    private func skeletonPill(width: CGFloat, showPlus: Bool) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 7) {
                SkeletonBar(width: showPlus ? 74 : 46, height: 11)
                SkeletonBar(width: showPlus ? 78 : 52, height: 3, cornerRadius: 2)
            }
            if showPlus {
                SkeletonBar(width: 24, height: 24, cornerRadius: 12)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(width: width, alignment: .leading)
        .background(SHColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
    }
}

// MARK: - 2. Transcript Skeleton

public struct TranscriptSkeletonView: View {
    public init() {}

    public var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            // User bubble 1
            HStack {
                Spacer(minLength: 72)
                VStack(alignment: .leading, spacing: 8) {
                    SkeletonBar(width: 205, height: 12)
                    SkeletonBar(width: 145, height: 12)
                }
                .padding(.horizontal, 15)
                .padding(.vertical, 12)
                .background(SHColor.surfaceBubble)
                .clipShape(RoundedRectangle(cornerRadius: SHRadius.xl, style: .continuous))
            }

            // Assistant reply 1 (speaker + tool card + prose)
            VStack(alignment: .leading, spacing: 11) {
                HStack(spacing: 7) {
                    SkeletonBar(width: 15, height: 15, cornerRadius: 4)
                    SkeletonBar(width: 96, height: 11)
                    Spacer()
                    SkeletonBar(width: 34, height: 10)
                }

                // Collapsed tool card skeleton
                HStack(spacing: 8) {
                    SkeletonBar(width: 14, height: 14, cornerRadius: 4)
                    SkeletonBar(width: 160, height: 11)
                    Spacer()
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 11)
                .background(SHColor.surfaceSubtle)
                .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))

                VStack(alignment: .leading, spacing: 8) {
                    SkeletonBar(height: 12)
                    SkeletonBar(height: 12)
                    SkeletonBar(width: 220, height: 12)
                }
            }

            // User bubble 2
            HStack {
                Spacer(minLength: 100)
                SkeletonBar(width: 170, height: 12)
                    .padding(.horizontal, 15)
                    .padding(.vertical, 12)
                    .background(SHColor.surfaceBubble)
                    .clipShape(RoundedRectangle(cornerRadius: SHRadius.xl, style: .continuous))
            }

            // Assistant reply 2
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 7) {
                    SkeletonBar(width: 15, height: 15, cornerRadius: 4)
                    SkeletonBar(width: 110, height: 11)
                }
                VStack(alignment: .leading, spacing: 8) {
                    SkeletonBar(height: 12)
                    SkeletonBar(width: 245, height: 12)
                }
            }
        }
        .padding(.vertical, 8)
        .obsidianShimmer()
        .accessibilityLabel("Loading transcript")
    }
}

// MARK: - 3. Usage Sheet Skeleton

public struct UsageSkeletonView: View {
    public init() {}

    private let barHeights: [CGFloat] = [36, 54, 28, 42, 68, 52, 78]

    public var body: some View {
        VStack(alignment: .leading, spacing: SHSpacing.lg) {
            // Header
            HStack {
                SkeletonBar(width: 120, height: 18)
                Spacer()
                SkeletonBar(width: 96, height: 11)
            }

            // Hero limit card skeleton
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    SkeletonBar(width: 110, height: 12)
                    Spacer()
                    SkeletonBar(width: 82, height: 11)
                }
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    SkeletonBar(width: 68, height: 28, cornerRadius: 7)
                    SkeletonBar(width: 148, height: 12)
                }
                SkeletonBar(height: 7, cornerRadius: 4)
                SkeletonBar(width: 175, height: 10)
            }
            .padding(SHSpacing.lg)
            .background(SHColor.surfacePopover)
            .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))

            // Secondary windows row skeleton
            HStack {
                SkeletonBar(width: 145, height: 12)
                Spacer()
                SkeletonBar(width: 14, height: 14, cornerRadius: 4)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(SHColor.surfaceSubtle)
            .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))

            // 7-day spend chart skeleton
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    SkeletonBar(width: 136, height: 12)
                    Spacer()
                    SkeletonBar(width: 92, height: 11)
                }
                HStack(spacing: 18) {
                    SkeletonBar(width: 68, height: 20)
                    SkeletonBar(width: 58, height: 14)
                    SkeletonBar(width: 58, height: 14)
                }
                HStack(alignment: .bottom, spacing: 12) {
                    ForEach(0..<barHeights.count, id: \.self) { i in
                        VStack(spacing: 6) {
                            SkeletonBar(height: barHeights[i], cornerRadius: 4)
                            SkeletonBar(width: 22, height: 9, cornerRadius: 3)
                        }
                    }
                }
                .frame(height: 104, alignment: .bottom)
            }
            .padding(.top, 4)
        }
        .obsidianShimmer()
        .accessibilityLabel("Loading usage data")
    }
}
