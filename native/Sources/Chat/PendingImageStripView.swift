import SwiftUI

struct PendingImageStripView: View {
    let images: [PendingImage]
    let onRemove: (UUID) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(images) { image in
                    ZStack {
                        if image.isProcessing {
                            RoundedRectangle(cornerRadius: 14)
                                .fill(Color.white.opacity(0.08))
                                .frame(width: 48, height: 48)
                                .overlay(
                                    ProgressView()
                                        .scaleEffect(0.5)
                                        .tint(.white)
                                )
                                .padding(4)
                        } else {
                            Image(nsImage: image.thumbnail)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 48, height: 48)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                                .padding(4)
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: 16)
                            .fill(Color.white.opacity(0.05))
                    )
                    .overlay(alignment: .topTrailing) {
                        if !image.isProcessing {
                            Button {
                                onRemove(image.id)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundColor(.white)
                                    .frame(width: 18, height: 18)
                                    .background(Color.red.opacity(0.75))
                                    .clipShape(Circle())
                            }
                            .buttonStyle(.plain)
                            .offset(x: 5, y: -5)
                        }
                    }
                }
            }
            .padding(.top, 8)
            .padding(.horizontal, 18)
        }
        .padding(.bottom, 8)
    }
}
