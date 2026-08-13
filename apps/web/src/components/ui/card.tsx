import { cn } from '@/lib/cn';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Adds the module-coloured gradient strip along the top edge. Use on the main
   * card of a page; using it on every card on a screen reads as stripes.
   */
  banded?: boolean;
}

export function Card({ className, banded, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-border-tint bg-surface text-card-foreground overflow-hidden',
        'shadow-soft hover:shadow-elevated transition-all duration-300',
        className,
      )}
      {...props}
    >
      {banded ? (
        <div
          className="h-1.5 bg-gradient-to-r from-[var(--mod-from)] to-[var(--mod-to)]"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </div>
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        'text-xl font-semibold leading-none tracking-tight text-[var(--mod-text)]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * text-slate-600, not slate-500. slate-500 measures 3.97-4.49:1 on the tinted
 * card surface, under the 4.50 WCAG AA floor — it only passed when this card was
 * pure white. app.css also remaps slate-500 inside the canvas as a safety net,
 * but stating it here means this component is correct on its own.
 */
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-slate-600', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center p-6 pt-0', className)} {...props} />;
}
