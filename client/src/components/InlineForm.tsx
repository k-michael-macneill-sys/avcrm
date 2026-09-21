import { Button } from '@/components/ui/button';
import { DataFormFields, useDataForm, type FieldSpec } from '@/components/DataForm';
import { ErrorNotice } from '@/components/Misc';
import { useSubmit } from '@/lib/useSubmit';

/**
 * The pattern nearly every "add a thing" panel on this app follows: a spec-
 * driven field grid, an error line, and one submit button that disables
 * itself while the request is in flight.
 */
export function InlineForm({
  specs,
  submitLabel,
  onSubmit,
  onDone,
}: {
  specs: FieldSpec[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  onDone: () => void;
}): JSX.Element {
  const { values, setValue } = useDataForm(specs);
  const { run, pending, error } = useSubmit(onDone);

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <DataFormFields specs={specs} values={values} setValue={setValue} />
      {error ? <ErrorNotice message={error} /> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => run(() => onSubmit(values))}>
          {pending ? 'Working…' : submitLabel}
        </Button>
      </div>
    </div>
  );
}
