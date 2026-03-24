import SwiftUI

struct HubSettingsSection<Content: View>: View {
    let title: String
    let content: () -> Content

    init(title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(Theme.Typography.display())
                .foregroundColor(Color.white.opacity(0.82))

            VStack(alignment: .leading, spacing: 10) {
                content()
            }
        }
        .padding(18)
        .background(Color.white.opacity(0.02))
        .clipShape(RoundedRectangle(cornerRadius: 22))
    }
}

struct HubFieldLabel: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(Theme.Typography.label(weight: .semibold))
            .foregroundColor(Color.white.opacity(0.35))
            .tracking(0.8)
    }
}

struct HubTextField: View {
    let placeholder: String
    @Binding var text: String

    init(_ placeholder: String, text: Binding<String>) {
        self.placeholder = placeholder
        _text = text
    }

    var body: some View {
        TextField(placeholder, text: $text)
            .textFieldStyle(.plain)
            .font(Theme.Typography.body(Theme.FontSize.lg))
            .foregroundColor(Color.white.opacity(0.82))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}

struct HubSecureField: View {
    let placeholder: String
    @Binding var text: String

    init(_ placeholder: String, text: Binding<String>) {
        self.placeholder = placeholder
        _text = text
    }

    var body: some View {
        SecureField(placeholder, text: $text)
            .textFieldStyle(.plain)
            .font(Theme.Typography.body(Theme.FontSize.lg))
            .foregroundColor(Color.white.opacity(0.82))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}
