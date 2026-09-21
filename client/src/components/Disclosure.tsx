import * as React from 'react';
import { Button } from '@/components/ui/button';

/** A collapsible panel, so a screen is not a wall of forms. */
export function Disclosure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mt-3">
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen((o) => !o)}>
        {open ? 'Cancel' : label}
      </Button>
      {open ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}
