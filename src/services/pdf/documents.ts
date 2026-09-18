import {
  CONTENT_WIDTH,
  heading,
  keepTogether,
  letterhead,
  newDocument,
  paginate,
  pairs,
  paragraph,
  PAGE_MARGIN,
  rule,
  table,
  toBuffer,
  total,
  type Doc,
} from './layout';

/**
 * The two documents this company hands to a customer: what they owe, and what
 * was done at their property.
 *
 * Both take plain data rather than reaching for the database, so a document is
 * a function of its input and can be rendered in a test without a server.
 */

/** Money arrives as a string from numeric columns and stays one. */
function money(amount: string): string {
  return `$${Number(amount).toFixed(2)}`;
}

function day(value: string | Date | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(`${value}T00:00:00Z`) : value;
  return date.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function moment(value: Date | null): string {
  if (!value) return '—';
  return `${day(value)}, ${value.toLocaleTimeString('en-CA', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;
}

const titleCase = (value: string): string =>
  value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export interface InvoiceDocument {
  invoice: {
    id: string;
    billing_period_start: string;
    billing_period_end: string;
    amount_due: string;
    amount_paid: string;
    status: string;
    due_date: string;
    sent_at: Date | null;
  };
  customer: { first_name: string; last_name: string; email: string | null; phone: string | null };
  property: {
    address_line1: string;
    address_line2: string | null;
    city: string;
    province: string;
    postal_code: string;
  };
  branch: { name: string };
  contract: { billing_type: string; terms_version: string };
  payments: {
    processed_at: Date | null;
    method: string;
    status: string;
    amount: string;
    failure_reason: string | null;
  }[];
}

export async function renderInvoice(input: InvoiceDocument): Promise<Buffer> {
  const doc = newDocument(`Invoice ${reference(input.invoice.id)}`, 'Snow and ice removal');
  const { invoice, property } = input;

  letterhead(doc, input.branch.name, 'Invoice');

  pairs(doc, [
    { label: 'Invoice', value: reference(invoice.id) },
    { label: 'Billed to', value: `${input.customer.first_name} ${input.customer.last_name}` },
    {
      label: 'Service address',
      value: [
        property.address_line1,
        property.address_line2,
        `${property.city}, ${property.province} ${property.postal_code}`,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    { label: 'Issued', value: day(invoice.sent_at) },
    { label: 'Due', value: day(invoice.due_date) },
    { label: 'Status', value: titleCase(invoice.status) },
  ], 3);

  rule(doc);
  heading(doc, 'What this covers');
  table(
    doc,
    [
      { header: 'Description', width: CONTENT_WIDTH - 120, cell: (row: { text: string }) => row.text },
      {
        header: 'Amount',
        width: 120,
        numeric: true,
        cell: (row: { amount: string }) => row.amount,
      },
    ],
    [
      {
        text:
          `Snow and ice removal, ${titleCase(input.contract.billing_type)} contract\n`
          + `${day(invoice.billing_period_start)} to ${day(invoice.billing_period_end)}`,
        amount: money(invoice.amount_due),
      },
    ],
    'Nothing billed.',
  );

  const outstanding = (Number(invoice.amount_due) - Number(invoice.amount_paid)).toFixed(2);
  total(doc, 'Total due', money(invoice.amount_due));
  // Only worth breaking out once something has been paid: on an untouched
  // invoice the balance is the total, and saying it twice reads as an error.
  if (Number(invoice.amount_paid) > 0) {
    total(doc, 'Paid to date', `-${money(invoice.amount_paid)}`);
    total(doc, Number(outstanding) > 0 ? 'Balance owing' : 'Paid in full', money(outstanding));
  }

  // Only the payments that actually moved money. A failed attempt belongs in
  // the office's record, not on the customer's copy of the bill.
  const settled = input.payments.filter((p) => p.status !== 'failed');
  if (settled.length) {
    doc.y += 10;
    heading(doc, 'Payments received');
    table(
      doc,
      [
        { header: 'Date', width: 130, cell: (row) => day(row.processed_at) },
        { header: 'Method', width: 140, cell: (row) => titleCase(row.method) },
        { header: 'Status', width: 110, cell: (row) => titleCase(row.status) },
        { header: 'Amount', width: CONTENT_WIDTH - 380, numeric: true, cell: (row) => money(row.amount) },
      ],
      settled,
      'None yet.',
    );
  }

  doc.y += 12;
  paragraph(
    doc,
    Number(outstanding) > 0
      ? `Payment is due ${day(invoice.due_date)}. If a card is on file for this `
        + 'contract it will be charged automatically; there is nothing to do.'
      : 'This invoice is settled. Thank you.',
    true,
  );

  paginate(doc, `Invoice ${reference(invoice.id)} — ${input.branch.name}`);
  return toBuffer(doc);
}

export interface ServiceReportDocument {
  workOrder: {
    id: string;
    service_type: string;
    status: string;
    scheduled_for: Date;
    started_at: Date | null;
    completed_at: Date | null;
    operator_notes: string | null;
    skip_reason: string | null;
  };
  customer: { first_name: string; last_name: string };
  property: {
    address_line1: string;
    address_line2: string | null;
    city: string;
    province: string;
    postal_code: string;
    priority_flag: boolean;
    access_notes: string | null;
  };
  branch: { name: string };
  operator: { first_name: string; last_name: string } | null;
  photos: {
    photo_type: string;
    taken_at: Date;
    latitude: string | null;
    longitude: string | null;
    /** Decoded bytes, or null when the image could not be read or embedded. */
    image: Buffer | null;
  }[];
}

export async function renderServiceReport(input: ServiceReportDocument): Promise<Buffer> {
  const doc = newDocument(`Service report ${reference(input.workOrder.id)}`, 'Service record');
  const { workOrder, property } = input;

  letterhead(doc, input.branch.name, 'Service report');

  pairs(doc, [
    { label: 'Report', value: reference(workOrder.id) },
    { label: 'Customer', value: `${input.customer.first_name} ${input.customer.last_name}` },
    {
      label: 'Property',
      value: [
        property.address_line1,
        property.address_line2,
        `${property.city}, ${property.province} ${property.postal_code}`,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    { label: 'Service', value: titleCase(workOrder.service_type) },
    { label: 'Status', value: titleCase(workOrder.status) },
    {
      label: 'Operator',
      value: input.operator
        ? `${input.operator.first_name} ${input.operator.last_name}`
        : 'Unassigned',
    },
  ], 3);

  rule(doc);
  heading(doc, 'Timing');
  pairs(doc, [
    { label: 'Scheduled', value: moment(workOrder.scheduled_for) },
    { label: 'Started', value: moment(workOrder.started_at) },
    { label: 'Completed', value: moment(workOrder.completed_at) },
  ], 3);

  if (property.priority_flag) {
    paragraph(doc, 'Priority property — cleared ahead of the standard route.');
  }
  if (property.access_notes) {
    heading(doc, 'Access notes');
    paragraph(doc, property.access_notes);
  }

  if (workOrder.skip_reason) {
    heading(doc, 'Why this visit was skipped');
    paragraph(doc, workOrder.skip_reason);
  }

  if (workOrder.operator_notes) {
    heading(doc, 'Operator notes');
    paragraph(doc, workOrder.operator_notes);
  }

  doc.y += 6;
  heading(doc, 'Photographs');
  if (!input.photos.length) {
    paragraph(doc, 'No photos were taken on this visit.', true);
  }

  for (const photo of input.photos) {
    // Caption and image together: a before photo landing under an "after"
    // heading on the next page would misrepresent the work.
    keepTogether(doc, 230);
    doc.font('Helvetica-Bold').fontSize(9.5).text(
      `${titleCase(photo.photo_type)} — ${moment(photo.taken_at)}`,
      PAGE_MARGIN,
      doc.y,
    );
    if (photo.latitude && photo.longitude) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#6b6b6b')
        .text(`${photo.latitude}, ${photo.longitude}`, PAGE_MARGIN, doc.y + 1);
      doc.fillColor('#1a1a1a');
    }
    doc.y += 6;

    if (photo.image) {
      // Left, so the image lines up under the caption that names it.
      doc.image(photo.image, PAGE_MARGIN, doc.y, { fit: [CONTENT_WIDTH, 200] });
      doc.y += 208;
    } else {
      // A photo the renderer cannot embed is said out loud rather than
      // silently dropped — the report is a record, and a gap in it matters.
      paragraph(doc, 'This photo could not be included in the PDF.', true);
    }
  }

  paginate(doc, `Service report ${reference(workOrder.id)} — ${input.branch.name}`);
  return toBuffer(doc);
}

/** The short form of a uuid people can read over the phone. */
export function reference(id: string): string {
  return id.slice(0, 8).toUpperCase();
}
