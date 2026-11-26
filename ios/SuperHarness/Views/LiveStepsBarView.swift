import SwiftUI

public struct LiveStepsBarView: View {
    public let activity: LiveActivityState
    public let accentColor: Color
    @State private var isExpanded: Bool = false

    public init(activity: LiveActivityState, accentColor: Color) {
        self.activity = activity
        self.accentColor = accentColor
    }

    private var steps: [LiveStepItem] {
        activity.steps ?? []
    }

    private var runningTasks: [RunningTaskItem] {
        activity.runningTasks ?? []
    }

    private var doneCount: Int {
        steps.filter { $0.status == .done }.count
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: SHSpacing.sm) {
                    if activity.isWorking {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(accentColor)
                    } else {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 13))
                            .foregroundStyle(SHColor.statusSuccess)
                    }

                    Text(headerText)
                        .font(SHTypography.caption.weight(.medium))
                        .foregroundStyle(SHColor.inkPrimary)
                        .lineLimit(1)

                    Spacer(minLength: 6)

                    if !steps.isEmpty {
                        Text("\(doneCount)/\(steps.count)")
                            .font(SHTypography.micro.monospacedDigit().weight(.medium))
                            .foregroundStyle(SHColor.inkMuted)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.white.opacity(0.06))
                            .clipShape(Capsule())
                    }

                    if !steps.isEmpty || !runningTasks.isEmpty {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.up")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(SHColor.inkFaint)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if !runningTasks.isEmpty && !isExpanded {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(runningTasks) { task in
                            taskPill(task)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                }
            }

            if isExpanded {
                Divider()
                    .overlay(SHColor.lineHairline)

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(steps) { step in
                        HStack(spacing: 8) {
                            stepIcon(step.status)
                            Text(step.title)
                                .font(SHTypography.caption)
                                .foregroundStyle(step.status == .done ? SHColor.inkMuted : SHColor.inkPrimary)
                                .strikethrough(step.status == .skipped)
                                .lineLimit(2)
                        }
                    }

                    if !runningTasks.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(runningTasks) { task in
                                taskPill(task)
                            }
                        }
                        .padding(.top, steps.isEmpty ? 0 : 4)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
        }
        .background(SHColor.surfacePopover)
        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }

    private var headerText: String {
        if let focus = activity.focus, !focus.isEmpty {
            return focus
        }
        if let current = steps.first(where: { $0.status == .inProgress }) {
            return current.title
        }
        return activity.isWorking ? "Agent working…" : "Checklist complete"
    }

    @ViewBuilder
    private func stepIcon(_ status: LiveStepStatus) -> some View {
        switch status {
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(SHColor.statusSuccess)
        case .inProgress:
            ProgressView()
                .controlSize(.mini)
                .tint(accentColor)
        case .pending:
            Image(systemName: "circle")
                .font(.system(size: 12))
                .foregroundStyle(SHColor.inkFaint)
        case .skipped:
            Image(systemName: "minus.circle")
                .font(.system(size: 12))
                .foregroundStyle(SHColor.inkFaint)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(SHColor.statusDanger)
        }
    }

    private func taskPill(_ task: RunningTaskItem) -> some View {
        HStack(spacing: 5) {
            Image(systemName: task.isDaemon == true ? "dot.radiowaves.left.and.right" : "terminal")
                .font(.system(size: 10))
                .foregroundStyle(accentColor)
            Text(task.summary)
                .font(SHTypography.micro)
                .foregroundStyle(SHColor.inkSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(SHColor.surfaceRaised)
        .clipShape(Capsule())
    }
}
