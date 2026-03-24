import SwiftUI

struct SpawnFormView: View {
    @Binding var name: String
    @Binding var provider: String
    @Binding var model: String
    @Binding var systemPrompt: String
    let isLoading: Bool
    let onSpawn: () -> Void
    let onCancel: () -> Void

    @State private var selectedModel: GhostModel = .default
    @State private var reasoning: String = "medium"

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Spawn Ghost")
                .font(Theme.Typography.display())
                .foregroundColor(Color.white.opacity(0.82))

            VStack(alignment: .leading, spacing: 10) {
                fieldLabel("Ghost Name")
                formField("my-ghost", text: $name)

                fieldLabel("Model")
                modelPicker

                if selectedModel.supportsReasoning {
                    fieldLabel("Reasoning")
                    reasoningPicker
                }

                fieldLabel("System Prompt")
                TextEditor(text: $systemPrompt)
                    .font(Theme.Typography.body(Theme.FontSize.lg))
                    .foregroundColor(Color.white.opacity(0.82))
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 76, maxHeight: 76)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.03))
                    .clipShape(RoundedRectangle(cornerRadius: 18))
            }

            HStack(spacing: 10) {
                Button(action: onCancel) {
                    Text("Cancel")
                        .font(Theme.Typography.label())
                        .foregroundColor(Color.white.opacity(0.6))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Color.white.opacity(0.03))
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                }
                .buttonStyle(.plain)
                .disabled(isLoading)

                Button(action: onSpawn) {
                    HStack(spacing: 8) {
                        if isLoading {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.white)
                        }

                        Text(isLoading ? "Spawning..." : "Spawn")
                            .font(Theme.Typography.label(weight: .semibold))
                    }
                    .foregroundColor(.white.opacity(0.9))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Theme.Colors.accent.opacity(0.35))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18)
                            .strokeBorder(Theme.Colors.accentLight.opacity(0.3), lineWidth: 0.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
            }
        }
        .padding(18)
        .background(Color.white.opacity(0.02))
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .onAppear {
            provider = selectedModel.provider
            model = selectedModel.apiValue
        }
        .onChange(of: selectedModel) {
            provider = selectedModel.provider
            model = selectedModel.apiValue
        }
        .onChange(of: reasoning) {
            model = selectedModel.apiValue
        }
    }

    private var modelPicker: some View {
        HStack(spacing: 6) {
            ForEach(GhostModel.all) { ghostModel in
                modelButton(ghostModel)
            }
        }
    }

    private func modelButton(_ ghostModel: GhostModel) -> some View {
        let isSelected = selectedModel.id == ghostModel.id

        return Button {
            selectedModel = ghostModel
            if let defaultReasoning = ghostModel.defaultReasoning {
                reasoning = defaultReasoning
            }
        } label: {
            Text(ghostModel.displayName)
                .font(Theme.Typography.label(weight: isSelected ? .semibold : .regular))
                .foregroundColor(isSelected ? Theme.Colors.accentLightest : Color.white.opacity(Theme.Text.secondary))
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(isSelected ? Theme.Colors.accent.opacity(0.22) : Color.white.opacity(0.03))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .strokeBorder(
                            isSelected ? Theme.Colors.accentLight.opacity(0.28) : Color.white.opacity(0.04),
                            lineWidth: 0.5
                        )
                )
                .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }

    private var reasoningPicker: some View {
        HStack(spacing: 6) {
            ForEach(GhostModel.reasoningLevels, id: \.self) { level in
                let isSelected = reasoning == level

                Button {
                    reasoning = level
                } label: {
                    Text(level)
                        .font(Theme.Typography.caption(weight: isSelected ? .semibold : .regular))
                        .foregroundColor(isSelected ? Theme.Colors.accentLightest : Color.white.opacity(Theme.Text.tertiary))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity)
                        .background(isSelected ? Theme.Colors.accent.opacity(0.18) : Color.white.opacity(0.03))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func fieldLabel(_ title: String) -> some View {
        Text(title)
            .font(Theme.Typography.label(weight: .semibold))
            .foregroundColor(Color.white.opacity(0.35))
            .tracking(0.8)
    }

    private func formField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .textFieldStyle(.plain)
            .font(Theme.Typography.body(Theme.FontSize.lg))
            .foregroundColor(Color.white.opacity(0.82))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.03))
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}
