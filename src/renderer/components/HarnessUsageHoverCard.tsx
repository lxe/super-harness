import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type {
  DailySpendPoint,
  HarnessGroup,
  HarnessUsageSummary,
  UsageSnapshot,
} from '../../shared/types';
import { Badge, Button, PopoverSurface, ProgressBar, StatTile } from '../ui';
import { HarnessLogo } from './HarnessLogo';

interface HarnessLink {
  label: string;
  url: string;
}

const HARNESS_ACCOUNT_LINKS: Record<HarnessGroup, HarnessLink[]> = {
  claude: [
    { label: 'Usage', url: 'https://claude.ai/settings/usage' },
    { label: 'Billing & Account', url: 'https://claude.ai/settings/billing' },
  ],
  codex: [
    { label: 'Codex Usage', url: 'https://chatgpt.com/codex/settings/usage' },
    { label: 'Analytics', url: 'https://chatgpt.com/codex/cloud/settings/analytics#usage' },
  ],
  antigravity: [
    { label: 'AI Credits', url: 'https://one.google.com/ai/credits' },
    { label: 'AI Plans', url: 'https://one.google.com/about/google-ai-plans/' },
  ],
};

function formatUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatResetCountdown(resetsAt?: number): string | null {
  if (!resetsAt) return null;
  const diff = resetsAt - Date.now();
  if (diff <= 0) return 'resets soon';
  const totalMin = Math.round(diff / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hrs = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `resets in ${days}d ${hrs}h`;
  if (hrs > 0) return `resets in ${hrs}h ${mins}m`;
  return `resets in ${mins}m`;
}

const HARNESS_TITLES: Record<HarnessGroup, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude',
};

interface SparklineProps {
  points: DailySpendPoint[];
  harness: HarnessGroup | 'all';
}

const SpendSparkline: React.FC<SparklineProps> = ({ points, harness }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const maxVal = Math.max(...points.map((p) => p.spendUsd), 0.01);
  const active = hoverIdx !== null ? points[hoverIdx] : null;
  const barCls =
    harness === 'claude'
      ? 'bg-brand-claude/80 hover:bg-brand-claude'
      : harness === 'codex'
        ? 'bg-brand-codex/80 hover:bg-brand-codex'
        : harness === 'antigravity'
          ? 'bg-brand-antigravity/80 hover:bg-brand-antigravity'
          : 'bg-ink-secondary/70 hover:bg-ink-primary';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-micro text-ink-muted">
        <span>7-day spend trend</span>
        <span className="font-mono text-ink-secondary">
          {active
            ? `${active.date.slice(5)}: ~${formatUsd(active.spendUsd)} (${formatTokens(active.tokens)})`
            : `peak ~${formatUsd(maxVal)}/d`}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-1.5 items-end h-12 pt-1">
        {points.map((pt, idx) => {
          const hPct = pt.spendUsd > 0 ? Math.max(12, Math.round((pt.spendUsd / maxVal) * 100)) : 5;
          return (
            <div
              key={pt.date}
              onMouseEnter={() => setHoverIdx(idx)}
              onMouseLeave={() => setHoverIdx(null)}
              className="h-full flex flex-col items-center justify-end gap-1 cursor-default"
            >
              <div className="w-full flex-1 flex items-end">
                <div
                  style={{ height: `${hPct}%` }}
                  className={`w-full rounded-sm transition-colors ${
                    pt.spendUsd > 0 ? barCls : 'bg-white/[0.06]'
                  }`}
                />
              </div>
              <span className="text-[10px] text-ink-faint leading-none">
                {pt.dayLabel.slice(0, 1)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

interface Props {
  target: HarnessGroup | 'all';
  usage: UsageSnapshot;
  anchorRect: { left: number; bottom: number; width: number };
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export const HarnessUsageHoverCard: React.FC<Props> = ({
  target,
  usage,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
}) => {
  const left = Math.max(10, Math.min(anchorRect.left, window.innerWidth - 310));
  const top = anchorRect.bottom + 8;

  if (target === 'all') {
    const list: HarnessUsageSummary[] = [usage.antigravity, usage.codex, usage.claude];
    const total5h = list.reduce((a, x) => a + x.spend5hUsd, 0);
    const total24h = list.reduce((a, x) => a + x.spend24hUsd, 0);
    const total7d = list.reduce((a, x) => a + x.spend7dUsd, 0);
    const total14d = list.reduce((a, x) => a + x.spend14dUsd, 0);
    const totalTok7d = list.reduce((a, x) => a + x.tokens7d, 0);

    const combinedDaily: DailySpendPoint[] = (usage.claude.dailySpend7d || []).map((pt, idx) => ({
      date: pt.date,
      dayLabel: pt.dayLabel,
      spendUsd:
        Math.round(
          ((usage.antigravity.dailySpend7d[idx]?.spendUsd ?? 0) +
            (usage.codex.dailySpend7d[idx]?.spendUsd ?? 0) +
            (usage.claude.dailySpend7d[idx]?.spendUsd ?? 0)) *
            100
        ) / 100,
      tokens:
        (usage.antigravity.dailySpend7d[idx]?.tokens ?? 0) +
        (usage.codex.dailySpend7d[idx]?.tokens ?? 0) +
        (usage.claude.dailySpend7d[idx]?.tokens ?? 0),
    }));

    return (
      <PopoverSurface
        width="lg"
        style={{ left, top }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        className="fixed z-50 p-3.5 space-y-3"
      >
        <div className="flex items-center justify-between">
          <span className="font-semibold text-ink-primary">All Harnesses Usage</span>
          <span className="text-micro font-mono text-ink-muted">
            {formatTokens(totalTok7d)} tok · 7d
          </span>
        </div>

        <div className="space-y-2">
          {list.map((h) => {
            const weekly = h.windows.find((w) => w.id === 'weekly');
            const fiveH = h.windows.find((w) => w.id === 'five_hour');
            const summaryLabel = weekly
              ? `${Math.round(weekly.usedPercent)}% wk${fiveH ? ` · ${Math.round(fiveH.usedPercent)}% 5h` : ''}`
              : `~${formatUsd(h.spend7dUsd)} / 7d`;
            const primaryLink = HARNESS_ACCOUNT_LINKS[h.harness][0];
            return (
              <div key={h.harness} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => void window.superHarness.openExternalUrl(primaryLink.url)}
                    title={`Open ${HARNESS_TITLES[h.harness]} ${primaryLink.label}`}
                    className="flex items-center gap-1.5 text-ink-secondary hover:text-ink-primary font-medium transition-colors group cursor-pointer"
                  >
                    <HarnessLogo harness={h.harness} size={13} />
                    <span>{HARNESS_TITLES[h.harness]}</span>
                    <ExternalLink className="w-2.5 h-2.5 text-ink-faint group-hover:text-ink-secondary transition-colors" />
                  </button>
                  <span className="font-mono text-micro text-ink-muted">{summaryLabel}</span>
                </div>
                <ProgressBar
                  value={h.barPercent}
                  tone={h.harness}
                  estimated={h.barIsEstimated}
                />
              </div>
            );
          })}
        </div>

        <div className="pt-2.5 border-t border-line-hairline space-y-2.5">
          <div className="grid grid-cols-3 gap-1.5">
            <StatTile label="5h spend" value={`~${formatUsd(total5h)}`} />
            <StatTile label="24h spend" value={`~${formatUsd(total24h)}`} />
            <StatTile label="7d spend" value={`~${formatUsd(total7d)}`} emphasize />
          </div>

          <SpendSparkline points={combinedDaily} harness="all" />

          <div className="flex items-center justify-between text-[10px] text-ink-faint">
            <span>14-day est. total</span>
            <span className="font-mono text-ink-muted">~{formatUsd(total14d)}</span>
          </div>
        </div>
      </PopoverSurface>
    );
  }

  const info = usage[target];

  return (
    <PopoverSurface
      width="lg"
      style={{ left, top }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-50 p-3.5 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HarnessLogo harness={target} size={15} />
          <span className="font-semibold text-ink-primary">{HARNESS_TITLES[target]}</span>
        </div>
        {info.planLabel && <Badge tone="neutral">{info.planLabel}</Badge>}
      </div>

      {info.windows.length > 0 ? (
        <div className="space-y-2.5">
          {info.windows.map((w) => {
            const resetStr = formatResetCountdown(w.resetsAt);
            return (
              <div key={w.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-secondary font-medium">{w.label}</span>
                  <div className="flex items-center gap-1.5 font-mono">
                    {typeof w.delta24h === 'number' && w.delta24h !== 0 && (
                      <span className="text-[10px] text-ink-faint">
                        {w.delta24h > 0 ? `+${w.delta24h}%` : `${w.delta24h}%`} 24h
                      </span>
                    )}
                    <span
                      className={`font-semibold ${
                        w.usedPercent >= 90
                          ? 'text-status-danger'
                          : w.usedPercent >= 75
                            ? 'text-status-warning'
                            : 'text-ink-primary'
                      }`}
                    >
                      {w.usedPercent % 1 === 0 ? w.usedPercent : w.usedPercent.toFixed(1)}%
                    </span>
                  </div>
                </div>
                <ProgressBar value={w.usedPercent} tone={target} />
                {resetStr && <div className="text-[10px] text-ink-faint">{resetStr}</div>}
              </div>
            );
          })}

          {typeof info.creditsBalance === 'number' && (
            <div className="flex items-center justify-between pt-0.5 text-micro">
              <span className="text-ink-muted">Credits remaining</span>
              <span className="font-mono text-ink-secondary">
                {info.creditsBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg bg-white/[0.03] border border-line-hairline px-2.5 py-2 text-micro text-ink-muted leading-relaxed">
          {info.note || 'Quota percentages are not persisted locally by this harness.'}
        </div>
      )}

      <div className="pt-2.5 border-t border-line-hairline space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-micro font-medium text-ink-secondary">
            Est. API-equivalent spend
          </span>
          <span className="text-[10px] font-mono text-ink-faint">
            {formatTokens(info.tokens7d)} tok · 7d
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <StatTile label="5h" value={`~${formatUsd(info.spend5hUsd)}`} />
          <StatTile label="24h" value={`~${formatUsd(info.spend24hUsd)}`} />
          <StatTile label="7d" value={`~${formatUsd(info.spend7dUsd)}`} emphasize />
        </div>

        <SpendSparkline points={info.dailySpend7d} harness={target} />

        <div className="flex items-center justify-between text-[10px] text-ink-faint">
          <span>14-day total</span>
          <span className="font-mono text-ink-muted">~{formatUsd(info.spend14dUsd)}</span>
        </div>
      </div>

      <div className="pt-2 border-t border-line-hairline flex items-center gap-1.5">
        {HARNESS_ACCOUNT_LINKS[target].map((link) => (
          <Button
            key={link.url}
            size="xs"
            variant="subtle"
            onClick={() => void window.superHarness.openExternalUrl(link.url)}
            iconRight={<ExternalLink className="w-3 h-3 text-ink-faint" />}
            className="flex-1"
          >
            {link.label}
          </Button>
        ))}
      </div>
    </PopoverSurface>
  );
};
