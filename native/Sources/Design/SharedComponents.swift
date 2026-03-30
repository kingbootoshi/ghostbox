import SwiftUI

struct CircularIconButton: View {
    let systemImage: String
    let action: () -> Void
    var size: CGFloat = 24
    var iconSize: CGFloat = Theme.FontSize.xs
    var iconWeight: Font.Weight = .semibold
    var foregroundColor: Color = Color.white.opacity(Theme.Text.tertiary)
    var backgroundColor: Color = Theme.Colors.controlBackground
    var borderColor: Color? = nil
    var borderWidth: CGFloat = 0.6

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: iconSize, weight: iconWeight))
                .foregroundColor(foregroundColor)
                .frame(width: size, height: size)
                .background(backgroundColor)
                .overlay {
                    if let borderColor {
                        Circle()
                            .strokeBorder(borderColor, lineWidth: borderWidth)
                    }
                }
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
    }
}

struct StatusBanner<Leading: View>: View {
    let text: String
    var spacing: CGFloat = 8
    var verticalPadding: CGFloat = 10
    var backgroundColor: Color = Theme.Colors.accent.opacity(0.2)
    var borderColor: Color = Theme.Colors.accentLight.opacity(0.35)
    var lineWidth: CGFloat = 0.8
    @ViewBuilder let leading: () -> Leading

    var body: some View {
        HStack(spacing: spacing) {
            leading()

            Text(text)
                .font(Theme.Typography.caption(weight: .medium))

            Spacer(minLength: 0)
        }
        .foregroundColor(Theme.Colors.accentLightest)
        .padding(.horizontal, 14)
        .padding(.vertical, verticalPadding)
        .background(backgroundColor)
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Layout.controlCornerRadius, style: .continuous)
                .strokeBorder(borderColor, lineWidth: lineWidth)
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.controlCornerRadius, style: .continuous))
    }
}
