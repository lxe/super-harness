import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import { cn } from './cn';

export interface ModalProps {
  open?: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

const MODAL_WIDTHS = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
};

export const Modal: React.FC<ModalProps> = ({
  open = true,
  onClose,
  title,
  subtitle,
  icon,
  width = 'md',
  headerExtra,
  footer,
  children,
  className,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-full max-h-[86vh] rounded-2xl border border-line-subtle bg-surface-popover shadow-[0_24px_64px_-12px_rgba(0,0,0,0.78)] flex flex-col overflow-hidden',
          MODAL_WIDTHS[width],
          className
        )}
      >
        <div className="px-5 py-3.5 border-b border-line-hairline flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {icon && <span className="shrink-0 text-ink-secondary">{icon}</span>}
            <div className="min-w-0">
              <h2 className="text-heading font-semibold text-ink-primary truncate">{title}</h2>
              {subtitle && (
                <p className="text-micro text-ink-muted truncate mt-0.5">{subtitle}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {headerExtra}
            <IconButton label="Close" onClick={onClose}>
              <X className="w-4 h-4" />
            </IconButton>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="px-5 py-3 border-t border-line-hairline bg-surface-rail/40 flex items-center justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export interface DrawerProps {
  open?: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const Drawer: React.FC<DrawerProps> = ({
  open = true,
  onClose,
  title,
  subtitle,
  icon,
  headerActions,
  children,
  className,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex justify-end"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-[min(780px,82vw)] h-full bg-surface-canvas border-l border-line-subtle shadow-2xl flex flex-col overflow-hidden',
          className
        )}
      >
        <div className="px-4 py-3 border-b border-line-hairline bg-surface-rail/90 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {icon && <span className="shrink-0 text-ink-muted">{icon}</span>}
            <div className="min-w-0">
              <div className="text-label font-medium text-ink-primary truncate">{title}</div>
              {subtitle && (
                <div className="text-micro font-mono text-ink-muted truncate mt-0.5">
                  {subtitle}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {headerActions}
            <IconButton label="Close" onClick={onClose}>
              <X className="w-4 h-4" />
            </IconButton>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  );
};
