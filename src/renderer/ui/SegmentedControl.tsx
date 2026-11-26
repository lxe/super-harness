import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';
import { ProgressBar, type ProgressTone } from './ProgressBar';

export interface SegmentedItem<T extends string> {
  id: T;
  label: string;
  icon?: React.ReactNode;
  working?: boolean;
  progress?: {
    value: number | null;
    tone: ProgressTone;
    estimated?: boolean;
  };
}

export interface SegmentedControlProps<T extends string> {
  items: Array<SegmentedItem<T>>;
  value: T;
  onChange: (value: T) => void;
  onItemMouseEnter?: (id: T, el: HTMLElement) => void;
  onItemMouseLeave?: (id: T) => void;
  /** When true, tabs that provide an `icon` hide their text label and center only the logo. */
  iconOnly?: boolean;
  /** Visual style: `'bar'` (default horizontal progress bar) or `'gauge'` (circular radial gauge around icon). */
  variant?: 'bar' | 'gauge';
  className?: string;
}

const GAUGE_COLORS: Record<ProgressTone, { stroke: string; shimmer: string }> = {
  antigravity: { stroke: '#60a5fa', shimmer: '#bfdbfe' },
  codex: { stroke: '#10a37f', shimmer: '#a7f3d0' },
  claude: { stroke: '#d97757', shimmer: '#fed7aa' },
  muse: { stroke: '#a855f7', shimmer: '#f0abfc' },
  warning: { stroke: '#fbbf24', shimmer: '#fef08a' },
  danger: { stroke: '#fb7185', shimmer: '#fecdd3' },
  neutral: { stroke: '#d4d4d8', shimmer: '#ffffff' },
  auto: { stroke: '#818cf8', shimmer: '#c7d2fe' },
};

function resolveGaugePalette(
  value: number | null,
  tone: ProgressTone,
  estimated?: boolean
): { stroke: string; shimmer: string } {
  if (value !== null && !estimated && (tone === 'auto' || tone === 'antigravity' || tone === 'codex' || tone === 'claude' || tone === 'muse')) {
    if (value >= 95) return GAUGE_COLORS.danger;
    if (value >= 80) return GAUGE_COLORS.warning;
  }
  return GAUGE_COLORS[tone] ?? GAUGE_COLORS.neutral;
}

const GAUGE_RADIUS = 15;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  onItemMouseEnter,
  onItemMouseLeave,
  iconOnly = false,
  variant = 'bar',
  className,
}: SegmentedControlProps<T>) {
  const hasAnyProgress = items.some((i) => i.progress !== undefined);

  if (variant === 'gauge') {
    return (
      <div
        role="tablist"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
        className={cn(
          'grid gap-1 p-1.5 rounded-2xl bg-surface-subtle border border-line-hairline',
          className
        )}
      >
        {items.map((item) => {
          const active = item.id === value;
          const rawVal = item.progress?.value ?? null;
          const clamped =
            rawVal === null || !Number.isFinite(rawVal)
              ? null
              : Math.max(0, Math.min(100, rawVal));
          const displayPct = clamped === null ? 0 : clamped > 0 ? Math.max(clamped, 4) : 0;
          const dashOffset = GAUGE_CIRCUMFERENCE * (1 - displayPct / 100);
          const palette = resolveGaugePalette(
            clamped,
            item.progress?.tone ?? 'neutral',
            item.progress?.estimated
          );

          return (
            <button
              key={item.id}
              role="tab"
              aria-selected={active}
              aria-label={item.label}
              title={!onItemMouseEnter ? item.label : undefined}
              type="button"
              onClick={() => onChange(item.id)}
              onMouseEnter={(e) => onItemMouseEnter?.(item.id, e.currentTarget)}
              onMouseLeave={() => onItemMouseLeave?.(item.id)}
              className={cn(
                'relative h-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer select-none focus:outline-none focus-visible:shadow-none',
                active
                  ? 'bg-white/[0.11] text-ink-primary shadow-sm'
                  : 'text-ink-muted hover:text-ink-primary hover:bg-white/[0.05]'
              )}
            >
              <span className="relative inline-flex items-center justify-center w-8 h-8">
                {/* Radial gauge track + underneath comet chaser + progress arc on top */}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 36 36"
                  className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none overflow-visible"
                >
                  <circle
                    cx="18"
                    cy="18"
                    r={GAUGE_RADIUS}
                    fill="none"
                    stroke={active ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.08)'}
                    strokeWidth="2.3"
                  />
                  {item.working && (
                    <g
                      className="sh-gauge-shimmer"
                      style={{ transformOrigin: '18px 18px' }}
                    >
                      {/* Smooth 4-stage clockwise comet: faded tail -> bright luminous head */}
                      <circle
                        cx="18"
                        cy="18"
                        r={GAUGE_RADIUS}
                        fill="none"
                        stroke={palette.shimmer}
                        strokeOpacity="0.18"
                        strokeWidth="2.3"
                        strokeLinecap="round"
                        strokeDasharray={`34 ${GAUGE_CIRCUMFERENCE}`}
                        strokeDashoffset="0"
                      />
                      <circle
                        cx="18"
                        cy="18"
                        r={GAUGE_RADIUS}
                        fill="none"
                        stroke={palette.shimmer}
                        strokeOpacity="0.38"
                        strokeWidth="2.3"
                        strokeLinecap="round"
                        strokeDasharray={`22 ${GAUGE_CIRCUMFERENCE}`}
                        strokeDashoffset="-12"
                      />
                      <circle
                        cx="18"
                        cy="18"
                        r={GAUGE_RADIUS}
                        fill="none"
                        stroke={palette.shimmer}
                        strokeOpacity="0.72"
                        strokeWidth="2.3"
                        strokeLinecap="round"
                        strokeDasharray={`11 ${GAUGE_CIRCUMFERENCE}`}
                        strokeDashoffset="-23"
                      />
                      <circle
                        cx="18"
                        cy="18"
                        r={GAUGE_RADIUS}
                        fill="none"
                        stroke="#ffffff"
                        strokeOpacity="0.96"
                        strokeWidth="2.3"
                        strokeLinecap="round"
                        strokeDasharray={`4 ${GAUGE_CIRCUMFERENCE}`}
                        strokeDashoffset="-30"
                        style={{ filter: `drop-shadow(0 0 2.5px ${palette.stroke})` }}
                      />
                    </g>
                  )}
                  {displayPct > 0 && (
                    <circle
                      cx="18"
                      cy="18"
                      r={GAUGE_RADIUS}
                      fill="none"
                      stroke={palette.stroke}
                      strokeOpacity={item.progress?.estimated ? 0.78 : 0.96}
                      strokeWidth="2.3"
                      strokeLinecap="round"
                      strokeDasharray={GAUGE_CIRCUMFERENCE}
                      strokeDashoffset={dashOffset}
                      className="transition-[stroke-dashoffset] duration-300 ease-out"
                    />
                  )}
                </svg>

                {/* Centered icon (or compact 'All' glyph for the unified tab) */}
                <span className="relative z-10 inline-flex items-center justify-center">
                  {item.icon ? (
                    item.icon
                  ) : (
                    <span className="text-[10.5px] font-semibold tracking-tight leading-none">
                      {item.label}
                    </span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      className={cn(
        'grid gap-1 p-1 rounded-xl bg-surface-subtle border border-line-hairline',
        className
      )}
    >
      {items.map((item) => {
        const active = item.id === value;
        const logoOnly = iconOnly && Boolean(item.icon);
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={active}
            aria-label={logoOnly ? item.label : undefined}
            title={logoOnly && !onItemMouseEnter ? item.label : undefined}
            type="button"
            onClick={() => onChange(item.id)}
            onMouseEnter={(e) => onItemMouseEnter?.(item.id, e.currentTarget)}
            onMouseLeave={() => onItemMouseLeave?.(item.id)}
            className={cn(
              'relative flex flex-col items-center justify-center gap-1 rounded-lg text-caption font-medium transition-colors cursor-pointer select-none',
              logoOnly ? 'px-1' : 'px-1.5',
              hasAnyProgress ? 'pt-1.5 pb-1' : 'py-1.5',
              active
                ? 'bg-white/[0.12] text-ink-primary shadow-sm'
                : 'text-ink-muted hover:text-ink-primary hover:bg-white/[0.05]'
            )}
          >
            <div
              className={cn(
                'flex items-center justify-center w-full min-w-0',
                iconOnly ? 'h-[18px]' : 'gap-1'
              )}
            >
              {item.icon && (
                <span className="shrink-0 inline-flex items-center justify-center">
                  {item.icon}
                </span>
              )}
              {!logoOnly && <span className="truncate">{item.label}</span>}
              {!logoOnly && item.working && (
                <Loader2 className="w-2.5 h-2.5 animate-spin text-ink-secondary shrink-0" />
              )}
            </div>
            {logoOnly && item.working && (
              <Loader2 className="w-2 h-2 animate-spin text-ink-secondary absolute top-1 right-1 pointer-events-none" />
            )}
            {hasAnyProgress && (
              <ProgressBar
                size="xs"
                value={item.progress?.value ?? null}
                tone={item.progress?.tone ?? 'neutral'}
                estimated={item.progress?.estimated}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
