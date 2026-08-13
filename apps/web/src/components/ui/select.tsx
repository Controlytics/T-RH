import { type SelectHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/cn';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  variant?: 'default' | 'filled' | 'outlined';
  selectSize?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, variant = 'default', selectSize = 'md', icon, ...props }, ref) => {
    const sizeClasses = {
      sm: 'h-9 text-xs px-3 pr-9',
      md: 'h-11 text-sm px-4 pr-10',
      lg: 'h-12 text-base px-5 pr-12',
    };

    const variantClasses = {
      default: [
        'border-2 border-border-tint bg-surface-raised',
        'hover:border-slate-300 hover:bg-slate-50/50',
        'focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 focus:bg-white',
      ].join(' '),
      filled: [
        'border-0 bg-slate-100',
        'hover:bg-slate-200/70',
        'focus:bg-white focus:ring-4 focus:ring-indigo-500/10 focus:shadow-md',
      ].join(' '),
      outlined: [
        'border-2 border-slate-300 bg-transparent',
        'hover:border-indigo-400 hover:bg-indigo-50/30',
        'focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15',
      ].join(' '),
    };

    // Custom chevron SVG with gradient
    const chevronSvg = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%236366f1'/%3E%3Cstop offset='100%25' style='stop-color:%238b5cf6'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath stroke='%236366f1' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`;

    return (
      <select
        ref={ref}
        className={cn(
          'flex w-full rounded-xl font-medium text-slate-700',
          'cursor-pointer',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-slate-100',
          'transition-all duration-200 ease-out',
          'appearance-none bg-no-repeat',
          sizeClasses[selectSize],
          variantClasses[variant],
          selectSize === 'sm' ? 'bg-[length:1rem] bg-[right_0.5rem_center]' :
          selectSize === 'lg' ? 'bg-[length:1.5rem] bg-[right_1rem_center]' :
          'bg-[length:1.25rem] bg-[right_0.75rem_center]',
          'shadow-sm hover:shadow-md focus:shadow-lg',
          className,
        )}
        style={{
          backgroundImage: chevronSvg,
        }}
        {...props}
      >
        {children}
      </select>
    );
  },
);
Select.displayName = 'Select';
