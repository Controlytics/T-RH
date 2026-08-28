import { cn } from '@/lib/cn';

const variants = {
  default: 'bg-slate-100 text-slate-700 border border-slate-200',
  secondary: 'bg-slate-100 text-slate-700 border border-slate-200',
  destructive: 'bg-red-100 text-red-700 border border-red-200',
  outline: 'text-slate-700 border border-slate-300 bg-white',
  success: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  warning: 'bg-amber-100 text-amber-700 border border-amber-200',
} as const;

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: keyof typeof variants;
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-semibold transition-all duration-200',
        'shadow-[var(--elev-1)]',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
