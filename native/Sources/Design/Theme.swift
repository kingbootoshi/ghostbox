import AppKit
import SwiftUI

enum Theme {
    static let purple = Colors.accent
    static let purpleLight = Colors.accentLight
    static let purpleLighter = Colors.accentLightest
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

        static let accentNS = NSColor(hex: 0x7C3AED)
        static let accentLightNS = NSColor(hex: 0x8B5CF6)
        static let accentLightestNS = NSColor(hex: 0xA78BFA)
        static let backgroundNS = NSColor(hex: 0x09090D)
        static let surfaceNS = NSColor(hex: 0x11111A)
        static let surfaceElevatedNS = NSColor(hex: 0x171724)
        static let surfaceMutedNS = NSColor(hex: 0x1E1B2E)
        static let panelTintNS = NSColor(hex: 0x120F1D, alpha: 0.96)
    }

    enum Text {
        static let primary = 0.82
        static let secondary = 0.60
        static let tertiary = 0.35
        static let quaternary = 0.15
    }

    enum Typography {
        static func display(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
            .custom("DM Sans", size: size).weight(weight)
        }

        static func body(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
            .custom("DM Sans", size: size).weight(weight)
        }

        static func label(_ size: CGFloat, weight: Font.Weight = .medium) -> Font {
            .custom("DM Sans", size: size).weight(weight)
        }
    }

    enum Layout {
        static let cornerRadius: CGFloat = 24
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
