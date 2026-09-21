import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/**
 * Small forms, built from a spec — the same shape the old vanilla-DOM
 * `buildForm` used, so every screen's field list ports over almost
 * unchanged. `useDataForm` owns the values; this component only renders.
 */
export interface FieldSpec {
  name: string;
  label: string;
  type?:
    | 'text'
    | 'number'
    | 'date'
    | 'datetime-local'
    | 'email'
    | 'password'
    | 'textarea'
    | 'select';
  value?: string;
  placeholder?: string;
  required?: boolean;
  step?: string;
  options?: { value: string; label: string }[];
  /** Shown under the control: where to find this value, what it means. */
  help?: string;
}

export function useDataForm(specs: FieldSpec[]): {
  values: Record<string, string>;
  setValue: (name: string, value: string) => void;
  reset: (specs: FieldSpec[]) => void;
} {
  const initial = React.useMemo(() => defaults(specs), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = React.useState<Record<string, string>>(initial);

  const setValue = React.useCallback((name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
  }, []);

  const reset = React.useCallback((next: FieldSpec[]) => setValues(defaults(next)), []);

  return { values, setValue, reset };
}

function defaults(specs: FieldSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    out[spec.name] = spec.value ?? (spec.type === 'select' ? (spec.options?.[0]?.value ?? '') : '');
  }
  return out;
}

export function DataFormFields({
  specs,
  values,
  setValue,
  className = 'mb-3 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3',
}: {
  specs: FieldSpec[];
  values: Record<string, string>;
  setValue: (name: string, value: string) => void;
  className?: string;
}): JSX.Element {
  return (
    <div className={className}>
      {specs.map((spec) => {
        const id = `field-${spec.name}`;
        return (
          <div key={spec.name} className="flex flex-col gap-1.5">
            <Label htmlFor={id}>
              {spec.label}
              {spec.required ? <span className="text-critical"> *</span> : null}
            </Label>
            {spec.type === 'select' ? (
              <Select value={values[spec.name] ?? ''} onValueChange={(v) => setValue(spec.name, v)}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(spec.options ?? []).map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : spec.type === 'textarea' ? (
              <Textarea
                id={id}
                value={values[spec.name] ?? ''}
                onChange={(e) => setValue(spec.name, e.target.value)}
                rows={3}
              />
            ) : (
              <Input
                id={id}
                type={spec.type ?? 'text'}
                value={values[spec.name] ?? ''}
                placeholder={spec.placeholder}
                required={spec.required}
                step={spec.step}
                onChange={(e) => setValue(spec.name, e.target.value)}
              />
            )}
            {spec.help ? <p className="max-w-[60ch] text-xs text-muted-foreground">{spec.help}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
