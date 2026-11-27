import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from './cn';

const BASE_CONTROL =
  'w-full bg-surface-rail rounded-lg shadow-[inset_0_1px_2px_rgba(0,0,0,0.32)] text-ink-primary placeholder:text-ink-faint transition-all focus:outline-none focus-visible:shadow-none focus:bg-surface-subtle focus:ring-1 focus:ring-white/15 disabled:opacity-45';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  inputSize?: 'sm' | 'md';
  mono?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ inputSize = 'md', mono = false, className, ...rest }, ref) => (
    <input
      ref={ref}
      className={cn(
        BASE_CONTROL,
        inputSize === 'sm'
          ? 'h-8 px-2.5 py-0 text-caption leading-[30px]'
          : 'h-9 px-3 py-0 text-label leading-[34px]',
        mono && 'font-mono pt-[1px]',
        className
      )}
      {...rest}
    />
  )
);
Input.displayName = 'Input';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  inputSize?: 'sm' | 'md';
}

interface ParsedOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

function parseSelectOptions(children: React.ReactNode): ParsedOption[] {
  const out: ParsedOption[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === 'option') {
      const props = child.props as React.OptionHTMLAttributes<HTMLOptionElement>;
      const val = props.value !== undefined ? String(props.value) : String(props.children ?? '');
      out.push({
        value: val,
        label: props.children ?? val,
        disabled: Boolean(props.disabled),
      });
    } else if (child.type === React.Fragment) {
      out.push(...parseSelectOptions((child.props as { children?: React.ReactNode }).children));
    }
  });
  return out;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      inputSize = 'md',
      className,
      children,
      value,
      defaultValue,
      onChange,
      disabled,
      name,
      id,
      'aria-label': ariaLabel,
    },
    _ref
  ) => {
    const options = useMemo(() => parseSelectOptions(children), [children]);
    const isControlled = value !== undefined;
    const [uncontrolledValue, setUncontrolledValue] = useState<string>(() =>
      defaultValue !== undefined ? String(defaultValue) : options[0]?.value ?? ''
    );
    const currentValue = isControlled ? String(value) : uncontrolledValue;
    const selectedOption = options.find((o) => o.value === currentValue) ?? options[0];

    const [open, setOpen] = useState(false);
    const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const updatePosition = () => {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const estimatedHeight = Math.min(options.length * 34 + 14, 260);
      const spaceBelow = window.innerHeight - rect.bottom;
      const up = spaceBelow < estimatedHeight + 12 && rect.top > estimatedHeight + 12;
      setMenuPos({
        top: up ? rect.top - 6 : rect.bottom + 6,
        left: rect.left,
        width: rect.width,
        up,
      });
    };

    useEffect(() => {
      if (!open) return;
      updatePosition();
      const onPointerDown = (e: MouseEvent) => {
        const target = e.target as Node;
        if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
        setOpen(false);
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      };
      const onScrollOrResize = () => updatePosition();
      window.addEventListener('mousedown', onPointerDown, true);
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', onScrollOrResize);
      window.addEventListener('scroll', onScrollOrResize, true);
      return () => {
        window.removeEventListener('mousedown', onPointerDown, true);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('resize', onScrollOrResize);
        window.removeEventListener('scroll', onScrollOrResize, true);
      };
    }, [open, options.length]);

    const commitValue = (nextVal: string) => {
      if (!isControlled) setUncontrolledValue(nextVal);
      setOpen(false);
      if (nextVal !== currentValue && onChange) {
        const synthetic = {
          target: { value: nextVal, name: name ?? '' },
          currentTarget: { value: nextVal, name: name ?? '' },
        } as unknown as React.ChangeEvent<HTMLSelectElement>;
        onChange(synthetic);
      }
      triggerRef.current?.focus();
    };

    const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        const enabled = options.filter((o) => !o.disabled);
        const idx = enabled.findIndex((o) => o.value === currentValue);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const next = enabled[(idx + delta + enabled.length) % enabled.length];
        if (next) commitValue(next.value);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };

    return (
      <div className={cn('relative inline-flex items-center w-full', className)}>
        <button
          ref={triggerRef}
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={() => !disabled && setOpen((v) => !v)}
          onKeyDown={handleTriggerKeyDown}
          className={cn(
            'w-full flex items-center justify-between gap-2 rounded-lg text-left transition-all cursor-pointer select-none',
            'bg-surface-raised hover:bg-surface-bubble text-ink-primary',
            'shadow-[0_1px_2px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.06)]',
            'focus:outline-none focus-visible:shadow-none focus-visible:ring-1 focus-visible:ring-white/20 disabled:opacity-45 disabled:cursor-not-allowed',
            open && 'bg-surface-bubble ring-1 ring-white/15',
            inputSize === 'sm' ? 'h-8 px-3 text-caption' : 'h-9 px-3.5 text-label'
          )}
        >
          <span className="truncate">{selectedOption?.label ?? ''}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'shrink-0 text-ink-muted transition-transform duration-150',
              open && 'rotate-180 text-ink-secondary',
              inputSize === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'
            )}
          />
        </button>

        {open &&
          menuPos &&
          createPortal(
            <div
              ref={menuRef}
              role="listbox"
              style={{
                position: 'fixed',
                top: menuPos.top,
                left: menuPos.left,
                minWidth: menuPos.width,
                transform: menuPos.up ? 'translateY(-100%)' : undefined,
              }}
              className="z-[9999] max-h-64 overflow-y-auto sh-scroll-hover rounded-xl bg-surface-popover p-1.5 shadow-[0_6px_18px_rgba(0,0,0,0.42),0_1px_2px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.06)]"
            >
              {options.map((opt) => {
                const active = opt.value === currentValue;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={opt.disabled}
                    onClick={() => !opt.disabled && commitValue(opt.value)}
                    className={cn(
                      'w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors cursor-pointer select-none',
                      inputSize === 'sm' ? 'text-caption' : 'text-label',
                      active
                        ? 'bg-white/[0.08] text-ink-primary font-medium'
                        : 'text-ink-secondary hover:bg-white/[0.06] hover:text-ink-primary',
                      opt.disabled && 'opacity-40 cursor-not-allowed'
                    )}
                  >
                    <span className="truncate">{opt.label}</span>
                    {active && <Check className="w-3.5 h-3.5 shrink-0 text-ink-primary" />}
                  </button>
                );
              })}
            </div>,
            document.body
          )}
      </div>
    );
  }
);
Select.displayName = 'Select';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ mono = false, className, ...rest }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        BASE_CONTROL,
        'px-3 py-2 text-body leading-relaxed resize-none',
        mono && 'font-mono text-caption',
        className
      )}
      {...rest}
    />
  )
);
Textarea.displayName = 'Textarea';

export interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}

export const Field: React.FC<FieldProps> = ({ label, hint, children, className }) => (
  <div className={cn('space-y-1.5', className)}>
    <div className="flex items-baseline justify-between gap-2">
      <label className="text-caption font-medium text-ink-secondary">{label}</label>
      {hint && <span className="text-micro text-ink-faint">{hint}</span>}
    </div>
    {children}
  </div>
);
