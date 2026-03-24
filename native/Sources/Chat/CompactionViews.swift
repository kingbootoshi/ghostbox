import SwiftUI

struct CompactionDivider: View {
    let summary: String?

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
                Text(summary)
                    .font(Theme.Typography.caption())
                    .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                    .lineLimit(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(Color.white.opacity(0.02))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
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
    @State private var phase = 0
    @State private var timer: Timer?

    var body: some View {
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
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .onAppear {
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
                phase = (phase + 1) % 3
            }
        }
        .onDisappear {
            timer?.invalidate()
            timer = nil
        }
    }
}
