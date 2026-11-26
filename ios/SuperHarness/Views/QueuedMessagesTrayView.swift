import SwiftUI

public struct QueuedMessagesTrayView: View {
    public let items: [QueuedMessageItem]
    @State private var isExpanded: Bool = true

    public init(items: [QueuedMessageItem]) {
        self.items = items
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.16)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "text.line.last.and.arrowtriangle.forward")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(SHColor.statusWarning)
                    Text("Queued (\(items.count))")
                        .font(SHTypography.micro.weight(.semibold))
                        .foregroundStyle(SHColor.inkSecondary)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.up")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(SHColor.inkFaint)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                ForEach(items) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Circle()
                            .fill(SHColor.statusWarning.opacity(0.8))
                            .frame(width: 5, height: 5)
                            .padding(.top, 6)
                        Text(item.text)
                            .font(SHTypography.caption)
                            .foregroundStyle(SHColor.inkSecondary)
                            .lineLimit(2)
                        Spacer(minLength: 4)
                        if let count = item.attachments?.count, count > 0 {
                            Label("\(count)", systemImage: "photo")
                                .font(SHTypography.micro)
                                .foregroundStyle(SHColor.inkFaint)
                        }
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(SHColor.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: SHRadius.sm, style: .continuous))
                }
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 9)
        .background(SHColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }
}
