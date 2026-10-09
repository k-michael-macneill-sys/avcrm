import * as React from 'react';
import { Trash2 } from 'lucide-react';
import { ErrorNotice } from '@/components/Misc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useSubmit } from '@/lib/useSubmit';

/**
 * A delete button that asks first. Nothing is sent until "Yes, delete" is
 * pressed in the box; an error from the server stays in the box so it can be
 * read rather than lost behind a closed dialog.
 */
export function ConfirmDelete({
  what,
  consequences,
  onConfirm,
  onDeleted,
  label = 'Delete',
  size = 'sm',
  typeToConfirm,
}: {
  /** "this customer", "the pin at 12 Main St" — finishes "Delete …?" */
  what: string;
  /** What else goes with it, in plain words. */
  consequences?: string;
  onConfirm: () => Promise<unknown>;
  onDeleted: () => void;
  label?: string;
  size?: 'sm' | 'default';
  /** A word that must be typed exactly before the delete button wakes up. */
  typeToConfirm?: string;
}): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const confirmed = !typeToConfirm || typed === typeToConfirm;
  const { run, pending, error, clearError } = useSubmit(() => {
    setOpen(false);
    onDeleted();
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) clearError();
        setTyped('');
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" size={size}>
          <Trash2 className="size-3.5" /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Are you sure?</DialogTitle>
          <DialogDescription>
            Delete {what}? This cannot be undone.
            {consequences ? ` ${consequences}` : ''}
          </DialogDescription>
        </DialogHeader>
        {typeToConfirm ? (
          <div className="mb-3 flex flex-col gap-1.5">
            <Label htmlFor="confirm-delete-word">
              Type <span className="font-mono font-semibold">{typeToConfirm}</span> to confirm
            </Label>
            <Input
              id="confirm-delete-word"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        ) : null}
        {error ? (
          <div className="mb-3">
            <ErrorNotice message={error} />
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={pending || !confirmed}
            onClick={() => run(onConfirm)}
          >
            {pending ? 'Deleting…' : 'Yes, delete'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
