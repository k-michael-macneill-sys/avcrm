import * as api from '../api.js';
import { filterBar, labelled, pageHeader, select } from '../components.js';
import { field, fieldList, fragment, h, link, section, table } from '../dom.js';
import { buildForm, disclosure, errorLine, submitter } from '../form.js';
import { relative, statusPill, stamp } from '../format.js';
import * as router from '../router.js';
import { fileImage, filePicker, uploadBlob } from '../upload.js';
import { SERVICE_TYPES, WORK_ORDER_STATUSES } from '../../src/types/models.js';
import type {
  Contract,
  Property,
  PublicUser,
  ServicePhoto,
  WorkOrder,
} from '../../src/types/models.js';

interface WorkOrderDetail extends WorkOrder {
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

export async function renderWorkOrders(root: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  const status = query.get('status') ?? '';
  const mine = query.get('mine') === 'true';
  const user = api.currentUser();

  const visits = await api.list<WorkOrder>('/work-orders', {
    status,
    assigned_user_id: mine && user ? user.id : undefined,
    page_size: 100,
  });

  const operators = api.isCorporate()
    ? await api.get<PublicUser[]>('/operators')
    : [];
  const operatorName = (id: string | null) => {
    if (!id) return 'Unassigned';
    const found = operators.find((o) => o.id === id);
    return found ? `${found.first_name} ${found.last_name}` : 'Assigned';
  };

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.navigate(`/work-orders${qs ? `?${qs}` : ''}`, true);
  };

  root.appendChild(
    fragment(
      pageHeader(
        'Dispatch',
        `${visits.meta.total} visits on the board`,
        api.isCorporate() ? await newVisitPanel() : null,
      ),
      filterBar(
        labelled(
          'Status',
          select(
            [
              { value: '', label: 'Any status' },
              ...WORK_ORDER_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
            ],
            status,
            (value) => setParam('status', value),
          ),
        ),
        labelled(
          'Whose',
          select(
            [
              { value: '', label: 'Everyone' },
              { value: 'true', label: 'Mine' },
            ],
            mine ? 'true' : '',
            (value) => setParam('mine', value),
          ),
        ),
      ),
      table<WorkOrder>(
        [
          {
            header: 'When',
            cell: (row) => link(`/work-orders/${row.id}`, stamp(row.scheduled_for)),
          },
          { header: 'Due', cell: (row) => relative(row.scheduled_for) },
          { header: 'Service', cell: (row) => row.service_type.replace(/_/g, ' ') },
          {
            header: 'Operator',
            cell: (row) =>
              api.isCorporate() ? operatorName(row.assigned_user_id) : '—',
          },
          { header: 'Status', cell: (row) => statusPill(row.status) },
        ],
        visits.data,
        'Nothing on the board for those filters.',
      ),
    ),
  );
}

async function newVisitPanel(): Promise<HTMLElement> {
  const [contracts, operators] = await Promise.all([
    api.list<Contract>('/contracts', { status: 'active', page_size: 100 }),
    api.get<PublicUser[]>('/operators', { assignable: true }),
  ]);

  // The address is what a dispatcher recognises, not a contract id.
  const properties = await Promise.all(
    contracts.data.map((contract) =>
      api.get<Property>(`/properties/${contract.property_id}`),
    ),
  );

  return disclosure('New visit', () => {
    const error = errorLine();
    const form = buildForm([
      {
        name: 'contract_id',
        label: 'Property',
        type: 'select',
        options: contracts.data.map((contract, index) => ({
          value: contract.id,
          label: properties[index]?.address_line1 ?? contract.id,
        })),
      },
      {
        name: 'assigned_user_id',
        label: 'Operator',
        type: 'select',
        options: [
          { value: '', label: 'Unassigned' },
          ...operators.map((o) => ({
            value: o.id,
            label: `${o.first_name} ${o.last_name}`,
          })),
        ],
      },
      {
        name: 'service_type',
        label: 'Service',
        type: 'select',
        options: SERVICE_TYPES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
      },
      {
        name: 'scheduled_for',
        label: 'Scheduled for',
        type: 'datetime-local',
        value: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16),
      },
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
          'Book it',
          async () => {
            const values = form.values();
            await api.post<WorkOrder>('/work-orders', {
              contract_id: values.contract_id,
              assigned_user_id: values.assigned_user_id || null,
              service_type: values.service_type,
              scheduled_for: new Date(values.scheduled_for ?? '').toISOString(),
            });
          },
          'primary',
        ),
      ),
    );
  });
}

export async function renderWorkOrder(root: HTMLElement, params: string[]): Promise<void> {
  const id = params[0] ?? '';
  const visit = await api.get<WorkOrderDetail>(`/work-orders/${id}`);
  const property = await api.get<Property>(`/properties/${visit.property_id}`);

  const error = errorLine();
  const run = submitter(error, () => router.render());
  const moves = NEXT[visit.status] ?? [];
  const isOpen = moves.length > 0;

  const before = visit.photos.filter((p) => p.photo_type === 'before').length;
  const after = visit.photos.filter((p) => p.photo_type === 'after').length;

  const skipReason = h('input', {
    type: 'text',
    placeholder: 'Why it was skipped',
    class: 'skip-reason',
  });

  root.appendChild(
    fragment(
      pageHeader(
        `${visit.service_type.replace(/_/g, ' ')} at ${property.address_line1}`,
        `${property.city}, ${property.province} — ${relative(visit.scheduled_for)}`,
      ),
      section(
        'Visit',
        fieldList(
          field('Status', statusPill(visit.status)),
          field('Scheduled', stamp(visit.scheduled_for)),
          field('Started', stamp(visit.started_at)),
          field('Completed', stamp(visit.completed_at)),
          field('Contract', link(`/contracts/${visit.contract_id}`, 'View the contract')),
          field('Access notes', property.access_notes ?? 'none'),
        ),
        visit.skip_reason
          ? h('p', { class: 'notes' }, `Skipped: ${visit.skip_reason}`)
          : null,
        visit.operator_notes ? h('p', { class: 'notes' }, visit.operator_notes) : null,
        error,
        isOpen
          ? h(
              'div',
              {},
              h(
                'p',
                { class: 'gate-note' },
                before > 0 && after > 0
                  ? 'Before and after photos are on file — this visit can be completed.'
                  : `Completing needs a before and an after photo. On file: ${before} before, ${after} after.`,
              ),
              h(
                'div',
                { class: 'actions' },
                ...moves
                  .filter((next) => next !== 'skipped')
                  .map((next) =>
                    run(
                      ACTION_LABEL[next] ?? next,
                      () => api.patch(`/work-orders/${id}/status`, { status: next }),
                      next === 'completed' ? 'primary' : 'secondary',
                    ),
                  ),
              ),
              h(
                'div',
                { class: 'actions' },
                skipReason,
                run(
                  'Skip this visit',
                  () =>
                    api.patch(`/work-orders/${id}/status`, {
                      status: 'skipped',
                      skip_reason: skipReason.value.trim() || null,
                    }),
                  'danger',
                ),
              ),
            )
          : h('p', { class: 'empty' }, `A ${visit.status} visit is a record, not a draft.`),
      ),
      section(
        'Photos',
        table<ServicePhoto>(
          [
            { header: 'Type', cell: (row) => statusPill(row.photo_type) },
            {
              header: 'Photo',
              cell: (row) => fileImage(row.file_url, `${row.photo_type} photo`, 'thumb'),
            },
            { header: 'Taken', cell: (row) => stamp(row.taken_at) },
            {
              header: 'Geotag',
              cell: (row) =>
                row.latitude && row.longitude ? `${row.latitude}, ${row.longitude}` : '—',
            },
          ],
          visit.photos,
          'No photos on this visit yet.',
        ),
        isOpen ? photoPanel(id, property) : null,
      ),
    ),
  );
}

function photoPanel(workOrderId: string, property: Property): HTMLElement {
  return disclosure('Add photo', () => {
    const error = errorLine();
    const picker = filePicker({
      accept: 'image/jpeg,image/png,image/webp',
      capture: true,
      note: 'JPEG, PNG or WebP, up to 12 MB',
    });
    const form = buildForm([
      {
        name: 'photo_type',
        label: 'Type',
        type: 'select',
        options: [
          { value: 'before', label: 'before' },
          { value: 'after', label: 'after' },
          { value: 'issue', label: 'issue' },
        ],
      },
      {
        name: 'taken_at',
        label: 'Taken at (EXIF)',
        type: 'datetime-local',
        value: new Date(Date.now() - 60_000).toISOString().slice(0, 16),
      },
      {
        name: 'latitude',
        label: 'Latitude',
        value: property.latitude ?? '',
        placeholder: 'from the photo',
      },
      { name: 'longitude', label: 'Longitude', value: property.longitude ?? '' },
    ]);

    const run = submitter(error, () => router.render());

    return h(
      'div',
      { class: 'card' },
      h('p', { class: 'sig-label' }, 'Photo'),
      picker.node,
      form.node,
      error,
      h(
        'div',
        { class: 'actions' },
        run(
          'Attach photo',
          async () => {
            const values = form.values();
            const file = picker.file();
            if (!file) {
              throw new api.ApiError(400, 'bad_request', 'Choose a photo first', []);
            }
            const key = await uploadBlob('service_photo', file, file.name);

            await api.post<ServicePhoto>(`/work-orders/${workOrderId}/photos`, {
              photo_type: values.photo_type,
              file_url: key,
              taken_at: new Date(values.taken_at ?? '').toISOString(),
              latitude: values.latitude ? Number(values.latitude) : null,
              longitude: values.longitude ? Number(values.longitude) : null,
            });
          },
          'primary',
        ),
      ),
    );
  });
}
