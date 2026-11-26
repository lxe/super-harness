import React from 'react';
import { formatRelativeTime } from '../utils/format';
import { cn } from './cn';

export type RecencyTier = 'hot' | 'recent' | 'today' | 'day' | 'week' | 'stale';

export interface RecencyVisual {
  tier: RecencyTier;
  /** Clockwise hand angle in degrees (15..330) representing elapsed age on a smooth log scale */
  angleDeg: number;
  /** Tailwind text color class encoding visual freshness intensity */
  colorClass: string;
  /** Opacity of the swept pie wedge (0..0.32) */
  wedgeOpacity: number;
  /** Human-readable tooltip label */
  tooltip: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Pure mapping from `updatedAt` timestamp to a visual clock hand angle and
 * color intensity tier (hot emerald <10m -> bright <1h -> medium <6h ->
 * muted <24h -> dim <7d -> faint >7d).
 */
export function computeRecencyVisual(updatedAt: number, now = Date.now()): RecencyVisual {
  const ageMs = Math.max(0, now - updatedAt);
  const rel = formatRelativeTime(updatedAt);
  const tooltip = rel === 'now' ? 'Active just now' : `Active ${rel} ago`;

  // Smooth logarithmic angle sweep from 20 deg (just now) to 330 deg (14+ days)
  const ageMin = ageMs / MINUTE;
  const norm = Math.min(1, Math.log1p(ageMin) / Math.log1p(14 * 24 * 60));
  const angleDeg = Math.round(20 + norm * 310);

  if (ageMs < 10 * MINUTE) {
    return {
      tier: 'hot',
      angleDeg,
      colorClass: 'text-emerald-400',
      wedgeOpacity: 0.28,
      tooltip,
    };
  }
  if (ageMs < HOUR) {
    return {
      tier: 'recent',
      angleDeg,
      colorClass: 'text-zinc-200',
      wedgeOpacity: 0.22,
      tooltip,
    };
  }
  if (ageMs < 6 * HOUR) {
    return {
      tier: 'today',
      angleDeg,
      colorClass: 'text-zinc-400',
      wedgeOpacity: 0.18,
      tooltip,
    };
  }
  if (ageMs < DAY) {
    return {
      tier: 'day',
      angleDeg,
      colorClass: 'text-zinc-500',
      wedgeOpacity: 0.15,
      tooltip,
    };
  }
  if (ageMs < 7 * DAY) {
    return {
      tier: 'week',
      angleDeg,
      colorClass: 'text-zinc-600',
      wedgeOpacity: 0.12,
      tooltip,
    };
  }
  return {
    tier: 'stale',
    angleDeg,
    colorClass: 'text-zinc-700',
    wedgeOpacity: 0.08,
    tooltip,
  };
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

export interface RecencyClockProps {
  updatedAt: number;
  size?: number;
  className?: string;
}

/**
 * Compact clock-dial indicator that communicates how recently a conversation
 * was active via both clock-hand sweep and color intensity — replacing noisy
 * `11m` / `2h` text badges in dense sidebar lists.
 */
export const RecencyClock: React.FC<RecencyClockProps> = React.memo(
  ({ updatedAt, size = 14, className }) => {
    const vis = computeRecencyVisual(updatedAt);
    const cx = 8;
    const cy = 8;
    const outerR = 6.2;
    const handR = 4.1;
    const wedgeR = 5.4;

    const handEnd = polarToCartesian(cx, cy, handR, vis.angleDeg);
    const wedgeStart = polarToCartesian(cx, cy, wedgeR, 0);
    const wedgeEnd = polarToCartesian(cx, cy, wedgeR, vis.angleDeg);
    const largeArc = vis.angleDeg > 180 ? 1 : 0;

    const wedgePath = `M ${cx} ${cy} L ${wedgeStart.x.toFixed(2)} ${wedgeStart.y.toFixed(2)} A ${wedgeR} ${wedgeR} 0 ${largeArc} 1 ${wedgeEnd.x.toFixed(2)} ${wedgeEnd.y.toFixed(2)} Z`;

    return (
      <span
        title={vis.tooltip}
        aria-label={vis.tooltip}
        className={cn('inline-flex items-center justify-center shrink-0', vis.colorClass, className)}
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          {/* Swept elapsed wedge */}
          <path d={wedgePath} fill="currentColor" fillOpacity={vis.wedgeOpacity} />
          {/* Crisp outer clock bezel */}
          <circle
            cx={cx}
            cy={cy}
            r={outerR}
            stroke="currentColor"
            strokeWidth="1.35"
            strokeOpacity="0.85"
          />
          {/* 12 o'clock reference hand + elapsed sweep hand */}
          <path
            d={`M ${cx} ${cy - handR} L ${cx} ${cy} L ${handEnd.x.toFixed(2)} ${handEnd.y.toFixed(2)}`}
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
);
RecencyClock.displayName = 'RecencyClock';
