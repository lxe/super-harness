import React, { useEffect, useRef } from 'react';
import { cn } from './cn';

/**
 * Pure dismissal predicate for click-outside popover behavior.
 * Returns true when an event target is outside both the popover surface and
 * its optional trigger element (`ignoreEl`).
 */
export function shouldDismissPopover(
  target: Node | null,
  surfaceEl: Node | null,
  ignoreEl?: Node | null
): boolean {
  if (!target) return false;
  if (surfaceEl && surfaceEl.contains(target)) return false;
  if (ignoreEl && ignoreEl.contains(target)) return false;
  return true;
}

export interface PopoverSurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: 'sm' | 'md' | 'lg' | 'auto';
  /** When provided, clicking outside the popover or pressing Escape automatically calls `onClose`. */
  onClose?: () => void;
  /** Optional ref to the trigger element that toggles this popover so clicking it doesn't double-toggle. */
  ignoreRef?: React.RefObject<HTMLElement | null>;
}

const WIDTH_CLASSES = {
  sm: 'w-48',
  md: 'w-56',
  lg: 'w-[296px]',
  auto: '',
};

export const PopoverSurface = React.forwardRef<HTMLDivElement, PopoverSurfaceProps>(
  ({ width = 'md', onClose, ignoreRef, className, children, ...rest }, ref) => {
    const localRef = useRef<HTMLDivElement | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
      if (!onClose) return;
      const onPointerDown = (e: MouseEvent) => {
        if (
          shouldDismissPopover(
            e.target as Node | null,
            localRef.current,
            ignoreRef?.current ?? null
          )
        ) {
          onCloseRef.current?.();
        }
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onCloseRef.current?.();
        }
      };
      // Use capture phase for mousedown so stopPropagation() on sibling containers still dismisses
      document.addEventListener('mousedown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown);
      return () => {
        document.removeEventListener('mousedown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown);
      };
    }, [Boolean(onClose), ignoreRef]);

    const setRefs = (node: HTMLDivElement | null) => {
      localRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    };

    return (
      <div
        ref={setRefs}
        className={cn(
          'sh-no-drag rounded-2xl bg-surface-popover/98 backdrop-blur-md p-1.5 text-caption select-none',
          'shadow-[0_2px_6px_rgba(0,0,0,0.32),0_6px_14px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.06)]',
          WIDTH_CLASSES[width],
          className
        )}
        {...rest}
      >
        {children}
      </div>
    );
  }
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
          'w-full h-8 flex items-center gap-2 px-2.5 rounded-lg text-left text-caption transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:shadow-none',
          toneCls,
          className
        )}
        {...rest}
      >
        {icon && <span className="shrink-0 inline-flex items-center text-ink-muted">{icon}</span>}
        <span className="truncate flex-1 leading-[1.35] pt-[1px]">{children}</span>
        {rightSlot && (
          <span className="shrink-0 inline-flex items-center text-ink-faint">{rightSlot}</span>
        )}
      </button>
    );
};
