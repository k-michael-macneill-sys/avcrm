import * as api from '../api.js';
import { pageHeader } from '../components.js';
import { field, fieldList, fragment, h, link, section, table } from '../dom.js';
import { buildForm, disclosure, errorLine, submitter } from '../form.js';
import { date, statusPill, stamp } from '../format.js';
import * as router from '../router.js';
import type { OperatorDocument, PublicUser } from '../../src/types/models.js';

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

export async function renderOperators(root: HTMLElement): Promise<void> {
  const operators = await api.get<PublicUser[]>('/operators');

  root.appendChild(
    fragment(
      pageHeader('Crew', `${operators.length} operators`),
      table<PublicUser>(
        [
          {
            header: 'Name',
            cell: (row) => link(`/operators/${row.id}`, `${row.first_name} ${row.last_name}`),
          },
          { header: 'Email', cell: (row) => row.email },
          { header: 'Phone', cell: (row) => row.phone ?? '—' },
          { header: 'Onboarding', cell: (row) => statusPill(row.onboarding_status) },
          {
            header: 'Assignable',
            cell: (row) =>
              row.is_active && row.onboarding_status === 'approved' ? 'Yes' : 'No',
          },
        ],
        operators,
        'No operators in scope.',
      ),
    ),
  );
}

export async function renderOperator(root: HTMLElement, params: string[]): Promise<void> {
  const id = params[0] ?? '';
  const [compliance, documents, operators] = await Promise.all([
    api.get<Compliance>(`/operators/${id}/compliance`),
    api.get<OperatorDocument[]>(`/operators/${id}/documents`),
    api.get<PublicUser[]>('/operators'),
  ]);

  const operator = operators.find((o) => o.id === id);
  const error = errorLine();
  const run = submitter(error, () => router.render());

  root.appendChild(
    fragment(
      pageHeader(
        operator ? `${operator.first_name} ${operator.last_name}` : 'Operator',
        operator?.email,
      ),
      section(
        'Compliance',
        fieldList(
          field('Onboarding', statusPill(compliance.onboarding_status)),
          field('Assignable', compliance.assignable ? 'Yes' : 'No'),
          field(
            'Missing required',
            compliance.missing_required.length === 0
              ? 'nothing outstanding'
              : compliance.missing_required.join(', '),
          ),
        ),
      ),
      section(
        'Requirements',
        table<ComplianceItem>(
          [
            { header: 'Document', cell: (row) => row.label },
            {
              header: 'Required',
              cell: (row) => (row.is_required ? 'Required' : 'Optional'),
            },
            { header: 'Status', cell: (row) => statusPill(row.status) },
            { header: 'Expires', cell: (row) => date(row.expires_on) },
          ],
          compliance.items,
          'No requirements apply to this branch.',
        ),
      ),
      section(
        'Documents on file',
        error,
        table<OperatorDocument>(
          [
            { header: 'Requirement', cell: (row) => row.requirement_code },
            { header: 'File', cell: (row) => row.file_name },
            { header: 'Issued', cell: (row) => date(row.issued_on) },
            { header: 'Expires', cell: (row) => date(row.expires_on) },
            { header: 'Status', cell: (row) => statusPill(row.status) },
            { header: 'Reviewed', cell: (row) => stamp(row.reviewed_at) },
            {
              header: '',
              cell: (row) =>
                api.isCorporate() && row.status === 'submitted'
                  ? h(
                      'div',
                      { class: 'row-actions' },
                      run(
                        'Approve',
                        () =>
                          api.patch(`/operators/documents/${row.id}/review`, {
                            status: 'approved',
                          }),
                        'primary',
                      ),
                      run(
                        'Reject',
                        () =>
                          api.patch(`/operators/documents/${row.id}/review`, {
                            status: 'rejected',
                            rejection_reason: 'Rejected from the crew screen',
                          }),
                        'danger',
                      ),
                    )
                  : row.rejection_reason,
            },
          ],
          documents,
          'Nothing submitted yet.',
        ),
        uploadPanel(id, compliance),
      ),
    ),
  );
}

function uploadPanel(operatorId: string, compliance: Compliance): HTMLElement {
  const outstanding = compliance.items.filter((item) => item.status === 'missing');
  if (outstanding.length === 0) return h('p', { class: 'empty' }, 'Every requirement has a document.');

  return disclosure('Record a document', () => {
    const error = errorLine();
    const form = buildForm([
      {
        name: 'requirement_code',
        label: 'Requirement',
        type: 'select',
        options: outstanding.map((item) => ({
          value: item.requirement_code,
          label: item.label,
        })),
      },
      {
        name: 'file_url',
        label: 'File key',
        value: `private/operator-docs/${operatorId}/${Date.now()}.pdf`,
        required: true,
      },
      { name: 'file_name', label: 'File name', value: 'document.pdf', required: true },
      { name: 'issued_on', label: 'Issued on', type: 'date' },
    ]);

    const run = submitter(error, () => router.render());

    return h(
      'div',
      { class: 'card' },
      form.node,
      error,
      h(
        'div',
        { class: 'actions' },
        run(
          'Record it',
          async () => {
            const values = form.values();
            await api.post(`/operators/${operatorId}/documents`, {
              requirement_code: values.requirement_code,
              file_url: values.file_url,
              file_name: values.file_name,
              mime_type: 'application/pdf',
              file_size: 102_400,
              issued_on: values.issued_on || null,
            });
          },
          'primary',
        ),
      ),
    );
  });
}
