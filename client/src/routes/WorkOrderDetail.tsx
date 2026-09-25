import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Property, ServicePhoto, WorkOrder } from '../../../src/types/models';
import { useAuth } from '@/auth/AuthContext';
import { ConfirmDelete } from '@/components/ConfirmDelete';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Disclosure } from '@/components/Disclosure';
import { DownloadButton, FileImage } from '@/components/FileWidgets';
import { DataFormFields, useDataForm } from '@/components/DataForm';
import { Field, FieldList, Loading, ErrorNotice } from '@/components/Misc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';
import * as api from '@/lib/api';
import { uploadBlob } from '@/lib/upload';
import { relative, stamp } from '@/lib/format';

interface WorkOrderDetailModel extends WorkOrder {
  photos: ServicePhoto[];
}

/** Mirrors the service's transition table, so the buttons match the rules. */
const NEXT: Record<string, string[]> = {
  scheduled: ['en_route', 'in_progress', 'skipped'],
  en_route: ['in_progress', 'skipped'],
  in_progress: ['completed', 'skipped'],
  completed: [],
  skipped: [],
};

const ACTION_LABEL: Record<string, string> = {
  en_route: 'On the way',
  in_progress: 'Start work',
  completed: 'Mark complete',
  skipped: 'Skip this visit',
};

export function WorkOrderDetail(): JSX.Element {
  const { id = '' } = useParams();
  const { isCorporate } = useAuth();
  const navigate = useNavigate();
  const [skipReason, setSkipReason] = React.useState('');

  const { data, loading, error, reload } = useQuery(async () => {
    const visit = await api.get<WorkOrderDetailModel>(`/work-orders/${id}`);
    const property = await api.get<Property>(`/properties/${visit.property_id}`);
    return { visit, property };
  }, [id]);

  const { run, pending, error: actionError } = useSubmit(reload);

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const { visit, property } = data;
  const moves = NEXT[visit.status] ?? [];
  const isOpen = moves.length > 0;
  const before = visit.photos.filter((p) => p.photo_type === 'before').length;
  const after = visit.photos.filter((p) => p.photo_type === 'after').length;

  return (
    <>
      <PageHeader
        title={`${visit.service_type.replace(/_/g, ' ')} at ${property.address_line1}`}
        subtitle={`${property.city}, ${property.province} — ${relative(visit.scheduled_for)}`}
        actions={
          isCorporate ? (
            <ConfirmDelete
              what="this visit"
              consequences="Its photos and any review request sent after it are deleted too."
              onConfirm={() => api.del(`/work-orders/${visit.id}`)}
              onDeleted={() => navigate('/work-orders')}
            />
          ) : undefined
        }
      />

      <Section title="Visit" className="mb-4">
        <FieldList>
          <Field label="Status">
            <StatusPill status={visit.status} />
          </Field>
          <Field label="Scheduled">{stamp(visit.scheduled_for)}</Field>
          <Field label="Started">{stamp(visit.started_at)}</Field>
          <Field label="Completed">{stamp(visit.completed_at)}</Field>
          <Field label="Contract">
            <Link className="text-primary hover:underline" to={`/contracts/${visit.contract_id}`}>
              View the contract
            </Link>
          </Field>
          <Field label="Access notes">{property.access_notes ?? 'none'}</Field>
        </FieldList>

        {visit.skip_reason ? (
          <p className="mt-3 rounded-lg bg-accent/40 px-3 py-2 text-sm text-secondary-foreground">
            Skipped: {visit.skip_reason}
          </p>
        ) : null}
        {visit.operator_notes ? (
          <p className="mt-3 rounded-lg bg-accent/40 px-3 py-2 text-sm text-secondary-foreground">
            {visit.operator_notes}
          </p>
        ) : null}
        {actionError ? <ErrorNotice message={actionError} /> : null}

        {visit.status === 'completed' || visit.status === 'skipped' ? (
          <div className="mt-3">
            <DownloadButton
              path={`/work-orders/${id}/report.pdf`}
              fileName={`service-report-${id.slice(0, 8)}.pdf`}
              label="Download the service report"
            />
          </div>
        ) : null}

        {isOpen ? (
          <div className="mt-3">
            <p className="mb-2 text-sm text-secondary-foreground">
              {before > 0 && after > 0
                ? 'Before and after photos are on file — this visit can be completed.'
                : `Completing needs a before and an after photo. On file: ${before} before, ${after} after.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {moves
                .filter((next) => next !== 'skipped')
                .map((next) => (
                  <Button
                    key={next}
                    type="button"
                    variant={next === 'completed' ? 'default' : 'secondary'}
                    disabled={pending}
                    onClick={() => run(() => api.patch(`/work-orders/${id}/status`, { status: next }))}
                  >
                    {ACTION_LABEL[next] ?? next}
                  </Button>
                ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input
                className="max-w-xs"
                value={skipReason}
                onChange={(e) => setSkipReason(e.target.value)}
                placeholder="Why it was skipped"
              />
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  run(() =>
                    api.patch(`/work-orders/${id}/status`, {
                      status: 'skipped',
                      skip_reason: skipReason.trim() || null,
                    }),
                  )
                }
              >
                Skip this visit
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            A {visit.status} visit is a record, not a draft.
          </p>
        )}
      </Section>

      <Section title="Photos">
        <DataTable
          rowKey={(row) => row.id}
          rows={visit.photos}
          emptyMessage="No photos on this visit yet."
          columns={[
            { header: 'Type', cell: (row) => <StatusPill status={row.photo_type} /> },
            {
              header: 'Photo',
              cell: (row) => (
                <FileImage
                  fileKey={row.file_url}
                  alt={`${row.photo_type} photo`}
                  className="block size-24 rounded-md border border-border bg-accent/40 object-cover"
                />
              ),
            },
            { header: 'Taken', cell: (row) => stamp(row.taken_at) },
            {
              header: 'Geotag',
              cell: (row) => (row.latitude && row.longitude ? `${row.latitude}, ${row.longitude}` : '—'),
            },
          ]}
        />
        {isOpen ? (
          <Disclosure label="Add photo">
            <PhotoForm workOrderId={id} property={property} onDone={reload} />
          </Disclosure>
        ) : null}
      </Section>
    </>
  );
}

function PhotoForm({
  workOrderId,
  property,
  onDone,
}: {
  workOrderId: string;
  property: Property;
  onDone: () => void;
}): JSX.Element {
  const [file, setFile] = React.useState<File | null>(null);
  const specs = [
    {
      name: 'photo_type',
      label: 'Type',
      type: 'select' as const,
      options: [
        { value: 'before', label: 'before' },
        { value: 'after', label: 'after' },
        { value: 'issue', label: 'issue' },
      ],
    },
    {
      name: 'taken_at',
      label: 'Taken at (EXIF)',
      type: 'datetime-local' as const,
      value: new Date(Date.now() - 60_000).toISOString().slice(0, 16),
    },
    { name: 'latitude', label: 'Latitude', value: property.latitude ?? '', placeholder: 'from the photo' },
    { name: 'longitude', label: 'Longitude', value: property.longitude ?? '' },
  ];
  const { values, setValue } = useDataForm(specs);
  const { run, pending, error } = useSubmit(onDone);

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Photo
      </p>
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="mb-3 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground"
      />
      <p className="mb-3 -mt-2 text-xs text-muted-foreground">
        {file ? `${file.name}` : 'JPEG, PNG or WebP, up to 12 MB'}
      </p>
      <DataFormFields specs={specs} values={values} setValue={setValue} />
      {error ? <ErrorNotice message={error} /> : null}
      <Button
        type="button"
        disabled={pending}
        onClick={() =>
          run(async () => {
            if (!file) throw new api.ApiError(400, 'bad_request', 'Choose a photo first', []);
            const key = await uploadBlob('service_photo', file, file.name);
            await api.post<ServicePhoto>(`/work-orders/${workOrderId}/photos`, {
              photo_type: values.photo_type,
              file_url: key,
              taken_at: new Date(values.taken_at ?? '').toISOString(),
              latitude: values.latitude ? Number(values.latitude) : null,
              longitude: values.longitude ? Number(values.longitude) : null,
            });
          })
        }
      >
        {pending ? 'Working…' : 'Attach photo'}
      </Button>
    </div>
  );
}
