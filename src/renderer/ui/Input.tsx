import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

const BASE_CONTROL =
  'w-full bg-surface-subtle border border-line-subtle rounded-lg text-ink-primary placeholder:text-ink-faint transition-colors focus:outline-none focus-visible:shadow-none focus:border-line-strong disabled:opacity-45';

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
        inputSize === 'sm' ? 'h-8 px-2.5 text-caption' : 'h-9 px-3 text-label',
        mono && 'font-mono',
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
          inputSize === 'sm' ? 'h-8 pl-3 pr-8 text-caption' : 'h-9 pl-3.5 pr-9 text-label'
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
