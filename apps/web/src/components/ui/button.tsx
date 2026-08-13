import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/cn';

const variants = {
  default: 'bg-blue-600 text-white hover:bg-blue-700 shadow-md hover:shadow-lg',
  destructive: 'bg-red-600 text-white hover:bg-red-700 shadow-md hover:shadow-lg',
  outline: 'border-2 border-border-tint bg-surface-raised hover:bg-surface-alt hover:border-slate-300 text-slate-700',
  secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  link: 'text-[#3b82f6] underline-offset-4 hover:underline',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-md hover:shadow-lg',
} as const;

const sizes = {
  default: 'h-11 px-5 py-2.5',
  sm: 'h-9 px-4 text-sm',
  lg: 'h-12 px-8 text-base',
  icon: 'h-10 w-10',
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50',
        'active:scale-[0.98]',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
