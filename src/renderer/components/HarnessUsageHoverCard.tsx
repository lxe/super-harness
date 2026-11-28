import React, { useState } from 'react';
import { ExternalLink, RotateCcw } from 'lucide-react';
import type {
  DailySpendPoint,
  HarnessDetection,
  BuiltinHarnessGroup,
  HarnessGroup,
  HarnessUsageSummary,
  UsageQuotaWindow,
  UsageSnapshot,
} from '../../shared/types';
import { Button, PopoverSurface, ProgressBar } from '../ui';
import { isUpdateRunning, useHarnessUpdateJobs } from '../utils/harnessUpdates';
import { HarnessLogo } from './HarnessLogo';
import { HARNESS_TITLES } from '../utils/harnessMeta';

interface HarnessLink {
  label: string;
  url: string;
}

const HARNESS_ACCOUNT_LINKS: Record<BuiltinHarnessGroup, HarnessLink[]> = {
  claude: [
    { label: 'Usage details', url: 'https://claude.ai/settings/usage' },
    { label: 'Billing', url: 'https://claude.ai/settings/billing' },
  ],
  codex: [
    { label: 'Usage details', url: 'https://chatgpt.com/codex/settings/usage' },
    { label: 'Analytics', url: 'https://chatgpt.com/codex/cloud/settings/analytics#usage' },
  ],
  antigravity: [
    { label: 'AI Credits', url: 'https://one.google.com/ai/credits' },
    { label: 'Plans', url: 'https://one.google.com/about/google-ai-plans/' },
  ],
  muse: [],
  pi: [],
};


function formatUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 10) return `$${Math.round(n)}`;
  if (n >= 1) return `$${n.toFixed(1)}`;
  if (n === 0) return '$0';
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatUpdatedAgo(updatedAt: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
  if (diffSec < 60) return 'just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatResetLabel(resetsAt?: number): string | null {
  if (!resetsAt) return null;
  const now = Date.now();
  const diff = resetsAt - now;
  if (diff <= 0) return 'soon';
  const totalMin = Math.round(diff / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  if (totalMin < 24 * 60) {
    const hrs = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  }
  const d = new Date(resetsAt);
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${weekday} ${time}`;
}

const ResetBadge: React.FC<{ text: string; title?: string; className?: string }> = ({
  text,
  title,
  className,
}) => (
  <span
    title={title || `Resets ${text}`}
    className={`inline-flex items-center justify-end gap-1 text-micro text-ink-faint tabular-nums leading-none min-w-0 ${className || ''}`}
  >
    <RotateCcw className="w-2.5 h-2.5 shrink-0 opacity-80 -translate-y-[1px]" strokeWidth={2.1} />
    <span className="truncate">{text}</span>
  </span>
);

export interface WindowPaceInfo {
  elapsedPercent: number;
  projectedPercent: number | null;
  windowWord: string;
}

/**
 * Computes how far through a quota window we are (0..100) and the projected
 * end-of-window utilization when both `resetsAt` and `windowMinutes` are known.
 */
export function computeWindowPace(
  w: UsageQuotaWindow,
  now = Date.now()
): WindowPaceInfo | null {
  if (!w.resetsAt || !w.windowMinutes || w.windowMinutes <= 0) return null;
  const windowMs = w.windowMinutes * 60_000;
  const remainingMs = w.resetsAt - now;
  if (remainingMs <= 0 || remainingMs > windowMs) return null;
  const elapsedMs = windowMs - remainingMs;
  const elapsedPercent = Math.min(100, Math.max(0, (elapsedMs / windowMs) * 100));
  const windowWord =
    w.windowMinutes >= 7 * 1440
      ? 'week'
      : w.windowMinutes >= 1440
        ? 'day'
        : `${Math.round(w.windowMinutes / 60)}h window`;

  const projectedPercent =
    elapsedPercent >= 5 && elapsedPercent <= 98 && w.usedPercent > 0
      ? Math.round((w.usedPercent / elapsedPercent) * 100)
      : null;

  return { elapsedPercent, projectedPercent, windowWord };
}

/**
 * Selects the single most constrained primary limit to headline the popover.
 * Prefers the harness's canonical primary windows (`five_hour`, `weekly`, `primary`)
 * so third-party/extra pools (e.g. Antigravity's `3p-weekly` Claude & GPT pool)
 * stay in the secondary list rather than hijacking the headline from Gemini.
 */
export function pickHeroWindow(windows: UsageQuotaWindow[]): {
  hero: UsageQuotaWindow | null;
  secondary: UsageQuotaWindow[];
} {
  if (windows.length === 0) return { hero: null, secondary: [] };
  const canonicalPool = windows.filter(
    (w) => w.id === 'five_hour' || w.id === 'weekly' || w.id === 'primary'
  );
  const nonExtraPool = windows.filter((w) => w.id !== 'extra');
  const candidates =
    canonicalPool.length > 0
      ? canonicalPool
      : nonExtraPool.length > 0
        ? nonExtraPool
        : windows;

  let hero = candidates[0];
  for (const w of candidates) {
    if (w.usedPercent > hero.usedPercent) {
      hero = w;
    } else if (
      w.usedPercent === hero.usedPercent &&
      w.id === 'weekly' &&
      hero.id !== 'weekly'
    ) {
      hero = w;
    }
  }
  return {
    hero,
    secondary: windows.filter((w) => w !== hero),
  };
}

function pctToneClass(pct: number): string {
  if (pct >= 95) return 'text-status-danger';
  if (pct >= 80) return 'text-status-warning';
  return 'text-ink-primary';
}

function secondaryContextLabel(w: UsageQuotaWindow): string | null {
  const reset = formatResetLabel(w.resetsAt);
  if (reset) return reset;
  if (w.id === 'extra') return 'of monthly cap';
  if (Math.round(w.usedPercent) === 0) return 'fresh window';
  return null;
}

interface SpendChartProps {
  points: DailySpendPoint[];
  harness: HarnessGroup | 'all';
  spend7d: number;
  spend24h: number;
  spend5h: number;
  tokens7d: number;
}

const SpendTrendSection: React.FC<SpendChartProps> = ({
  points,
  harness,
  spend7d,
  spend24h,
  spend5h,
  tokens7d,
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const maxVal = Math.max(...points.map((p) => p.spendUsd), 0.01);
  const active = hoverIdx !== null ? points[hoverIdx] : null;
  const lastIdx = points.length - 1;

  const todayBarCls =
    harness === 'claude'
      ? 'bg-brand-claude'
      : harness === 'codex'
        ? 'bg-brand-codex'
        : harness === 'antigravity'
          ? 'bg-brand-antigravity'
          : harness === 'muse'
            ? 'bg-brand-muse'
            : harness === 'pi'
              ? 'bg-brand-pi'
              : 'bg-ink-primary';

  return (
    <div className="rounded-xl bg-black/[0.16] shadow-[inset_0_1px_1px_rgba(0,0,0,0.22)] px-3.5 py-3 space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-caption font-medium text-ink-secondary">
          API-equivalent value <span className="text-ink-faint font-normal">(est.)</span>
        </span>
        <span className="text-micro tabular-nums text-ink-faint truncate">
          {active
            ? `${hoverIdx === lastIdx ? 'Today' : active.dayLabel} · ${formatUsd(active.spendUsd)} · ${formatTokens(active.tokens)}`
            : `7d · ${formatTokens(tokens7d)} tokens`}
        </span>
      </div>

      {/* Inline typographic summary — whitespace & type hierarchy instead of nested boxes */}
      <div className="flex items-baseline gap-4 flex-wrap">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[19px] font-semibold leading-none tracking-tight tabular-nums text-ink-primary">
            {formatUsd(spend7d)}
          </span>
          <span className="text-micro text-ink-faint">week</span>
        </div>
        <div className="flex items-baseline gap-1 text-caption tabular-nums">
          <span className="font-medium text-ink-secondary">{formatUsd(spend24h)}</span>
          <span className="text-micro text-ink-faint">today</span>
        </div>
        <div className="flex items-baseline gap-1 text-caption tabular-nums">
          <span className="font-medium text-ink-secondary">{formatUsd(spend5h)}</span>
          <span className="text-micro text-ink-faint">last 5h</span>
        </div>
      </div>

      {/* Flat-top neutral bars with Today highlighted in harness colorway + clear day labels */}
      <div className="grid grid-cols-7 gap-1.5 items-end h-[58px] pt-1">
        {points.map((pt, idx) => {
          const isToday = idx === lastIdx;
          const hPct =
            pt.spendUsd > 0 ? Math.max(12, Math.round((pt.spendUsd / maxVal) * 100)) : 6;
          return (
            <div
              key={pt.date}
              onMouseEnter={() => setHoverIdx(idx)}
              onMouseLeave={() => setHoverIdx(null)}
              className="h-full flex flex-col items-center justify-end gap-1.5 cursor-default"
            >
              <div className="w-full flex-1 flex items-end">
                <div
                  style={{ height: `${hPct}%` }}
                  className={`w-full rounded-t-sm transition-colors ${
                    isToday
                      ? pt.spendUsd > 0
                        ? todayBarCls
                        : `${todayBarCls}/40`
                      : pt.spendUsd > 0
                        ? 'bg-white/[0.16] hover:bg-white/[0.28]'
                        : 'bg-white/[0.06]'
                  }`}
                />
              </div>
              <span
                className={`text-[11px] leading-none ${
                  isToday ? 'text-ink-secondary font-medium' : 'text-ink-faint'
                }`}
              >
                {isToday ? 'Today' : pt.dayLabel}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** "Update available 1.4.0 → 1.6.1 [Update]", then the update's progress and outcome. */
const HarnessUpdateNotice: React.FC<{ detection: HarnessDetection }> = ({ detection }) => {
  const { jobs, start } = useHarnessUpdateJobs();
  const [error, setError] = useState<string | null>(null);
  const u = detection.update;
  const latestJob = jobs[detection.id];
  const running = isUpdateRunning(latestJob);
  // A finished update stays on show until something new needs attention (a failure stays, to retry).
  const job =
    running ||
    latestJob?.phase === 'failed' ||
    (latestJob?.phase === 'done' && !u?.updateAvailable && !u?.staleDaemon)
      ? latestJob
      : undefined;
  if (!u) return null;
  if (!job && !u.updateAvailable && !u.staleDaemon) return null;

  let text: string;
  let tone = 'text-ink-secondary';
  if (job && running) {
    const lastLine = job.log.filter((l) => !l.startsWith('$ ')).at(-1);
    text =
      job.phase === 'waiting'
        ? (job.message ?? 'Waiting for working sessions to finish.')
        : job.phase === 'restarting'
          ? 'Restarting…'
          : lastLine || `Running ${job.step ?? 'the updater'}…`;
  } else if (job && (job.phase === 'done' || job.phase === 'failed')) {
    text = job.message ?? '';
    tone = job.phase === 'failed' ? 'text-status-danger' : 'text-status-success';
  } else if (u.updateAvailable) {
    text = `Update available · ${u.current} → ${u.latest}`;
  } else {
    text = u.staleDaemon?.detail ?? '';
    tone = 'text-status-warning';
  }
  const canStart = !running && (u.updateAvailable || Boolean(u.staleDaemon));

  return (
    <div className="flex items-center justify-between gap-3 text-caption">
      <span className={`min-w-0 ${tone} ${running ? 'truncate' : ''}`}>{error ?? text}</span>
      {(canStart || running) && (
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          loading={running}
          disabled={running}
          onClick={() => {
            setError(null);
            void start(detection.id).then((e) => setError(e));
          }}
        >
          {running ? 'Updating' : u.updateAvailable ? 'Update' : 'Restart daemon'}
        </Button>
      )}
    </div>
  );
};

interface Props {
  target: BuiltinHarnessGroup | 'all';
  usage: UsageSnapshot;
  /** That harness's detection, for the update notice. */
  detection?: HarnessDetection;
  anchorRect: { left: number; top?: number; bottom: number; width: number };
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export const HarnessUsageHoverCard: React.FC<Props> = ({
  target,
  usage,
  detection,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
}) => {
  const left = Math.max(10, Math.min(anchorRect.left, window.innerWidth - 350));
  const openAbove = anchorRect.top !== undefined && anchorRect.bottom > window.innerHeight * 0.55;
  const posStyle: React.CSSProperties = openAbove
    ? { left, bottom: Math.max(10, window.innerHeight - (anchorRect.top ?? anchorRect.bottom) + 8) }
    : { left, top: anchorRect.bottom + 8 };

  if (target === 'all') {
    const list: HarnessUsageSummary[] = [
      usage.antigravity,
      usage.codex,
      usage.claude,
      usage.muse,
      usage.pi,
    ].filter((x): x is HarnessUsageSummary => Boolean(x));
    const total5h = list.reduce((a, x) => a + x.spend5hUsd, 0);
    const total24h = list.reduce((a, x) => a + x.spend24hUsd, 0);
    const total7d = list.reduce((a, x) => a + x.spend7dUsd, 0);
    const totalTok7d = list.reduce((a, x) => a + x.tokens7d, 0);

    const combinedDaily: DailySpendPoint[] = (usage.claude?.dailySpend7d || []).map((pt, idx) => ({
      date: pt.date,
      dayLabel: pt.dayLabel,
      spendUsd:
        Math.round(
          ((usage.antigravity?.dailySpend7d[idx]?.spendUsd ?? 0) +
            (usage.codex?.dailySpend7d[idx]?.spendUsd ?? 0) +
            (usage.claude?.dailySpend7d[idx]?.spendUsd ?? 0) +
            (usage.muse?.dailySpend7d[idx]?.spendUsd ?? 0) +
            (usage.pi?.dailySpend7d[idx]?.spendUsd ?? 0)) *
            100
        ) / 100,
      tokens:
        (usage.antigravity?.dailySpend7d[idx]?.tokens ?? 0) +
        (usage.codex?.dailySpend7d[idx]?.tokens ?? 0) +
        (usage.claude?.dailySpend7d[idx]?.tokens ?? 0) +
        (usage.muse?.dailySpend7d[idx]?.tokens ?? 0) +
        (usage.pi?.dailySpend7d[idx]?.tokens ?? 0),
    }));

    return (
      <PopoverSurface
        width="auto"
        style={posStyle}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        className="fixed z-50 w-[336px] p-4 space-y-4"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-heading font-semibold text-ink-primary">Usage</span>
          <span className="text-micro text-ink-faint">All harnesses</span>
        </div>

        <div className="space-y-3">
          {list.map((h) => {
            const { hero } = pickHeroWindow(h.windows);
            const pace = hero ? computeWindowPace(hero) : null;
            const resetStr = hero ? formatResetLabel(hero.resetsAt) : null;
            const primaryLink = HARNESS_ACCOUNT_LINKS[h.harness as BuiltinHarnessGroup]?.[0];
            const pct = hero ? Math.round(hero.usedPercent) : null;

            return (
              <div key={h.harness} className="space-y-1.5">
                <div className="grid grid-cols-[minmax(0,1fr)_auto_2.75rem] items-baseline gap-x-2">
                  {primaryLink ? (
                    <button
                      type="button"
                      onClick={() => void window.superHarness.openExternalUrl(primaryLink.url)}
                      title={`Open ${HARNESS_TITLES[h.harness]} ${primaryLink.label}`}
                      className="flex items-center gap-1.5 min-w-0 text-label text-ink-primary hover:text-white font-medium transition-colors group cursor-pointer"
                    >
                      <HarnessLogo harness={h.harness} size={14} />
                      <span className="truncate">{HARNESS_TITLES[h.harness]}</span>
                      <ExternalLink className="w-2.5 h-2.5 text-ink-faint opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5 min-w-0 text-label text-ink-primary font-medium">
                      <HarnessLogo harness={h.harness} size={14} />
                      <span className="truncate">{HARNESS_TITLES[h.harness]}</span>
                    </div>
                  )}
                  {pct !== null ? (
                    <>
                      {resetStr ? (
                        <ResetBadge text={resetStr} className="max-w-[130px]" />
                      ) : (
                        <span className="text-micro text-ink-faint text-right truncate max-w-[130px]">
                          {hero?.label}
                        </span>
                      )}
                      <span className={`text-caption font-semibold tabular-nums text-right ${pctToneClass(pct)}`}>
                        {pct}%
                      </span>
                    </>
                  ) : (
                    <span className="col-span-2 text-micro text-ink-faint tabular-nums text-right">
                      {formatUsd(h.spend7dUsd)} / 7d
                    </span>
                  )}
                </div>
                <ProgressBar
                  value={hero ? hero.usedPercent : h.barPercent}
                  tone={h.harness}
                  estimated={!hero && h.barIsEstimated}
                  pacePercent={pace?.elapsedPercent}
                  size="sm"
                />
              </div>
            );
          })}
        </div>

        <SpendTrendSection
          points={combinedDaily}
          harness="all"
          spend7d={total7d}
          spend24h={total24h}
          spend5h={total5h}
          tokens7d={totalTok7d}
        />
      </PopoverSurface>
    );
  }

  const info = usage[target];
  if (!info) return null;
  const { hero, secondary } = pickHeroWindow(info.windows);
  const heroPace = hero ? computeWindowPace(hero) : null;
  const heroReset = hero ? formatResetLabel(hero.resetsAt) : null;
  const heroPct = hero ? Math.round(hero.usedPercent) : null;

  const deltaToday =
    hero && typeof hero.delta24h === 'number' && hero.delta24h > 0 ? `+${hero.delta24h}% today` : null;
  const paceLabel =
    heroPace?.projectedPercent !== null && heroPace?.projectedPercent !== undefined
      ? heroPace.projectedPercent > 150
        ? 'on pace to hit limit'
        : `on pace for ${heroPace.projectedPercent}%`
      : null;
  const paceIsOver = Boolean(heroPace?.projectedPercent && heroPace.projectedPercent >= 100);

  const rawPlan = info.planLabel?.trim() || '';
  const harnessTitle = HARNESS_TITLES[target];
  const strippedPlan = rawPlan
    .replace(new RegExp(`^${harnessTitle}\\s+`, 'i'), '')
    .trim();
  const planShort =
    strippedPlan && strippedPlan.toLowerCase() !== harnessTitle.toLowerCase()
      ? strippedPlan
      : null;

  const hasSpendData =
    info.tokens7d > 0 ||
    info.spend7dUsd > 0 ||
    info.spend24hUsd > 0 ||
    info.spend5hUsd > 0 ||
    info.dailySpend7d.some((d) => d.spendUsd > 0 || d.tokens > 0);

  const accountLinks = HARNESS_ACCOUNT_LINKS[target] || [];

  return (
    <PopoverSurface
      width="auto"
      style={posStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-50 w-[336px] p-4 space-y-4"
    >
      {/* Header: Harness identity + hero reset time (center-aligned) */}
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2 shrink-0">
          <HarnessLogo harness={target} size={15} />
          <span className="text-heading font-semibold text-ink-primary leading-none whitespace-nowrap">
            {harnessTitle}
          </span>
        </div>
        {heroReset ? (
          <ResetBadge
            text={heroReset}
            title={`Resets ${heroReset} · Updated ${formatUpdatedAgo(info.updatedAt)}`}
          />
        ) : (heroPct === 0 && hero) || planShort ? (
          <span
            title={`Updated ${formatUpdatedAgo(info.updatedAt)}`}
            className="text-micro text-ink-faint leading-none min-w-0 truncate text-right"
          >
            {heroPct === 0 && hero ? 'fresh window' : planShort}
          </span>
        ) : null}
      </div>

      {/* Hero Limit: the single most important answer ("am I close to cutoff?") */}
      {hero && heroPct !== null ? (
        <div className="space-y-3.5">
          <div className="space-y-2">
            <span className="block text-caption font-medium text-ink-secondary">{hero.label}</span>

            <div className="flex items-baseline gap-2.5 flex-wrap">
              <span
                className={`text-[28px] font-semibold leading-none tracking-tight tabular-nums ${pctToneClass(heroPct)}`}
              >
                {heroPct}%
              </span>
              {(deltaToday || paceLabel) && (
                <span className="text-caption text-ink-muted tabular-nums">
                  {deltaToday}
                  {deltaToday && paceLabel ? ' · ' : ''}
                  {paceLabel && (
                    <span className={paceIsOver ? 'text-status-warning' : undefined}>
                      {paceLabel}
                    </span>
                  )}
                </span>
              )}
            </div>

            <ProgressBar
              value={hero.usedPercent}
              tone={target}
              pacePercent={heroPace?.elapsedPercent}
              size="md"
            />
          </div>

          {/* Secondary limits: aligned 3-column layout (label | reset | %) */}
          {secondary.length > 0 && (
            <div className="space-y-2.5 pt-0.5">
              {secondary.map((w) => {
                const pct = Math.round(w.usedPercent);
                const resetStr = formatResetLabel(w.resetsAt);
                const ctx = !resetStr ? secondaryContextLabel(w) : null;
                return (
                  <div key={w.id} className="space-y-1.5">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto_2.75rem] items-center gap-x-2">
                      <span className="text-caption text-ink-secondary truncate">{w.label}</span>
                      {resetStr ? (
                        <ResetBadge text={resetStr} />
                      ) : (
                        <span className="text-micro text-ink-faint text-right truncate">
                          {ctx || ''}
                        </span>
                      )}
                      <span
                        className={`text-caption font-semibold tabular-nums text-right ${pctToneClass(pct)}`}
                      >
                        {pct}%
                      </span>
                    </div>
                    <ProgressBar value={w.usedPercent} tone={target} muted size="sm" />
                  </div>
                );
              })}
            </div>
          )}

          {typeof info.creditsBalance === 'number' && (
            <div className="flex items-baseline justify-between pt-0.5 text-caption">
              <span className="text-ink-muted">Credits remaining</span>
              <span className="tabular-nums font-medium text-ink-secondary">
                {info.creditsBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            </div>
          )}
        </div>
      ) : (
        <p className="text-caption text-ink-muted leading-relaxed">
          {info.note || 'Quota limits are not available locally for this harness.'}
        </p>
      )}

      {/* Secondary section: API-equivalent value + unambiguous 7-day trend */}
      {hasSpendData && (
        <SpendTrendSection
          points={info.dailySpend7d}
          harness={target}
          spend7d={info.spend7dUsd}
          spend24h={info.spend24hUsd}
          spend5h={info.spend5hUsd}
          tokens7d={info.tokens7d}
        />
      )}

      {detection && <HarnessUpdateNotice detection={detection} />}

      {/* Quiet footer text links (no horizontal rule) */}
      {accountLinks.length > 0 && (
        <div className="pt-0.5 flex items-center justify-between gap-3">
          {accountLinks.map((link) => (
            <button
              key={link.url}
              type="button"
              onClick={() => void window.superHarness.openExternalUrl(link.url)}
              className="inline-flex items-center gap-1.5 text-caption text-ink-muted hover:text-ink-primary transition-colors cursor-pointer"
            >
              <span>{link.label}</span>
              <ExternalLink className="w-3 h-3 text-ink-faint" />
            </button>
          ))}
        </div>
      )}
    </PopoverSurface>
  );
};
