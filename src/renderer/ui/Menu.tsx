import React from 'react';
import { cn } from './cn';

export interface PopoverSurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: 'sm' | 'md' | 'lg' | 'auto';
}

const WIDTH_CLASSES = {
  sm: 'w-48',
  md: 'w-56',
  lg: 'w-[296px]',
  auto: '',
};

export const PopoverSurface = React.forwardRef<HTMLDivElement, PopoverSurfaceProps>(
  ({ width = 'md', className, children, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-xl border border-line-subtle bg-surface-popover/98 backdrop-blur-md p-1.5 text-caption select-none',
        'shadow-[0_18px_40px_-10px_rgba(0,0,0,0.65)]',
        WIDTH_CLASSES[width],
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
);
PopoverSurface.displayName = 'PopoverSurface';

export interface MenuHeaderProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const MenuHeader: React.FC<MenuHeaderProps> = ({ icon, children, className }) => (
  <div
    className={cn(
      'px-2.5 py-1.5 flex items-center gap-2 border-b border-line-hairline mb-1 text-caption font-medium text-ink-primary',
      className
    )}
  >
    {icon && <span className="shrink-0 inline-flex">{icon}</span>}
    <span className="truncate">{children}</span>
  </div>
);

export const MenuSectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <div
    className={cn(
      'px-2.5 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint',
      className
    )}
  >
    {children}
  </div>
);

export const MenuDivider: React.FC<{ className?: string }> = ({ className }) => (
  <div className={cn('my-1 border-t border-line-hairline', className)} />
);

export interface MenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  rightSlot?: React.ReactNode;
  active?: boolean;
  tone?: 'default' | 'warning' | 'danger';
}

export const MenuItem: React.FC<MenuItemProps> = ({
  icon,
  rightSlot,
  active = false,
  tone = 'default',
  className,
  children,
  type = 'button',
  ...rest
}) => {
  const toneCls =
    tone === 'danger'
      ? 'text-rose-300/90 hover:text-rose-200 hover:bg-rose-500/12'
      : tone === 'warning'
        ? 'text-ink-secondary hover:text-amber-300 hover:bg-white/[0.07]'
        : active
          ? 'text-ink-primary bg-white/[0.08] font-medium'
          : 'text-ink-secondary hover:text-ink-primary hover:bg-white/[0.07]';

  return (
    <button
      type={type}
      className={cn(
        'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-caption transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
        toneCls,
        className
      )}
      {...rest}
    >
      {icon && <span className="shrink-0 inline-flex text-ink-muted">{icon}</span>}
      <span className="truncate flex-1">{children}</span>
      {rightSlot && <span className="shrink-0 inline-flex text-ink-faint">{rightSlot}</span>}
    </button>
  );
};
