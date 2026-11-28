import React from 'react';
import { cn } from './cn';

export type ProgressTone =
  | 'neutral'
  | 'antigravity'
  | 'codex'
  | 'claude'
  | 'muse'
  | 'pi'
  | 'acp'
  | 'warning'
  | 'danger'
  | 'auto';

export interface ProgressBarProps {
  value: number | null;
  tone?: ProgressTone;
  /** When true, avoids amber/rose threshold override for estimated activity bars */
  estimated?: boolean;
  /** Quieter opacity for secondary limits below the hero limit */
  muted?: boolean;
  /** Optional 0..100 vertical pace tick showing elapsed fraction of the current window */
  pacePercent?: number | null;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

export function resolveProgressFillClass(
  value: number | null,
  tone: ProgressTone = 'auto',
  estimated = false,
  muted = false
): string {
  if (value === null) return 'bg-zinc-600/40';
  if (!estimated && (tone === 'auto' || tone === 'antigravity' || tone === 'codex' || tone === 'claude' || tone === 'muse' || tone === 'pi' || tone === 'acp')) {
    if (value >= 95) return 'bg-status-danger';
    if (value >= 80) return 'bg-status-warning';
  }
  switch (tone) {
    case 'claude':
      return muted ? 'bg-brand-claude/60' : 'bg-brand-claude';
    case 'codex':
      return muted ? 'bg-brand-codex/60' : 'bg-brand-codex';
    case 'antigravity':
      return muted ? 'bg-brand-antigravity/60' : 'bg-brand-antigravity';
    case 'muse':
      return muted ? 'bg-brand-muse/60' : 'bg-brand-muse';
    case 'pi':
      return muted ? 'bg-brand-pi/60' : 'bg-brand-pi';
    case 'acp':
      return muted ? 'bg-lime-400/60' : 'bg-lime-400';
    case 'warning':
      return 'bg-status-warning';
    case 'danger':
      return 'bg-status-danger';
    default:
      return muted ? 'bg-ink-secondary/45' : 'bg-ink-secondary/80';
  }
}

const SIZE_CLASSES = {
  xs: 'h-[2.5px]',
  sm: 'h-1.5',
  md: 'h-2',
};

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  tone = 'auto',
  estimated = false,
  muted = false,
  pacePercent = null,
  size = 'sm',
  className,
}) => {
  const clamped = Math.min(100, Math.max(0, value ?? 0));
  const showPace =
    typeof pacePercent === 'number' &&
    Number.isFinite(pacePercent) &&
    pacePercent >= 2 &&
    pacePercent <= 98;
  return (
    <div className={cn('relative w-full', SIZE_CLASSES[size], className)}>
      <div className="w-full h-full rounded-full bg-white/[0.08] overflow-hidden">
        <div
          style={{ width: `${clamped}%` }}
          className={cn(
            'h-full rounded-full transition-all duration-300',
            resolveProgressFillClass(value, tone, estimated, muted)
          )}
        />
      </div>
      {showPace && (
        <div
          style={{ left: `${pacePercent}%` }}
          title={`${Math.round(pacePercent!)}% through window`}
          className="pointer-events-none absolute -top-[3px] -bottom-[3px] w-[2px] -ml-[1px] rounded-full bg-ink-primary/80 shadow-[0_0_4px_rgba(0,0,0,0.8)]"
        />
      )}
    </div>
  );
};

export interface StatTileProps {
  label: string;
  value: React.ReactNode;
  emphasize?: boolean;
  className?: string;
}

export const StatTile: React.FC<StatTileProps> = ({
  label,
  value,
  emphasize = false,
  className,
}) => (
  <div
    className={cn(
      'rounded-lg bg-white/[0.03] border border-line-hairline px-2 py-1.5',
      className
    )}
  >
    <div className="text-[10px] text-ink-faint leading-tight">{label}</div>
    <div
      className={cn(
        'font-mono text-caption font-medium mt-0.5',
        emphasize ? 'text-ink-primary' : 'text-ink-secondary'
      )}
    >
      {value}
    </div>
  </div>
);
