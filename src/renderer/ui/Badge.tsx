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
  neutral: 'bg-white/[0.06] text-ink-secondary border-line-hairline',
  accent: 'bg-indigo-500/15 text-indigo-200 border-indigo-400/25',
  success: 'bg-emerald-500/12 text-emerald-300 border-emerald-400/25',
  warning: 'bg-amber-500/12 text-amber-300 border-amber-400/25',
  danger: 'bg-rose-500/12 text-rose-300 border-rose-400/25',
};

const SIZE_CLASSES: Record<BadgeSize, string> = {
  xs: 'px-1.5 py-0.5 text-[10px] leading-none rounded-md gap-1',
  sm: 'px-2 py-0.5 text-micro rounded-md gap-1.5',
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
        'inline-flex items-center border font-medium whitespace-nowrap select-none',
        TONE_CLASSES[tone],
        SIZE_CLASSES[size],
        mono && 'font-mono',
        className
      )}
      {...rest}
    >
      {icon && <span className="shrink-0 inline-flex">{icon}</span>}
      <span>{children}</span>
    </span>
  );
};
