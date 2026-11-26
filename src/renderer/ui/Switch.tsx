import React, { useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
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
      'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:shadow-none',
      checked
        ? 'bg-ink-primary border-ink-primary'
        : 'bg-surface-raised border-line-subtle hover:border-line-strong',
      className
    )}
  >
    <span
      className={cn(
        'inline-block h-3.5 w-3.5 rounded-full transition-transform',
        checked ? 'translate-x-[18px] bg-surface-rail' : 'translate-x-[3px] bg-ink-muted'
      )}
    />
  </button>
);

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Compact inline checkbox for merging closely related boolean toggles into a single
 * settings row (e.g. "Also show: [ ] Archived  [ ] Hidden").
 */
export const Checkbox: React.FC<CheckboxProps> = ({
  checked,
  onChange,
  label,
  disabled = false,
  className,
}) => (
  <button
    type="button"
    role="checkbox"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cn(
      'inline-flex items-center gap-2 text-caption text-ink-secondary hover:text-ink-primary transition-colors cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:shadow-none',
      className
    )}
  >
    <span
      className={cn(
        'w-4 h-4 rounded-[4px] border flex items-center justify-center transition-colors shrink-0',
        checked
          ? 'bg-ink-primary border-ink-primary text-surface-rail'
          : 'bg-transparent border-line-strong hover:border-ink-muted text-transparent'
      )}
    >
      <Check className="w-3 h-3 stroke-[2.75]" />
    </span>
    <span>{label}</span>
  </button>
);

export interface ChoiceOption<T extends string | number> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

export interface ChoicePillsProps<T extends string | number> {
  value: T;
  options: Array<ChoiceOption<T>>;
  onChange: (value: T) => void;
  className?: string;
}

/**
 * Compact segmented choice bar with units baked into the control
 * (e.g. `1s | 5s | 30s | Off`) so users never do mental arithmetic.
 */
export function ChoicePills<T extends string | number>({
  value,
  options,
  onChange,
  className,
}: ChoicePillsProps<T>) {
  return (
    <div
      className={cn(
        'inline-flex items-center p-0.5 rounded-lg bg-surface-subtle border border-line-hairline',
        className
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md text-caption font-medium transition-colors cursor-pointer whitespace-nowrap focus:outline-none focus-visible:shadow-none',
              active
                ? 'bg-white/[0.12] text-ink-primary'
                : 'text-ink-muted hover:text-ink-primary'
            )}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface UnitNumberInputProps {
  value: number;
  onChange: (next: number) => void;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel?: string;
  className?: string;
}

/**
 * Compact numeric input that renders its unit right inside the control
 * (e.g. `80  max`) so it aligns with every other single-control settings row.
 */
export const UnitNumberInput: React.FC<UnitNumberInputProps> = ({
  value,
  onChange,
  unit,
  min,
  max,
  step = 1,
  ariaLabel,
  className,
}) => (
  <div
    className={cn(
      'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-surface-subtle border border-line-subtle focus-within:border-line-strong transition-colors',
      className
    )}
  >
    <input
      type="number"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => {
        const parsed = Number(e.target.value);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      className="w-11 bg-transparent text-right text-caption font-medium tabular-nums text-ink-primary focus:outline-none focus-visible:shadow-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
    />
    <span className="text-micro text-ink-faint select-none">{unit}</span>
  </div>
);

export interface SettingsGroupProps {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  /** Collapses low-frequency / plumbing sections by default (e.g. Advanced). */
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * Cardless settings section grouped with typography, whitespace, and clean hairlines
 * between rows (no nested box around every group).
 */
export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  description,
  action,
  collapsible = false,
  defaultOpen = true,
  children,
  className,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const isExpanded = collapsible ? open : true;

  return (
    <section className={cn('space-y-1', className)}>
      {(title || description || action) && (
        <div className="flex items-center justify-between gap-3 pb-1.5">
          <div className="min-w-0">
            {title &&
              (collapsible ? (
                <button
                  type="button"
                  onClick={() => setOpen((v) => !v)}
                  aria-expanded={isExpanded}
                  className="inline-flex items-center gap-1.5 text-caption font-medium text-ink-muted hover:text-ink-primary transition-colors cursor-pointer focus:outline-none focus-visible:shadow-none"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-ink-faint" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-ink-faint" />
                  )}
                  <span>{title}</span>
                </button>
              ) : (
                <h3 className="text-caption font-medium text-ink-muted">{title}</h3>
              ))}
            {description && (
              <p className="text-micro text-ink-faint mt-0.5">{description}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {isExpanded && (
        <div className="divide-y divide-line-hairline border-t border-line-hairline">
          {children}
        </div>
      )}
    </section>
  );
};

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
      'py-3.5',
      stacked ? 'space-y-2.5' : 'flex items-center justify-between gap-6',
      className
    )}
  >
    <div className="min-w-0">
      <div className="text-body font-medium text-ink-primary leading-snug">{label}</div>
      {description && (
        <div className="text-caption text-ink-muted mt-0.5 leading-snug">{description}</div>
      )}
    </div>
    <div className={cn(stacked ? 'w-full' : 'shrink-0')}>{control}</div>
  </div>
);
