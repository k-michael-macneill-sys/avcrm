import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { OperatorDocument, PublicUser } from '../../../src/types/models';
import { ConfirmDelete } from '@/components/ConfirmDelete';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Disclosure } from '@/components/Disclosure';
import { DataFormFields, useDataForm } from '@/components/DataForm';
import { Field, FieldList, Loading, ErrorNotice } from '@/components/Misc';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/auth/AuthContext';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';
import * as api from '@/lib/api';
import { openFile, uploadBlob } from '@/lib/upload';
import { date, stamp } from '@/lib/format';

interface ComplianceItem {
  requirement_code: string;
  label: string;
  is_required: boolean;
  expires: boolean;
  status: string;
  expires_on: string | null;
  document_id: string | null;
}

interface Compliance {
  user_id: string;
  onboarding_status: string;
  assignable: boolean;
  missing_required: string[];
  items: ComplianceItem[];
}

export function OperatorDetail(): JSX.Element {
  const { id = '' } = useParams();
  const { isCorporate, user } = useAuth();
  const navigate = useNavigate();
  const [fileError, setFileError] = React.useState('');

  const { data, loading, error, reload } = useQuery(
    () =>
      Promise.all([
        api.get<Compliance>(`/operators/${id}/compliance`),
        api.get<OperatorDocument[]>(`/operators/${id}/documents`),
        api.get<PublicUser[]>('/operators'),
      ]),
    [id],
  );

  const { run, pending } = useSubmit(reload);

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [compliance, documents, operators] = data;
  const operator = operators.find((o) => o.id === id);

  return (
    <>
      <PageHeader
        title={operator ? `${operator.first_name} ${operator.last_name}` : 'Operator'}
        subtitle={operator?.email}
        actions={
          isCorporate && operator && operator.id !== user?.id ? (
            <ConfirmDelete
              what={`${operator.first_name} ${operator.last_name}'s account`}
              consequences="They can no longer sign in, and their documents are deleted. Visits assigned to them go back to unassigned."
              onConfirm={() => api.del(`/users/${operator.id}`)}
              onDeleted={() => navigate('/operators')}
            />
          ) : undefined
        }
      />

      <Section title="Compliance" className="mb-4">
        <FieldList>
          <Field label="Onboarding">
            <StatusPill status={compliance.onboarding_status} />
          </Field>
          <Field label="Assignable">{compliance.assignable ? 'Yes' : 'No'}</Field>
          <Field label="Missing required">
            {compliance.missing_required.length === 0 ? 'nothing outstanding' : compliance.missing_required.join(', ')}
          </Field>
        </FieldList>
      </Section>

      <Section title="Requirements" className="mb-4">
        <DataTable
          rowKey={(row) => row.requirement_code}
          rows={compliance.items}
          emptyMessage="No requirements apply to this branch."
          columns={[
            { header: 'Document', cell: (row) => row.label },
            { header: 'Required', cell: (row) => (row.is_required ? 'Required' : 'Optional') },
            { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
            { header: 'Expires', cell: (row) => date(row.expires_on) },
          ]}
        />
      </Section>

      <Section title="Documents on file">
        {fileError ? <ErrorNotice message={fileError} /> : null}
        <DataTable
          rowKey={(row) => row.id}
          rows={documents}
          emptyMessage="Nothing submitted yet."
          columns={[
            { header: 'Requirement', cell: (row) => row.requirement_code },
            {
              header: 'File',
              cell: (row) => (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => {
                    openFile(row.file_url, row.file_name).catch(() => setFileError('That file is not in storage'));
                  }}
                >
                  {row.file_name}
                </button>
              ),
            },
            { header: 'Issued', cell: (row) => date(row.issued_on) },
            { header: 'Expires', cell: (row) => date(row.expires_on) },
            { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
            { header: 'Reviewed', cell: (row) => stamp(row.reviewed_at) },
            {
              header: '',
              cell: (row) =>
                isCorporate && row.status === 'submitted' ? (
                  <div className="flex gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={pending}
                      onClick={() => run(() => api.patch(`/operators/documents/${row.id}/review`, { status: 'approved' }))}
                    >
                      Approve
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={pending}
                      onClick={() =>
                        run(() =>
                          api.patch(`/operators/documents/${row.id}/review`, {
                            status: 'rejected',
                            rejection_reason: 'Rejected from the crew screen',
                          }),
                        )
                      }
                    >
                      Reject
                    </Button>
                  </div>
                ) : (
                  row.rejection_reason
                ),
            },
          ]}
        />
        <UploadPanel operatorId={id} compliance={compliance} onDone={reload} />
      </Section>
    </>
  );
}

function UploadPanel({
  operatorId,
  compliance,
  onDone,
}: {
  operatorId: string;
  compliance: Compliance;
  onDone: () => void;
}): JSX.Element {
  const outstanding = compliance.items.filter((item) => item.status === 'missing');
  const [file, setFile] = React.useState<File | null>(null);
  const specs = [
    {
      name: 'requirement_code',
      label: 'Requirement',
      type: 'select' as const,
      options: outstanding.map((item) => ({ value: item.requirement_code, label: item.label })),
    },
    { name: 'issued_on', label: 'Issued on', type: 'date' as const },
  ];
  const { values, setValue } = useDataForm(specs);
  const { run, pending, error } = useSubmit(onDone);

  if (outstanding.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">Every requirement has a document.</p>;
  }

  return (
    <Disclosure label="Record a document">
      <div className="rounded-xl border border-border bg-card/40 p-4">
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Document
        </p>
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          capture="environment"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mb-1 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground"
        />
        <p className="mb-3 text-xs text-muted-foreground">{file ? file.name : 'PDF or a photo of the document, up to 10 MB'}</p>
        <DataFormFields specs={specs} values={values} setValue={setValue} />
        {error ? <ErrorNotice message={error} /> : null}
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            run(async () => {
              if (!file) throw new api.ApiError(400, 'bad_request', 'Choose a file first', []);
              const key = await uploadBlob('operator_document', file, file.name);
              await api.post(`/operators/${operatorId}/documents`, {
                requirement_code: values.requirement_code,
                file_url: key,
                file_name: file.name,
                mime_type: file.type,
                file_size: file.size,
                issued_on: values.issued_on || null,
              });
            })
          }
        >
          {pending ? 'Working…' : 'Upload it'}
        </Button>
      </div>
    </Disclosure>
  );
}
