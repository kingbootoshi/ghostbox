import SwiftUI

private enum ChatInputLayout {
    static let minHeight: CGFloat = 20
    static let maxHeight: CGFloat = 60
}

struct ChatInputView: View {
    @Binding var inputText: String
    let ghostName: String
    let backgroundTasks: [ActiveBackgroundTask]
    let isStreaming: Bool
    let isWakingGhost: Bool
    let isLoadingHistory: Bool
    let isCompacting: Bool
    let isCreatingSession: Bool
    let isHistoryModeActive: Bool
    let isInputDisabled: Bool
    let isInputFocused: FocusState<Bool>.Binding
    let showsSlashCommandPopup: Bool
    let firstFilteredSlashCommand: GhostSlashCommand?
    let stats: GhostStats?
    let onPasteCommand: () -> Bool
    let onHistoryBack: () -> Bool
    let onHistoryForward: () -> Bool
    let onQueueBrowseUp: () -> Bool
    let onQueueBrowseDown: () -> Bool
    let onTab: () -> Bool
    let onSubmit: () -> Void
    @State private var inputHeight: CGFloat = ChatInputLayout.minHeight
    @State private var showingBackgroundTasks = false

    var body: some View {
        VStack(spacing: 8) {
            if isHistoryModeActive {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.up.arrow.down")
                        .font(.system(size: Theme.FontSize.xs, weight: .semibold))

                    Text("History mode - up/down select, return rewinds, esc exits")
                        .font(Theme.Typography.caption(weight: .medium))

                    Spacer(minLength: 0)
                }
                .foregroundColor(Theme.Colors.accentLightest)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.Colors.accent.opacity(0.2))
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Theme.Colors.accentLight.opacity(0.35), lineWidth: 0.8)
                }
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.horizontal, 18)
            }

            if isCompacting {
                HStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Theme.Colors.accentLight)

                    Text("Compacting conversation...")
                        .font(Theme.Typography.caption(weight: .medium))

                    Spacer(minLength: 0)
                }
                .foregroundColor(Theme.Colors.accentLightest)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Theme.Colors.accent.opacity(0.16))
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Theme.Colors.accentLight.opacity(0.22), lineWidth: 0.6)
                }
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.horizontal, 18)
            }

            MultilineInput(
                text: $inputText,
                height: $inputHeight,
                placeholder: inputPlaceholder,
                font: NSFont.systemFont(ofSize: Theme.FontSize.lg),
                textColor: NSColor.white.withAlphaComponent(CGFloat(Theme.Text.primary)),
                isDisabled: isInputDisabled,
                minHeight: ChatInputLayout.minHeight,
                maxHeight: ChatInputLayout.maxHeight,
                onSubmit: { submitInput() },
                onPasteCommand: onPasteCommand,
                onArrowUp: onQueueBrowseUp,
                onArrowDown: onQueueBrowseDown,
                onTab: onTab
            )
            .frame(height: inputHeight)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .background(Color.white.opacity(0.02))
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .padding(.horizontal, 18)

            HStack(spacing: 0) {
                Text(footerHint)
                    .font(Theme.Typography.caption())
                    .foregroundColor(Color.white.opacity(0.08))

                Spacer()

                if !backgroundTasks.isEmpty {
                    Button {
                        showingBackgroundTasks.toggle()
                    } label: {
                        HStack(spacing: 4) {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(Theme.Colors.accentLight)
                            Text("\(backgroundTasks.count) bg")
                                .font(Theme.Typography.mono(Theme.FontSize.xs))
                                .foregroundColor(Theme.Colors.accentLight.opacity(0.7))
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, 8)
                    .popover(isPresented: $showingBackgroundTasks, arrowEdge: .bottom) {
                        backgroundTaskPopover
                    }
                }

                if let tokenFooter = tokenFooterText {
                    Text(tokenFooter)
                        .font(Theme.Typography.mono(Theme.FontSize.xs))
                        .foregroundColor(Color.white.opacity(tokenFooterOpacity))
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
    }

    private var inputPlaceholder: String {
        if isWakingGhost {
            return "Waking ghost..."
        }

        if isLoadingHistory {
            return "Loading chat history..."
        }

        return "Talk to \(ghostName)..."
    }

    private var footerHint: String {
        if isWakingGhost {
            return "Please wait"
        }

        if isLoadingHistory {
            return "Please wait"
        }

        if isCreatingSession {
            return "Starting a new session in the background"
        }

        return "Press return to send, shift+return for new line"
    }

    private var tokenFooterText: String? {
        guard let context = stats?.context else { return nil }
        return "\(Self.formatTokenCount(context.used)) / \(Self.formatTokenCount(context.window))"
    }

    private var tokenFooterOpacity: Double {
        guard let context = stats?.context else { return 0.08 }
        if context.percent > 75 { return 0.5 }
        if context.percent > 50 { return 0.2 }
        return 0.12
    }

    private static func formatTokenCount(_ count: Int) -> String {
        if count >= 1_000_000 {
            let value = Double(count) / 1_000_000
            return value.truncatingRemainder(dividingBy: 1) == 0
                ? "\(Int(value))M"
                : String(format: "%.1fM", value)
        }
        if count >= 1_000 {
            let value = Double(count) / 1_000
            return value.truncatingRemainder(dividingBy: 1) == 0
                ? "\(Int(value))K"
                : String(format: "%.1fK", value)
        }
        return "\(count)"
    }

    private var backgroundTaskPopover: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Background Tasks")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.white.opacity(0.9))
                Spacer()
                Text("\(backgroundTasks.count)")
                    .font(Theme.Typography.mono(11))
                    .foregroundColor(Theme.Colors.accentLight)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()
                .background(Color.white.opacity(0.1))

            ForEach(backgroundTasks) { task in
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Theme.Colors.accentLight)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(task.label)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.white.opacity(0.85))
                            .lineLimit(1)
                        Text(String(task.id.prefix(20)))
                            .font(Theme.Typography.mono(9))
                            .foregroundColor(.white.opacity(0.3))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
        }
        .frame(minWidth: 240, maxWidth: 320)
        .padding(.vertical, 4)
        .background(.ultraThinMaterial)
    }

    private func submitInput() {
        onSubmit()
    }
}
