import SwiftUI

// MARK: - Obsidian Design Tokens (matched to src/renderer/ui/tokens.css)

public enum SHColor {
    // Unified OKLCH hue-268 cool blue-violet obsidian surface scale (matched to src/renderer/ui/tokens.css)
    public static let surfaceCode = Color(hex: 0x0E1015)
    public static let surfaceRail = Color(hex: 0x101218)
    public static let surfaceCanvas = Color(hex: 0x15171D)
    public static let surfaceSubtle = Color(hex: 0x181B22)
    public static let surfacePopover = Color(hex: 0x1C1F26)
    public static let surfaceRaised = Color(hex: 0x20232B)
    public static let surfaceBubble = Color(hex: 0x242830)
    public static let surfaceHover = Color(hex: 0x292C35)

    // Ink / text hierarchy (same 268 cool-obsidian hue)
    public static let inkPrimary = Color(hex: 0xEEF0F5)
    public static let inkSecondary = Color(hex: 0xC6C9D0)
    public static let inkMuted = Color(hex: 0x8E929C)
    public static let inkFaint = Color(hex: 0x646770)

    // Harness brand accents
    public static let brandAntigravity = Color(hex: 0x60A5FA)
    public static let brandCodex = Color(hex: 0x10A37F)
    public static let brandClaude = Color(hex: 0xD97757)
    public static let brandMuse = Color(hex: 0xA855F7)
    public static let brandPi = Color(hex: 0x22D3EE)
    /// The orchestrator's colour. Neutral: the app keeps purple out entirely.
    public static let brandMaster = Color(hex: 0xD3D7E0)

    // Semantic accents
    /// The app's accent for text buttons, links in chrome and progress marks: a neutral
    /// near-white.
    public static let accentPrimary = Color(hex: 0xE4E6EC)
    /// The blue for links, in-progress marks, diff hunk headers and informational notices. It is
    /// the same blue as Antigravity's brand colour; use this name wherever the meaning is
    /// "information", and `brandAntigravity` only for the harness itself.
    public static let accentInfo = brandAntigravity
    /// The white of the Superharness porcelain mark.
    public static let porcelain = Color(hex: 0xF1F2F5)
    /// The "on" colour of every switch.
    public static let toggleOn = Color(hex: 0x34C38F)
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
    /// The user's message bubble and the pairing hero tile.
    public static let bubble: CGFloat = 20
    /// The composer and floating panels.
    public static let panel: CGFloat = 22
    public static let pill: CGFloat = 999
    /// Corner radius of the system's glass popover on iOS 26 (measured in the Simulator), for
    /// shapes nested inside one.
    public static let systemPopover: CGFloat = 24

    /// Radius for a shape nested inside another rounded shape, so the two corners stay
    /// concentric: the outer radius minus the gap between them, never tighter than `sm`.
    /// Standalone surfaces in the chat, lists and sheets use `lg`.
    public static func concentric(_ outer: CGFloat, inset: CGFloat) -> CGFloat {
        max(outer - inset, sm)
    }
}

public enum SHTypography {
    public static let heroNumber = Font.system(size: 28, weight: .semibold, design: .default)
    public static let title = Font.system(size: 18, weight: .semibold, design: .default)
    public static let heading = Font.system(size: 16, weight: .semibold, design: .default)
    public static let body = Font.system(size: 15, weight: .regular, design: .default)
    public static let label = Font.system(size: 14.5, weight: .medium, design: .default)
    public static let caption = Font.system(size: 13.5, weight: .regular, design: .default)
    public static let micro = Font.system(size: 12.5, weight: .regular, design: .default)
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
        case .card: return 0.25
        case .bubble: return 0.22
        case .tile: return 0.24
        }
    }

    var shadowRadius: CGFloat {
        switch self {
        case .card: return 3.5
        case .bubble: return 3.2
        case .tile: return 2.5
        }
    }

    var shadowOffset: CGFloat {
        switch self {
        case .card: return 2.5
        case .bubble: return 2.5
        case .tile: return 1.5
        }
    }

    var topHighlightOpacity: Double {
        switch self {
        case .card: return 0.04
        case .bubble: return 0.052
        case .tile: return 0.032
        }
    }
}

public extension View {
    /// Clips the view to a rounded shape and draws a raised surface behind it,
    /// softly calibrated to match desktop's obsidian card/bubble depth.
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
                        .shadow(.inner(color: .white.opacity(elevation.topHighlightOpacity), radius: 0, y: 0.75))
                        .shadow(.drop(color: .black.opacity(elevation.shadowOpacity), radius: elevation.shadowRadius, y: elevation.shadowOffset))
                )
            )
    }

    /// Background for a small control (round button or chip) sitting on a raised panel: a hair
    /// of lift, from a soft shadow below and a faint light outline that fades out down the top half.
    func shRaisedControl<S: InsettableShape>(_ fill: Color, in shape: S) -> some View {
        self
            .background(
                shape.fill(
                    fill
                        .shadow(.inner(color: .white.opacity(0.03), radius: 0, y: 0.5))
                        .shadow(.drop(color: .black.opacity(0.16), radius: 1.25, y: 0.75))
                )
            )
            .overlay {
                shape
                    .strokeBorder(
                        LinearGradient(
                            colors: [.white.opacity(0.055), .white.opacity(0)],
                            startPoint: .top,
                            endPoint: .center
                        ),
                        lineWidth: 0.5
                    )
                    .allowsHitTesting(false)
            }
    }

    /// Background for a small control while it is pressed or switched on: pressed into the
    /// panel, with a soft inner shadow along the top and no lift.
    func shPressedControl<S: InsettableShape>(_ fill: Color, in shape: S) -> some View {
        // The raised control turned inside out: its drop shadow becomes a soft shadow inside the
        // top edge, its top highlight becomes a faint light line along the bottom, and the fill
        // dims a touch.
        self
            .background(
                shape.fill(
                    fill
                        .shadow(.inner(color: .black.opacity(0.18), radius: 1.25, y: 0.75))
                )
                .overlay(shape.fill(Color.black.opacity(0.06)))
            )
            .overlay {
                shape
                    .strokeBorder(
                        LinearGradient(
                            colors: [.white.opacity(0), .white.opacity(0.055)],
                            startPoint: .center,
                            endPoint: .bottom
                        ),
                        lineWidth: 0.5
                    )
                    .allowsHitTesting(false)
            }
    }

    /// Clips the view to a rounded shape and draws a recessed well for terminal, diff,
    /// and tool output.
    func shRecessedWell(_ fill: Color = SHColor.surfaceCode, cornerRadius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return self
            .clipShape(shape)
            .background(
                shape.fill(fill.shadow(.inner(color: .black.opacity(0.30), radius: 1.25, y: 0.75)))
            )
            .overlay(alignment: .bottom) {
                shape
                    .strokeBorder(
                        LinearGradient(colors: [.clear, .white.opacity(0.03)], startPoint: .center, endPoint: .bottom),
                        lineWidth: 0.6
                    )
                    .allowsHitTesting(false)
            }
    }
}

// MARK: - Chat Text Size and Density

/// How large chat text is drawn. The scale multiplies every chat font size.
public enum ChatTextSize: String, CaseIterable, Identifiable, Sendable {
    case small, standard, large, extraLarge

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .small: return "Small"
        case .standard: return "Default"
        case .large: return "Large"
        case .extraLarge: return "Extra Large"
        }
    }

    public var scale: CGFloat {
        switch self {
        case .small: return 0.92
        case .standard: return 1.0
        case .large: return 1.1
        case .extraLarge: return 1.22
        }
    }
}

/// How much room chat content gets: space between lines, between blocks inside a message,
/// and between messages.
public enum ChatDensity: String, CaseIterable, Identifiable, Sendable {
    case compact, comfortable, spacious

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .compact: return "Compact"
        case .comfortable: return "Comfortable"
        case .spacious: return "Spacious"
        }
    }

    // The three gaps form a clear ladder at every density: lines inside a paragraph or list
    // item are closest, list items are further apart, and paragraphs further still, so the
    // eye can tell a wrapped line from a new item from a new paragraph.

    /// Extra space between wrapped lines of the same paragraph or list item.
    var lineSpacing: CGFloat {
        switch self {
        case .compact: return 2.5
        case .comfortable: return 3.5
        case .spacious: return 5
        }
    }

    /// Space between one list item and the next.
    var listItemGap: CGFloat {
        switch self {
        case .compact: return 6
        case .comfortable: return 9
        case .spacious: return 12
        }
    }

    /// Space between paragraphs and other blocks inside a message.
    var blockGap: CGFloat {
        switch self {
        case .compact: return 10
        case .comfortable: return 14
        case .spacious: return 19
        }
    }

    var messageGap: CGFloat {
        switch self {
        case .compact: return 16
        case .comfortable: return 22
        case .spacious: return 30
        }
    }
}

/// The resolved chat measurements, passed down through the environment.
public struct SHChatMetrics: Equatable, Sendable {
    public var textSize: ChatTextSize = .standard
    public var density: ChatDensity = .comfortable

    public init(textSize: ChatTextSize = .standard, density: ChatDensity = .comfortable) {
        self.textSize = textSize
        self.density = density
    }

    public var scale: CGFloat { textSize.scale }
    public var blockGap: CGFloat { density.blockGap * scale }
    public var messageGap: CGFloat { density.messageGap }
    public var lineSpacing: CGFloat { density.lineSpacing * scale }
    public var listItemGap: CGFloat { density.listItemGap * scale }

    public func font(_ size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        .system(size: size * scale, weight: weight, design: design)
    }

    public var body: Font { font(15) }
    public var mono: Font { font(12.5, design: .monospaced) }
}

private struct SHChatMetricsKey: EnvironmentKey {
    static let defaultValue = SHChatMetrics()
}

public extension EnvironmentValues {
    var shChatMetrics: SHChatMetrics {
        get { self[SHChatMetricsKey.self] }
        set { self[SHChatMetricsKey.self] = newValue }
    }
}

/// A small control that sits raised and presses in: raised at rest, pressed into the panel while
/// held or while `isOn` (for example while the menu it opens is showing).
public struct SHControlPressStyle<S: InsettableShape>: ButtonStyle {
    public let fill: Color
    public let shape: S
    public var isOn: Bool = false

    public init(fill: Color, shape: S, isOn: Bool = false) {
        self.fill = fill
        self.shape = shape
        self.isOn = isOn
    }

    public func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed || isOn
        Group {
            if pressed {
                configuration.label.shPressedControl(fill, in: shape)
            } else {
                configuration.label.shRaisedControl(fill, in: shape)
            }
        }
        .animation(.easeOut(duration: 0.12), value: pressed)
    }
}
