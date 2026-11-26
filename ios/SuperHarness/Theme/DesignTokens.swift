import SwiftUI

// MARK: - Obsidian Design Tokens (matched to src/renderer/ui/tokens.css)

public enum SHColor {
    // Surface elevation scale (recessed -> elevated)
    public static let surfaceCode = Color(hex: 0x101114)
    public static let surfaceRail = Color(hex: 0x111215)
    public static let surfaceCanvas = Color(hex: 0x16171B)
    public static let surfaceSubtle = Color(hex: 0x181A1F)
    public static let surfacePopover = Color(hex: 0x1A1C22)
    public static let surfaceRaised = Color(hex: 0x1F2128)
    public static let surfaceBubble = Color(hex: 0x23252C)

    // Ink / text hierarchy
    public static let inkPrimary = Color(hex: 0xF1F3F7)
    public static let inkSecondary = Color(hex: 0xC8CCD6)
    public static let inkMuted = Color(hex: 0x8B909E)
    public static let inkFaint = Color(hex: 0x5F6472)

    // Harness brand accents
    public static let brandAntigravity = Color(hex: 0x60A5FA)
    public static let brandCodex = Color(hex: 0x10A37F)
    public static let brandClaude = Color(hex: 0xD97757)
    public static let brandMuse = Color(hex: 0xA855F7)
    public static let brandPi = Color(hex: 0x22D3EE)
    public static let brandMaster = Color(hex: 0x818CF8)

    // Semantic accents
    public static let accentPrimary = Color(hex: 0x818CF8)
    public static let statusSuccess = Color(hex: 0x34D399)
    public static let statusWarning = Color(hex: 0xFBBF24)
    public static let statusDanger = Color(hex: 0xFB7185)

    // Border tokens
    public static let lineHairline = Color.white.opacity(0.06)
    public static let lineSubtle = Color.white.opacity(0.10)
    public static let lineStrong = Color.white.opacity(0.18)

    public static func harness(_ kind: HarnessKind) -> Color {
        switch kind {
        case .master: return brandMaster
        case .antigravity: return brandAntigravity
        case .codex: return brandCodex
        case .claudeTmux, .claudeDesktop, .claudeCli: return brandClaude
        case .muse: return brandMuse
        case .pi: return brandPi
        }
    }

    public static func harness(_ group: HarnessGroup) -> Color {
        switch group {
        case .antigravity: return brandAntigravity
        case .codex: return brandCodex
        case .claude: return brandClaude
        case .muse: return brandMuse
        case .pi: return brandPi
        }
    }

    public static func harnessOrMaster(_ group: HarnessGroupOrMaster) -> Color {
        switch group {
        case .master: return brandMaster
        case .antigravity: return brandAntigravity
        case .codex: return brandCodex
        case .claude: return brandClaude
        case .muse: return brandMuse
        case .pi: return brandPi
        }
    }

    public static func percentageTone(_ percent: Double) -> Color {
        if percent >= 95 { return statusDanger }
        if percent >= 80 { return statusWarning }
        return inkPrimary
    }
}

public enum SHSpacing {
    public static let xxs: CGFloat = 2
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
    public static let xl: CGFloat = 20
    public static let xxl: CGFloat = 24
}

public enum SHRadius {
    public static let sm: CGFloat = 6
    public static let md: CGFloat = 10
    public static let lg: CGFloat = 14
    public static let xl: CGFloat = 18
    public static let pill: CGFloat = 999
}

public enum SHTypography {
    public static let heroNumber = Font.system(size: 28, weight: .semibold, design: .default)
    public static let title = Font.system(size: 18, weight: .semibold, design: .default)
    public static let heading = Font.system(size: 15.5, weight: .semibold, design: .default)
    public static let body = Font.system(size: 15, weight: .regular, design: .default)
    public static let label = Font.system(size: 14, weight: .medium, design: .default)
    public static let caption = Font.system(size: 13, weight: .regular, design: .default)
    public static let micro = Font.system(size: 12, weight: .regular, design: .default)
    public static let mono = Font.system(size: 12.5, weight: .regular, design: .monospaced)
    public static let monoSmall = Font.system(size: 11.5, weight: .regular, design: .monospaced)
}

public extension Color {
    init(hex: UInt32, alpha: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }

    init(cssHex: String, fallback: Color = SHColor.accentPrimary) {
        let cleaned = cssHex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        guard cleaned.count == 6, let value = UInt32(cleaned, radix: 16) else {
            self = fallback
            return
        }
        self.init(hex: value)
    }
}

// MARK: - Harness Visual Metadata

public struct HarnessVisual: Sendable {
    public let label: String
    public let shortLabel: String
    public let symbolName: String
    public let color: Color

    public static func forKind(_ kind: HarnessKind) -> HarnessVisual {
        switch kind {
        case .master:
            return HarnessVisual(
                label: "Master",
                shortLabel: "Master",
                symbolName: "sparkles",
                color: SHColor.brandMaster
            )
        case .antigravity:
            return HarnessVisual(
                label: "Antigravity",
                shortLabel: "AGY",
                symbolName: "atom",
                color: SHColor.brandAntigravity
            )
        case .codex:
            return HarnessVisual(
                label: "Codex",
                shortLabel: "Codex",
                symbolName: "chevron.left.forwardslash.chevron.right",
                color: SHColor.brandCodex
            )
        case .claudeTmux:
            return HarnessVisual(
                label: "Claude tmux",
                shortLabel: "Claude",
                symbolName: "terminal",
                color: SHColor.brandClaude
            )
        case .claudeDesktop:
            return HarnessVisual(
                label: "Claude Desktop",
                shortLabel: "Claude",
                symbolName: "sun.max.fill",
                color: SHColor.brandClaude
            )
        case .claudeCli:
            return HarnessVisual(
                label: "Claude CLI",
                shortLabel: "Claude",
                symbolName: "sun.max.fill",
                color: SHColor.brandClaude
            )
        case .muse:
            return HarnessVisual(
                label: "Muse",
                shortLabel: "Muse",
                symbolName: "circle.dashed",
                color: SHColor.brandMuse
            )
        case .pi:
            return HarnessVisual(
                label: "Pi",
                shortLabel: "Pi",
                symbolName: "function",
                color: SHColor.brandPi
            )
        }
    }

    public static func forGroup(_ group: HarnessGroup) -> HarnessVisual {
        switch group {
        case .antigravity: return forKind(.antigravity)
        case .codex: return forKind(.codex)
        case .claude: return forKind(.claudeCli)
        case .muse: return forKind(.muse)
        case .pi: return forKind(.pi)
        }
    }
}

// MARK: - Reusable Obsidian Primitives

/// Official vector SVG brand logo for each AI coding harness (matched 1:1 with desktop HarnessLogo.tsx).
public struct HarnessLogoView: View {
    public let harness: HarnessKind
    public var size: CGFloat = 16

    public init(harness: HarnessKind, size: CGFloat = 16) {
        self.harness = harness
        self.size = size
    }

    public init(group: HarnessGroup, size: CGFloat = 16) {
        self.harness = group.defaultKind
        self.size = size
    }

    private var assetName: String {
        switch harness {
        case .antigravity: return "HarnessAntigravity"
        case .codex: return "HarnessCodex"
        case .claudeTmux, .claudeDesktop, .claudeCli: return "HarnessClaude"
        case .muse: return "HarnessMuse"
        case .pi: return "HarnessPi"
        case .master: return "HarnessMaster"
        }
    }

    public var body: some View {
        Image(assetName)
            .renderingMode(.original)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

public struct HarnessIconView: View {
    public let kind: HarnessKind
    public var size: CGFloat = 14

    public init(kind: HarnessKind, size: CGFloat = 14) {
        self.kind = kind
        self.size = size
    }

    public init(group: HarnessGroup, size: CGFloat = 14) {
        self.kind = group.defaultKind
        self.size = size
    }

    public var body: some View {
        HarnessLogoView(harness: kind, size: size)
    }
}

public struct ObsidianProgressBar: View {
    public let value: Double?
    public let tint: Color
    public var pacePercent: Double?
    public var muted: Bool = false
    public var estimated: Bool = false
    public var height: CGFloat = 5

    public init(
        value: Double?,
        tint: Color,
        pacePercent: Double? = nil,
        muted: Bool = false,
        estimated: Bool = false,
        height: CGFloat = 5
    ) {
        self.value = value
        self.tint = tint
        self.pacePercent = pacePercent
        self.muted = muted
        self.estimated = estimated
        self.height = height
    }

    public var body: some View {
        let clamped = min(100, max(0, value ?? 0))
        GeometryReader { geo in
            let width = geo.size.width
            let fillWidth = width * CGFloat(clamped / 100.0)
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.white.opacity(0.08))
                    .frame(height: height)

                if value != nil {
                    Capsule()
                        .fill(barFill(clamped: clamped))
                        .frame(width: max(clamped > 0 ? height : 0, fillWidth), height: height)
                }

                if let pace = pacePercent, pace > 2, pace < 98 {
                    let tickX = width * CGFloat(pace / 100.0)
                    Rectangle()
                        .fill(SHColor.inkPrimary.opacity(0.85))
                        .frame(width: 1.5, height: height + 5)
                        .offset(x: tickX - 0.75)
                }
            }
            .frame(maxHeight: .infinity, alignment: .center)
        }
        .frame(height: max(height + 5, 10))
    }

    private func barFill(clamped: Double) -> Color {
        if clamped >= 95 { return SHColor.statusDanger }
        if clamped >= 80 && !muted { return SHColor.statusWarning }
        if estimated { return tint.opacity(0.45) }
        return muted ? tint.opacity(0.60) : tint
    }
}

// MARK: - Raised and Recessed Surfaces

/// Depth levels shared with the desktop app. A raised surface is borderless: a soft drop
/// shadow below it and a one-point light edge along its top make it read as lifted. These
/// are for content inside the scroll area (bubbles, cards, wells); bars and floating
/// controls keep Liquid Glass.
public enum SHElevation: Sendable {
    /// Cards and collapsible blocks.
    case card
    /// The user's message bubble, which sits slightly higher than a card.
    case bubble
    /// Small tiles and chips.
    case tile

    var shadowOpacity: Double {
        switch self {
        case .card: return 0.34
        case .bubble: return 0.30
        case .tile: return 0.32
        }
    }

    var shadowRadius: CGFloat {
        switch self {
        case .card, .bubble: return 5
        case .tile: return 3.5
        }
    }

    var shadowOffset: CGFloat {
        switch self {
        case .card, .bubble: return 4
        case .tile: return 2
        }
    }

    var topHighlightOpacity: Double {
        switch self {
        case .card: return 0.05
        case .bubble: return 0.07
        case .tile: return 0.04
        }
    }
}

public extension View {
    /// Clips the view to a rounded shape and draws a raised surface behind it.
    func shRaisedSurface(
        _ fill: Color,
        cornerRadius: CGFloat,
        elevation: SHElevation = .card
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return self
            .clipShape(shape)
            .background(
                shape.fill(
                    fill
                        .shadow(.inner(color: .white.opacity(elevation.topHighlightOpacity), radius: 0, y: 1))
                        .shadow(.drop(color: .black.opacity(elevation.shadowOpacity), radius: elevation.shadowRadius, y: elevation.shadowOffset))
                )
            )
    }

    /// Clips the view to a rounded shape and draws a well that looks pressed into the page:
    /// a darker fill with a soft shadow under its top edge. Used for terminal, diff and tool
    /// output.
    func shRecessedWell(_ fill: Color = SHColor.surfaceCode, cornerRadius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return self
            .clipShape(shape)
            .background(
                shape.fill(fill.shadow(.inner(color: .black.opacity(0.42), radius: 1.5, y: 1)))
            )
            .overlay(alignment: .bottom) {
                shape
                    .strokeBorder(
                        LinearGradient(colors: [.clear, .white.opacity(0.045)], startPoint: .center, endPoint: .bottom),
                        lineWidth: 0.75
                    )
                    .allowsHitTesting(false)
            }
    }
}
