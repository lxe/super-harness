import React from 'react';
import type { HarnessGroup } from '../../shared/types';
import { cn } from './cn';

export type WorkingOrbTone = HarnessGroup | 'master' | 'neutral';

interface OrbPalette {
  glint: string;
  highlight: string;
  mid: string;
  deep: string;
}

/**
 * HSB-derived opaque 3D sphere palettes matching the exact harness gauge & icon tints:
 * Antigravity #60a5fa, Codex #10a37f, Claude #d97757, Muse #a855f7, Master #818cf8, All #d4d4d8.
 */
const ORB_PALETTES: Record<WorkingOrbTone, OrbPalette> = {
  antigravity: {
    glint: '#ecf5ff',
    highlight: '#c6e0ff',
    mid: '#5ca5ff',
    deep: '#26548c',
  },
  codex: {
    glint: '#e3fff8',
    highlight: '#9be6d3',
    mid: '#0bad85',
    deep: '#005b45',
  },
  claude: {
    glint: '#fff1ed',
    highlight: '#ffd6c8',
    mid: '#e67a57',
    deep: '#7a3924',
  },
  muse: {
    glint: '#f5ebff',
    highlight: '#e2c3ff',
    mid: '#aa51ff',
    deep: '#561f8a',
  },
  master: {
    glint: '#f0f2ff',
    highlight: '#d3d7ff',
    mid: '#808cff',
    deep: '#3c448b',
  },
  neutral: {
    glint: '#fefeff',
    highlight: '#fdfdff',
    mid: '#e1e1e5',
    deep: '#767679',
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
 * Glow-free 3D orbiting lit-sphere activity indicator tinted to the exact harness colorway:
 * three fully opaque HSB-shaded spheres revolving in depth-scaled perspective with a crisp specular glint.
 */
export const WorkingOrb: React.FC<WorkingOrbProps> = ({
  tone = 'master',
  size = 'md',
  className,
}) => {
  const px = SIZE_PX[size];
  const dotPx = Math.max(4.6, Math.round(px * 0.34 * 10) / 10);
  const orbitR = Math.round(px * 0.31 * 10) / 10;
  const palette = ORB_PALETTES[tone] ?? ORB_PALETTES.master;
  const sphereBg = [
    `radial-gradient(circle at 30% 27%, ${palette.glint} 0%, ${palette.glint} 11%, transparent 24%)`,
    `radial-gradient(circle at 32% 28%, ${palette.highlight} 0%, ${palette.mid} 42%, ${palette.deep} 100%)`,
  ].join(', ');

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
            animationDelay: `${(-idx * 1.5) / 3}s`,
          }}
        />
      ))}
    </span>
  );
};

export interface WorkingIndicatorProps {
  tone?: WorkingOrbTone;
  focus?: string;
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Cohesive working status row combining the kinetic WorkingOrb with a subtle
 * shimmering text sweep.
 */
export const WorkingIndicator: React.FC<WorkingIndicatorProps> = ({
  tone = 'master',
  focus,
  label,
  size = 'md',
  className,
}) => (
  <span
    className={cn(
      'inline-flex items-center gap-2 text-caption font-medium select-none',
      className
    )}
  >
    <WorkingOrb tone={tone} size={size} />
    <span className="sh-working-shimmer">{focus || label || 'Working'}</span>
  </span>
);
