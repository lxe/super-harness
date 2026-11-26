import React from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { cn } from './cn';
import { WorkingOrb, type WorkingOrbTone } from './WorkingOrb';

export type SectionHeaderAccent = 'antigravity' | 'codex' | 'claude' | 'muse';

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
  const isTopLevel = variant === 'separator' || level === 1;

  const pillContent = (
    <div
      data-harness-separator={variant === 'separator' ? 'true' : undefined}
      onContextMenu={onContextMenu}
      className={cn(
        'group w-full flex items-center gap-1 rounded-lg transition-colors select-none',
        isTopLevel
          ? 'h-8 px-2.5 rounded-lg bg-[#191b21] hover:bg-[#1f2129] shadow-[0_2px_8px_-3px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.05)] text-[13px] font-semibold tracking-[-0.01em] text-ink-primary'
          : 'h-7 px-2 rounded-lg bg-surface-rail hover:bg-white/[0.04] text-[12.5px] font-medium text-ink-secondary/80 hover:text-ink-primary',
        !isTopLevel && sticky && 'sticky top-10 z-10',
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
          <ChevronRight className="w-3.5 h-3.5 text-ink-faint group-hover:text-ink-muted shrink-0 transition-colors" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-ink-faint group-hover:text-ink-muted shrink-0 transition-colors" />
        )}
        {working && !isTopLevel ? (
          <span className="shrink-0 inline-flex items-center justify-center w-3.5 h-3.5">
            <WorkingOrb tone={accent ?? 'master'} size="sm" />
          </span>
        ) : (
          icon && <span className="shrink-0 inline-flex items-center justify-center">{icon}</span>
        )}
        <span className="leading-none truncate">{label}</span>
        {(count !== undefined || (working && isTopLevel)) && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] leading-none tabular-nums font-normal text-ink-faint shrink-0">
            {working && isTopLevel && <WorkingOrb tone={accent ?? 'master'} size="sm" />}
            {count !== undefined && <span>{count}</span>}
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
          className="w-5 h-5 rounded-md flex items-center justify-center text-ink-faint hover:text-ink-primary hover:bg-white/[0.08] opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity shrink-0 cursor-pointer focus:outline-none focus-visible:shadow-none"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );

  if (isTopLevel && sticky) {
    return (
      <div className="sticky top-0 z-20 -mx-2.5 px-2.5 pt-2 bg-surface-rail">
        {pillContent}
      </div>
    );
  }

  return pillContent;
};

export interface NavRowProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  /** Yellow notification dot rendered at the bottom-right of the leading icon (or left of title when iconless). */
  unread?: boolean;
  title: string;
  /** Optional hover tooltip text (e.g. one-line thread summary). */
  tooltip?: string;
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
  unread = false,
  title,
  tooltip,
  titleBadge,
  titleOpacity,
  meta,
  hoverActions,
  active = false,
  secondaryActive = false,
  selected = false,
  working = false,
  workingTone: _workingTone = 'master',
  className,
  ...rest
}) => {
  const effectiveOpacity =
    active || secondaryActive || selected || working || titleOpacity === undefined
      ? undefined
      : titleOpacity;

  return (
      <div
        title={tooltip ?? title}
        className={cn(
          'group relative h-8 flex items-center gap-2 px-2.5 rounded-lg cursor-pointer transition-colors select-none',
          selected
            ? 'bg-indigo-500/20 text-ink-primary ring-1 ring-inset ring-indigo-400/40'
            : active
              ? 'bg-white/[0.09] text-ink-primary font-medium'
              : secondaryActive
                ? 'bg-white/[0.05] text-ink-primary'
                : 'text-ink-secondary hover:text-ink-primary hover:bg-white/[0.045]',
          className
        )}
        {...rest}
      >
        {icon && (
          <span className="relative shrink-0 inline-flex items-center">
            {icon}
            {unread && (
              <span
                aria-label="Unread"
                title="New activity since you last opened this thread"
                className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 ring-[1.5px] ring-surface-rail shadow-[0_0_7px_rgba(251,191,36,0.85)]"
              />
            )}
          </span>
        )}
        <span className="min-w-0 flex-1 inline-flex items-center gap-1.5">
          {!icon && unread && (
            <span
              aria-label="Unread"
              title="New activity since you last opened this thread"
              className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.85)] shrink-0"
            />
          )}
          {titleBadge && <span className="shrink-0 inline-flex items-center">{titleBadge}</span>}
          <span
            style={effectiveOpacity !== undefined ? { opacity: effectiveOpacity } : undefined}
            className={cn(
              'text-[13px] leading-[1.35] truncate transition-opacity group-hover:!opacity-100',
              working && 'sh-nav-title-shimmer font-medium'
            )}
          >
            {title}
          </span>
        </span>
        {meta && (
          <span className="shrink-0 inline-flex items-center justify-end gap-1.5 group-hover:opacity-0 transition-opacity">
            {meta}
          </span>
        )}
        {hoverActions && (
          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 absolute right-2 top-1/2 -translate-y-1/2 transition-opacity">
            {hoverActions}
          </div>
        )}
      </div>
  );
};
