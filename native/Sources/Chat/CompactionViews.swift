import MarkdownUI
import SwiftUI

struct CompactionDivider: View {
    let summary: String?
    @State private var isExpanded = false

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                Rectangle()
                    .fill(Color.white.opacity(0.15))
                    .frame(height: 1)

                Text("Session Compacted")
                    .font(Theme.Typography.caption(weight: .medium))
                    .foregroundColor(Color.white.opacity(0.25))

                Rectangle()
                    .fill(Color.white.opacity(0.15))
                    .frame(height: 1)
            }

            if let summary, !summary.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(.easeOut(duration: 0.18)) {
                            isExpanded.toggle()
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                                .font(.system(size: 8, weight: .semibold))
                            Text("Compaction summary")
                                .font(Theme.Typography.caption(weight: .medium))
                            Spacer()
                        }
                        .foregroundColor(Color.white.opacity(0.3))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                    }
                    .buttonStyle(.plain)

                    if isExpanded {
                        ScrollView {
                            Markdown(summary)
                                .markdownTheme(.basic)
                                .markdownTextStyle(\.text) {
                                    FontSize(Theme.FontSize.sm)
                                    ForegroundColor(Color.white.opacity(Theme.Text.tertiary))
                                }
                                .markdownTextStyle(\.strong) {
                                    FontWeight(.semibold)
                                    ForegroundColor(Color.white.opacity(Theme.Text.secondary))
                                }
                                .markdownTextStyle(\.code) {
                                    FontFamilyVariant(.monospaced)
                                    FontSize(.em(0.9))
                                    ForegroundColor(Color.white.opacity(0.5))
                                    BackgroundColor(Color.white.opacity(0.03))
                                }
                                .markdownBlockStyle(\.codeBlock) { configuration in
                                    configuration.label
                                        .padding(8)
                                        .background(Color.white.opacity(0.03))
                                        .clipShape(RoundedRectangle(cornerRadius: 6))
                                        .markdownTextStyle {
                                            FontFamilyVariant(.monospaced)
                                            FontSize(.em(0.85))
                                            ForegroundColor(Color.white.opacity(0.5))
                                        }
                                }
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 10)
                                .padding(.bottom, 10)
                        }
                        .frame(maxHeight: 300)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
                .background(Color.white.opacity(0.02))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Color.white.opacity(0.05), lineWidth: 0.5)
                )
            }
        }
        .padding(.horizontal, 20)
    }
}

struct ExchangeBreak: View {
    var body: some View {
        Rectangle()
            .fill(Color.white.opacity(0.04))
            .frame(width: 30, height: 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 20)
    }
}

struct GhostTypingBlock: View {
    let name: String

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.4, paused: false)) { context in
            let phase = Int(context.date.timeIntervalSinceReferenceDate / 0.4) % 3

            VStack(alignment: .leading, spacing: 4) {
                Text(name)
                    .font(Theme.Typography.label(weight: .semibold))
                    .foregroundColor(Theme.Colors.accentLight)

                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { index in
                        Circle()
                            .fill(Color.white.opacity(phase == index ? 0.4 : 0.1))
                            .frame(width: 5, height: 5)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
        }
    }
}
