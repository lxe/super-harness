import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';
import { ProgressBar, type ProgressTone } from './ProgressBar';

export interface SegmentedItem<T extends string> {
  id: T;
  label: string;
  icon?: React.ReactNode;
  working?: boolean;
  progress?: {
    value: number | null;
    tone: ProgressTone;
    estimated?: boolean;
  };
}

export interface SegmentedControlProps<T extends string> {
  items: Array<SegmentedItem<T>>;
  value: T;
  onChange: (value: T) => void;
  onItemMouseEnter?: (id: T, el: HTMLElement) => void;
  onItemMouseLeave?: (id: T) => void;
  /** When true, tabs that provide an `icon` hide their text label and center only the logo. */
  iconOnly?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  onItemMouseEnter,
  onItemMouseLeave,
  iconOnly = false,
  className,
}: SegmentedControlProps<T>) {
  const hasAnyProgress = items.some((i) => i.progress !== undefined);

  return (
    <div
      role="tablist"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      className={cn(
        'grid gap-1 p-1 rounded-xl bg-surface-subtle border border-line-hairline',
        className
      )}
    >
      {items.map((item) => {
        const active = item.id === value;
        const logoOnly = iconOnly && Boolean(item.icon);
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={active}
            aria-label={logoOnly ? item.label : undefined}
            title={logoOnly ? item.label : undefined}
            type="button"
            onClick={() => onChange(item.id)}
            onMouseEnter={(e) => onItemMouseEnter?.(item.id, e.currentTarget)}
            onMouseLeave={() => onItemMouseLeave?.(item.id)}
            className={cn(
              'relative flex flex-col items-center justify-center gap-1 rounded-lg text-caption font-medium transition-colors cursor-pointer select-none',
              logoOnly ? 'px-1' : 'px-1.5',
              hasAnyProgress ? 'pt-1.5 pb-1' : 'py-1.5',
              active
                ? 'bg-white/[0.12] text-ink-primary shadow-sm'
                : 'text-ink-muted hover:text-ink-primary hover:bg-white/[0.05]'
            )}
          >
            <div
              className={cn(
                'flex items-center justify-center w-full min-w-0',
                iconOnly ? 'h-[18px]' : 'gap-1'
              )}
            >
              {item.icon && (
                <span className="shrink-0 inline-flex items-center justify-center">
                  {item.icon}
                </span>
              )}
              {!logoOnly && <span className="truncate">{item.label}</span>}
              {!logoOnly && item.working && (
                <Loader2 className="w-2.5 h-2.5 animate-spin text-ink-secondary shrink-0" />
              )}
            </div>
            {logoOnly && item.working && (
              <Loader2 className="w-2 h-2 animate-spin text-ink-secondary absolute top-1 right-1 pointer-events-none" />
            )}
            {hasAnyProgress && (
              <ProgressBar
                size="xs"
                value={item.progress?.value ?? null}
                tone={item.progress?.tone ?? 'neutral'}
                estimated={item.progress?.estimated}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
