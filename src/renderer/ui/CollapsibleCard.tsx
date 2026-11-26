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
  variant?: 'default' | 'recessed' | 'subtle' | 'plain';
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
}

const VARIANT_CLASSES = {
  default:
    'rounded-2xl bg-[#1a1c22] shadow-[0_4px_14px_-5px_rgba(0,0,0,0.34),0_1px_3px_-1px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.05)]',
  recessed: 'rounded-xl bg-surface-code shadow-[inset_0_1px_2px_rgba(0,0,0,0.32)]',
  subtle:
    'rounded-xl bg-[#181a20] shadow-[0_2px_10px_-4px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.04)]',
  plain: 'rounded-lg bg-transparent',
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
        className={cn(
          'w-full flex items-center gap-2 text-left transition-colors cursor-pointer focus:outline-none focus-visible:shadow-none',
          variant === 'plain'
            ? 'px-1.5 py-1 rounded-md hover:bg-white/[0.04]'
            : 'px-3 py-2 hover:bg-white/[0.03] focus-visible:bg-white/[0.05]'
        )}
      >
        {isOpen ? (
          <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />
        )}
        {icon && <span className="shrink-0 inline-flex">{icon}</span>}
        <span
          className={cn(
            'text-caption font-medium text-ink-secondary min-w-0 truncate',
            !isOpen && preview ? 'shrink-0 max-w-[45%]' : 'flex-1'
          )}
        >
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
            variant === 'plain'
              ? 'pl-6 pr-2 py-1.5'
              : 'border-t border-white/[0.04] px-3.5 py-2.5',
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
        className="inline-flex items-center gap-1.5 text-caption text-ink-muted hover:text-ink-primary transition-colors py-0.5 px-1 -ml-1 rounded cursor-pointer focus:outline-none focus-visible:shadow-none"
      >
        <span>{label}</span>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-ink-faint" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-ink-faint" />
        )}
      </button>
      {open && (
        <div className="mt-1.5 space-y-0.5">{children}</div>
      )}
    </div>
  );
};
