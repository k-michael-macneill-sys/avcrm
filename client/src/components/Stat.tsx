import { cn } from '@/lib/utils';

/** The one number a screen leads with. Exactly one per view. */
export function Hero({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): JSX.Element {
  return (
    <div className="glass-card relative mb-4 overflow-hidden rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-xl">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(280px_circle_at_100%_0%,hsl(var(--primary)/0.14),transparent_70%)]" />
      <p className="relative text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="relative my-1.5 bg-gradient-to-b from-foreground to-muted-foreground bg-clip-text text-[44px] font-semibold leading-tight tracking-tight text-transparent">
        {value}
      </p>
      {note ? <p className="relative text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}

export function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): JSX.Element {
  return (
    <div className="glass-card rounded-xl border border-border bg-card/60 p-4 backdrop-blur-xl">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-[26px] font-semibold leading-tight tracking-tight text-foreground">
        {value}
      </p>
      {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
      <div className="mt-2.5 h-[3px] rounded-full bg-gradient-to-r from-primary to-transparent opacity-60" />
    </div>
  );
}

export function StatRow({ children, className }: { children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <div
      className={cn(
        'mb-4 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3',
        className,
      )}
    >
      {children}
    </div>
  );
}
