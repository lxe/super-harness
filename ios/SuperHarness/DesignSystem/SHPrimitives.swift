import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Layout Measurements

public enum SHLayout {
    /// Side margin of a chat's scroll content.
    public static let screenPad: CGFloat = 14
    /// Gap between stacked step rows.
    public static let itemGap: CGFloat = 6
    /// Attachment thumbnail in a message.
    public static let thumbSize: CGFloat = 76
    /// Attachment thumbnail in the composer.
    public static let composerThumbSize: CGFloat = 56
    /// Diameter of the composer's round controls and height of its model menu.
    public static let controlSize: CGFloat = 38
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

// MARK: - Grounded Composer Surface

/// Tactile elevated dark surface matching desktop's borderless 22px squircle composer.
public struct SHComposerSurface<Content: View>: View {
    @ViewBuilder public let content: () -> Content

    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    public var body: some View {
        content()
            .shRaisedSurface(SHColor.surfaceRaised, cornerRadius: SHRadius.panel, elevation: .card)
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
    /// The title shimmers, as a working chat's title does, while the icon stays put.
    public var isShimmering: Bool = false
    public var isExpanded: Bool = false
    /// False when there is nothing to open: the row then has no chevron and does not respond to taps.
    public var isExpandable: Bool = true
    public let action: () -> Void

    public init(
        icon: String,
        title: String,
        trailingBadge: String? = nil,
        trailingMeta: String? = nil,
        tint: Color = SHColor.inkMuted,
        isSpinning: Bool = false,
        isShimmering: Bool = false,
        isExpanded: Bool = false,
        isExpandable: Bool = true,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.title = title
        self.trailingBadge = trailingBadge
        self.trailingMeta = trailingMeta
        self.tint = tint
        self.isSpinning = isSpinning
        self.isShimmering = isShimmering
        self.isExpanded = isExpanded
        self.isExpandable = isExpandable
        self.action = action
    }

    public var body: some View {
        Button(action: { if isExpandable { action() } }) {
            HStack(spacing: 7) {
                if isSpinning {
                    SHActivityPulse(tint: tint, size: 12)
                        .frame(width: 14, height: 14)
                } else {
                    Image(systemName: icon)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(tint)
                        .frame(width: 14)
                }

                if isShimmering {
                    SHShimmerText(text: title, font: .system(size: 13.5, weight: .medium), isActive: true)
                        .lineLimit(1)
                } else {
                    Text(title)
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(SHColor.inkSecondary)
                        .lineLimit(1)
                }

                if let trailingBadge, !trailingBadge.isEmpty {
                    Text(trailingBadge)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(SHColor.inkFaint)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(SHColor.surfaceRaised)
                        .clipShape(Capsule())
                }

                if isExpandable {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(SHColor.inkFaint)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }

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
        let hasRemove = onRemove != nil
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: hasRemove ? 12 : 8) {
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
            .padding(.top, hasRemove ? 10 : 2)
            .padding(.bottom, hasRemove ? 4 : 2)
            .padding(.leading, hasRemove ? 2 : 0)
            .padding(.trailing, hasRemove ? 10 : 0)
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
                    // Same relief as the composer's round controls below it.
                    Image(systemName: "xmark")
                        .font(.system(size: 9.5, weight: .bold))
                        .foregroundStyle(SHColor.inkPrimary)
                        .frame(width: 20, height: 20)
                        .shRaisedControl(SHColor.surfaceBubble, in: Circle())
                    .frame(width: 28, height: 28)
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .offset(x: 10, y: -10)
                .accessibilityLabel("Remove \(item.name)")
                .accessibilityIdentifier("attachment.remove.\(item.id)")
            }
        }
        .task(id: item.path) {
            #if canImport(UIKit)
            // A video's path loads as a poster frame: the host answers a sized request for a
            // video with one JPEG frame.
            guard item.isImage || item.isVideo,
                  DataURLImageDecoder.decode(item.dataUrl) == nil,
                  remoteImage == nil,
                  !item.path.isEmpty,
                  let loader = onLoadMedia else { return }
            if let cached = SHMediaImageCache.shared.image(for: item.path) {
                remoteImage = cached
                return
            }
            // Retries with pauses: the file behind a freshly generated image may not be complete yet.
            if let img = await MediaRetryLoader.load(path: item.path, loader: loader, decode: { UIImage(data: $0) }) {
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
                SHActivityPulse(tint: .white, size: 16)
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
                RoundedRectangle(cornerRadius: SHRadius.concentric(SHRadius.md, inset: 8), style: .continuous)
                    .fill(SHColor.surfaceBubble)
                    .frame(width: 32, height: 32)
                if item.isUploading {
                    SHActivityPulse(tint: SHColor.accentPrimary, size: 16)
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

    // Thicker refined 3.1 stroke inside a 36pt coordinate box (matches Desktop SegmentedControl).
    private var lineWidth: CGFloat { size * 3.1 / 36 }
    private var ringInset: CGFloat { max(lineWidth / 2 + 0.5, size * 3.0 / 36 - lineWidth / 2) }

    private var clamped: Double? {
        guard let value, value.isFinite else { return nil }
        return min(100, max(0, value))
    }

    /// A non-zero value always shows at least a 4% arc so it stays visible.
    private var displayFraction: Double {
        guard let clamped, clamped > 0 else { return 0 }
        return max(clamped, 4) / 100
    }

    /// Shared gauge color resolution (warning >= 80%, danger >= 95%, else harness tint).
    /// Used by both `SHRadialGauge` and `AppStore.gaugeTint(for:)` so orbs always match the gauge.
    public static func resolvedTint(base: Color, value: Double?, estimated: Bool = false) -> Color {
        if let value, value.isFinite, !estimated {
            let c = min(100, max(0, value))
            if c >= 95 { return SHColor.statusDanger }
            if c >= 80 { return SHColor.statusWarning }
        }
        return base
    }

    private var stroke: Color {
        Self.resolvedTint(base: tint, value: clamped, estimated: estimated)
    }

    public var body: some View {
        if isWorking && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                let sweepDeg = (t / 2.6).truncatingRemainder(dividingBy: 1.0) * 360.0
                gaugeContent(sweepDeg: sweepDeg)
            }
        } else {
            gaugeContent(sweepDeg: 0)
        }
    }

    /// The coloured usage arc as a shape, used to confine the working pulse to the arc.
    private func arcShape(lineWidth: CGFloat) -> some View {
        Circle()
            .inset(by: ringInset)
            .trim(from: 0, to: displayFraction)
            .stroke(Color.white, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
            .rotationEffect(.degrees(-90))
    }

    /// A lighter, still saturated version of `color` in the same hue.
    public static func brightened(_ color: Color) -> Color {
        let hsb = SHActivityPulse.hsbComponents(of: color)
        return Color(hue: hsb.hue, saturation: hsb.sat * 0.82, brightness: min(1, hsb.bright * 1.3 + 0.08))
    }

    /// A soft swell of colour: it rises smoothly from nothing to full strength and falls
    /// away just as smoothly (a raised-cosine curve over `spanDegrees`), so no point on the
    /// ring jumps from dark to bright.
    static func pulseGradient(color: Color, spanDegrees: Double = 200) -> AngularGradient {
        let steps = 16
        var stops: [Gradient.Stop] = (0...steps).map { i in
            let u = Double(i) / Double(steps)
            let strength = 0.5 - 0.5 * cos(2 * Double.pi * u)
            return Gradient.Stop(color: color.opacity(strength), location: u * spanDegrees / 360.0)
        }
        stops.append(Gradient.Stop(color: color.opacity(0), location: 1.0))
        return AngularGradient(gradient: Gradient(stops: stops), center: .center)
    }

    @ViewBuilder
    private func gaugeContent(sweepDeg: Double) -> some View {
        ZStack {
            // Ring stack: track, usage arc, and the working pulse.
            ZStack {
                // 1. Recessed circular track
                Circle()
                    .inset(by: ringInset)
                    .stroke(Color.white.opacity(isActive ? 0.15 : 0.09), lineWidth: lineWidth)

                // 2. Colored usage gauge arc
                if displayFraction > 0 {
                    Circle()
                        .inset(by: ringInset)
                        .trim(from: 0, to: displayFraction)
                        .stroke(
                            stroke.opacity(estimated ? 0.92 : 1.0),
                            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))
                        .animation(.easeOut(duration: 0.3), value: displayFraction)
                }

                // 3. Working: a soft swell of the gauge's own colour travels round the ring. It
                // is drawn in the arc's hue (never white), so the colour gets brighter where it
                // passes instead of being washed out, and it fades in and out with no hard edge.
                if isWorking {
                    // Over the empty track the pulse is a faint tint of the same hue.
                    Circle()
                        .inset(by: ringInset)
                        .stroke(Self.pulseGradient(color: stroke.opacity(0.42)), lineWidth: lineWidth)
                        .rotationEffect(.degrees(sweepDeg))

                    if displayFraction > 0 {
                        let bright = Self.brightened(stroke)
                        // Soft halo in the same hue: reads as the arc emitting light.
                        Circle()
                            .inset(by: ringInset)
                            .stroke(Self.pulseGradient(color: bright), lineWidth: lineWidth * 1.5)
                            .rotationEffect(.degrees(sweepDeg))
                            .blur(radius: size * 0.055)
                            .blendMode(.plusLighter)
                            .mask(arcShape(lineWidth: lineWidth * 2.2).blur(radius: size * 0.045))
                        // The brightened arc itself.
                        Circle()
                            .inset(by: ringInset)
                            .stroke(Self.pulseGradient(color: bright), lineWidth: lineWidth)
                            .rotationEffect(.degrees(sweepDeg))
                            .mask(arcShape(lineWidth: lineWidth))
                    }
                }
            }
            // Room for the halo, which would otherwise be cut off at the gauge's square bounds.
            .padding(size * 0.15)
            .compositingGroup()
            .padding(-size * 0.15)

            center
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Activity Indicator (the animated porcelain mark)

/// The app's working indicator. It draws `SHWorkingMark`; the name is kept because every
/// call site uses it.
public struct SHActivityPulse: View {
    public let tint: Color
    public var size: CGFloat = 14

    public init(tint: Color, size: CGFloat = 14) {
        self.tint = tint
        self.size = size
    }

    private var renderSize: CGFloat {
        max(size, 16)
    }

    // The working indicator is the porcelain mark with a pulse travelling round its pieces,
    // the same as the desktop's. Every call site keeps using SHActivityPulse.
    public var body: some View {
        SHWorkingMark(tint: tint, size: renderSize)
    }

    public static func hsbComponents(of color: Color) -> (hue: Double, sat: Double, bright: Double) {
        #if canImport(UIKit)
        var h: CGFloat = 0
        var s: CGFloat = 0
        var b: CGFloat = 0
        var a: CGFloat = 0
        if UIColor(color).getHue(&h, saturation: &s, brightness: &b, alpha: &a) {
            return (Double(h), Double(s), Double(b))
        }
        var white: CGFloat = 0
        if UIColor(color).getWhite(&white, alpha: &a) {
            return (0, 0, Double(white))
        }
        #endif
        return (0.62, 0.55, 0.90)
    }
}

// MARK: - Liquid Glass Surface

/// Liquid Glass for floating chrome: the dock, the header pills, the New Chat button. Before
/// iOS 26 it falls back to a thin material with a light edge.
private struct SHGlassSurfaceModifier<S: Shape>: ViewModifier {
    let shape: S

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: shape)
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(Color.white.opacity(0.14), lineWidth: 0.75))
        }
    }
}

public extension View {
    /// Floating Liquid Glass chrome in `shape`. Content inside the scroll area uses
    /// `shRaisedSurface` and `shRecessedWell` instead.
    func shGlassSurface<S: Shape>(in shape: S) -> some View {
        modifier(SHGlassSurfaceModifier(shape: shape))
    }
}

// MARK: - Working Title Shimmer

/// A one-line title that shows activity by itself: while `isActive`, a soft band of light
/// sweeps across the letters. It matches the desktop `.sh-working-shimmer` (muted grey to
/// near-white and back, one sweep every 2.6 seconds, eased in and out).
struct SHShimmerText: View {
    let text: String
    let font: Font
    let isActive: Bool
    var period: Double = 2.6

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let dim = Color(red: 161 / 255, green: 166 / 255, blue: 179 / 255).opacity(0.72)
    private static let bright = Color.white
    /// The band: resting grey at both ends and a tight white core, so the highlight reads as
    /// a clear glint crossing the text while the resting colour stays as it was.
    private static let band = Gradient(stops: [
        .init(color: dim, location: 0),
        .init(color: dim, location: 0.22),
        .init(color: bright, location: 0.44),
        .init(color: bright, location: 0.56),
        .init(color: dim, location: 0.78),
        .init(color: dim, location: 1),
    ])

    /// Centre of the bright band at `time`, in units of the text width. It travels from just
    /// left of the text to just right of it, eased in and out, then starts again.
    nonisolated static func bandCenter(at time: Double, period: Double) -> Double {
        let linear = (time / period).truncatingRemainder(dividingBy: 1)
        let progress = linear < 0 ? linear + 1 : linear
        let eased = 0.5 - 0.5 * cos(progress * .pi)
        return -0.6 + eased * 2.2
    }

    var body: some View {
        if isActive && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let center = Self.bandCenter(at: context.date.timeIntervalSinceReferenceDate, period: period)
                label.foregroundStyle(
                    LinearGradient(
                        gradient: Self.band,
                        startPoint: UnitPoint(x: center - 0.6, y: 0.5),
                        endPoint: UnitPoint(x: center + 0.6, y: 0.5)
                    )
                )
            }
            .accessibilityLabel("\(text), working")
        } else {
            label.foregroundStyle(SHColor.inkPrimary)
        }
    }

    private var label: some View {
        Text(text)
            .font(font)
            .lineLimit(1)
            .truncationMode(.tail)
    }
}

// MARK: - Toolbar Logo

/// The Superharness mark shown in the middle of the session list's top bar.
struct SHToolbarLogo: View {
    var body: some View {
        // The porcelain mark, a single-colour template tinted porcelain white.
        Image("SuperHarnessLogo")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(SHColor.porcelain)
            .frame(width: 26, height: 26)
            .accessibilityLabel("Superharness")
            .accessibilityIdentifier("header.logo")
    }
}

// MARK: - Round Control

/// The face of a round control in the composer: quiet for secondary actions (attach, mic),
/// prominent for the one main action (send, stop).
public struct SHRoundControlLabel: View {
    public let systemImage: String
    public var symbolSize: CGFloat = 16
    public var weight: Font.Weight = .semibold
    public var isProminent: Bool = false

    public init(systemImage: String, symbolSize: CGFloat = 16, weight: Font.Weight = .semibold, isProminent: Bool = false) {
        self.systemImage = systemImage
        self.symbolSize = symbolSize
        self.weight = weight
        self.isProminent = isProminent
    }

    public var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: symbolSize, weight: weight))
            .foregroundStyle(isProminent ? SHColor.surfaceRail : SHColor.inkSecondary)
            .frame(width: SHLayout.controlSize, height: SHLayout.controlSize)
            .shRaisedControl(isProminent ? SHColor.inkPrimary : SHColor.surfaceBubble, in: Circle())
    }
}

// MARK: - Section Cards (Settings, Usage)

/// Measurements shared by every row in a section card, so icons, labels and dividers line up.
public enum SHCardMetrics {
    public static let iconColumn: CGFloat = 28
    public static let iconGap: CGFloat = 12
    public static let rowInset: CGFloat = 14
    public static var labelInset: CGFloat { rowInset + iconColumn + iconGap }
}

/// A quiet title above one raised card of rows.
public struct SHSectionCard<Content: View>: View {
    public let title: String
    @ViewBuilder public let content: () -> Content

    public init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(SHColor.inkMuted)
                .padding(.leading, 6)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .shRaisedSurface(SHColor.surfaceSubtle, cornerRadius: SHRadius.lg, elevation: .card)
        }
    }
}

/// A hairline between card rows, starting at the label so it lines up in every card.
public struct SHCardDivider: View {
    public init() {}

    public var body: some View {
        Rectangle()
            .fill(SHColor.lineHairline)
            .frame(height: 1)
            .padding(.leading, SHCardMetrics.labelInset)
    }
}

public struct SHCardRowPadding: ViewModifier {
    public init() {}

    public func body(content: Content) -> some View {
        content
            .frame(minHeight: 40)
            .padding(.horizontal, SHCardMetrics.rowInset)
            .padding(.vertical, 6)
    }
}

/// Title with one optional quiet line under it.
public struct SHCardRowLabel: View {
    public let title: String
    public var detail: String? = nil
    public var tint: Color = SHColor.inkPrimary
    public var detailColor: Color = SHColor.inkMuted

    public init(title: String, detail: String? = nil, tint: Color = SHColor.inkPrimary, detailColor: Color = SHColor.inkMuted) {
        self.title = title
        self.detail = detail
        self.tint = tint
        self.detailColor = detailColor
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(tint)
                .lineLimit(1)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(SHTypography.caption)
                    .foregroundStyle(detailColor)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }
}

/// Icon in the fixed leading column, then the label.
public struct SHCardIconLabel: View {
    public let icon: String
    public let title: String
    public var detail: String? = nil
    public var tint: Color = SHColor.inkPrimary
    public var detailColor: Color = SHColor.inkMuted

    public init(icon: String, title: String, detail: String? = nil, tint: Color = SHColor.inkPrimary, detailColor: Color = SHColor.inkMuted) {
        self.icon = icon
        self.title = title
        self.detail = detail
        self.tint = tint
        self.detailColor = detailColor
    }

    public var body: some View {
        HStack(spacing: SHCardMetrics.iconGap) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(tint == SHColor.inkPrimary ? SHColor.inkSecondary : tint)
                .frame(width: SHCardMetrics.iconColumn, height: SHCardMetrics.iconColumn)
            SHCardRowLabel(title: title, detail: detail, tint: tint, detailColor: detailColor)
        }
    }
}

/// The one card row layout: icon column, label, optional trailing content.
public struct SHCardRow<Trailing: View>: View {
    public let icon: String
    public let title: String
    public var detail: String? = nil
    public var tint: Color = SHColor.inkPrimary
    public var detailColor: Color = SHColor.inkMuted
    @ViewBuilder public let trailing: () -> Trailing

    public init(
        icon: String,
        title: String,
        detail: String? = nil,
        tint: Color = SHColor.inkPrimary,
        detailColor: Color = SHColor.inkMuted,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.icon = icon
        self.title = title
        self.detail = detail
        self.tint = tint
        self.detailColor = detailColor
        self.trailing = trailing
    }

    public var body: some View {
        HStack(spacing: 8) {
            SHCardIconLabel(icon: icon, title: title, detail: detail, tint: tint, detailColor: detailColor)
            Spacer(minLength: 8)
            trailing()
        }
        .modifier(SHCardRowPadding())
        .contentShape(Rectangle())
    }
}

// MARK: - Choice Bar

/// A full-height row of choices, one selected: the same job as a segmented control, at a size
/// that is comfortable to tap and read.
struct SHChoiceBar<Value: Hashable>: View {
    let options: [(value: Value, label: String)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let isSelected = option.value == selection
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { selection = option.value }
                } label: {
                    Text(option.label)
                        .font(.system(size: 15, weight: isSelected ? .semibold : .regular))
                        .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .background(
                            isSelected ? Color.white.opacity(0.14) : Color.clear,
                            in: RoundedRectangle(cornerRadius: SHRadius.concentric(SHRadius.lg, inset: 4), style: .continuous)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(4)
        .background(SHColor.surfaceCanvas, in: RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
    }
}
