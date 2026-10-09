import * as React from 'react';
import { KeyRound } from 'lucide-react';
import { DataFormFields, useDataForm, type FieldSpec } from '@/components/DataForm';
import { ErrorNotice } from '@/components/Misc';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import * as api from '@/lib/api';
import { useSubmit } from '@/lib/useSubmit';

/** The server's own minimum (MIN_PASSWORD_LENGTH), said up front. */
const MIN_LENGTH = 10;

const SPECS: FieldSpec[] = [
  { name: 'current', label: 'Current password', type: 'password', required: true },
  { name: 'next', label: 'New password', type: 'password', required: true, help: `At least ${MIN_LENGTH} characters.` },
  { name: 'confirm', label: 'New password again', type: 'password', required: true },
];

/**
 * Changing your own password. Every other device signed in as you is signed
 * out by it — which is the point when the reason is a lost phone — and this
 * one carries on with the fresh session the server hands back.
 */
export function ChangePassword(): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const { values, setValue, reset } = useDataForm(SPECS);
  const [mismatch, setMismatch] = React.useState<string | null>(null);
  const { run, pending, error, clearError } = useSubmit(() => setDone(true));

  const close = (next: boolean) => {
    if (pending) return;
    if (!next) {
      clearError();
      setMismatch(null);
      setDone(false);
      reset(SPECS);
    }
    setOpen(next);
  };

  const submit = () => {
    setMismatch(null);
    if ((values.next ?? '') !== (values.confirm ?? '')) {
      setMismatch('The two new passwords do not match');
      return;
    }
    run(() => api.changePassword(values.current ?? '', values.next ?? ''));
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" className="justify-start gap-2">
          <KeyRound className="size-3.5" /> Change password
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change your password</DialogTitle>
          <DialogDescription>
            Any other device signed in as you is signed out, and has to sign in with the new one.
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <>
            <p className="text-sm">Your password has been changed.</p>
            <div className="flex justify-end">
              <DialogClose asChild>
                <Button type="button">Done</Button>
              </DialogClose>
            </div>
          </>
        ) : (
          <>
            <DataFormFields specs={SPECS} values={values} setValue={setValue} className="flex flex-col gap-3" />
            {mismatch || error ? (
              <div className="mt-3">
                <ErrorNotice message={mismatch ?? error ?? ''} />
              </div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="secondary" disabled={pending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="button" disabled={pending} onClick={submit}>
                {pending ? 'Working…' : 'Change password'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
