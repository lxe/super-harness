import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Consistent Mobile Density Rhythm

public enum SHLayout {
    public static let screenPad: CGFloat = 14
    public static let messageGap: CGFloat = 16
    public static let blockGap: CGFloat = 8
    public static let itemGap: CGFloat = 6
    public static let thumbSize: CGFloat = 76
    public static let composerThumbSize: CGFloat = 56
    public static let headerHeight: CGFloat = 52
}

// MARK: - Liquid Glass Floating Chrome Primitives

/// Circular frosted glass button matching iOS 26 overlay chrome.
public struct SHGlassCircleButton: View {
    public let systemImage: String
    public let accessibilityLabel: String
    public let action: () -> Void

    public init(systemImage: String, accessibilityLabel: String, action: @escaping () -> Void) {
        self.systemImage = systemImage
        self.accessibilityLabel = accessibilityLabel
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(SHColor.inkPrimary)
                .frame(width: 38, height: 38)
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.white.opacity(0.14), lineWidth: 0.75))
                .shadow(color: Color.black.opacity(0.32), radius: 8, y: 3)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// Compact centered Liquid Glass header pill matching the exact 38pt height of the left/right chrome pills.
/// Uses the harness icon on the left + crisp single-line title for balanced horizontal symmetry.
public struct SHFloatingTitlePill: View {
    public let title: String
    public let subtitle: String?
    public let harness: HarnessKind?
    public var onTap: (() -> Void)? = nil

    public init(title: String, subtitle: String? = nil, harness: HarnessKind? = nil, onTap: (() -> Void)? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.harness = harness
        self.onTap = onTap
    }

    public var body: some View {
        let content = HStack(spacing: 7) {
            if let harness {
                HarnessLogoView(harness: harness, size: 14)
            }
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(SHColor.inkPrimary)
                .lineLimit(1)
        }
        .padding(.horizontal, 13)
        .frame(height: 38)
        .frame(maxWidth: 225)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 0.75))
        .shadow(color: Color.black.opacity(0.32), radius: 8, y: 3)

        if let onTap {
            Button(action: onTap) { content }
                .buttonStyle(.plain)
        } else {
            content
        }
    }
}

// MARK: - Bespoke Session Row Status Badges

/// Compact amber `?` badge for sessions awaiting user input or approval.
public struct SHQuestionBadge: View {
    public init() {}

    public var body: some View {
        ZStack {
            Circle()
                .fill(SHColor.statusWarning)
                .frame(width: 15, height: 15)
            Image(systemName: "questionmark")
                .font(.system(size: 8.5, weight: .black))
                .foregroundStyle(Color(hex: 0x16171B))
        }
        .overlay(Circle().stroke(SHColor.surfaceSubtle, lineWidth: 1.75))
        .shadow(color: Color.black.opacity(0.35), radius: 2, y: 1)
    }
}

// MARK: - Synchronous In-Memory Media Image Cache (Zero-Flash Handoff)

@MainActor
public final class SHMediaImageCache {
    public static let shared = SHMediaImageCache()
    #if canImport(UIKit)
    private let cache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.countLimit = 120
        return c
    }()

    public func image(for path: String) -> UIImage? {
        guard !path.isEmpty else { return nil }
        return cache.object(forKey: path as NSString)
    }

    public func store(_ image: UIImage, for path: String) {
        guard !path.isEmpty else { return }
        cache.setObject(image, forKey: path as NSString)
    }

    public func store(data: Data, for path: String) {
        guard !path.isEmpty, let img = UIImage(data: data) else { return }
        cache.setObject(img, forKey: path as NSString)
    }
    #endif
}

/// Right-side Liquid Glass capsule combining an optional live activity ring and a menu button.
public struct SHGlassActionCapsule<MenuContent: View>: View {
    public let isBusy: Bool
    public let accentColor: Color
    @ViewBuilder public let menuContent: () -> MenuContent

    public init(
        isBusy: Bool,
        accentColor: Color,
        @ViewBuilder menuContent: @escaping () -> MenuContent
    ) {
        self.isBusy = isBusy
        self.accentColor = accentColor
        self.menuContent = menuContent
    }

    public var body: some View {
        HStack(spacing: 10) {
            if isBusy {
                ProgressView()
                    .controlSize(.small)
                    .tint(accentColor)
                    .frame(width: 20, height: 20)
            }
            Menu {
                menuContent()
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(SHColor.inkPrimary)
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Session actions")
        }
        .padding(.horizontal, isBusy ? 12 : 6)
        .frame(height: 38)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 0.75))
        .shadow(color: Color.black.opacity(0.32), radius: 8, y: 3)
    }
}

// MARK: - Grounded Composer Surface

/// Tactile elevated dark surface with soft shadow that stays anchored flush at the bottom.
public struct SHComposerSurface<Content: View>: View {
    @ViewBuilder public let content: () -> Content

    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    public var body: some View {
        content()
            .background(SHColor.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.09), lineWidth: 0.75)
            )
            .shadow(color: Color.black.opacity(0.42), radius: 16, x: 0, y: 4)
    }
}

// MARK: - Compact Inline Disclosure Row (Commands, Tools, Live Activity)

/// Dense single-line scannable disclosure row (e.g. `Ran 4 commands >` / `Running >`)
/// keeping consistent rhythm between transcript items without bulky boxes.
public struct SHInlineDisclosureRow: View {
    public let icon: String
    public let title: String
    public var trailingBadge: String? = nil
    public var trailingMeta: String? = nil
    public var tint: Color = SHColor.inkMuted
    public var isSpinning: Bool = false
    public var isExpanded: Bool = false
    public let action: () -> Void

    public init(
        icon: String,
        title: String,
        trailingBadge: String? = nil,
        trailingMeta: String? = nil,
        tint: Color = SHColor.inkMuted,
        isSpinning: Bool = false,
        isExpanded: Bool = false,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.title = title
        self.trailingBadge = trailingBadge
        self.trailingMeta = trailingMeta
        self.tint = tint
        self.isSpinning = isSpinning
        self.isExpanded = isExpanded
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if isSpinning {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(tint)
                        .frame(width: 14, height: 14)
                } else {
                    Image(systemName: icon)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(tint)
                        .frame(width: 14)
                }

                Text(title)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(SHColor.inkSecondary)
                    .lineLimit(1)

                if let trailingBadge, !trailingBadge.isEmpty {
                    Text(trailingBadge)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(SHColor.inkFaint)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(SHColor.surfaceRaised)
                        .clipShape(Capsule())
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(SHColor.inkFaint)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))

                Spacer(minLength: 8)

                if let trailingMeta, !trailingMeta.isEmpty {
                    Text(trailingMeta)
                        .font(.system(size: 11))
                        .foregroundStyle(SHColor.inkFaint)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Sensible Compact Attachment Thumbnails (Image, Video, File)

public struct SHAttachmentThumbItem: Identifiable, Equatable {
    public let id: String
    public let name: String
    public let path: String
    public let mimeType: String
    public let dataUrl: String?
    public let sizeBytes: Int?
    public let isUploading: Bool

    public var isImage: Bool { mimeType.lowercased().hasPrefix("image/") }
    public var isVideo: Bool { mimeType.lowercased().hasPrefix("video/") }

    public init(
        id: String,
        name: String,
        path: String = "",
        mimeType: String = "image/jpeg",
        dataUrl: String? = nil,
        sizeBytes: Int? = nil,
        isUploading: Bool = false
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.mimeType = mimeType
        self.dataUrl = dataUrl
        self.sizeBytes = sizeBytes
        self.isUploading = isUploading
    }
}

/// Compact rounded thumbnail strip for images, videos, and files — no giant letterboxed boxes
/// and no ugly raw `uploaded_media_...` filenames under photos.
public struct SHAttachmentThumbStrip: View {
    public let items: [SHAttachmentThumbItem]
    public var thumbSize: CGFloat = SHLayout.thumbSize
    public var onTap: ((SHAttachmentThumbItem) -> Void)? = nil
    public var onRemove: ((String) -> Void)? = nil
    public var onLoadMedia: ((String) async -> Data?)? = nil

    public init(
        items: [SHAttachmentThumbItem],
        thumbSize: CGFloat = SHLayout.thumbSize,
        onTap: ((SHAttachmentThumbItem) -> Void)? = nil,
        onRemove: ((String) -> Void)? = nil,
        onLoadMedia: ((String) async -> Data?)? = nil
    ) {
        self.items = items
        self.thumbSize = thumbSize
        self.onTap = onTap
        self.onRemove = onRemove
        self.onLoadMedia = onLoadMedia
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items) { item in
                    SHAttachmentThumbTile(
                        item: item,
                        thumbSize: thumbSize,
                        onTap: onTap,
                        onRemove: onRemove,
                        onLoadMedia: onLoadMedia
                    )
                }
            }
            .padding(.vertical, 2)
        }
    }
}

private struct SHAttachmentThumbTile: View {
    let item: SHAttachmentThumbItem
    let thumbSize: CGFloat
    let onTap: ((SHAttachmentThumbItem) -> Void)?
    let onRemove: ((String) -> Void)?
    let onLoadMedia: ((String) async -> Data?)?

    #if canImport(UIKit)
    @State private var remoteImage: UIImage?
    #endif

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button {
                onTap?(item)
            } label: {
                if item.isImage || item.isVideo {
                    mediaTile
                } else {
                    fileTile
                }
            }
            .buttonStyle(.plain)

            if let onRemove {
                Button {
                    onRemove(item.id)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(SHColor.inkPrimary, SHColor.surfaceRail)
                }
                .buttonStyle(.plain)
                .offset(x: 5, y: -5)
                .accessibilityLabel("Remove \(item.name)")
            }
        }
        .task(id: item.path) {
            #if canImport(UIKit)
            guard item.isImage,
                  DataURLImageDecoder.decode(item.dataUrl) == nil,
                  remoteImage == nil,
                  !item.path.isEmpty,
                  let loader = onLoadMedia else { return }
            if let cached = SHMediaImageCache.shared.image(for: item.path) {
                remoteImage = cached
                return
            }
            if let data = await loader(item.path), let img = UIImage(data: data) {
                SHMediaImageCache.shared.store(img, for: item.path)
                remoteImage = img
            }
            #endif
        }
    }

    private var mediaTile: some View {
        ZStack {
            #if canImport(UIKit)
            if let img = DataURLImageDecoder.decode(item.dataUrl) ?? SHMediaImageCache.shared.image(for: item.path) ?? remoteImage {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
            } else {
                SHColor.surfaceBubble
                Image(systemName: item.isVideo ? "video.fill" : "photo")
                    .font(.system(size: 18))
                    .foregroundStyle(SHColor.inkMuted)
            }
            #else
            SHColor.surfaceBubble
            Image(systemName: item.isVideo ? "video.fill" : "photo")
                .foregroundStyle(SHColor.inkMuted)
            #endif

            if item.isVideo {
                Image(systemName: "play.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(7)
                    .background(Color.black.opacity(0.55), in: Circle())
            }

            if item.isUploading {
                Color.black.opacity(0.42)
                ProgressView()
                    .controlSize(.mini)
                    .tint(.white)
            }
        }
        .frame(width: thumbSize, height: thumbSize)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.75)
        )
    }

    private var fileTile: some View {
        HStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(SHColor.surfaceBubble)
                    .frame(width: 32, height: 32)
                if item.isUploading {
                    ProgressView().controlSize(.mini).tint(SHColor.inkPrimary)
                } else {
                    Image(systemName: fileIconName(for: item.name, mime: item.mimeType))
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(SHColor.accentPrimary)
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(item.name)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(SHColor.inkPrimary)
                    .lineLimit(1)
                if let size = item.sizeBytes, size > 0 {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                        .font(.system(size: 10.5))
                        .foregroundStyle(SHColor.inkMuted)
                } else {
                    Text(fileExtBadge(for: item.name))
                        .font(.system(size: 10.5))
                        .foregroundStyle(SHColor.inkMuted)
                }
            }
            .frame(maxWidth: 120, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(height: max(48, min(thumbSize, 56)))
        .background(SHColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous)
                .strokeBorder(Color.white.opacity(0.09), lineWidth: 0.75)
        )
    }

    private func fileIconName(for name: String, mime: String) -> String {
        let lower = name.lowercased()
        if lower.hasSuffix(".pdf") || mime.contains("pdf") { return "doc.richtext" }
        if lower.hasSuffix(".zip") || lower.hasSuffix(".tar") || lower.hasSuffix(".gz") { return "doc.zipper" }
        if lower.hasSuffix(".swift") || lower.hasSuffix(".ts") || lower.hasSuffix(".py") || lower.hasSuffix(".go") || lower.hasSuffix(".json") {
            return "chevron.left.forwardslash.chevron.right"
        }
        if mime.hasPrefix("audio/") { return "waveform" }
        return "doc.fill"
    }

    private func fileExtBadge(for name: String) -> String {
        let ext = (name as NSString).pathExtension.uppercased()
        return ext.isEmpty ? "FILE" : ext
    }
}


// MARK: - Combined Super Harness Logo + Live Status Core

/// Renders the official Super Harness 3-arm geometric logo with its center core dynamically
/// tinted to reflect live host connection health (green = live, amber = connecting, red = error).
public struct SuperHarnessStatusLogo: View {
    public let statusColor: Color
    public var size: CGFloat = 22

    public init(statusColor: Color, size: CGFloat = 22) {
        self.statusColor = statusColor
        self.size = size
    }

    public var body: some View {
        Canvas { ctx, sz in
            let sx = sz.width / 24.0
            let sy = sz.height / 24.0
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * sx, y: y * sy) }

            var topArm = Path()
            topArm.move(to: pt(12, 2.2))
            topArm.addLine(to: pt(20.4, 7.05))
            topArm.addLine(to: pt(17.4, 8.8))
            topArm.addLine(to: pt(12, 5.65))
            topArm.addLine(to: pt(6.6, 8.8))
            topArm.addLine(to: pt(3.6, 7.05))
            topArm.closeSubpath()
            ctx.fill(
                topArm,
                with: .linearGradient(
                    Gradient(colors: [Color(hex: 0x818CF8), Color(hex: 0x60A5FA)]),
                    startPoint: pt(3, 3),
                    endPoint: pt(21, 12)
                )
            )

            var leftArm = Path()
            leftArm.move(to: pt(3.6, 8.95))
            leftArm.addLine(to: pt(6.6, 10.7))
            leftArm.addLine(to: pt(6.6, 16.2))
            leftArm.addLine(to: pt(11.15, 18.85))
            leftArm.addLine(to: pt(11.15, 22.3))
            leftArm.addLine(to: pt(3.6, 17.95))
            leftArm.closeSubpath()
            ctx.fill(
                leftArm,
                with: .linearGradient(
                    Gradient(colors: [Color(hex: 0x60A5FA), Color(hex: 0x10A37F)]),
                    startPoint: pt(4, 8),
                    endPoint: pt(12, 21)
                )
            )

            var rightArm = Path()
            rightArm.move(to: pt(20.4, 8.95))
            rightArm.addLine(to: pt(20.4, 17.95))
            rightArm.addLine(to: pt(12.85, 22.3))
            rightArm.addLine(to: pt(12.85, 18.85))
            rightArm.addLine(to: pt(17.4, 16.2))
            rightArm.addLine(to: pt(17.4, 10.7))
            rightArm.closeSubpath()
            ctx.fill(
                rightArm,
                with: .linearGradient(
                    Gradient(colors: [Color(hex: 0xD97757), Color(hex: 0x818CF8)]),
                    startPoint: pt(20, 8),
                    endPoint: pt(12, 21)
                )
            )

            // Live status core inside the logo
            var core = Path()
            core.move(to: pt(12, 8.4))
            core.addLine(to: pt(15.35, 10.35))
            core.addLine(to: pt(15.35, 14.25))
            core.addLine(to: pt(12, 16.2))
            core.addLine(to: pt(8.65, 14.25))
            core.addLine(to: pt(8.65, 10.35))
            core.closeSubpath()
            ctx.fill(core, with: .color(statusColor))
        }
        .frame(width: size, height: size)
        .shadow(color: statusColor.opacity(0.35), radius: 4, x: 0, y: 0)
    }
}

// MARK: - Radial Quota Gauge (harness switcher; mirrors desktop SegmentedControl `gauge` variant)

/// Circular quota ring drawn around a centered glyph. While `isWorking`, a conic "chaser"
/// rotates on the track underneath the usage arc, like the desktop sidebar gauges.
public struct SHRadialGauge<Center: View>: View {
    public let value: Double?
    public let tint: Color
    public var estimated: Bool = false
    public var isWorking: Bool = false
    public var isActive: Bool = false
    public var size: CGFloat = 34
    private let center: Center

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        value: Double?,
        tint: Color,
        estimated: Bool = false,
        isWorking: Bool = false,
        isActive: Bool = false,
        size: CGFloat = 34,
        @ViewBuilder center: () -> Center
    ) {
        self.value = value
        self.tint = tint
        self.estimated = estimated
        self.isWorking = isWorking
        self.isActive = isActive
        self.size = size
        self.center = center()
    }

    // Desktop draws radius 15 with a 2.3 stroke inside a 36pt box.
    private var lineWidth: CGFloat { size * 2.3 / 36 }
    private var ringInset: CGFloat { size * 3 / 36 - lineWidth / 2 }

    private var clamped: Double? {
        guard let value, value.isFinite else { return nil }
        return min(100, max(0, value))
    }

    /// A non-zero value always shows at least a 4% arc so it stays visible.
    private var displayFraction: Double {
        guard let clamped, clamped > 0 else { return 0 }
        return max(clamped, 4) / 100
    }

    private var stroke: Color {
        if let clamped, !estimated {
            if clamped >= 95 { return SHColor.statusDanger }
            if clamped >= 80 { return SHColor.statusWarning }
        }
        return tint
    }

    public var body: some View {
        ZStack {
            Circle()
                .inset(by: ringInset)
                .stroke(Color.white.opacity(isActive ? 0.13 : 0.08), lineWidth: lineWidth)

            if isWorking {
                chaser
            }

            if displayFraction > 0 {
                Circle()
                    .inset(by: ringInset)
                    .trim(from: 0, to: displayFraction)
                    .stroke(
                        stroke.opacity(estimated ? 0.78 : 0.96),
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.3), value: displayFraction)
            }

            center
        }
        .frame(width: size, height: size)
    }

    private var chaserRing: some View {
        Circle()
            .inset(by: ringInset)
            .stroke(
                AngularGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .clear, location: 120.0 / 360),
                        .init(color: stroke.opacity(0.16), location: 195.0 / 360),
                        .init(color: stroke.mix(with: .white, by: 0.4).opacity(0.62), location: 295.0 / 360),
                        .init(color: Color.white.opacity(0.92), location: 348.0 / 360),
                        .init(color: .clear, location: 1),
                    ],
                    center: .center
                ),
                lineWidth: lineWidth
            )
    }

    @ViewBuilder
    private var chaser: some View {
        if reduceMotion {
            chaserRing.rotationEffect(.degrees(-90))
        } else {
            // One turn every 2.2s, matching desktop `sh-gauge-spin`.
            TimelineView(.animation) { context in
                let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.2) / 2.2
                chaserRing.rotationEffect(.degrees(turn * 360 - 90))
            }
        }
    }
}
