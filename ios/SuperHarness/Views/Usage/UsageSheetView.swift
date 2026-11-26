import Charts
import SwiftUI

public struct UsageSheetView: View {
    @Bindable var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var selectedTarget: HarnessGroup?
    @State private var selectedDayDate: String?
    @State private var isRefreshing: Bool = false

    public init(store: AppStore, initialTarget: HarnessGroup? = nil) {
        self.store = store
        _selectedTarget = State(initialValue: initialTarget)
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: SHSpacing.xl) {
                    targetPicker

                    if let usage = store.usage {
                        if let target = selectedTarget {
                            singleHarnessBody(usage[target])
                        } else {
                            allHarnessesBody(usage)
                        }
                    } else if store.isBootstrapping || store.isLoadingUsage || isRefreshing {
                        UsageSkeletonView()
                    } else {
                        VStack(spacing: SHSpacing.sm) {
                            Image(systemName: "chart.bar.xaxis")
                                .font(.system(size: 28))
                                .foregroundStyle(SHColor.inkFaint)
                            Text("Usage data unavailable")
                                .font(SHTypography.heading)
                                .foregroundStyle(SHColor.inkPrimary)
                            Text("Connect to a host exposing /api/usage or switch to Demo Mode to preview quota tracking.")
                                .font(SHTypography.caption)
                                .foregroundStyle(SHColor.inkMuted)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                    }
                }
                .padding(.horizontal, SHSpacing.lg)
                .padding(.vertical, SHSpacing.md)
            }
            .background(SHColor.surfaceCanvas)
            .navigationTitle("Usage & Quotas")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                if store.usage == nil {
                    await store.refreshUsage(force: false)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task {
                            isRefreshing = true
                            await store.refreshUsage(force: true)
                            isRefreshing = false
                        }
                    } label: {
                        if isRefreshing {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .foregroundStyle(SHColor.inkSecondary)
                        }
                    }
                    .accessibilityLabel("Refresh usage")
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    // MARK: - Target Selector Pills

    private var targetPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: SHSpacing.sm) {
                targetPill(title: "All", group: nil)
                ForEach(HarnessGroup.allCases) { group in
                    targetPill(title: group.title, group: group)
                }
            }
        }
    }

    private func targetPill(title: String, group: HarnessGroup?) -> some View {
        let isSelected = selectedTarget == group
        let accent = group.map(SHColor.harness) ?? SHColor.inkPrimary
        return Button {
            withAnimation(.easeInOut(duration: 0.16)) {
                selectedTarget = group
                selectedDayDate = nil
            }
        } label: {
            HStack(spacing: 6) {
                if let group {
                    HarnessLogoView(group: group, size: 13)
                }
                Text(title)
                    .font(SHTypography.caption.weight(.semibold))
                    .foregroundStyle(isSelected ? SHColor.inkPrimary : SHColor.inkMuted)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 8)
            .background(isSelected ? accent.opacity(0.16) : SHColor.surfaceSubtle)
            .overlay(
                Capsule()
                    .stroke(isSelected ? accent.opacity(0.35) : Color.clear, lineWidth: 0.5)
            )
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Single Harness Hero-Limit Layout (mirrors desktop commit 2961d79)

    @ViewBuilder
    private func singleHarnessBody(_ info: HarnessUsageSummary) -> some View {
        let picked = UsageMetrics.pickHeroWindow(info.windows)
        let hero = picked.hero
        let secondary = picked.secondary
        let pace = hero.flatMap { UsageMetrics.computeWindowPace($0) }
        let resetStr = hero.flatMap { UsageMetrics.formatResetLabel($0.resetsAt) }
        let brand = SHColor.harness(info.harness)

        VStack(alignment: .leading, spacing: SHSpacing.lg) {
            // Header
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 8) {
                    HarnessLogoView(group: info.harness, size: 17)
                    Text(info.harness.title)
                        .font(SHTypography.title)
                        .foregroundStyle(SHColor.inkPrimary)
                }
                Spacer()
                Text(headerSubtitle(info))
                    .font(SHTypography.micro)
                    .foregroundStyle(SHColor.inkFaint)
            }

            // Hero Limit Section
            if let hero {
                let heroPct = Int(hero.usedPercent.rounded())
                let deltaText = (hero.delta24h ?? 0) > 0 ? "+\(Int((hero.delta24h ?? 0).rounded()))% today" : nil
                let paceText: String? = pace?.projectedPercent.map { proj in
                    proj > 150 ? "on pace to hit limit" : "on pace for \(proj)%"
                }
                let paceIsOver = (pace?.projectedPercent ?? 0) >= 100

                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(hero.label)
                            .font(SHTypography.caption.weight(.medium))
                            .foregroundStyle(SHColor.inkSecondary)
                        Spacer()
                        Text(resetStr ?? (heroPct == 0 ? "fresh window" : ""))
                            .font(SHTypography.micro)
                            .foregroundStyle(SHColor.inkMuted)
                    }

                    // 28pt Hero Percentage + "+X% today · on pace for Y%"
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("\(heroPct)%")
                            .font(SHTypography.heroNumber.monospacedDigit())
                            .foregroundStyle(SHColor.percentageTone(hero.usedPercent))

                        if deltaText != nil || paceText != nil {
                            HStack(spacing: 4) {
                                if let deltaText {
                                    Text(deltaText)
                                        .foregroundStyle(SHColor.inkMuted)
                                }
                                if deltaText != nil && paceText != nil {
                                    Text("·")
                                        .foregroundStyle(SHColor.inkFaint)
                                }
                                if let paceText {
                                    Text(paceText)
                                        .foregroundStyle(paceIsOver ? SHColor.statusWarning : SHColor.inkMuted)
                                }
                            }
                            .font(SHTypography.caption.monospacedDigit())
                        }
                    }

                    // Progress bar with vertical pace tick
                    ObsidianProgressBar(
                        value: hero.usedPercent,
                        tint: brand,
                        pacePercent: pace?.elapsedPercent,
                        height: 7
                    )

                    if let pace {
                        Text("Tick marks \(Int(pace.elapsedPercent.rounded()))% through the \(pace.windowWord)")
                            .font(.system(size: 11))
                            .foregroundStyle(SHColor.inkFaint)
                    }
                }
                .padding(SHSpacing.lg)
                .background(SHColor.surfacePopover)
                .clipShape(RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
            } else {
                Text(info.note ?? "Quota limits are not available locally for this harness.")
                    .font(SHTypography.caption)
                    .foregroundStyle(SHColor.inkMuted)
            }

            // Always-expanded secondary quota windows & credits
            if !secondary.isEmpty || info.creditsBalance != nil {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(secondary) { w in
                        let pct = Int(w.usedPercent.rounded())
                        let reset = UsageMetrics.formatResetLabel(w.resetsAt)
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(w.label)
                                    .font(SHTypography.caption)
                                    .foregroundStyle(SHColor.inkSecondary)
                                Spacer()
                                Text("\(pct)%")
                                    .font(SHTypography.caption.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(SHColor.percentageTone(w.usedPercent))
                                if let ctx = reset ?? (w.id == "extra" ? "of monthly cap" : nil) {
                                    Text("· \(ctx)")
                                        .font(SHTypography.micro)
                                        .foregroundStyle(SHColor.inkFaint)
                                }
                            }
                            ObsidianProgressBar(value: w.usedPercent, tint: brand, muted: true, height: 4)
                        }
                    }

                    if let credits = info.creditsBalance {
                        HStack {
                            Text("Credits remaining")
                                .font(SHTypography.caption)
                                .foregroundStyle(SHColor.inkMuted)
                            Spacer()
                            Text(Int(credits.rounded()).formatted())
                                .font(SHTypography.caption.weight(.semibold).monospacedDigit())
                                .foregroundStyle(SHColor.inkPrimary)
                        }
                        .padding(.top, 2)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(SHColor.surfaceSubtle)
                .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
            }

            // Boxless 7-Day Spend Trend (Swift Charts)
            spendTrendSection(
                points: info.dailySpend7d,
                accent: brand,
                spend7d: info.spend7dUsd,
                spend24h: info.spend24hUsd,
                spend5h: info.spend5hUsd,
                tokens7d: info.tokens7d
            )
        }
    }

    // MARK: - All Harnesses Overview

    @ViewBuilder
    private func allHarnessesBody(_ usage: UsageSnapshot) -> some View {
        let summaries = usage.allSummaries
        let total5h = summaries.reduce(0) { $0 + $1.spend5hUsd }
        let total24h = summaries.reduce(0) { $0 + $1.spend24hUsd }
        let total7d = summaries.reduce(0) { $0 + $1.spend7dUsd }
        let totalTokens = summaries.reduce(0) { $0 + $1.tokens7d }
        let combinedDaily = combineDailySpend(summaries)

        VStack(alignment: .leading, spacing: SHSpacing.lg) {
            VStack(spacing: SHSpacing.md) {
                ForEach(summaries) { h in
                    let hero = UsageMetrics.pickHeroWindow(h.windows).hero
                    let pace = hero.flatMap { UsageMetrics.computeWindowPace($0) }
                    let resetStr = hero.flatMap { UsageMetrics.formatResetLabel($0.resetsAt) }
                    let brand = SHColor.harness(h.harness)

                    Button {
                        withAnimation(.easeInOut(duration: 0.16)) {
                            selectedTarget = h.harness
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(alignment: .firstTextBaseline) {
                                HStack(spacing: 7) {
                                    HarnessLogoView(group: h.harness, size: 15)
                                    Text(h.harness.title)
                                        .font(SHTypography.label.weight(.semibold))
                                        .foregroundStyle(SHColor.inkPrimary)
                                }
                                Spacer()
                                if let hero {
                                    let pct = Int(hero.usedPercent.rounded())
                                    Text("\(pct)%")
                                        .font(SHTypography.label.weight(.semibold).monospacedDigit())
                                        .foregroundStyle(SHColor.percentageTone(hero.usedPercent))
                                    if let label = resetStr ?? hero.label as String? {
                                        Text(label)
                                            .font(SHTypography.micro)
                                            .foregroundStyle(SHColor.inkFaint)
                                    }
                                } else {
                                    Text("\(UsageMetrics.formatUsd(h.spend7dUsd)) / 7d")
                                        .font(SHTypography.micro)
                                        .foregroundStyle(SHColor.inkFaint)
                                }
                            }

                            ObsidianProgressBar(
                                value: hero?.usedPercent ?? h.barPercent,
                                tint: brand,
                                pacePercent: pace?.elapsedPercent,
                                estimated: hero == nil && (h.barIsEstimated ?? false),
                                height: 5
                            )
                        }
                        .padding(14)
                        .background(SHColor.surfacePopover)
                        .clipShape(RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }

            spendTrendSection(
                points: combinedDaily,
                accent: SHColor.inkPrimary,
                spend7d: total7d,
                spend24h: total24h,
                spend5h: total5h,
                tokens7d: totalTokens
            )
        }
    }

    // MARK: - Boxless 7-Day Spend Swift Chart

    @ViewBuilder
    private func spendTrendSection(
        points: [DailySpendPoint],
        accent: Color,
        spend7d: Double,
        spend24h: Double,
        spend5h: Double,
        tokens7d: Int
    ) -> some View {
        let lastDate = points.last?.date
        let activePoint = points.first(where: { $0.date == selectedDayDate })

        VStack(alignment: .leading, spacing: SHSpacing.md) {
            Divider().overlay(SHColor.lineHairline)

            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 4) {
                    Text("API-equivalent value")
                        .font(SHTypography.caption.weight(.medium))
                        .foregroundStyle(SHColor.inkSecondary)
                    Text("(est.)")
                        .font(SHTypography.micro)
                        .foregroundStyle(SHColor.inkFaint)
                }
                Spacer()
                if let activePoint {
                    Text("\(activePoint.date == lastDate ? "Today" : activePoint.dayLabel) · \(UsageMetrics.formatUsd(activePoint.spendUsd)) · \(UsageMetrics.formatTokens(activePoint.tokens))")
                        .font(SHTypography.micro.monospacedDigit())
                        .foregroundStyle(SHColor.inkSecondary)
                } else {
                    Text("7d · \(UsageMetrics.formatTokens(tokens7d)) tokens")
                        .font(SHTypography.micro.monospacedDigit())
                        .foregroundStyle(SHColor.inkFaint)
                }
            }

            // Boxless inline typographic metrics
            HStack(alignment: .firstTextBaseline, spacing: 18) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(UsageMetrics.formatUsd(spend7d))
                        .font(.system(size: 20, weight: .semibold).monospacedDigit())
                        .foregroundStyle(SHColor.inkPrimary)
                    Text("week")
                        .font(SHTypography.micro)
                        .foregroundStyle(SHColor.inkFaint)
                }
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(UsageMetrics.formatUsd(spend24h))
                        .font(SHTypography.caption.weight(.medium).monospacedDigit())
                        .foregroundStyle(SHColor.inkSecondary)
                    Text("today")
                        .font(SHTypography.micro)
                        .foregroundStyle(SHColor.inkFaint)
                }
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(UsageMetrics.formatUsd(spend5h))
                        .font(SHTypography.caption.weight(.medium).monospacedDigit())
                        .foregroundStyle(SHColor.inkSecondary)
                    Text("last 5h")
                        .font(SHTypography.micro)
                        .foregroundStyle(SHColor.inkFaint)
                }
            }

            if !points.isEmpty {
                Chart(points) { pt in
                    let isToday = pt.date == lastDate
                    BarMark(
                        x: .value("Day", isToday ? "Today" : pt.dayLabel),
                        y: .value("Spend", pt.spendUsd)
                    )
                    .foregroundStyle(isToday ? accent : Color.white.opacity(selectedDayDate == pt.date ? 0.36 : 0.16))
                    .cornerRadius(3)
                }
                .chartYAxis(.hidden)
                .chartXAxis {
                    AxisMarks(values: .automatic) { value in
                        AxisValueLabel()
                            .font(.system(size: 11))
                            .foregroundStyle(SHColor.inkFaint)
                    }
                }
                .frame(height: 112)
                .chartOverlay { proxy in
                    GeometryReader { _ in
                        Rectangle()
                            .fill(.clear)
                            .contentShape(Rectangle())
                            .onTapGesture { location in
                                if let label: String = proxy.value(atX: location.x) {
                                    if let match = points.first(where: { ($0.date == lastDate ? "Today" : $0.dayLabel) == label }) {
                                        selectedDayDate = selectedDayDate == match.date ? nil : match.date
                                    }
                                }
                            }
                    }
                }
            }
        }
    }

    // MARK: - Helpers

    private func headerSubtitle(_ info: HarnessUsageSummary) -> String {
        let updated = "updated \(UsageMetrics.formatUpdatedAgo(info.updatedAt))"
        if let plan = info.planLabel, plan.lowercased() != info.harness.title.lowercased() {
            return "\(plan) · \(updated)"
        }
        return updated
    }

    private func secondarySummaryLabel(secondary: [UsageQuotaWindow], credits: Double?) -> String {
        var parts: [String] = []
        if !secondary.isEmpty {
            parts.append(secondary.count == 1 ? "1 secondary window" : "\(secondary.count) secondary windows")
        }
        if credits != nil {
            parts.append("credits")
        }
        return parts.joined(separator: " & ").capitalized
    }

    private func combineDailySpend(_ summaries: [HarnessUsageSummary]) -> [DailySpendPoint] {
        guard let base = summaries.first(where: { !$0.dailySpend7d.isEmpty })?.dailySpend7d else {
            return []
        }
        return base.enumerated().map { idx, pt in
            let spend = summaries.reduce(0.0) { acc, h in
                acc + (idx < h.dailySpend7d.count ? h.dailySpend7d[idx].spendUsd : 0)
            }
            let tokens = summaries.reduce(0) { acc, h in
                acc + (idx < h.dailySpend7d.count ? h.dailySpend7d[idx].tokens : 0)
            }
            return DailySpendPoint(
                date: pt.date,
                dayLabel: pt.dayLabel,
                spendUsd: (spend * 100).rounded() / 100,
                tokens: tokens
            )
        }
    }
}
