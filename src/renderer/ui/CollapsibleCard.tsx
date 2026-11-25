import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from './cn';

export interface CollapsibleCardProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  preview?: React.ReactNode;
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: 'default' | 'recessed' | 'subtle';
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
}

const VARIANT_CLASSES = {
  default: 'rounded-xl border border-line-hairline bg-surface-subtle/90',
  recessed: 'rounded-lg border border-line-hairline bg-surface-code',
  subtle: 'rounded-lg border border-line-hairline bg-white/[0.02]',
};

export const CollapsibleCard: React.FC<CollapsibleCardProps> = ({
  icon,
  title,
  preview,
  meta,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  variant = 'default',
  bodyClassName,
  className,
  children,
}) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = controlledOpen ?? uncontrolledOpen;

  const toggle = () => {
    const next = !isOpen;
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className={cn('overflow-hidden', VARIANT_CLASSES[variant], className)}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition-colors cursor-pointer"
      >
        {isOpen ? (
          <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />
        )}
        {icon && <span className="shrink-0 inline-flex">{icon}</span>}
        <span className="text-caption font-medium text-ink-secondary shrink-0 min-w-0 truncate">
          {title}
        </span>
        {!isOpen && preview && (
          <span className="text-caption text-ink-faint truncate flex-1 min-w-0">{preview}</span>
        )}
        {meta && (
          <span className="ml-auto text-micro text-ink-muted font-mono shrink-0">{meta}</span>
        )}
      </button>
      {isOpen && (
        <div
          className={cn(
            'border-t border-line-hairline px-3.5 py-2.5',
            bodyClassName
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
};

export interface DisclosureRowProps {
  label: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const DisclosureRow: React.FC<DisclosureRowProps> = ({
  label,
  defaultOpen = false,
  className,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn('my-1.5', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-caption text-ink-muted hover:text-ink-primary transition-colors py-0.5 px-1 -ml-1 rounded cursor-pointer"
      >
        <span>{label}</span>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-ink-faint" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-ink-faint" />
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 pl-3 border-l border-line-subtle">{children}</div>
      )}
    </div>
  );
};
