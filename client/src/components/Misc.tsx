import { Loader2 } from 'lucide-react';

export function Loading(): JSX.Element {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
      <Loader2 className="size-4 animate-spin" /> Loading…
    </p>
  );
}

export function ErrorNotice({ message }: { message: string }): JSX.Element {
  return (
    <p className="rounded-lg border border-critical/35 bg-critical/10 px-3 py-2 text-sm text-critical">
      {message}
    </p>
  );
}

export function FieldList({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-x-5 gap-y-3">
      {children}
    </dl>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-foreground">{children}</dd>
    </div>
  );
}
