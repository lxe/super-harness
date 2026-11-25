import React from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from './cn';

export interface SectionHeaderProps {
  level?: 1 | 2;
  /** 'separator' renders a full-bleed collapsible divider band (used between harnesses in All view). */
  variant?: 'tree' | 'separator';
  collapsed?: boolean;
  onToggle: () => void;
  icon?: React.ReactNode;
  label: string;
  count?: number;
  working?: boolean;
  sticky?: boolean;
  className?: string;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  level = 1,
  variant = 'tree',
  collapsed = false,
  onToggle,
  icon,
  label,
  count,
  working = false,
  sticky = true,
  className,
}) => {
  if (variant === 'separator') {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          'group w-[calc(100%+1.25rem)] -mx-2.5 px-3 h-8 flex items-center gap-2 bg-surface-rail/95 backdrop-blur-md border-y border-line-hairline/75 hover:bg-white/[0.035] transition-colors cursor-pointer select-none focus:outline-none focus-visible:shadow-none',
          sticky && 'sticky top-0 z-20',
          className
        )}
      >
        {icon && <span className="shrink-0 inline-flex">{icon}</span>}
        <span className="text-micro font-semibold uppercase tracking-[0.06em] text-ink-secondary group-hover:text-ink-primary transition-colors truncate">
          {label}
        </span>
        <span className="flex-1 h-px bg-line-hairline/70 mx-1" aria-hidden="true" />
        <span className="flex items-center gap-1.5 text-micro tabular-nums font-normal text-ink-faint shrink-0">
          {working && <Loader2 className="w-3 h-3 animate-spin text-ink-secondary shrink-0" />}
          {count !== undefined && <span>{count}</span>}
          {collapsed ? (
            <ChevronRight className="w-3.5 h-3.5 text-ink-faint group-hover:text-ink-secondary shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-ink-faint group-hover:text-ink-secondary shrink-0" />
          )}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className={cn(
        'w-full flex items-center gap-2 px-2 bg-surface-rail/95 backdrop-blur-sm hover:bg-surface-subtle rounded-md transition-colors cursor-pointer select-none focus:outline-none focus-visible:shadow-none',
        level === 1
          ? 'h-8 text-label font-semibold text-ink-primary'
          : 'h-7 text-caption font-medium text-ink-muted hover:text-ink-primary',
        sticky && (level === 1 ? 'sticky top-0 z-20' : 'sticky top-8 z-10'),
        className
      )}
    >
      {collapsed ? (
        <ChevronRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />
      ) : (
        <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0" />
      )}
      {icon && <span className="shrink-0 inline-flex">{icon}</span>}
      <span className="truncate">{label}</span>
      <span className="ml-auto flex items-center gap-1.5 text-caption tabular-nums font-normal text-ink-faint">
        {working && <Loader2 className="w-3 h-3 animate-spin text-ink-secondary shrink-0" />}
        {count !== undefined && <span>{count}</span>}
      </span>
    </button>
  );
};

export interface NavRowProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: string;
  meta?: React.ReactNode;
  hoverActions?: React.ReactNode;
  active?: boolean;
  secondaryActive?: boolean;
  selected?: boolean;
  working?: boolean;
}

export const NavRow: React.FC<NavRowProps> = ({
  icon,
  title,
  meta,
  hoverActions,
  active = false,
  secondaryActive = false,
  selected = false,
  working = false,
  className,
  ...rest
}) => {
  return (
    <div
      className={cn(
        'group relative flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors select-none',
        selected
          ? 'bg-indigo-500/20 text-ink-primary ring-1 ring-inset ring-indigo-400/40'
          : active
            ? 'bg-white/[0.1] text-ink-primary font-medium'
            : secondaryActive
              ? 'bg-white/[0.06] text-ink-primary'
              : 'text-ink-secondary hover:text-ink-primary hover:bg-white/[0.05]',
        className
      )}
      {...rest}
    >
      {icon && <span className="shrink-0 inline-flex">{icon}</span>}
      <span className="text-body leading-snug truncate flex-1">{title}</span>
      {meta && (
        <span className="shrink-0 inline-flex items-center gap-1.5 group-hover:opacity-0 transition-opacity">
          {meta}
        </span>
      )}
      {working && (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-secondary shrink-0" />
      )}
      {hoverActions && (
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 absolute right-1.5 bg-surface-raised/95 rounded-md p-0.5 transition-opacity">
          {hoverActions}
        </div>
      )}
    </div>
  );
};
