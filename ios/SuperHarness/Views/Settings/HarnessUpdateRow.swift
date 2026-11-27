import SwiftUI

/// One line about a harness's update, shown in place wherever the harness is listed: the
/// version change with an Update button, then the updater's progress, then its result.
/// It takes no space when the harness is up to date and no update has run.
struct HarnessUpdateRow: View {
    @Bindable var store: AppStore
    let group: HarnessGroup

    /// What the row shows, worked out from the host's version information and the newest run.
    enum Content: Equatable {
        case none
        case available(change: String, canRun: Bool, hint: String?)
        case running(line: String, canCancel: Bool)
        case finished(line: String, failed: Bool, canRetry: Bool)
    }

    nonisolated static func content(info: HarnessUpdateInfo?, job: HarnessUpdateJob?) -> Content {
        if let job {
            if job.phase.isRunning {
                return .running(line: job.statusLine, canCancel: job.phase == .waiting)
            }
            switch job.phase {
            case .failed:
                return .finished(line: job.statusLine, failed: true, canRetry: info?.canRunUpdater == true)
            case .done:
                return .finished(line: job.statusLine, failed: false, canRetry: false)
            default:
                break
            }
        }
        guard let info, info.updateAvailable else { return .none }
        return .available(change: info.versionChange, canRun: info.canRunUpdater, hint: info.manualHint)
    }

    var body: some View {
        let info = store.harnesses.first { $0.id == group }?.update
        let content = Self.content(info: info, job: store.harnessUpdateJobs[group])
        switch content {
        case .none:
            EmptyView()
        case let .available(change, canRun, hint):
            line(icon: "arrow.down.circle", tint: SHColor.statusWarning,
                 text: "Update available",
                 // The version change sits on its own line so it never wraps mid-number.
                 detail: [change, canRun ? nil : hint].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")) {
                if canRun { actionButton("Update") { Task { await store.startHarnessUpdate(group) } } }
            }
        case let .running(text, canCancel):
            line(icon: nil, tint: SHColor.inkSecondary, text: text, detail: nil) {
                if canCancel { actionButton("Cancel") { Task { await store.cancelHarnessUpdate(group) } } }
            }
        case let .finished(text, failed, canRetry):
            line(icon: failed ? "exclamationmark.circle" : "checkmark.circle",
                 tint: failed ? SHColor.statusDanger : SHColor.statusSuccess, text: text, detail: nil) {
                if canRetry { actionButton("Retry") { Task { await store.startHarnessUpdate(group) } } }
            }
        }
    }

    private func line<Trailing: View>(icon: String?, tint: Color, text: String, detail: String?, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Group {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(tint)
                } else {
                    SHActivityPulse(tint: SHColor.porcelain, size: 14)
                }
            }
            .frame(width: 18, height: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(text)
                    .font(SHTypography.caption.weight(.medium))
                    .foregroundStyle(SHColor.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(SHTypography.micro)
                        .foregroundStyle(SHColor.inkMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            trailing()
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("harness.update.\(group.rawValue)")
    }

    private func actionButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(SHTypography.caption.weight(.semibold))
                .foregroundStyle(SHColor.inkPrimary)
                .padding(.horizontal, 12)
                .frame(height: 30)
                .shRaisedSurface(SHColor.surfaceBubble, cornerRadius: SHRadius.pill, elevation: .tile)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("harness.update.\(group.rawValue).\(title.lowercased())")
    }
}
