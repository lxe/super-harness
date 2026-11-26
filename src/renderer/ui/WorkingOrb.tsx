import React from 'react';
import type { HarnessGroup } from '../../shared/types';
import { cn } from './cn';

export type WorkingOrbTone = HarnessGroup | 'master';

interface OrbPalette {
  core: string;
  arcPrimary: string;
  arcSecondary: string;
  halo: string;
  rim: string;
}

const ORB_PALETTES: Record<WorkingOrbTone, OrbPalette> = {
  antigravity: {
    core: 'radial-gradient(circle, rgba(147,197,253,0.92) 0%, rgba(96,165,250,0.45) 55%, transparent 100%)',
    arcPrimary:
      'conic-gradient(from 0deg, transparent 0deg, rgba(125,211,252,0.85) 70deg, rgba(99,102,241,0.35) 145deg, transparent 220deg)',
    arcSecondary:
      'conic-gradient(from 180deg, transparent 0deg, rgba(129,140,248,0.65) 80deg, transparent 190deg)',
    halo: 'rgba(96, 165, 250, 0.22)',
    rim: 'rgba(147, 197, 253, 0.22)',
  },
  codex: {
    core: 'radial-gradient(circle, rgba(167,243,208,0.92) 0%, rgba(52,211,153,0.45) 55%, transparent 100%)',
    arcPrimary:
      'conic-gradient(from 0deg, transparent 0deg, rgba(110,231,183,0.85) 70deg, rgba(20,184,166,0.35) 145deg, transparent 220deg)',
    arcSecondary:
      'conic-gradient(from 180deg, transparent 0deg, rgba(45,212,191,0.6) 80deg, transparent 190deg)',
    halo: 'rgba(52, 211, 153, 0.2)',
    rim: 'rgba(110, 231, 183, 0.22)',
  },
  claude: {
    core: 'radial-gradient(circle, rgba(254,215,170,0.9) 0%, rgba(251,146,60,0.42) 55%, transparent 100%)',
    arcPrimary:
      'conic-gradient(from 0deg, transparent 0deg, rgba(253,186,116,0.82) 70deg, rgba(234,88,12,0.3) 145deg, transparent 220deg)',
    arcSecondary:
      'conic-gradient(from 180deg, transparent 0deg, rgba(251,146,60,0.55) 80deg, transparent 190deg)',
    halo: 'rgba(251, 146, 60, 0.18)',
    rim: 'rgba(253, 186, 116, 0.2)',
  },
  master: {
    core: 'radial-gradient(circle, rgba(233,213,255,0.92) 0%, rgba(167,139,250,0.45) 55%, transparent 100%)',
    arcPrimary:
      'conic-gradient(from 0deg, transparent 0deg, rgba(216,180,254,0.85) 70deg, rgba(129,140,248,0.35) 145deg, transparent 220deg)',
    arcSecondary:
      'conic-gradient(from 180deg, transparent 0deg, rgba(167,139,250,0.6) 80deg, transparent 190deg)',
    halo: 'rgba(167, 139, 250, 0.2)',
    rim: 'rgba(216, 180, 254, 0.22)',
  },
};

export interface WorkingOrbProps {
  tone?: WorkingOrbTone;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_PX: Record<NonNullable<WorkingOrbProps['size']>, number> = {
  sm: 12,
  md: 14,
  lg: 20,
};

/**
 * Subtle, fluid kinetic orb tinted to the active harness colorway: a quiet
 * translucent ring with counter-rotating light arcs and a softly breathing
 * drifting core.
 */
export const WorkingOrb: React.FC<WorkingOrbProps> = ({
  tone = 'master',
  size = 'md',
  className,
}) => {
  const px = SIZE_PX[size];
  const palette = ORB_PALETTES[tone] ?? ORB_PALETTES.master;

  return (
    <span
      aria-hidden="true"
      style={{ width: px, height: px }}
      className={cn('relative inline-flex items-center justify-center shrink-0', className)}
    >
      {/* Whisper-soft ambient bloom */}
      <span
        className="sh-orb-halo absolute inset-[-3px] rounded-full pointer-events-none"
        style={{
          background: `radial-gradient(circle, ${palette.halo} 0%, transparent 72%)`,
        }}
      />

      {/* Primary orbiting light arc (ring-masked) */}
      <span
        className="sh-orb-swirl absolute inset-0 rounded-full pointer-events-none"
        style={{
          background: palette.arcPrimary,
          WebkitMaskImage: 'radial-gradient(circle, transparent 54%, black 60%)',
          maskImage: 'radial-gradient(circle, transparent 54%, black 60%)',
        }}
      />

      {/* Counter-rotating secondary harmonic arc */}
      <span
        className="sh-orb-counter absolute inset-[1px] rounded-full pointer-events-none"
        style={{
          background: palette.arcSecondary,
          WebkitMaskImage: 'radial-gradient(circle, transparent 52%, black 60%)',
          maskImage: 'radial-gradient(circle, transparent 52%, black 60%)',
        }}
      />

      {/* Delicate glass rim */}
      <span
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          boxShadow: `inset 0 0 0 1px ${palette.rim}`,
        }}
      />

      {/* Soft breathing drifting inner core */}
      <span
        className="sh-orb-core relative rounded-full pointer-events-none"
        style={{
          width: '46%',
          height: '46%',
          background: palette.core,
        }}
      />
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
