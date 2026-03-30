import AppKit
import SwiftUI

enum Theme {
    static let background = Colors.background

    enum Colors {
        static let accent = Color(hex: 0x7C3AED)
        static let accentLight = Color(hex: 0x8B5CF6)
        static let accentLightest = Color(hex: 0xA78BFA)

        static let background = Color(hex: 0x09090D)
        static let surface = Color(hex: 0x11111A)
        static let surfaceElevated = Color(hex: 0x171724)
        static let surfaceMuted = Color(hex: 0x1E1B2E)
        static let surfaceBorder = Color.white.opacity(Text.quaternary)
        static let controlBackground = Color.white.opacity(0.05)
        static let controlBorder = accentLight.opacity(0.18)
        static let glassTint = Color(.sRGB, red: 0.04, green: 0.04, blue: 0.06, opacity: 1)
        static let overlayBackdrop = Color(.sRGB, red: 0.02, green: 0.02, blue: 0.04, opacity: 1)
        static let overlaySurface = Color(.sRGB, red: 0.06, green: 0.06, blue: 0.08, opacity: 1)

        static let accentNS = NSColor(hex: 0x7C3AED)
        static let accentLightNS = NSColor(hex: 0x8B5CF6)
        static let accentLightestNS = NSColor(hex: 0xA78BFA)
        static let backgroundNS = NSColor(hex: 0x09090D)
        static let surfaceNS = NSColor(hex: 0x11111A)
        static let surfaceElevatedNS = NSColor(hex: 0x171724)
        static let surfaceMutedNS = NSColor(hex: 0x1E1B2E)
        static let panelTintNS = NSColor(hex: 0x120F1D, alpha: 0.96)
        static let primaryTextNS = NSColor.white.withAlphaComponent(CGFloat(Text.primary))

        static func statusColor(for status: String) -> Color {
            switch status.lowercased() {
            case "running":
                return Color.green.opacity(0.9)
            case "sleeping":
                return Color.yellow.opacity(0.9)
            case "stopped":
                return Color.red.opacity(0.9)
            case "error":
                return Color.orange.opacity(0.95)
            default:
                return Color.white.opacity(Text.quaternary)
            }
        }
    }

    enum Text {
        static let primary = 0.82
        static let secondary = 0.60
        static let tertiary = 0.35
        static let quaternary = 0.15
    }

    enum FontSize {
        /// Timestamp, metadata - smallest readable
        static let xs: CGFloat = 12
        /// Labels, subtitles, secondary info
        static let sm: CGFloat = 13
        /// Body text, chat messages, file names
        static let md: CGFloat = 14
        /// Section headers, input fields
        static let lg: CGFloat = 15
        /// Panel titles, ghost names
        static let xl: CGFloat = 16
        /// Display headings
        static let xxl: CGFloat = 18
    }

    enum Typography {
        static func display(_ size: CGFloat = FontSize.xl, weight: Font.Weight = .semibold) -> Font {
            .custom("DM Sans", size: size).weight(weight)
        }

        static func body(_ size: CGFloat = FontSize.md, weight: Font.Weight = .regular) -> Font {
            .custom("DM Sans", size: size).weight(weight)
        }

        static func label(_ size: CGFloat = FontSize.sm, weight: Font.Weight = .medium) -> Font {
            .custom("DM Sans", size: size).weight(weight)
        }

        static func caption(_ size: CGFloat = FontSize.xs, weight: Font.Weight = .regular) -> Font {
            .custom("DM Sans", size: size).weight(weight)
        }

        static func mono(_ size: CGFloat = FontSize.sm) -> Font {
            .system(size: size, weight: .regular, design: .monospaced)
        }

        static func editor(_ size: CGFloat = FontSize.lg, weight: NSFont.Weight = .regular) -> NSFont {
            .systemFont(ofSize: size, weight: weight)
        }
    }

    enum Layout {
        static let cornerRadius: CGFloat = 24
        static let smallCornerRadius: CGFloat = 8
        static let compactCornerRadius: CGFloat = 10
        static let controlCornerRadius: CGFloat = 14
        static let cardCornerRadius: CGFloat = 16
        static let inputCornerRadius: CGFloat = 18
        static let panelCornerRadius: CGFloat = 20
        static let rowCornerRadius: CGFloat = 22
    }

    enum Glass {
        static let baseOpacity = 0.96
        static let tintOpacity = 0.12
        static let highlightOpacity = 0.10
        static let shadowOpacity = 0.78
        static let shadowRadius: CGFloat = 60
        static let shadowYOffset: CGFloat = 20
        static let borderOpacity = Text.quaternary
    }
}

struct CapsuleControlStyle: ViewModifier {
    let foregroundColor: Color
    let backgroundColor: Color
    let borderColor: Color?
    let lineWidth: CGFloat
    let horizontalPadding: CGFloat
    let verticalPadding: CGFloat

    init(
        foregroundColor: Color = Theme.Colors.accentLightest,
        backgroundColor: Color = Theme.Colors.controlBackground,
        borderColor: Color? = Theme.Colors.controlBorder,
        lineWidth: CGFloat = 0.5,
        horizontalPadding: CGFloat = 10,
        verticalPadding: CGFloat = 7
    ) {
        self.foregroundColor = foregroundColor
        self.backgroundColor = backgroundColor
        self.borderColor = borderColor
        self.lineWidth = lineWidth
        self.horizontalPadding = horizontalPadding
        self.verticalPadding = verticalPadding
    }

    func body(content: Content) -> some View {
        content
            .foregroundColor(foregroundColor)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .background(backgroundColor)
            .overlay {
                if let borderColor {
                    Capsule()
                        .strokeBorder(borderColor, lineWidth: lineWidth)
                }
            }
            .clipShape(Capsule())
    }
}

extension View {
    func capsuleControlStyle(
        foregroundColor: Color = Theme.Colors.accentLightest,
        backgroundColor: Color = Theme.Colors.controlBackground,
        borderColor: Color? = Theme.Colors.controlBorder,
        lineWidth: CGFloat = 0.5,
        horizontalPadding: CGFloat = 10,
        verticalPadding: CGFloat = 7
    ) -> some View {
        modifier(
            CapsuleControlStyle(
                foregroundColor: foregroundColor,
                backgroundColor: backgroundColor,
                borderColor: borderColor,
                lineWidth: lineWidth,
                horizontalPadding: horizontalPadding,
                verticalPadding: verticalPadding
            )
        )
    }
}

private extension Color {
    init(hex: Int, alpha: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: alpha
        )
    }
}

private extension NSColor {
    convenience init(hex: Int, alpha: CGFloat = 1.0) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255.0,
            green: CGFloat((hex >> 8) & 0xFF) / 255.0,
            blue: CGFloat(hex & 0xFF) / 255.0,
            alpha: alpha
        )
    }
}
