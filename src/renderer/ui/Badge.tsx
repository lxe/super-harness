import React from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export type BadgeSize = 'xs' | 'sm';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  mono?: boolean;
  icon?: React.ReactNode;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-white/[0.08] text-ink-secondary',
  accent: 'bg-indigo-500/18 text-indigo-200',
  success: 'bg-emerald-500/15 text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-300',
  danger: 'bg-rose-500/15 text-rose-300',
};

const SIZE_CLASSES: Record<BadgeSize, string> = {
  xs: 'h-[19px] min-w-[19px] px-1.5 text-[11px] leading-none rounded-[7px] gap-1',
  sm: 'h-5 px-2 text-micro leading-none rounded-[7px] gap-1.5',
};

export const Badge: React.FC<BadgeProps> = ({
  tone = 'neutral',
  size = 'xs',
  mono = false,
  icon,
  className,
  children,
  ...rest
}) => {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center font-medium whitespace-nowrap select-none',
        TONE_CLASSES[tone],
        SIZE_CLASSES[size],
        mono && 'font-mono tabular-nums',
        className
      )}
      {...rest}
    >
      {icon && <span className="shrink-0 inline-flex items-center">{icon}</span>}
      <span className="leading-none translate-y-[0.5px]">{children}</span>
    </span>
  );
};
