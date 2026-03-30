import SwiftUI

struct ConnectionView: View {
    @State private var serverURL = ""
    @State private var serverToken = ""
    @State private var isConnecting = false
    @State private var error: String?

    let onConnect: (String, String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 28) {
                // Logo area
                VStack(spacing: 12) {
                    Text("Ghostbox")
                        .font(Theme.Typography.display(24, weight: .bold))
                        .foregroundColor(.white.opacity(Theme.Text.primary))

                    Text("Connect to your server")
                        .font(Theme.Typography.body())
                        .foregroundColor(.white.opacity(Theme.Text.secondary))
                }

                // Form
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Server URL")
                            .font(Theme.Typography.label(weight: .medium))
                            .foregroundColor(.white.opacity(Theme.Text.secondary))

                        TextField("http://100.127.73.47:8008", text: $serverURL)
                            .textFieldStyle(.plain)
                            .font(Theme.Typography.body())
                            .foregroundColor(.white.opacity(Theme.Text.primary))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(Color.white.opacity(0.05))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Admin Token")
                            .font(Theme.Typography.label(weight: .medium))
                            .foregroundColor(.white.opacity(Theme.Text.secondary))

                        SecureField("Paste your admin token", text: $serverToken)
                            .textFieldStyle(.plain)
                            .font(Theme.Typography.body())
                            .foregroundColor(.white.opacity(Theme.Text.primary))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(Color.white.opacity(0.05))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }

                if let error {
                    Text(error)
                        .font(Theme.Typography.caption())
                        .foregroundColor(.orange.opacity(0.9))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.orange.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                Button(action: connect) {
                    HStack(spacing: 8) {
                        if isConnecting {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.white)
                        }
                        Text(isConnecting ? "Connecting..." : "Connect")
                            .font(Theme.Typography.label(weight: .semibold))
                    }
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(canConnect ? Theme.Colors.accent : Theme.Colors.accent.opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .disabled(!canConnect || isConnecting)
            }
            .padding(32)
            .frame(maxWidth: 360)

            Spacer()

            Text("Enter your Ghostbox server URL and admin token to connect.")
                .font(Theme.Typography.caption())
                .foregroundColor(.white.opacity(Theme.Text.tertiary))
                .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var canConnect: Bool {
        !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !serverToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func connect() {
        let url = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = Self.sanitizedToken(serverToken)

        guard URL(string: url) != nil else {
            error = "Invalid URL"
            return
        }

        isConnecting = true
        error = nil

        Task {
            let testClient = GhostboxClient(baseURL: URL(string: url), token: token)
            let healthy = await testClient.healthCheck()

            if healthy {
                onConnect(url, token)
            } else {
                error = "Could not reach server. Check URL and try again."
                isConnecting = false
            }
        }
    }

    private static func sanitizedToken(_ token: String) -> String {
        token.filter { !$0.isWhitespace && !$0.isNewline }
    }
}
