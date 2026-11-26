import React from 'react';
import { cn } from './cn';
import { WorkingOrb } from './WorkingOrb';
import { useAnimationVisibilityRef } from './animationVisibility';
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
  /**
   * Gauge variant: lets the user drag items to reorder them. `canReorder` picks which items
   * take part (e.g. not "All"); `onReorder` gets the dragged item and the item it was dropped on.
   */
  onReorder?: (dragged: T, target: T) => void;
  canReorder?: (id: T) => boolean;
}

const GAUGE_COLORS: Record<ProgressTone, { stroke: string; comet: string }> = {
  antigravity: {
    stroke: '#60a5fa',
    comet:
      'conic-gradient(from 0deg, transparent 0deg, transparent 120deg, rgba(96,165,250,0.16) 195deg, rgba(147,197,253,0.62) 295deg, rgba(255,255,255,0.92) 348deg, transparent 360deg)',
  },
  codex: {
    stroke: '#10a37f',
    comet:
      'conic-gradient(from 0deg, transparent 0deg, transparent 120deg, rgba(16,163,127,0.16) 195deg, rgba(110,231,183,0.62) 295deg, rgba(255,255,255,0.92) 348deg, transparent 360deg)',
  },
  claude: {
    stroke: '#d97757',
    comet:
      'conic-gradient(from 0deg, transparent 0deg, transparent 120deg, rgba(217,119,87,0.16) 195deg, rgba(253,186,116,0.62) 295deg, rgba(255,255,255,0.92) 348deg, transparent 360deg)',
  },
  muse: {
    stroke: '#a855f7',
    comet:
      'conic-gradient(from 0deg, transparent 0deg, transparent 120deg, rgba(168,85,247,0.18) 195deg, rgba(232,121,249,0.65) 295deg, rgba(255,255,255,0.92) 348deg, transparent 360deg)',
  },
  warning: {
    stroke: '#fbbf24',
    comet:
      'conic-gradient(from 0deg, transparent 0deg, transparent 120deg, rgba(251,191,36,0.16) 195deg, rgba(253,224,71,0.62) 295deg, rgba(255,255,255,0.92) 348deg, transparent 360deg)',
  },
  danger: {
    stroke: '#fb7185',
    comet:
      'conic-gradient(from 0deg, transparent 0deg, transparent 120deg, rgba(251,113,133,0.16) 195deg, rgba(253,164,175,0.62) 295deg, rgba(255,255,255,0.92) 348deg, transparent 360deg)',
  },
  neutral: {
    stroke: '#d4d4d8',
    comet:
      'conic-gradient(from 0deg, transparent 0deg, transparent 120deg, rgba(212,212,216,0.14) 195deg, rgba(244,244,245,0.55) 295deg, rgba(255,255,255,0.9) 348deg, transparent 360deg)',
  },
  auto: {
    stroke: '#818cf8',
    comet:
      'conic-gradient(from 0deg, transparent 0deg, transparent 120deg, rgba(129,140,248,0.16) 195deg, rgba(199,210,254,0.62) 295deg, rgba(255,255,255,0.92) 348deg, transparent 360deg)',
  },
};

function resolveGaugePalette(
  value: number | null,
  tone: ProgressTone,
  estimated?: boolean
): { stroke: string; comet: string } {
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
  onReorder,
  canReorder,
}: SegmentedControlProps<T>) {
  const gaugeContainerRef = useAnimationVisibilityRef<HTMLDivElement>();
  const hasAnyProgress = items.some((i) => i.progress !== undefined);
  const [dragId, setDragId] = React.useState<T | null>(null);
  const [overId, setOverId] = React.useState<T | null>(null);
  const dragIdRef = React.useRef<T | null>(null);
  const overIdRef = React.useRef<T | null>(null);
  const pendingDragRef = React.useRef<{ id: T; startX: number; startY: number; pointerId: number } | null>(null);
  const suppressClickRef = React.useRef(false);
  const onReorderRef = React.useRef(onReorder);
  const canReorderRef = React.useRef(canReorder);
  const onItemMouseLeaveRef = React.useRef(onItemMouseLeave);
  onReorderRef.current = onReorder;
  canReorderRef.current = canReorder;
  onItemMouseLeaveRef.current = onItemMouseLeave;

  const reorderable = (id: T) => Boolean(onReorder) && (canReorder ? canReorder(id) : true);

  // Pointer-event drag-to-reorder (never HTML5 draggable, which deadlocks Electron on Wayland)
  React.useEffect(() => {
    if (variant !== 'gauge') return;
    const isReorderableId = (id: T) =>
      Boolean(onReorderRef.current) && (canReorderRef.current ? canReorderRef.current(id) : true);

    const findTargetAtPoint = (x: number, y: number): T | null => {
      const container = gaugeContainerRef.current;
      if (!container) return null;
      const buttons = container.querySelectorAll<HTMLElement>('[data-gauge-id]');
      for (const btn of buttons) {
        const rect = btn.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top - 12 && y <= rect.bottom + 12) {
          const id = btn.dataset.gaugeId as T | undefined;
          if (id && isReorderableId(id)) return id;
        }
      }
      return null;
    };

    const onPointerMove = (e: PointerEvent) => {
      const pending = pendingDragRef.current;
      if (!pending || e.pointerId !== pending.pointerId) return;
      if (!dragIdRef.current) {
        const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
        if (dist < 5) return;
        dragIdRef.current = pending.id;
        setDragId(pending.id);
        onItemMouseLeaveRef.current?.(pending.id);
      }
      const target = findTargetAtPoint(e.clientX, e.clientY);
      if (target !== overIdRef.current) {
        overIdRef.current = target;
        setOverId(target);
      }
    };

    const finishDrag = (commit: boolean) => {
      const dragged = dragIdRef.current;
      const target = overIdRef.current;
      pendingDragRef.current = null;
      if (dragged) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        if (commit && target && target !== dragged && isReorderableId(target)) {
          onReorderRef.current?.(dragged, target);
        }
      }
      dragIdRef.current = null;
      overIdRef.current = null;
      setDragId(null);
      setOverId(null);
    };

    const onPointerUp = (e: PointerEvent) => {
      const pending = pendingDragRef.current;
      if (!pending || e.pointerId !== pending.pointerId) return;
      finishDrag(true);
    };

    const onPointerCancel = () => {
      if (!pendingDragRef.current && !dragIdRef.current) return;
      finishDrag(false);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onPointerCancel);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('blur', onPointerCancel);
    };
  }, [variant, gaugeContainerRef]);

  if (variant === 'gauge') {
    return (
      <div
        ref={gaugeContainerRef}
        role="tablist"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
        className={cn(
          'grid gap-1 p-1.5 rounded-2xl bg-[#181a20] shadow-[0_2px_8px_-3px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.04)]',
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
              data-gauge-id={item.id}
              role="tab"
              aria-selected={active}
              aria-label={item.label}
              title={!onItemMouseEnter ? item.label : undefined}
              type="button"
              onClick={() => {
                if (suppressClickRef.current) return;
                onChange(item.id);
              }}
              onMouseEnter={(e) => {
                if (dragIdRef.current) return;
                onItemMouseEnter?.(item.id, e.currentTarget);
              }}
              onMouseLeave={() => onItemMouseLeave?.(item.id)}
              onPointerDown={(e) => {
                if (e.button !== 0 || !reorderable(item.id)) return;
                pendingDragRef.current = {
                  id: item.id,
                  startX: e.clientX,
                  startY: e.clientY,
                  pointerId: e.pointerId,
                };
              }}
              className={cn(
                'relative h-11 rounded-xl flex items-center justify-center transition-colors cursor-pointer select-none focus:outline-none focus-visible:shadow-none',
                dragId === item.id && 'opacity-40',
                overId === item.id && dragId !== item.id && 'ring-1 ring-white/25',
                active
                  ? 'bg-white/[0.11] text-ink-primary shadow-[0_2px_6px_-2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.07)]'
                  : 'text-ink-muted hover:text-ink-primary hover:bg-white/[0.05]'
              )}
            >
              <span className="relative inline-flex items-center justify-center w-8 h-8 isolate">
                {/* 1. Recessed circular track (bottom layer) — thicker refined 3.0 stroke */}
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
                    stroke={active ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.09)'}
                    strokeWidth="3.0"
                  />
                </svg>

                {/* 2. Colored usage gauge arc */}
                {displayPct > 0 && (
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
                      stroke={palette.stroke}
                      strokeOpacity={item.progress?.estimated ? 0.8 : 0.96}
                      strokeWidth="3.0"
                      strokeLinecap="round"
                      strokeDasharray={GAUGE_CIRCUMFERENCE}
                      strokeDashoffset={dashOffset}
                      className="transition-[stroke-dashoffset] duration-300 ease-out"
                    />
                  </svg>
                )}

                {/* 3. Pure luminosity shimmer wave sweeping over both grey track & colored arc */}
                {item.working && (
                  <span
                    aria-hidden="true"
                    className="sh-gauge-aurora absolute inset-[1px] rounded-full pointer-events-none"
                    style={{
                      background:
                        'conic-gradient(from 0deg, transparent 0deg, rgba(255,255,255,0.06) 35deg, rgba(255,255,255,0.44) 80deg, rgba(255,255,255,0.06) 125deg, transparent 160deg)',
                      mixBlendMode: 'screen',
                      WebkitMaskImage:
                        'radial-gradient(farthest-side, transparent calc(100% - 3.1px), #000 calc(100% - 2.8px))',
                      maskImage:
                        'radial-gradient(farthest-side, transparent calc(100% - 3.1px), #000 calc(100% - 2.8px))',
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
                <WorkingOrb tone="master" size="sm" className="shrink-0" />
              )}
            </div>
            {logoOnly && item.working && (
              <WorkingOrb tone="master" size="sm" className="absolute top-0.5 right-0.5 pointer-events-none scale-75" />
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
