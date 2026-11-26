import SwiftUI

/// Calm, scrollable inline activity indicator (`Running >`) that expands on tap to inspect
/// live agent steps or running tasks without ever being pinned above the composer.
public struct LiveStepsBarView: View {
    public let activity: LiveActivityState
    public let accentColor: Color

    @State private var isExpanded: Bool = false

    public init(activity: LiveActivityState, accentColor: Color) {
        self.activity = activity
        self.accentColor = accentColor
    }

    private var steps: [LiveStepItem] { activity.steps ?? [] }
    private var runningTasks: [RunningTaskItem] { activity.runningTasks ?? [] }

    private var titleText: String {
        if let focus = activity.focus, !focus.isEmpty {
            return focus
        }
        if let active = steps.first(where: { $0.status == .inProgress }) {
            return active.title
        }
        if let task = runningTasks.first {
            return task.summary
        }
        return activity.isWorking ? "Running" : "Activity"
    }

    private var progressBadge: String? {
        guard !steps.isEmpty else { return nil }
        let done = steps.filter { $0.status == .done }.count
        return "\(done)/\(steps.count)"
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: SHLayout.itemGap) {
            SHInlineDisclosureRow(
                icon: "terminal",
                title: titleText,
                trailingBadge: progressBadge,
                tint: activity.isWorking ? accentColor : SHColor.inkMuted,
                isSpinning: activity.isWorking,
                isExpanded: isExpanded
            ) {
                isExpanded.toggle()
            }

            if isExpanded {
                VStack(alignment: .leading, spacing: SHLayout.itemGap) {
                    ForEach(steps) { step in
                        HStack(spacing: 7) {
                            Image(systemName: stepIcon(step.status))
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(stepColor(step.status))
                            Text(step.title)
                                .font(SHTypography.caption)
                                .foregroundStyle(step.status == .done ? SHColor.inkMuted : SHColor.inkSecondary)
                                .lineLimit(2)
                        }
                    }
                    ForEach(runningTasks) { task in
                        HStack(spacing: 7) {
                            Image(systemName: "terminal")
                                .font(.system(size: 11))
                                .foregroundStyle(accentColor)
                            Text(task.command ?? task.summary)
                                .font(SHTypography.monoSmall)
                                .foregroundStyle(SHColor.inkSecondary)
                                .lineLimit(2)
                        }
                    }
                }
                .padding(.leading, 21)
                .padding(.bottom, 4)
            }
        }
    }

    private func stepIcon(_ status: LiveStepStatus) -> String {
        switch status {
        case .done: return "checkmark.circle.fill"
        case .inProgress: return "circle.dotted"
        case .pending: return "circle"
        case .skipped: return "minus.circle"
        case .failed: return "xmark.circle.fill"
        }
    }

    private func stepColor(_ status: LiveStepStatus) -> Color {
        switch status {
        case .done: return SHColor.statusSuccess
        case .inProgress: return accentColor
        case .pending, .skipped: return SHColor.inkFaint
        case .failed: return SHColor.statusDanger
        }
    }
}
