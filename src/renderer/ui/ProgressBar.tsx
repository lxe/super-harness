import React from 'react';
import { cn } from './cn';

export type ProgressTone =
  | 'neutral'
  | 'antigravity'
  | 'codex'
  | 'claude'
  | 'warning'
  | 'danger'
  | 'auto';

export interface ProgressBarProps {
  value: number | null;
  tone?: ProgressTone;
  /** When true, avoids amber/rose threshold override for estimated activity bars */
  estimated?: boolean;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

export function resolveProgressFillClass(
  value: number | null,
  tone: ProgressTone = 'auto',
  estimated = false
): string {
  if (value === null) return 'bg-zinc-600/40';
  if (!estimated && (tone === 'auto' || tone === 'antigravity' || tone === 'codex' || tone === 'claude')) {
    if (value >= 90) return 'bg-status-danger';
    if (value >= 75) return 'bg-status-warning';
  }
  switch (tone) {
    case 'claude':
      return 'bg-brand-claude';
    case 'codex':
      return 'bg-brand-codex';
    case 'antigravity':
      return 'bg-brand-antigravity';
    case 'warning':
      return 'bg-status-warning';
    case 'danger':
      return 'bg-status-danger';
    default:
      return 'bg-ink-secondary/80';
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
  size = 'sm',
  className,
}) => {
  const clamped = Math.min(100, Math.max(0, value ?? 0));
  return (
    <div
      className={cn(
        'w-full rounded-full bg-white/[0.08] overflow-hidden',
        SIZE_CLASSES[size],
        className
      )}
    >
      <div
        style={{ width: `${clamped}%` }}
        className={cn(
          'h-full rounded-full transition-all duration-300',
          resolveProgressFillClass(value, tone, estimated)
        )}
      />
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
