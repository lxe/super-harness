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

/// Compact centered Liquid Glass header pill with smaller title + subtle project subtitle.
public struct SHFloatingTitlePill: View {
    public let title: String
    public let subtitle: String?
    public var onTap: (() -> Void)? = nil

    public init(title: String, subtitle: String? = nil, onTap: (() -> Void)? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.onTap = onTap
    }

    public var body: some View {
        let content = VStack(spacing: 1) {
            Text(title)
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(SHColor.inkPrimary)
                .lineLimit(1)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(SHColor.inkMuted)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, subtitle?.isEmpty == false ? 6 : 9)
        .frame(maxWidth: 215)
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
            .shadow(color: Color.black.opacity(0.48), radius: 14, x: 0, y: -3)
    }
}

// MARK: - Compact Inline Disclosure Row (Commands, Tools, Live Activity)

/// Dense single-line scannable disclosure row (e.g. `Ran 4 commands >` / `Running >`)
/// keeping consistent rhythm between transcript items without bulky boxes.
public struct SHInlineDisclosureRow: View {
    public let icon: String
    public let title: String
    public var trailingBadge: String? = nil
    public var tint: Color = SHColor.inkMuted
    public var isSpinning: Bool = false
    public var isExpanded: Bool = false
    public let action: () -> Void

    public init(
        icon: String,
        title: String,
        trailingBadge: String? = nil,
        tint: Color = SHColor.inkMuted,
        isSpinning: Bool = false,
        isExpanded: Bool = false,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.title = title
        self.trailingBadge = trailingBadge
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

                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
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
            if let data = await loader(item.path), let img = UIImage(data: data) {
                remoteImage = img
            }
            #endif
        }
    }

    private var mediaTile: some View {
        ZStack {
            #if canImport(UIKit)
            if let img = DataURLImageDecoder.decode(item.dataUrl) ?? remoteImage {
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
