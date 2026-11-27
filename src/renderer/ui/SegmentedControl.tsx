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

const GAUGE_COLORS: Record<ProgressTone, { stroke: string }> = {
  antigravity: { stroke: '#60a5fa' },
  codex: { stroke: '#10a37f' },
  claude: { stroke: '#d97757' },
  pi: { stroke: '#22d3ee' },
  muse: { stroke: '#a855f7' },
  warning: { stroke: '#fbbf24' },
  danger: { stroke: '#fb7185' },
  neutral: { stroke: '#d4d4d8' },
  auto: { stroke: '#818cf8' },
};

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Matches iOS `SHRadialGauge.brightened(_:)`: lighter, still-saturated version
 * of `hex` in the same hue (sat * 0.82, brightness * 1.3 + 0.08).
 */
function brightenedRgb(hex: string): [number, number, number] {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const s = (max === 0 ? 0 : d / max) * 0.82;
  const v = Math.min(1, max * 1.3 + 0.08);

  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let nr = v;
  let ng = t;
  let nb = p;
  switch (i % 6) {
    case 1:
      nr = q; ng = v; nb = p;
      break;
    case 2:
      nr = p; ng = v; nb = t;
      break;
    case 3:
      nr = p; ng = q; nb = v;
      break;
    case 4:
      nr = t; ng = p; nb = v;
      break;
    case 5:
      nr = v; ng = p; nb = q;
      break;
  }
  return [Math.round(nr * 255), Math.round(ng * 255), Math.round(nb * 255)];
}

/**
 * Matches iOS `SHRadialGauge.pulseGradient(color:spanDegrees:)`:
 * 16-stop raised-cosine swell over 200deg so the wave rises and falls smoothly with zero hard edges.
 */
function buildRaisedCosineConic(
  [r, g, b]: [number, number, number],
  maxAlpha: number,
  spanDegrees = 200
): string {
  const steps = 16;
  const stops: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const u = i / steps;
    const strength = 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
    const alpha = +(strength * maxAlpha).toFixed(3);
    const deg = +(u * spanDegrees).toFixed(1);
    stops.push(`rgba(${r},${g},${b},${alpha}) ${deg}deg`);
  }
  stops.push(`rgba(${r},${g},${b},0) 360deg`);
  return `conic-gradient(from 0deg, ${stops.join(', ')})`;
}

const pulseGradientCache = new Map<string, { trackPulse: string; brightPulse: string }>();

function getGaugePulseGradients(strokeHex: string): { trackPulse: string; brightPulse: string } {
  let cached = pulseGradientCache.get(strokeHex);
  if (!cached) {
    cached = {
      trackPulse: buildRaisedCosineConic(hexToRgb(strokeHex), 0.42),
      brightPulse: buildRaisedCosineConic(brightenedRgb(strokeHex), 1.0),
    };
    pulseGradientCache.set(strokeHex, cached);
  }
  return cached;
}

function resolveGaugePalette(
  value: number | null,
  tone: ProgressTone,
  estimated?: boolean
): { stroke: string } {
  if (value !== null && !estimated && (tone === 'auto' || tone === 'antigravity' || tone === 'codex' || tone === 'claude' || tone === 'muse' || tone === 'pi')) {
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
  const gaugeUid = React.useId().replace(/:/g, '');
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
          'grid gap-1 p-1.5 rounded-2xl bg-surface-subtle shadow-[0_2px_8px_-3px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.04)]',
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

                {/* 3. Working pulse (mirrors iOS SHRadialGauge):
                    single unified SVG so track swell, soft halo, and brightened arc ALWAYS mount together in 100% lockstep */}
                {item.working && (() => {
                  const { trackPulse, brightPulse } = getGaugePulseGradients(palette.stroke);
                  const safeItemId = `${gaugeUid}-${String(item.id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
                  const trackMaskId = `sh-track-mask-${safeItemId}`;
                  const arcMaskId = `sh-arc-mask-${safeItemId}`;
                  const haloMaskId = `sh-halo-mask-${safeItemId}`;
                  const haloBlurId = `sh-halo-blur-${safeItemId}`;
                  return (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 36 36"
                      overflow="visible"
                      className="absolute inset-0 w-full h-full pointer-events-none"
                    >
                      <defs>
                        <filter id={haloBlurId} x="-50%" y="-50%" width="200%" height="200%">
                          <feGaussianBlur stdDeviation="1.5" />
                        </filter>
                        <mask id={trackMaskId} maskUnits="userSpaceOnUse" x="-6" y="-6" width="48" height="48">
                          <circle
                            cx="18"
                            cy="18"
                            r={GAUGE_RADIUS}
                            fill="none"
                            stroke="#fff"
                            strokeWidth="3.0"
                          />
                        </mask>
                        <mask id={arcMaskId} maskUnits="userSpaceOnUse" x="-6" y="-6" width="48" height="48">
                          <circle
                            cx="18"
                            cy="18"
                            r={GAUGE_RADIUS}
                            fill="none"
                            stroke="#fff"
                            strokeWidth="3.0"
                            strokeLinecap="round"
                            strokeDasharray={GAUGE_CIRCUMFERENCE}
                            strokeDashoffset={dashOffset}
                            transform="rotate(-90 18 18)"
                          />
                        </mask>
                        <mask id={haloMaskId} maskUnits="userSpaceOnUse" x="-8" y="-8" width="52" height="52">
                          <circle
                            cx="18"
                            cy="18"
                            r={GAUGE_RADIUS}
                            fill="none"
                            stroke="#fff"
                            strokeWidth="6.6"
                            strokeLinecap="round"
                            strokeDasharray={GAUGE_CIRCUMFERENCE}
                            strokeDashoffset={dashOffset}
                            transform="rotate(-90 18 18)"
                            filter={`url(#${haloBlurId})`}
                          />
                        </mask>
                      </defs>

                      {/* Faint hue-matched swell travelling round the track */}
                      <g mask={`url(#${trackMaskId})`}>
                        <foreignObject x="0" y="0" width="36" height="36">
                          <div
                            className="sh-gauge-aurora w-full h-full rounded-full"
                            style={{ background: trackPulse }}
                          />
                        </foreignObject>
                      </g>

                      {/* Soft additive halo in the brightened hue, confined to the usage arc */}
                      <g
                        mask={`url(#${haloMaskId})`}
                        style={{
                          mixBlendMode: 'plus-lighter',
                          opacity: displayPct > 0 ? 1 : 0,
                        }}
                      >
                        <foreignObject x="-4" y="-4" width="44" height="44">
                          <div
                            className="sh-gauge-aurora w-full h-full rounded-full"
                            style={{
                              background: brightPulse,
                              filter: 'blur(1.8px)',
                            }}
                          />
                        </foreignObject>
                      </g>

                      {/* Brightened usage arc itself */}
                      <g
                        mask={`url(#${arcMaskId})`}
                        style={{ opacity: displayPct > 0 ? 1 : 0 }}
                      >
                        <foreignObject x="0" y="0" width="36" height="36">
                          <div
                            className="sh-gauge-aurora w-full h-full rounded-full"
                            style={{ background: brightPulse }}
                          />
                        </foreignObject>
                      </g>
                    </svg>
                  );
                })()}

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
