import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

const BASE_CONTROL =
  'w-full bg-[#15171c] rounded-[10px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.32)] text-ink-primary placeholder:text-ink-faint transition-all focus:outline-none focus-visible:shadow-none focus:bg-[#191b22] focus:ring-1 focus:ring-white/15 disabled:opacity-45';

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

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ inputSize = 'md', className, children, ...rest }, ref) => (
    <div className={cn('relative inline-flex items-center w-full', className)}>
      <select
        ref={ref}
        className={cn(
          BASE_CONTROL,
          'appearance-none cursor-pointer [&>option]:bg-surface-overlay [&>option]:text-ink-primary',
          inputSize === 'sm'
            ? 'h-8 pl-3 pr-8 py-0 text-caption leading-[30px]'
            : 'h-9 pl-3.5 pr-9 py-0 text-label leading-[34px]'
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-ink-muted',
          inputSize === 'sm' ? 'right-2.5 w-3.5 h-3.5' : 'right-3 w-4 h-4'
        )}
      />
    </div>
  )
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
