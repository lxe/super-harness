import React, { useEffect, useRef, useState } from 'react';
import type { HarnessGroup, UsageSnapshot } from '../../shared/types';
import { cn } from './cn';
import { useAnimationVisibilityRef } from './animationVisibility';

export type WorkingOrbTone = HarnessGroup | 'master' | 'neutral' | 'warning' | 'danger';

interface OrbPalette {
  glint: string;
  highlight: string;
  mid: string;
  deep: string;
}

/**
 * Monochromatic HSB-derived opaque 3D sphere palettes matching the exact harness & status gauge hues
 * (same hue & near-same saturation across highlight/mid/shadow — no desaturated white/pastel washout):
 * Antigravity #60a5fa, Codex #10a37f, Claude #d97757, Muse #a855f7,
 * Master #818cf8, All #d4d4d8, Warning #fbbf24, Danger #fb7185.
 */
const ORB_PALETTES: Record<WorkingOrbTone, OrbPalette> = {
  antigravity: {
    glint: '#99c7ff',
    highlight: '#6eafff',
    mid: '#60a5fa',
    deep: '#396aa5',
  },
  codex: {
    glint: '#54caad',
    highlight: '#20ba94',
    mid: '#10a37f',
    deep: '#056c52',
  },
  claude: {
    glint: '#ffb49c',
    highlight: '#f7916f',
    mid: '#d97757',
    deep: '#8f4b34',
  },
  muse: {
    glint: '#ca92ff',
    highlight: '#b465ff',
    mid: '#a855f7',
    deep: '#6c32a3',
  },
  master: {
    glint: '#afb7ff',
    highlight: '#8e99ff',
    mid: '#818cf8',
    deep: '#5058a4',
  },
  neutral: {
    glint: '#fcfcff',
    highlight: '#f2f2f6',
    mid: '#d4d4d8',
    deep: '#8c8c8f',
  },
  warning: {
    glint: '#ffd771',
    highlight: '#ffc736',
    mid: '#fbbf24',
    deep: '#a67c0f',
  },
  danger: {
    glint: '#ffa4b1',
    highlight: '#ff7e91',
    mid: '#fb7185',
    deep: '#a64553',
  },
};

/**
 * Resolves the active WorkingOrb tone for a harness group, mirroring the radial gauge's
 * warning (>=80%) and danger (>=95%) color overrides so orbs always match their gauge.
 */
export function resolveHarnessOrbTone(
  group: HarnessGroup | 'master',
  usage?: UsageSnapshot | null
): WorkingOrbTone {
  if (group === 'master' || !usage) return group;
  const entry =
    group === 'antigravity'
      ? usage.antigravity
      : group === 'codex'
        ? usage.codex
        : group === 'claude'
          ? usage.claude
          : group === 'muse'
            ? usage.muse
            : undefined;
  const pct = entry?.barPercent;
  if (typeof pct === 'number' && Number.isFinite(pct) && !entry?.barIsEstimated) {
    if (pct >= 95) return 'danger';
    if (pct >= 80) return 'warning';
  }
  return group;
}

export interface WorkingOrbProps {
  tone?: WorkingOrbTone;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_PX: Record<NonNullable<WorkingOrbProps['size']>, number> = {
  sm: 14,
  md: 16,
  lg: 22,
};

/**
 * Glow-free 3D orbiting lit-sphere activity indicator tinted to the exact gauge colorway:
 * three fully opaque monochromatic HSB-shaded spheres revolving in depth-scaled perspective.
 */
export const WorkingOrb: React.FC<WorkingOrbProps> = ({
  tone = 'master',
  size = 'md',
  className,
}) => {
  const hostRef = useAnimationVisibilityRef<HTMLSpanElement>();
  const px = SIZE_PX[size];
  const dotPx = Math.max(4.6, Math.round(px * 0.34 * 10) / 10);
  const orbitR = Math.round(px * 0.31 * 10) / 10;
  const palette = ORB_PALETTES[tone] ?? ORB_PALETTES.master;
  const sphereBg = [
    `radial-gradient(circle at 30% 27%, ${palette.glint} 0%, ${palette.glint} 8%, transparent 18%)`,
    `radial-gradient(circle at 32% 28%, ${palette.highlight} 0%, ${palette.mid} 42%, ${palette.deep} 100%)`,
  ].join(', ');

  return (
    <span
      ref={hostRef}
      aria-hidden="true"
      style={
        {
          width: px,
          height: px,
          '--sh-orbit-rx': `${orbitR}px`,
          '--sh-orbit-ry': `${Math.round(orbitR * 0.64 * 10) / 10}px`,
        } as React.CSSProperties
      }
      className={cn('relative inline-flex items-center justify-center shrink-0', className)}
    >
      {[0, 1, 2].map((idx) => {
        const delay = `${(-idx * 1.5) / 3}s`;
        return (
          <span
            key={idx}
            className="sh-orb-sphere absolute rounded-full overflow-hidden pointer-events-none"
            style={{
              width: dotPx,
              height: dotPx,
              background: sphereBg,
              animationDelay: delay,
            }}
          >
            {/* Compositor-only depth shading overlay (opacity-only, keeps sphere 100% opaque) */}
            <span
              className="sh-orb-shade absolute inset-0 rounded-full pointer-events-none"
              style={{
                background: palette.deep,
                animationDelay: delay,
              }}
            />
          </span>
        );
      })}
    </span>
  );
};

export interface WorkingIndicatorProps {
  tone?: WorkingOrbTone;
  focus?: string;
  label?: string;
  size?: 'sm' | 'md';
  /** Epoch ms when the current working turn began (defaults to mount time). */
  startedAt?: number;
  showTimer?: boolean;
  className?: string;
}

function formatWorkingElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  const remSec = s % 60;
  if (mins < 60) return `${mins}m ${String(remSec).padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hrs}h ${String(remMin).padStart(2, '0')}m`;
}

/**
 * Cohesive working status row combining the kinetic WorkingOrb with a subtle
 * compositor-only shimmering text sweep and live elapsed timer.
 */
export const WorkingIndicator: React.FC<WorkingIndicatorProps> = ({
  tone = 'master',
  focus,
  label,
  size = 'md',
  startedAt,
  showTimer = true,
  className,
}) => {
  const hostRef = useAnimationVisibilityRef<HTMLSpanElement>();
  const mountTimeRef = useRef<number>(Date.now());
  const originMs = startedAt && startedAt > 0 && startedAt <= Date.now() ? startedAt : mountTimeRef.current;
  const [elapsedSec, setElapsedSec] = useState<number>(() =>
    Math.max(0, Math.floor((Date.now() - originMs) / 1000))
  );

  useEffect(() => {
    if (!showTimer) return;
    const update = () => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - originMs) / 1000)));
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [originMs, showTimer]);

  return (
    <span
      ref={hostRef}
      className={cn(
        'inline-flex items-center gap-2 text-caption font-medium select-none',
        className
      )}
    >
      <WorkingOrb tone={tone} size={size} />
      <span className="inline-flex items-baseline gap-2">
        <span className="sh-working-shimmer">{focus || label || 'Working'}</span>
        {showTimer && (
          <span className="text-micro font-mono font-normal tabular-nums text-ink-faint">
            {formatWorkingElapsed(elapsedSec)}
          </span>
        )}
      </span>
    </span>
  );
};
