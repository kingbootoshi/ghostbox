import SwiftUI

struct ImageFullscreenOverlay: View {
    let image: NSImage
    let onClose: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.75)
                .ignoresSafeArea()
                .onTapGesture { onClose() }

            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .shadow(color: .black.opacity(0.5), radius: 30, y: 10)
                .padding(32)
                .onTapGesture { onClose() }
        }
        .focusable()
        .onKeyPress(.escape) {
            onClose()
            return .handled
        }
    }
}
