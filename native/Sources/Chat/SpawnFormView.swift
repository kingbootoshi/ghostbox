import SwiftUI

struct SpawnFormView: View {
    @Binding var name: String
    @Binding var provider: String
    @Binding var model: String
    @Binding var systemPrompt: String
    let isLoading: Bool
    let onSpawn: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Spawn Ghost")
                .font(Theme.Typography.display())
                .foregroundColor(Color.white.opacity(0.82))

            VStack(alignment: .leading, spacing: 10) {
                fieldLabel("Ghost Name")
                formField("my-ghost", text: $name)

                fieldLabel("Provider")
                Picker("", selection: $provider) {
                    Text("anthropic").tag("anthropic")
                    Text("openai").tag("openai")
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .colorScheme(.dark)

                fieldLabel("Model")
                formField("claude-sonnet-4-6", text: $model)

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
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Theme.Colors.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
            }
        }
        .padding(18)
        .background(Color.white.opacity(0.02))
        .clipShape(RoundedRectangle(cornerRadius: 22))
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
