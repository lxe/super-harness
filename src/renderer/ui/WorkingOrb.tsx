import React from 'react';
import type { HarnessGroup } from '../../shared/types';
import { cn } from './cn';

export type WorkingOrbTone = HarnessGroup | 'master';

interface OrbPalette {
  highlight: string;
  mid: string;
  deep: string;
  glow: string;
  halo: string;
}

const ORB_PALETTES: Record<WorkingOrbTone, OrbPalette> = {
  antigravity: {
    highlight: '#dbeafe',
    mid: '#60a5fa',
    deep: '#1d4ed8',
    glow: 'rgba(96, 165, 250, 0.65)',
    halo: 'rgba(96, 165, 250, 0.24)',
  },
  codex: {
    highlight: '#d1fae5',
    mid: '#34d399',
    deep: '#047857',
    glow: 'rgba(52, 211, 153, 0.62)',
    halo: 'rgba(52, 211, 153, 0.22)',
  },
  claude: {
    highlight: '#ffedd5',
    mid: '#f08762',
    deep: '#9a3412',
    glow: 'rgba(240, 135, 98, 0.62)',
    halo: 'rgba(240, 135, 98, 0.22)',
  },
  muse: {
    highlight: '#f3e8ff',
    mid: '#c084fc',
    deep: '#6b21a8',
    glow: 'rgba(192, 132, 252, 0.62)',
    halo: 'rgba(192, 132, 252, 0.22)',
  },
  master: {
    highlight: '#ede9fe',
    mid: '#a78bfa',
    deep: '#5b21b6',
    glow: 'rgba(167, 139, 250, 0.62)',
    halo: 'rgba(167, 139, 250, 0.22)',
  },
};

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
 * Refined 3D orbiting lit-sphere activity indicator tinted to the active harness colorway:
 * three specular-highlighted 3D spheres revolving in depth-scaled perspective.
 */
export const WorkingOrb: React.FC<WorkingOrbProps> = ({
  tone = 'master',
  size = 'md',
  className,
}) => {
  const px = SIZE_PX[size];
  const dotPx = Math.max(4.5, Math.round(px * 0.34 * 10) / 10);
  const orbitR = Math.round(px * 0.32 * 10) / 10;
  const palette = ORB_PALETTES[tone] ?? ORB_PALETTES.master;
  const sphereBg = `radial-gradient(circle at 32% 28%, #ffffff 0%, ${palette.highlight} 22%, ${palette.mid} 58%, ${palette.deep} 100%)`;

  return (
    <span
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
      {[0, 1, 2].map((idx) => (
        <span
          key={idx}
          className="sh-orb-sphere absolute rounded-full pointer-events-none"
          style={{
            width: dotPx,
            height: dotPx,
            background: sphereBg,
            boxShadow: 'inset -1px -1px 1.5px rgba(0,0,0,0.45)',
            animationDelay: `${(-idx * 1.5) / 3}s`,
          }}
        />
      ))}
    </span>
  );
};

export interface WorkingIndicatorProps {
  tone?: WorkingOrbTone;
  label?: string;
  focus?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Cohesive working status row combining the kinetic WorkingOrb with a subtle
 * light-sweep shimmer on the status label.
 */
export const WorkingIndicator: React.FC<WorkingIndicatorProps> = ({
  tone = 'master',
  label = 'Working',
  focus,
  size = 'md',
  className,
}) => (
  <div
    className={cn(
      'flex items-center gap-2 text-caption text-ink-muted pt-1.5 select-none',
      className
    )}
  >
    <WorkingOrb tone={tone} size={size} />
    <span className="sh-working-shimmer font-medium leading-[1.35] pt-[1px]">{label}</span>
    {focus && (
      <span className="text-ink-faint truncate leading-[1.35] pt-[1px]">· {focus}</span>
    )}
  </div>
);
