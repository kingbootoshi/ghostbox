import SwiftUI

struct ToolCallGroupBlock: View {
    let group: ToolCallGroup
    let isExpanded: Bool
    let onToggle: () -> Void
    let onShowFullscreen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: onToggle) {
                HStack(spacing: 10) {
                    Image(systemName: group.iconName)
                        .font(.system(size: Theme.FontSize.sm, weight: .medium))
                        .foregroundColor(Theme.Colors.accentLight)
                        .frame(width: 14)

                    Text(group.toolName)
                        .font(Theme.Typography.label(weight: .semibold))
                        .foregroundColor(Theme.Colors.accentLightest)

                    Text(group.collapsedPreview)
                        .font(Theme.Typography.label(weight: .regular))
                        .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                        .lineLimit(1)

                    if group.isRunning {
                        ToolCallRunningBadge()
                    }

                    Spacer(minLength: 0)

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: Theme.FontSize.xs, weight: .medium))
                        .foregroundColor(Color.white.opacity(Theme.Text.quaternary))
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(Color.white.opacity(0.03))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.controlCornerRadius, style: .continuous))

            if isExpanded {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 8) {
                        Text("Input")
                            .font(Theme.Typography.caption(weight: .semibold))
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))

                        Spacer(minLength: 0)

                        Button(action: onShowFullscreen) {
                            Image(systemName: "arrow.up.left.and.arrow.down.right")
                                .font(.system(size: Theme.FontSize.xs, weight: .semibold))
                                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                                .frame(width: 24, height: 24)
                                .background(Color.white.opacity(0.04))
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.smallCornerRadius, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }

                    ToolCallContentView(content: group.toolUse.content)

                    if let toolResult = group.toolResult {
                        Rectangle()
                            .fill(Color.white.opacity(0.06))
                            .frame(height: 1)

                        Text("Output")
                            .font(Theme.Typography.caption(weight: .semibold))
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))

                        ToolCallContentView(content: toolResult.content)
                    } else {
                        Rectangle()
                            .fill(Color.white.opacity(0.06))
                            .frame(height: 1)

                        ToolCallRunningRow()
                    }
                }
                .padding(12)
                .background(Color.white.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.cardCornerRadius, style: .continuous))
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
    }
}

struct ToolCallContentView: View {
    let content: String

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            Text(content)
                .font(Theme.Typography.mono())
                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                .textSelection(.enabled)
                .lineSpacing(4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxHeight: 220)
    }
}

private struct ToolCallRunningBadge: View {
    var body: some View {
        HStack(spacing: 6) {
            ProgressView()
                .controlSize(.small)
                .tint(Theme.Colors.accentLight)

            Text("Running...")
                .font(Theme.Typography.caption(weight: .medium))
                .foregroundColor(Theme.Colors.accentLight)
        }
        .capsuleControlStyle(
            foregroundColor: Theme.Colors.accentLight,
            backgroundColor: Theme.Colors.accent.opacity(0.12),
            borderColor: Theme.Colors.accentLight.opacity(0.18),
            horizontalPadding: 8,
            verticalPadding: 4
        )
    }
}

private struct ToolCallRunningRow: View {
    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
                .tint(Theme.Colors.accentLight)

            Text("Running...")
                .font(Theme.Typography.label(weight: .medium))
                .foregroundColor(Theme.Colors.accentLight)
        }
    }
}

struct ToolCallFullscreenOverlay: View {
    let group: ToolCallGroup
    let onClose: () -> Void

    var body: some View {
        ZStack {
            Theme.Colors.overlayBackdrop.opacity(0.88)
                .onTapGesture(perform: onClose)

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: group.iconName)
                        .font(.system(size: Theme.FontSize.sm, weight: .medium))
                        .foregroundColor(Theme.Colors.accentLight)

                    Text(group.toolName)
                        .font(Theme.Typography.label(weight: .semibold))
                        .foregroundColor(Theme.Colors.accentLightest)

                    Text(group.collapsedPreview)
                        .font(Theme.Typography.label(weight: .regular))
                        .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                        .lineLimit(1)

                    if group.isRunning {
                        ToolCallRunningBadge()
                    }

                    Spacer(minLength: 0)

                    CircularIconButton(
                        systemImage: "xmark",
                        action: onClose,
                        size: 28,
                        iconSize: Theme.FontSize.sm,
                        foregroundColor: Color.white.opacity(Theme.Text.secondary),
                        backgroundColor: Color.white.opacity(0.08)
                    )
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)

                Rectangle()
                    .fill(Color.white.opacity(0.06))
                    .frame(height: 1)

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Input")
                            .font(Theme.Typography.caption(weight: .semibold))
                            .foregroundColor(Theme.Colors.accentLight.opacity(0.7))

                        Text(group.toolUse.content)
                            .font(Theme.Typography.mono())
                            .foregroundColor(Color.white.opacity(Theme.Text.primary))
                            .textSelection(.enabled)
                            .lineSpacing(5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)

                        if let toolResult = group.toolResult {
                            Rectangle()
                                .fill(Color.white.opacity(0.06))
                                .frame(height: 1)
                                .padding(.vertical, 4)

                            Text("Output")
                                .font(Theme.Typography.caption(weight: .semibold))
                                .foregroundColor(Theme.Colors.accentLight.opacity(0.7))

                            Text(toolResult.content)
                                .font(Theme.Typography.mono())
                                .foregroundColor(Color.white.opacity(Theme.Text.primary))
                                .textSelection(.enabled)
                                .lineSpacing(5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            Rectangle()
                                .fill(Color.white.opacity(0.06))
                                .frame(height: 1)
                                .padding(.vertical, 4)

                            ToolCallRunningRow()
                        }
                    }
                    .padding(20)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: Theme.Layout.panelCornerRadius, style: .continuous)
                    .fill(Theme.Colors.overlaySurface.opacity(0.96))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Layout.panelCornerRadius, style: .continuous)
                    .strokeBorder(Theme.Colors.accentLight.opacity(0.12), lineWidth: 0.5)
            )
            .padding(14)
        }
    }
}
