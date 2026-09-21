import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-accent/60 text-muted-foreground',
        good: 'border-good/35 bg-good/15 text-good',
        warning: 'border-warning/35 bg-warning/15 text-warning',
        serious: 'border-serious/35 bg-serious/15 text-serious',
        critical: 'border-critical/35 bg-critical/15 text-critical',
        primary: 'border-primary/35 bg-primary/15 text-primary',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Renders the small status dot before the label — omit for a plain tag. */
  dot?: boolean;
}

function Badge({ className, variant, dot, children, ...props }: BadgeProps): JSX.Element {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? <span className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
