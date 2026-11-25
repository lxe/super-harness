import React from 'react';
import { cn } from './cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  label,
  className,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cn(
      'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
      checked
        ? 'bg-ink-primary border-ink-primary'
        : 'bg-surface-raised border-line-subtle hover:border-line-strong',
      className
    )}
  >
    <span
      className={cn(
        'inline-block h-3.5 w-3.5 rounded-full transition-transform',
        checked
          ? 'translate-x-[18px] bg-surface-rail'
          : 'translate-x-[3px] bg-ink-muted'
      )}
    />
  </button>
);

export interface SettingsGroupProps {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  description,
  action,
  children,
  className,
}) => (
  <section className={cn('space-y-2.5', className)}>
    {(title || description || action) && (
      <div className="flex items-end justify-between gap-3 px-0.5">
        <div className="min-w-0">
          {title && (
            <h3 className="text-label font-semibold text-ink-primary tracking-tight">{title}</h3>
          )}
          {description && (
            <p className="text-micro text-ink-muted mt-0.5">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    )}
    <div className="rounded-xl border border-line-hairline bg-surface-subtle divide-y divide-line-hairline overflow-hidden">
      {children}
    </div>
  </section>
);

export interface SettingsRowProps {
  label: string;
  description?: React.ReactNode;
  control: React.ReactNode;
  stacked?: boolean;
  className?: string;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({
  label,
  description,
  control,
  stacked = false,
  className,
}) => (
  <div
    className={cn(
      'px-4 py-3.5',
      stacked
        ? 'space-y-2.5'
        : 'flex items-center justify-between gap-6',
      className
    )}
  >
    <div className="min-w-0">
      <div className="text-caption font-medium text-ink-primary">{label}</div>
      {description && (
        <div className="text-micro text-ink-muted mt-0.5 leading-relaxed">{description}</div>
      )}
    </div>
    <div className={cn(stacked ? 'w-full' : 'shrink-0')}>{control}</div>
  </div>
);
