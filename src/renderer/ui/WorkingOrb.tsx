import React from 'react';
import type { HarnessGroup } from '../../shared/types';
import { cn } from './cn';

export type WorkingOrbTone = HarnessGroup | 'master';

interface OrbPalette {
  shell: string;
  swirl: string;
  halo: string;
  rim: string;
}

const ORB_PALETTES: Record<WorkingOrbTone, OrbPalette> = {
  antigravity: {
    shell:
      'radial-gradient(circle at 32% 28%, rgba(224,242,254,0.95) 0%, rgba(96,165,250,0.9) 28%, rgba(79,70,229,0.92) 66%, rgba(17,24,62,0.98) 100%)',
    swirl:
      'conic-gradient(from 0deg, rgba(56,189,248,0.85), rgba(129,140,248,0.25), rgba(34,211,238,0.9), rgba(99,102,241,0.35), rgba(56,189,248,0.85))',
    halo: 'rgba(96, 165, 250, 0.42)',
    rim: 'rgba(147, 197, 253, 0.5)',
  },
  codex: {
    shell:
      'radial-gradient(circle at 32% 28%, rgba(209,250,229,0.95) 0%, rgba(52,211,153,0.9) 28%, rgba(5,150,105,0.92) 66%, rgba(6,44,34,0.98) 100%)',
    swirl:
      'conic-gradient(from 0deg, rgba(45,212,191,0.85), rgba(16,185,129,0.25), rgba(110,231,183,0.9), rgba(20,184,166,0.35), rgba(45,212,191,0.85))',
    halo: 'rgba(52, 211, 153, 0.4)',
    rim: 'rgba(110, 231, 183, 0.48)',
  },
  claude: {
    shell:
      'radial-gradient(circle at 32% 28%, rgba(255,237,213,0.96) 0%, rgba(251,146,60,0.92) 28%, rgba(194,65,12,0.92) 66%, rgba(67,20,7,0.98) 100%)',
    swirl:
      'conic-gradient(from 0deg, rgba(251,191,36,0.85), rgba(249,115,22,0.25), rgba(253,186,116,0.9), rgba(234,88,12,0.35), rgba(251,191,36,0.85))',
    halo: 'rgba(251, 146, 60, 0.4)',
    rim: 'rgba(253, 186, 116, 0.5)',
  },
  master: {
    shell:
      'radial-gradient(circle at 32% 28%, rgba(243,232,255,0.96) 0%, rgba(167,139,250,0.9) 28%, rgba(99,102,241,0.92) 66%, rgba(30,27,75,0.98) 100%)',
    swirl:
      'conic-gradient(from 0deg, rgba(192,132,252,0.85), rgba(129,140,248,0.25), rgba(224,231,255,0.9), rgba(139,92,246,0.35), rgba(192,132,252,0.85))',
    halo: 'rgba(167, 139, 250, 0.42)',
    rim: 'rgba(216, 180, 254, 0.5)',
  },
};

export interface WorkingOrbProps {
  tone?: WorkingOrbTone;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_PX: Record<NonNullable<WorkingOrbProps['size']>, number> = {
  sm: 14,
  md: 18,
  lg: 26,
};

/**
 * Tactile 3D iridescent glass sphere indicator tinted to the active harness
 * colorway, with a rotating internal aurora swirl, specular caustic, and
 * breathing ambient halo.
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
      {/* Breathing outer bloom */}
      <span
        className="sh-orb-halo absolute inset-[-3px] rounded-full pointer-events-none"
        style={{
          background: `radial-gradient(circle, ${palette.halo} 0%, transparent 72%)`,
        }}
      />
      {/* 3D shaded sphere body */}
      <span
        className="relative w-full h-full rounded-full overflow-hidden block"
        style={{
          background: palette.shell,
          boxShadow: `inset 0 1px 1.5px rgba(255,255,255,0.55), inset 0 -2px 4px rgba(0,0,0,0.55), 0 0 8px -1px ${palette.halo}`,
        }}
      >
        {/* Rotating internal luminous aurora */}
        <span
          className="sh-orb-swirl absolute inset-[-35%] rounded-full opacity-80 mix-blend-screen"
          style={{
            background: palette.swirl,
            filter: 'blur(2px)',
          }}
        />
        {/* Crisp top-left glass specular highlight */}
        <span
          className="absolute rounded-full pointer-events-none"
          style={{
            top: '14%',
            left: '18%',
            width: '34%',
            height: '24%',
            transform: 'rotate(-24deg)',
            background:
              'radial-gradient(ellipse at center, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.18) 65%, transparent 100%)',
          }}
        />
        {/* Subtle bottom-right bounce rim */}
        <span
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            boxShadow: `inset -1.5px -1.5px 3px ${palette.rim}`,
          }}
        />
      </span>
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
 * Cohesive working status row combining the 3D WorkingOrb with a subtle
 * metallic light-sweep shimmer on the status label.
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
      'flex items-center gap-2.5 text-caption text-ink-muted pt-1.5 select-none',
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
