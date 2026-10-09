import * as React from 'react';
import { PenLine } from 'lucide-react';
import {
  AGREEMENT_FIELDS,
  TERM_LINE,
  agreementDate,
  agreementRewrites,
  termTypeOf,
  type AgreementFieldSpec,
  type AgreementRewrite,
  type AgreementValues,
} from '../../../src/types/agreement';
import { Loading, ErrorNotice } from '@/components/Misc';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * The company's agreement PDF, drawn page by page, with the form filled in
 * on top of it. Each field of the PDF is a tap target in the right place:
 * a text field opens a proper input (the PDF's own boxes are far too small
 * to type into on a phone), a checkbox or the package choice toggles in
 * place, and a signature line opens the signing pad. What is shown is what
 * the server prints into the signed copy.
 */

export type SignatureField = 'customer_signature' | 'provider_signature';

interface Widget {
  name: string;
  page: number;
  /** Fractions of the page, top-left origin. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** For the radio group: which option this widget is. */
  option?: string;
}

interface Rendered {
  pages: { width: number; height: number; image: string }[];
  widgets: Widget[];
}

const SPEC = new Map(AGREEMENT_FIELDS.map((f) => [f.name, f]));
const TYPED = AGREEMENT_FIELDS.filter((f) => !['check', 'choice', 'signature', 'date'].includes(f.kind));

/** How far past its box each checkbox's label runs, in PDF points, so the label is tappable too. */
const LABEL_REACH: Record<string, number> = {
  phone_type_cell: 24,
  phone_type_home: 30,
  package: 150,
};

/**
 * The walk-through behind "Next": every typed field, plus the boxes in
 * groups at the point they come up on the page, so a phone never has to hit
 * a checkbox a few pixels wide.
 */
type Step = { kind: 'field'; name: string } | { kind: 'group'; title: string; names: string[]; single?: boolean };
const STEPS: Step[] = (() => {
  const steps: Step[] = [];
  for (const f of TYPED) {
    if (f.name === 'term_start') steps.push({ kind: 'group', title: 'Term of service', names: ['term_type'], single: true });
    steps.push({ kind: 'field', name: f.name });
    if (f.name === 'customer_phone') {
      steps.push({ kind: 'group', title: 'Phone type', names: ['phone_type_cell', 'phone_type_home'] });
    }
    if (f.name === 'end_year') steps.push({ kind: 'group', title: 'Package', names: ['package'], single: true });
    if (f.name === 'price_premium') {
      steps.push({
        kind: 'group',
        title: 'Add-on services',
        names: AGREEMENT_FIELDS.filter((a) => a.name.startsWith('addon_')).map((a) => a.name),
      });
    }
  }
  return steps;
})();
const NONE: string[] = [];

/** How each single choice reads in the walk-through. */
const CHOICE_LABELS: Record<string, string> = {
  Basic: 'Basic package',
  Premium: 'Premium package',
  Seasonal: 'Seasonal — November 1st to March 31st',
  'Exact dates': 'Exact dates — a month or two, or any start and end',
};

/** The fields that only apply to the other kind of term, which Next skips. */
const SEASON_ONLY = ['start_year', 'end_year'];
const EXACT_ONLY = ['term_start', 'term_end'];
const TERM_FIELDS = ['term_type', ...EXACT_ONLY];

async function renderTemplate(): Promise<Rendered> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const doc = await pdfjs.getDocument('/agreement-template.pdf').promise;
  const pages: Rendered['pages'] = [];
  const widgets: Widget[] = [];
  // Drawn once, sharp enough for a large screen, then scaled with CSS.
  const scale = 2.2;

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw the agreement');
    // Form widgets are not drawn: the values are laid over the page instead.
    await page.render({ canvasContext: context, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
    pages.push({ width: base.width, height: base.height, image: canvas.toDataURL('image/png') });

    for (const a of (await page.getAnnotations()) as {
      fieldName?: string;
      rect: number[];
      radioButton?: boolean;
      buttonValue?: string;
    }[]) {
      if (!a.fieldName || !SPEC.has(a.fieldName)) continue;
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = a.rect;
      widgets.push({
        name: a.fieldName,
        page: n - 1,
        left: x1 / base.width,
        top: (base.height - y2) / base.height,
        width: (x2 - x1) / base.width,
        height: (y2 - y1) / base.height,
        ...(a.radioButton ? { option: a.buttonValue } : {}),
      });
    }
  }
  return { pages, widgets };
}

let cached: Promise<Rendered> | null = null;

export function AgreementPdf({
  values,
  onChange,
  signatures,
  onSign,
  invalid = [],
  locked = NONE,
  signedAt,
}: {
  values: AgreementValues;
  /** Absent for a read-only copy, as on the customer's own signing page. */
  onChange?: (next: AgreementValues) => void;
  /** Data URLs of the signatures taken so far, shown on their lines. */
  signatures: Partial<Record<SignatureField, string | null>>;
  /** Which signature lines can be tapped, and what tapping one does. */
  onSign?: (field: SignatureField) => void;
  /** Fields the server said are missing or wrong, outlined in red. */
  invalid?: string[];
  /**
   * Fields shown as filled in but not editable, and skipped by Next: the
   * city on a branch sign-in's agreement, which the server fills anyway.
   */
  locked?: string[];
  signedAt?: Date;
}): JSX.Element {
  const [rendered, setRendered] = React.useState<Rendered | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    cached ??= renderTemplate();
    cached.then(
      (r) => live && setRendered(r),
      (err: unknown) => {
        cached = null;
        if (live) setFailed(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  if (failed) return <ErrorNotice message={`The agreement could not be shown: ${failed}`} />;
  if (!rendered) return <Loading />;

  const set = (name: string, value: string | boolean): void => onChange?.({ ...values, [name]: value });
  const date = agreementDate(signedAt ?? new Date());
  const rewrites = agreementRewrites(values);
  const termBad = invalid.some((name) => TERM_FIELDS.includes(name));

  return (
    <div className="flex flex-col gap-4">
      {rendered.pages.map((page, index) => (
        <div
          key={index}
          className="relative w-full overflow-hidden rounded-lg bg-white shadow-lg ring-1 ring-black/10 [container-type:inline-size]"
          style={{ aspectRatio: `${page.width} / ${page.height}` }}
        >
          <img src={page.image} alt={`Agreement page ${index + 1}`} className="absolute inset-0 size-full select-none" draggable={false} />
          {/* Seasonal: the term sentence, under its two year boxes, opens the choice of term. */}
          {onChange && index === TERM_LINE.page && rewrites.length === 0 ? (
            <button
              type="button"
              aria-label="Term of service"
              onClick={() => setEditing('term_type')}
              className="absolute rounded-sm hover:bg-sky-200/30"
              style={lineBox(TERM_LINE, page)}
            />
          ) : null}
          {rendered.widgets
            .filter((w) => w.page === index)
            .map((w) => (
              <Overlay
                key={`${w.name}-${w.option ?? ''}`}
                widget={w}
                spec={SPEC.get(w.name)!}
                pageWidth={page.width}
                value={values[w.name]}
                editable={!!onChange && !locked.includes(w.name)}
                bad={invalid.includes(w.name)}
                signature={
                  SPEC.get(w.name)?.kind === 'signature' ? (signatures[w.name as SignatureField] ?? null) : null
                }
                signable={!!onSign && SPEC.get(w.name)?.kind === 'signature'}
                date={
                  SPEC.get(w.name)?.kind === 'date' &&
                  signatures[w.name.replace('_sign_date', '_signature') as SignatureField]
                    ? date
                    : ''
                }
                onEdit={() => setEditing(w.name)}
                onToggle={() => {
                  const spec = SPEC.get(w.name)!;
                  if (spec.kind === 'check') set(w.name, values[w.name] !== true);
                  else if (spec.kind === 'choice' && w.option) set(w.name, w.option);
                }}
                onSign={() => onSign?.(w.name as SignatureField)}
              />
            ))}
          {rewrites
            .filter((line) => line.page === index)
            .map((line) => (
              <Rewrite
                key={line.top}
                line={line}
                page={page}
                editable={!!onChange && !!line.term}
                bad={!!line.term && termBad}
                onEdit={() => setEditing('term_type')}
              />
            ))}
        </div>
      ))}

      {onChange ? (
        <FieldEditor
          name={editing}
          values={values}
          onChange={onChange}
          onMove={setEditing}
          locked={locked}
        />
      ) : null}
    </div>
  );
}

function lineBox(
  line: Pick<AgreementRewrite, 'left' | 'top' | 'right' | 'bottom'>,
  page: { width: number; height: number },
): React.CSSProperties {
  return {
    left: `${(line.left / page.width) * 100}%`,
    top: `${(line.top / page.height) * 100}%`,
    width: `${((line.right - line.left) / page.width) * 100}%`,
    height: `${((line.bottom - line.top) / page.height) * 100}%`,
  };
}

/**
 * A printed line reworded for an exact-dates term, drawn over the original
 * the way the signed copy prints it. The dates line opens its editor.
 */
function Rewrite({
  line,
  page,
  editable,
  bad,
  onEdit,
}: {
  line: AgreementRewrite;
  page: { width: number; height: number };
  editable: boolean;
  bad: boolean;
  onEdit: () => void;
}): JSX.Element {
  const type = (pt: number): string => `${(pt / page.width) * 100}cqw`;
  return (
    <button
      type="button"
      aria-label={line.term ? 'Term of service' : undefined}
      disabled={!editable}
      onClick={onEdit}
      className={cn(
        'absolute flex items-end overflow-hidden whitespace-nowrap bg-white text-left leading-none text-black',
        editable && 'ring-1 ring-sky-400/60 hover:ring-sky-500',
        bad && 'ring-2 ring-red-500',
      )}
      style={{
        ...lineBox(line, page),
        fontFamily: 'Helvetica, Arial, sans-serif',
        fontSize: type(line.size),
        paddingLeft: type(0.8),
        paddingBottom: type(Math.max(0, line.bottom - line.baseline - line.size * 0.21)),
      }}
    >
      {line.text}
    </button>
  );
}

function Overlay({
  widget,
  spec,
  pageWidth,
  value,
  editable,
  bad,
  signature,
  signable,
  date,
  onEdit,
  onToggle,
  onSign,
}: {
  widget: Widget;
  spec: AgreementFieldSpec;
  pageWidth: number;
  value: string | boolean | undefined;
  editable: boolean;
  bad: boolean;
  signature: string | null;
  signable: boolean;
  date: string;
  onEdit: () => void;
  onToggle: () => void;
  onSign: () => void;
}): JSX.Element | null {
  const box: React.CSSProperties = {
    left: `${widget.left * 100}%`,
    top: `${widget.top * 100}%`,
    width: `${widget.width * 100}%`,
    height: `${widget.height * 100}%`,
  };
  // Type sized in page units, so it scales with the page like the PDF does.
  const type = (pt: number): string => `${(pt / pageWidth) * 100}cqw`;
  const ring = bad ? 'ring-2 ring-red-500' : editable ? 'ring-1 ring-sky-400/60 hover:ring-sky-500' : '';

  if (spec.kind === 'check' || spec.kind === 'choice') {
    const on = spec.kind === 'check' ? value === true : value === widget.option;
    // The box itself is a few points wide; the tap target also covers the
    // label beside it, and is kept inside its own row and column so the
    // neighbours (rows are only 15pt apart) stay tappable.
    const reach = (LABEL_REACH[widget.name] ?? 95) / pageWidth;
    // 13pt tall, as a fraction of the page width so it can be sized in cqw.
    const tall = 13 / pageWidth;
    const centre = widget.top + widget.height / 2;
    return (
      <button
        type="button"
        aria-label={spec.kind === 'choice' ? `${widget.option} package` : spec.label}
        aria-pressed={on}
        disabled={!editable}
        onClick={onToggle}
        className={cn('absolute rounded-sm', editable && 'hover:bg-sky-200/30', bad && 'ring-2 ring-red-500')}
        style={{
          left: `${(widget.left - 2 / pageWidth) * 100}%`,
          width: `${(widget.width + reach + 2 / pageWidth) * 100}%`,
          top: `calc(${centre * 100}% - ${(tall / 2) * 100}cqw)`,
          height: `${tall * 100}cqw`,
        }}
      >
        {on ? (
          <span
            className="absolute grid place-items-center font-bold leading-none text-blue-700"
            style={{
              left: `${(2 / pageWidth / (widget.width + reach + 2 / pageWidth)) * 100}%`,
              width: `${(widget.width / (widget.width + reach + 2 / pageWidth)) * 100}%`,
              top: 0,
              bottom: 0,
              fontSize: type(widget.width * pageWidth * 1.15),
            }}
          >
            ✓
          </span>
        ) : null}
      </button>
    );
  }

  if (spec.kind === 'signature') {
    return (
      <button
        type="button"
        aria-label={spec.label}
        disabled={!signable}
        onClick={onSign}
        className={cn(
          'absolute flex items-end justify-center rounded-sm',
          signable && !signature && 'animate-pulse bg-amber-300/40 ring-2 ring-amber-500',
          bad && 'ring-2 ring-red-500',
        )}
        style={box}
      >
        {signature ? (
          <img src={signature} alt={spec.label} className="pointer-events-none absolute bottom-0 h-[170%] max-w-full object-contain" />
        ) : signable ? (
          <span className="flex items-center gap-1 font-semibold text-amber-900" style={{ fontSize: type(8) }}>
            <PenLine className="size-[1.2em]" /> Tap to sign
          </span>
        ) : null}
      </button>
    );
  }

  if (spec.kind === 'date') {
    return (
      <span className="absolute flex items-end px-[0.3%] text-black" style={{ ...box, fontSize: type(10) }}>
        {date}
      </span>
    );
  }

  const shown = typeof value === 'string' ? value : '';
  return (
    <button
      type="button"
      aria-label={spec.label}
      disabled={!editable}
      onClick={onEdit}
      className={cn(
        'absolute overflow-hidden rounded-sm px-[0.4%] text-left text-black',
        spec.kind === 'notes' ? 'items-start whitespace-pre-wrap leading-tight' : 'flex items-center whitespace-nowrap',
        !shown && editable && 'bg-sky-100/70',
        ring,
      )}
      style={{ ...box, fontSize: type(spec.kind === 'notes' ? 8.5 : 9.5) }}
    >
      {shown}
    </button>
  );
}

/** A comfortable input for one step at a time, with Next to walk the whole form. */
function FieldEditor({
  name,
  values,
  onChange,
  onMove,
  locked,
}: {
  name: string | null;
  values: AgreementValues;
  onChange: (next: AgreementValues) => void;
  onMove: (name: string | null) => void;
  locked: string[];
}): JSX.Element {
  const exact = termTypeOf(values) === 'Exact dates';
  const steps = React.useMemo(() => {
    const skipped = [...locked, ...(exact ? SEASON_ONLY : EXACT_ONLY)];
    return STEPS.filter((s) => !(s.kind === 'field' && skipped.includes(s.name)));
  }, [locked, exact]);
  const index = name ? steps.findIndex((s) => (s.kind === 'field' ? s.name === name : s.names.includes(name))) : -1;
  const step = index >= 0 ? steps[index] : undefined;
  const nextStep = index >= 0 ? steps[index + 1] : undefined;
  const previousStep = index > 0 ? steps[index - 1] : undefined;
  const nameOf = (s: Step | undefined): string | null => (s ? (s.kind === 'field' ? s.name : s.names[0]!) : null);
  const spec = step?.kind === 'field' ? SPEC.get(step.name) : undefined;
  const value = spec && typeof values[spec.name] === 'string' ? (values[spec.name] as string) : '';
  const set = (v: string): void => {
    if (spec) onChange({ ...values, [spec.name]: v });
  };

  const inputProps: Record<string, string> = {};
  if (spec?.kind === 'email') Object.assign(inputProps, { type: 'email', inputMode: 'email', autoComplete: 'email' });
  if (spec?.kind === 'tel') Object.assign(inputProps, { type: 'tel', inputMode: 'tel', autoComplete: 'tel' });
  if (spec?.kind === 'money') Object.assign(inputProps, { inputMode: 'decimal', placeholder: '0.00' });
  if (spec?.kind === 'year') Object.assign(inputProps, { inputMode: 'numeric', maxLength: '2', placeholder: 'e.g. 26' });
  if (spec?.kind === 'day') inputProps.type = 'date';
  if (spec?.name === 'term_end' && typeof values.term_start === 'string' && values.term_start) {
    inputProps.min = values.term_start;
  }
  if (spec?.name === 'customer_name') inputProps.autoComplete = 'name';
  if (spec?.name === 'customer_postal') inputProps.autoComplete = 'postal-code';

  return (
    <Dialog open={!!step} onOpenChange={(open) => !open && onMove(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{step?.kind === 'group' ? step.title : spec?.label}</DialogTitle>
          <DialogDescription>
            Step {index + 1} of {steps.length}. It goes onto the agreement exactly as entered.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onMove(nameOf(nextStep));
          }}
        >
          {step?.kind === 'group' ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {step.single
                ? (SPEC.get(step.names[0]!)?.options ?? []).map((option) => (
                    <Choice
                      key={option}
                      label={CHOICE_LABELS[option] ?? option}
                      on={values[step.names[0]!] === option}
                      onClick={() => onChange({ ...values, [step.names[0]!]: option })}
                    />
                  ))
                : step.names.map((n) => (
                    <Choice
                      key={n}
                      label={capitalize((SPEC.get(n)?.label ?? n).replace(/^Add-on: /, '').replace(/^Phone is an? /, ''))}
                      on={values[n] === true}
                      onClick={() => onChange({ ...values, [n]: values[n] !== true })}
                    />
                  ))}
            </div>
          ) : spec?.kind === 'notes' ? (
            <Textarea autoFocus rows={4} value={value} onChange={(e) => set(e.target.value)} />
          ) : (
            <Input
              autoFocus
              value={value}
              onChange={(e) =>
                set(spec?.kind === 'year' ? e.target.value.replace(/\D/g, '').slice(0, 2) : e.target.value)
              }
              {...inputProps}
            />
          )}
          <div className="mt-4 flex justify-between gap-2">
            <Button type="button" variant="secondary" disabled={!previousStep} onClick={() => onMove(nameOf(previousStep))}>
              Back
            </Button>
            <Button type="submit">{nextStep ? 'Next' : 'Done'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Choice({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-3 text-left text-sm',
        on ? 'border-primary/60 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent',
      )}
    >
      <span
        className={cn(
          'grid size-5 place-items-center rounded border text-xs',
          on ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
        )}
      >
        {on ? '✓' : ''}
      </span>
      {label}
    </button>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
