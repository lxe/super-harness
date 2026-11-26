import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-ink-primary text-surface-rail font-medium hover:bg-white disabled:opacity-35',
  secondary:
    'bg-surface-raised text-ink-primary border border-line-subtle hover:bg-white/[0.1] hover:border-line-strong disabled:opacity-40',
  subtle:
    'bg-white/[0.05] text-ink-secondary border border-line-hairline hover:bg-white/[0.09] hover:text-ink-primary disabled:opacity-40',
  ghost:
    'bg-transparent text-ink-muted hover:text-ink-primary hover:bg-white/[0.06] disabled:opacity-40',
  danger:
    'bg-rose-500/12 text-rose-300 border border-rose-500/25 hover:bg-rose-500/20 hover:text-rose-200 disabled:opacity-40',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: 'h-7 px-2 text-micro rounded-md gap-1.5',
  sm: 'h-8 px-2.5 text-caption rounded-lg gap-1.5',
  md: 'h-9 px-3.5 text-label rounded-lg gap-2',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'secondary',
      size = 'sm',
      loading = false,
      iconLeft,
      iconRight,
      className,
      children,
      disabled,
      type = 'button',
      ...rest
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center font-medium transition-colors cursor-pointer select-none whitespace-nowrap disabled:cursor-not-allowed',
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className
        )}
        {...rest}
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        ) : (
          iconLeft && <span className="shrink-0 inline-flex">{iconLeft}</span>
        )}
        {children && <span className="truncate leading-none pt-[0.5px]">{children}</span>}
        {!loading && iconRight && <span className="shrink-0 inline-flex">{iconRight}</span>}
      </button>
    );
  }
);
Button.displayName = 'Button';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: 'xs' | 'sm' | 'md';
  active?: boolean;
  tone?: 'default' | 'accent' | 'warning' | 'danger';
  label: string;
}

const ICON_SIZE_CLASSES = {
  xs: 'w-6 h-6 rounded-md',
  sm: 'w-7 h-7 rounded-md',
  md: 'w-8 h-8 rounded-lg',
};

const ICON_TONE_CLASSES = {
  default: 'text-ink-muted hover:text-ink-primary hover:bg-white/[0.06]',
  accent: 'text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25',
  warning: 'text-amber-400 hover:text-amber-300 hover:bg-white/[0.08]',
  danger: 'text-rose-300/90 hover:text-rose-200 hover:bg-rose-500/15',
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      size = 'sm',
      active = false,
      tone = 'default',
      label,
      className,
      children,
      type = 'button',
      ...rest
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        title={rest.title ?? label}
        aria-label={label}
        className={cn(
          'inline-flex items-center justify-center shrink-0 transition-colors cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed',
          ICON_SIZE_CLASSES[size],
          active
            ? 'text-ink-primary bg-white/[0.1]'
            : ICON_TONE_CLASSES[tone],
          className
        )}
        {...rest}
      >
        {children}
      </button>
    );
  }
);
IconButton.displayName = 'IconButton';
