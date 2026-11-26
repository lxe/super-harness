import React from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { cn } from './cn';
import { WorkingOrb, type WorkingOrbTone } from './WorkingOrb';

export type SectionHeaderAccent = 'antigravity' | 'codex' | 'claude' | 'muse';

const SEPARATOR_ACCENT_CLASSES: Record<SectionHeaderAccent, string> = {
  antigravity:
    'bg-gradient-to-r from-[#60a5fa]/[0.10] via-[#1a1d26]/95 to-[#171920]/95 border-l-2 border-l-[#60a5fa]/70 hover:from-[#60a5fa]/[0.15]',
  codex:
    'bg-gradient-to-r from-[#10a37f]/[0.10] via-[#171e1e]/95 to-[#16191e]/95 border-l-2 border-l-[#10a37f]/70 hover:from-[#10a37f]/[0.15]',
  claude:
    'bg-gradient-to-r from-[#d97757]/[0.10] via-[#201a19]/95 to-[#18181d]/95 border-l-2 border-l-[#d97757]/70 hover:from-[#d97757]/[0.15]',
  muse:
    'bg-gradient-to-r from-[#a855f7]/[0.10] via-[#1d1926]/95 to-[#171820]/95 border-l-2 border-l-[#a855f7]/70 hover:from-[#a855f7]/[0.15]',
};

export interface SectionHeaderProps {
  level?: 1 | 2;
  /** 'separator' renders a full-bleed collapsible divider band (used between harnesses in All view). */
  variant?: 'tree' | 'separator';
  /** Optional subtle harness brand tint for separator headers. */
  accent?: SectionHeaderAccent;
  collapsed?: boolean;
  onToggle: () => void;
  /** Optional quick-add action button rendered on the right (used on harness separators to start a new chat). */
  onAdd?: () => void;
  addLabel?: string;
  icon?: React.ReactNode;
  label: string;
  count?: number;
  working?: boolean;
  sticky?: boolean;
  dropTarget?: boolean;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  className?: string;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  level = 1,
  variant = 'tree',
  accent,
  collapsed = false,
  onToggle,
  onAdd,
  addLabel,
  icon,
  label,
  count,
  working = false,
  sticky = true,
  dropTarget = false,
  onContextMenu,
  className,
}) => {
  if (variant === 'separator') {
    return (
      <div
        data-harness-separator="true"
        onContextMenu={onContextMenu}
        className={cn(
          'group w-[calc(100%+1.25rem)] -mx-2.5 px-3 h-9 flex items-center gap-1 backdrop-blur-md border-y border-white/[0.08] transition-colors select-none',
          accent
            ? SEPARATOR_ACCENT_CLASSES[accent]
            : 'bg-surface-subtle/95 hover:bg-surface-raised/90',
          sticky && 'sticky top-0 z-20',
          className
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex-1 min-w-0 h-full flex items-center gap-2 cursor-pointer focus:outline-none focus-visible:shadow-none"
        >
          {icon && <span className="shrink-0 inline-flex items-center justify-center">{icon}</span>}
          <span className="text-micro font-semibold uppercase tracking-[0.06em] leading-none text-ink-primary/90 group-hover:text-ink-primary transition-colors truncate">
            {label}
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-micro leading-none tabular-nums font-normal text-ink-faint shrink-0">
            {working && <WorkingOrb tone={accent ?? 'master'} size="sm" />}
            {count !== undefined && <span>{count}</span>}
            {collapsed ? (
              <ChevronRight className="w-3.5 h-3.5 text-ink-faint group-hover:text-ink-secondary shrink-0" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-ink-faint group-hover:text-ink-secondary shrink-0" />
            )}
          </span>
        </button>
        {onAdd && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            title={addLabel || `New ${label} conversation`}
            aria-label={addLabel || `New ${label} conversation`}
            className="w-5 h-5 rounded-md flex items-center justify-center text-ink-faint hover:text-ink-primary hover:bg-white/[0.1] opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity shrink-0 cursor-pointer focus:outline-none focus-visible:shadow-none"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      onContextMenu={onContextMenu}
      className={cn(
        'group w-full flex items-center gap-1 px-2 backdrop-blur-sm rounded-md transition-colors select-none',
        level === 1
          ? 'h-9 text-label font-semibold text-ink-primary bg-surface-subtle/85 hover:bg-surface-raised/85 border border-line-hairline/70'
          : 'h-[30px] text-caption font-medium text-ink-muted hover:text-ink-primary bg-surface-rail/95 hover:bg-surface-subtle',
        sticky && (level === 1 ? 'sticky top-0 z-20' : 'sticky top-9 z-10'),
        dropTarget && 'bg-indigo-500/20 text-ink-primary ring-1 ring-inset ring-indigo-400/50',
        className
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex-1 min-w-0 h-full flex items-center gap-2 cursor-pointer focus:outline-none focus-visible:shadow-none"
      >
        {collapsed ? (
          <ChevronRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0" />
        )}
        {working ? (
          <span className="shrink-0 inline-flex items-center justify-center w-4 h-4">
            <WorkingOrb tone={accent ?? 'master'} size={level === 1 ? 'md' : 'sm'} />
          </span>
        ) : (
          icon && <span className="shrink-0 inline-flex items-center justify-center">{icon}</span>
        )}
        <span className="leading-none truncate">{label}</span>
        {count !== undefined && (
          <span className="ml-auto flex items-center gap-1.5 text-caption leading-none tabular-nums font-normal text-ink-faint shrink-0">
            <span>{count}</span>
          </span>
        )}
      </button>
      {onAdd && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          title={addLabel || `New conversation in ${label}`}
          aria-label={addLabel || `New conversation in ${label}`}
          className="w-5 h-5 rounded-md flex items-center justify-center text-ink-faint hover:text-ink-primary hover:bg-white/[0.1] opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity shrink-0 cursor-pointer focus:outline-none focus-visible:shadow-none"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};

export interface NavRowProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: string;
  /** Optional compact badge rendered inline right next to the title text. */
  titleBadge?: React.ReactNode;
  /** Subtle age-based opacity for inactive rows (restored to 1.0 on active/selected/hover). */
  titleOpacity?: number;
  meta?: React.ReactNode;
  hoverActions?: React.ReactNode;
  active?: boolean;
  secondaryActive?: boolean;
  selected?: boolean;
  working?: boolean;
  workingTone?: WorkingOrbTone;
}

export const NavRow: React.FC<NavRowProps> = ({
  icon,
  title,
  titleBadge,
  titleOpacity,
  meta,
  hoverActions,
  active = false,
  secondaryActive = false,
  selected = false,
  working = false,
  workingTone = 'master',
  className,
  ...rest
}) => {
  const effectiveOpacity =
    active || secondaryActive || selected || working || titleOpacity === undefined
      ? undefined
      : titleOpacity;

  return (
      <div
        className={cn(
          'group relative h-9 flex items-center gap-2.5 px-2.5 rounded-lg cursor-pointer transition-colors select-none',
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
        {icon && <span className="shrink-0 inline-flex items-center">{icon}</span>}
        <span className="min-w-0 flex-1 inline-flex items-center gap-1.5">
          <span
            style={effectiveOpacity !== undefined ? { opacity: effectiveOpacity } : undefined}
            className="text-body leading-[1.35] pt-[1px] truncate transition-opacity group-hover:!opacity-100"
          >
            {title}
          </span>
          {titleBadge && <span className="shrink-0 inline-flex items-center">{titleBadge}</span>}
        </span>
        {meta && (
          <span className="shrink-0 inline-flex items-center gap-1.5 group-hover:opacity-0 transition-opacity">
            {meta}
          </span>
        )}
        {working && <WorkingOrb tone={workingTone} size="md" />}
        {hoverActions && (
          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 absolute right-1.5 top-1/2 -translate-y-1/2 bg-surface-raised/95 rounded-md p-0.5 transition-opacity">
            {hoverActions}
          </div>
        )}
      </div>
  );
};
