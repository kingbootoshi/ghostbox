import MarkdownUI
import SwiftUI

struct AgentMessageBlock: View {
    let message: ChatMessage
    let ghostName: String
    let isSelected: Bool
    var onThumbnailTap: ((NSImage) -> Void)?

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter
    }()

    var body: some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
            Text(senderName)
                .font(Theme.Typography.label(weight: .semibold))
                .foregroundColor(senderColor)

            markdownContent
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            Text(Self.formatter.string(from: message.timestamp))
                .font(Theme.Typography.caption())
                .foregroundColor(Color.white.opacity(0.1))
                .padding(.top, 1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(isSelected ? Theme.Colors.accent.opacity(0.18) : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(isSelected ? Theme.Colors.accentLight.opacity(0.65) : Color.clear, lineWidth: 1)
        )
        .shadow(color: isSelected ? Theme.Colors.accent.opacity(0.2) : Color.clear, radius: 18, x: 0, y: 8)
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
        .padding(.horizontal, 20)
    }

    @ViewBuilder
    private var markdownContent: some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 8) {
            if !message.thumbnails.isEmpty {
                inlineThumbnails
            } else if message.attachmentCount > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "photo")
                        .font(.system(size: 10))
                    Text("\(message.attachmentCount) image\(message.attachmentCount == 1 ? "" : "s")")
                }
                .font(Theme.Typography.caption())
                .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.white.opacity(0.04))
                .clipShape(Capsule())
            }

            if !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if message.role == .ghost || message.role == .thinking {
                    Markdown(message.content)
                        .markdownTheme(.basic)
                        .markdownTextStyle(\.text) {
                            FontSize(Theme.FontSize.md)
                            ForegroundColor(contentColor)
                        }
                        .markdownTextStyle(\.strong) {
                            FontWeight(.semibold)
                            ForegroundColor(Color.white.opacity(Theme.Text.primary))
                        }
                        .markdownTextStyle(\.code) {
                            FontFamilyVariant(.monospaced)
                            FontSize(.em(0.92))
                            ForegroundColor(Color.white.opacity(0.92))
                            BackgroundColor(Color.white.opacity(0.05))
                        }
                        .markdownBlockStyle(\.codeBlock) { configuration in
                            configuration.label
                                .padding(12)
                                .background(Color.white.opacity(0.04))
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .markdownTextStyle {
                                    FontFamilyVariant(.monospaced)
                                    FontSize(.em(0.88))
                                    ForegroundColor(Color.white.opacity(0.85))
                                }
                        }
                        .textSelection(.enabled)
                } else if let attributed = message.attributedContent {
                    Text(attributed)
                        .font(Theme.Typography.body())
                        .foregroundColor(contentColor)
                        .lineSpacing(5.6)
                } else {
                    Text(message.content)
                        .font(Theme.Typography.body())
                        .foregroundColor(contentColor)
                        .lineSpacing(5.6)
                }
            }
        }
    }

    @ViewBuilder
    private var inlineThumbnails: some View {
        HStack(spacing: 6) {
            ForEach(Array(message.thumbnails.enumerated()), id: \.offset) { _, thumbnail in
                Image(nsImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 40, height: 40)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                    .onTapGesture {
                        onThumbnailTap?(thumbnail)
                    }
            }
        }
    }

    private var senderName: String {
        switch message.role {
        case .ghost:
            return ghostName
        case .user:
            return "You"
        case .thinking:
            return "Thinking"
        case .system:
            return "System"
        case .toolUse:
            return "Tool"
        case .toolResult:
            return "Result"
        }
    }

    private var senderColor: Color {
        switch message.role {
        case .ghost:
            return Theme.Colors.accentLight
        case .user:
            return Color.white.opacity(Theme.Text.tertiary)
        case .thinking:
            return Color.white.opacity(0.25)
        case .system:
            return Color.orange.opacity(0.85)
        case .toolUse:
            return Theme.Colors.accentLightest
        case .toolResult:
            return Color.white.opacity(Theme.Text.tertiary)
        }
    }

    private var contentColor: Color {
        switch message.role {
        case .ghost:
            return Color.white.opacity(Theme.Text.primary)
        case .user:
            return Color.white.opacity(Theme.Text.secondary)
        case .thinking:
            return Color.white.opacity(0.3)
        case .system:
            return Color.orange.opacity(0.9)
        case .toolUse, .toolResult:
            return Color.white.opacity(Theme.Text.secondary)
        }
    }
}
