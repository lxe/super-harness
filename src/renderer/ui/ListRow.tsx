import React from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from './cn';

export interface SectionHeaderProps {
  level?: 1 | 2;
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
  collapsed = false,
  onToggle,
  icon,
  label,
  count,
  working = false,
  sticky = true,
  className,
}) => {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className={cn(
        'w-full flex items-center gap-2 px-2 bg-surface-rail/95 backdrop-blur-sm hover:bg-surface-subtle rounded-md transition-colors cursor-pointer select-none',
        level === 1
          ? 'h-9 text-body font-semibold text-ink-primary'
          : 'h-8 text-label font-medium text-ink-secondary hover:text-ink-primary',
        sticky && (level === 1 ? 'sticky top-0 z-20' : 'sticky top-9 z-10'),
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
      <span className="ml-auto flex items-center gap-1.5 text-caption font-normal text-ink-faint">
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
