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

const GAUGE_COLORS: Record<ProgressTone, { stroke: string; shimmer: string; halo: string }> = {
  antigravity: {
    stroke: '#60a5fa',
    shimmer: 'conic-gradient(from 0deg, transparent 0deg, rgba(147,197,253,0.95) 55deg, rgba(96,165,250,0.45) 125deg, transparent 190deg)',
    halo: 'rgba(96, 165, 250, 0.24)',
  },
  codex: {
    stroke: '#10a37f',
    shimmer: 'conic-gradient(from 0deg, transparent 0deg, rgba(110,231,183,0.95) 55deg, rgba(16,163,127,0.45) 125deg, transparent 190deg)',
    halo: 'rgba(16, 163, 127, 0.24)',
  },
  claude: {
    stroke: '#d97757',
    shimmer: 'conic-gradient(from 0deg, transparent 0deg, rgba(253,186,116,0.95) 55deg, rgba(217,119,87,0.45) 125deg, transparent 190deg)',
    halo: 'rgba(217, 119, 87, 0.24)',
  },
  muse: {
    stroke: '#a855f7',
    shimmer: 'conic-gradient(from 0deg, transparent 0deg, rgba(232,121,249,0.95) 55deg, rgba(168,85,247,0.45) 125deg, transparent 190deg)',
    halo: 'rgba(168, 85, 247, 0.24)',
  },
  warning: {
    stroke: '#fbbf24',
    shimmer: 'conic-gradient(from 0deg, transparent 0deg, rgba(253,224,71,0.95) 55deg, rgba(251,191,36,0.45) 125deg, transparent 190deg)',
    halo: 'rgba(251, 191, 36, 0.24)',
  },
  danger: {
    stroke: '#fb7185',
    shimmer: 'conic-gradient(from 0deg, transparent 0deg, rgba(253,164,175,0.95) 55deg, rgba(251,113,133,0.45) 125deg, transparent 190deg)',
    halo: 'rgba(251, 113, 133, 0.24)',
  },
  neutral: {
    stroke: '#d4d4d8',
    shimmer: 'conic-gradient(from 0deg, transparent 0deg, rgba(244,244,245,0.9) 55deg, rgba(161,161,170,0.4) 125deg, transparent 190deg)',
    halo: 'rgba(212, 212, 216, 0.18)',
  },
  auto: {
    stroke: '#818cf8',
    shimmer: 'conic-gradient(from 0deg, transparent 0deg, rgba(199,210,254,0.95) 55deg, rgba(129,140,248,0.45) 125deg, transparent 190deg)',
    halo: 'rgba(129, 140, 248, 0.24)',
  },
};

function resolveGaugePalette(
  value: number | null,
  tone: ProgressTone,
  estimated?: boolean
): { stroke: string; shimmer: string; halo: string } {
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
                'relative h-11 rounded-xl flex items-center justify-center transition-colors cursor-pointer select-none focus:outline-none focus-visible:shadow-none',
                active
                  ? 'bg-white/[0.11] text-ink-primary shadow-sm'
                  : 'text-ink-muted hover:text-ink-primary hover:bg-white/[0.05]'
              )}
            >
              <span className="relative inline-flex items-center justify-center w-[34px] h-[34px]">
                {/* Soft ambient halo when actively working */}
                {item.working && (
                  <span
                    aria-hidden="true"
                    className="sh-gauge-halo absolute inset-[-3px] rounded-full pointer-events-none"
                    style={{
                      background: `radial-gradient(circle, ${palette.halo} 0%, transparent 70%)`,
                    }}
                  />
                )}

                {/* Radial gauge track + progress arc */}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 36 36"
                  className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none"
                >
                  <circle
                    cx="18"
                    cy="18"
                    r={GAUGE_RADIUS}
                    fill="none"
                    stroke={active ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.08)'}
                    strokeWidth="2.3"
                  />
                  {displayPct > 0 && (
                    <circle
                      cx="18"
                      cy="18"
                      r={GAUGE_RADIUS}
                      fill="none"
                      stroke={palette.stroke}
                      strokeOpacity={item.progress?.estimated ? 0.72 : 0.95}
                      strokeWidth="2.3"
                      strokeLinecap="round"
                      strokeDasharray={GAUGE_CIRCUMFERENCE}
                      strokeDashoffset={dashOffset}
                      className="transition-[stroke-dashoffset] duration-300 ease-out"
                    />
                  )}
                </svg>

                {/* Orbiting luminous shimmer around the gauge ring itself when working */}
                {item.working && (
                  <span
                    aria-hidden="true"
                    className="sh-gauge-shimmer absolute inset-[1px] rounded-full pointer-events-none"
                    style={{
                      background: palette.shimmer,
                      WebkitMaskImage:
                        'radial-gradient(farthest-side, transparent calc(100% - 2.6px), black calc(100% - 2.2px), black 100%)',
                      maskImage:
                        'radial-gradient(farthest-side, transparent calc(100% - 2.6px), black calc(100% - 2.2px), black 100%)',
                    }}
                  />
                )}

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
