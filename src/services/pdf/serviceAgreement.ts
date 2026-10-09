import path from 'node:path';
import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import {
  BILLING_SCHEDULE_SMALL_PRINT,
  COMPANY,
  COOLING_OFF_BANNER,
  type AgreementModel,
  type SignatureBox,
} from '../../types/serviceAgreement';
import { toBuffer } from './layout';

/**
 * The service agreement, drawn.
 *
 * Navy bars with white capitals over navy text, the way the agreement it is
 * modelled on looks. Everything printed comes from an AgreementModel, which
 * is also what the signing screen draws from, so the two show the same words
 * and the same numbers.
 *
 * pdfkit's built-in fonts, as for every other document here, so there is no
 * font to ship. Checkboxes and ticks are drawn rather than typed, because the
 * built-in fonts have no ballot box.
 */

const NAVY = '#1b2a4a';
const INK = '#1b2a4a';
const MUTED = '#5a6782';
const LINE = '#9aa6bf';
const SIGN_FILL = '#e8f1fb';

const MARGIN = 36;
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM = PAGE_HEIGHT - MARGIN - 18;
const GAP = 12;

const LOGO = path.resolve(__dirname, '..', '..', '..', 'assets', 'brand', 'drift-logo.jpg');
let logo: Buffer | null | undefined;
function logoBytes(): Buffer | null {
  if (logo === undefined) {
    try {
      logo = readFileSync(LOGO);
    } catch {
      logo = null;
    }
  }
  return logo;
}

type Doc = PDFKit.PDFDocument;

export interface AgreementSignatureImages {
  /** The customer's signature, applied to every box they signed. */
  customer?: Buffer | null;
}

export async function renderServiceAgreement(
  model: AgreementModel,
  images: AgreementSignatureImages = {},
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: `${COMPANY.name} — Service Agreement`,
      Subject: model.contract_type,
      Creator: 'Drift CRM',
    },
  });
  doc.fillColor(INK).font('Helvetica').fontSize(8.5);

  header(doc, model);

  // 1. Customer & service location | billing address
  const half = (WIDTH - GAP) / 2;
  const top = doc.y;
  const leftEnd = addressBox(doc, MARGIN, top, half, 'Customer & Service Location', model.customer);
  const rightEnd = addressBox(doc, MARGIN + half + GAP, top, half, 'Customer & Billing Address', model.billing);
  doc.y = Math.max(leftEnd, rightEnd) + GAP;

  // 2. Scope of service
  bar(doc, 'Scope of Service');
  checkGrid(
    doc,
    model.scope.map((s) => ({ label: s.label, checked: s.checked })),
    2,
  );
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(model.service_summary, MARGIN, doc.y + 2, { width: WIDTH });
  doc.moveDown(0.8);

  // 3. Additional services
  bar(doc, 'Available Additional Services');
  checkGrid(
    doc,
    model.addons.map((a) => ({ label: a.price ? `${a.label} — ${a.price}` : a.label, checked: a.checked })),
    2,
  );
  doc.moveDown(0.6);

  // 4. Billing schedule
  ensure(doc, 70);
  bar(doc, 'Billing Schedule');
  lengthLine(doc, model);
  small(doc, BILLING_SCHEDULE_SMALL_PRINT);
  doc.moveDown(0.6);

  // 5. Payment schedule grid
  ensure(doc, 90);
  bar(doc, `Payment Schedule (amounts include ${model.tax_label})`);
  scheduleGrid(doc, model);
  doc.moveDown(0.6);

  // 6. Agreement period
  ensure(doc, 70);
  bar(doc, 'Agreement Period');
  body(doc, model.wording.agreement_period);
  doc.moveDown(0.6);

  // 7. Commitment & cancellation | customer signature
  ensure(doc, 130);
  const sevenTop = doc.y;
  const leftWidth = WIDTH * 0.58;
  const rightWidth = WIDTH - leftWidth - GAP;
  bar(doc, 'Commitment & Cancellation', MARGIN, leftWidth);
  doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(model.wording.commitment, MARGIN, doc.y, { width: leftWidth });
  const leftBottom = doc.y;
  doc.y = sevenTop;
  bar(doc, 'Customer Signature', MARGIN + leftWidth + GAP, rightWidth);
  const sigBottom = signatureBox(doc, MARGIN + leftWidth + GAP, doc.y, rightWidth, model, 'commitment', images.customer);
  doc.y = Math.max(leftBottom, sigBottom) + GAP;

  // 8. Satisfaction guarantee
  ensure(doc, 70);
  bar(doc, 'Satisfaction Guarantee');
  body(doc, model.wording.guarantee);
  doc.moveDown(0.6);

  // 9. Service notifications
  ensure(doc, 70);
  bar(doc, 'Service Notifications');
  body(doc, model.wording.notifications);
  const lineY = doc.y + 4;
  filledLine(doc, MARGIN, lineY, WIDTH / 2 - 6, 'E-CARD/EMAIL:', model.notification_email ?? '');
  filledLine(doc, MARGIN + WIDTH / 2 + 6, lineY, WIDTH / 2 - 6, 'AUTOMATED VOICE/TEXT MSGS:', model.notification_phone ?? '');
  doc.y = lineY + 20;

  // 10. Service commitment and payment information
  ensure(doc, 260);
  bar(doc, 'Service Commitment and Payment Information');
  const tenTop = doc.y + 4;
  const colLeft = WIDTH * 0.55;
  const colRight = WIDTH - colLeft - GAP;
  let y = tenTop;
  for (const line of model.pricing_lines) {
    y = valueLine(doc, MARGIN, y, colLeft, line.label, line.value);
  }
  y = valueLine(doc, MARGIN, y, colLeft, `${COMPANY.name.split(' ')[0]} Rep`, model.rep_name ?? '');
  const leftSig = signatureBox(doc, MARGIN, y + 6, colLeft, model, 'service_commitment', images.customer);
  const rightBottom = cardBox(doc, MARGIN + colLeft + GAP, tenTop, colRight, model, images.customer);
  doc.y = Math.max(leftSig, rightBottom) + GAP;

  // 11. Cooling-off
  ensure(doc, 110);
  const bannerTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(12);
  const bannerHeight = doc.heightOfString(COOLING_OFF_BANNER, { width: WIDTH - 24 }) + 18;
  doc.rect(MARGIN, bannerTop, WIDTH, bannerHeight).fill(NAVY);
  doc.fillColor('#ffffff').text(COOLING_OFF_BANNER, MARGIN + 12, bannerTop + 9, { width: WIDTH - 24, align: 'center' });
  doc.y = bannerTop + bannerHeight + 6;
  small(doc, model.wording.continuation);

  // Page two: the terms.
  doc.addPage();
  bar(doc, 'Terms and Conditions');
  for (const section of model.terms) {
    ensure(doc, 40);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(section.heading, MARGIN, doc.y, { width: WIDTH });
    doc.moveDown(0.15);
    for (const paragraph of section.body) {
      doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(paragraph, MARGIN, doc.y, { width: WIDTH });
      doc.moveDown(0.25);
    }
    doc.moveDown(0.3);
  }

  if (model.status === 'signed') {
    ensure(doc, 60);
    doc.moveDown(0.5);
    bar(doc, 'Signature Record');
    const record = [
      `Signed electronically by ${model.signer_name}`,
      model.signed_at ? `at ${model.signed_at}` : null,
      model.signed_ip ? `from IP address ${model.signed_ip}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    body(doc, `${record}. Agreement reference ${model.quote_id}. This copy was locked when it was signed.`);
  }

  footer(doc, model);
  return toBuffer(doc);
}

// ── Pieces ────────────────────────────────────────────────────────────────

function header(doc: Doc, model: AgreementModel): void {
  const height = 64;
  doc.rect(MARGIN, MARGIN, WIDTH, height).fill(NAVY);
  const image = logoBytes();
  if (image) {
    doc.image(image, MARGIN + 8, MARGIN + 6, { height: height - 12 });
  } else {
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text('Drift', MARGIN + 12, MARGIN + 18);
  }
  const textX = MARGIN + 170;
  const textWidth = WIDTH - 170 - 12;
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor('#ffffff')
    .text('SNOW REMOVAL SERVICE AGREEMENT', textX, MARGIN + 10, { width: textWidth, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(8)
    .text(model.contract_type, textX, doc.y + 2, { width: textWidth, align: 'right' })
    .text(`${model.plan_label} · ${model.branch_name} · Ref ${model.quote_id.slice(0, 8).toUpperCase()}`, textX, doc.y + 1, {
      width: textWidth,
      align: 'right',
    });
  doc.y = MARGIN + height + GAP;
  doc.x = MARGIN;
}

function bar(doc: Doc, title: string, x = MARGIN, width = WIDTH): void {
  const top = doc.y;
  doc.rect(x, top, width, 15).fill(NAVY);
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor('#ffffff')
    .text(title.toUpperCase(), x + 6, top + 4, { width: width - 12, lineBreak: false });
  doc.y = top + 19;
  doc.x = x;
  doc.fillColor(INK);
}

function body(doc: Doc, text: string): void {
  doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(text, MARGIN, doc.y, { width: WIDTH });
}

function small(doc: Doc, text: string): void {
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text(text, MARGIN, doc.y, { width: WIDTH });
  doc.fillColor(INK);
}

function ensure(doc: Doc, needed: number): void {
  if (doc.y + needed > BOTTOM) {
    doc.addPage();
    doc.y = MARGIN;
  }
}

function addressBox(
  doc: Doc,
  x: number,
  top: number,
  width: number,
  title: string,
  who: AgreementModel['customer'],
): number {
  doc.y = top;
  bar(doc, title, x, width);
  let y = doc.y;
  const row = (label: string, value: string): void => {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), x + 6, y, { width: 52 });
    doc.font('Helvetica').fontSize(8.5).fillColor(INK);
    const h = doc.heightOfString(value || ' ', { width: width - 64 });
    doc.text(value || ' ', x + 58, y - 0.5, { width: width - 64 });
    y += Math.max(11, h + 2);
  };
  row('Name', who.name);
  row('Email', who.email ?? '');
  row('Phone', who.phone ?? '');
  row('Address', who.address.join('\n'));
  doc.lineWidth(0.6).rect(x, top, width, y - top + 3).stroke(NAVY);
  return y + 3;
}

function checkbox(doc: Doc, x: number, y: number, checked: boolean, size = 8): void {
  doc.lineWidth(0.8).rect(x, y, size, size).stroke(NAVY);
  if (checked) {
    doc
      .lineWidth(1.4)
      .moveTo(x + 1.6, y + size * 0.55)
      .lineTo(x + size * 0.42, y + size - 1.6)
      .lineTo(x + size - 1.2, y + 1.4)
      .stroke(NAVY);
  }
}

function checkGrid(doc: Doc, items: { label: string; checked: boolean }[], columns: number): void {
  const colWidth = WIDTH / columns;
  const rows = Math.ceil(items.length / columns);
  const top = doc.y;
  let maxY = top;
  for (let i = 0; i < items.length; i += 1) {
    // Down each column, then across, so the list reads in order.
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = MARGIN + col * colWidth;
    const y = top + row * 13;
    const item = items[i]!;
    checkbox(doc, x + 2, y + 1, item.checked);
    doc
      .font(item.checked ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(8.5)
      .fillColor(INK)
      .text(item.label, x + 15, y + 0.5, { width: colWidth - 20, lineBreak: false, ellipsis: true });
    maxY = Math.max(maxY, y + 13);
  }
  doc.y = maxY;
  doc.x = MARGIN;
}

function lengthLine(doc: Doc, model: AgreementModel): void {
  const y = doc.y + 1;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text('LENGTH OF THE AGREEMENT:', MARGIN, y, { lineBreak: false });
  let x = MARGIN + 140;
  const option = (label: string, checked: boolean): void => {
    checkbox(doc, x, y, checked);
    doc.font(checked ? 'Helvetica-Bold' : 'Helvetica').text(label, x + 12, y, { lineBreak: false });
    x += 12 + doc.widthOfString(label) + 18;
  };
  option('1 SEASON', model.length.one);
  option('2 SEASONS', model.length.two);
  option(model.length.other && model.length.other_label ? `OTHER: ${model.length.other_label}` : 'OTHER', model.length.other);
  doc.y = y + 14;
  doc.x = MARGIN;
}

function scheduleGrid(doc: Doc, model: AgreementModel): void {
  if (model.paid_in_full) {
    const cell = model.schedule[0];
    const top = doc.y;
    const width = 220;
    doc.lineWidth(0.8).rect(MARGIN, top, width, 34).stroke(NAVY);
    doc.rect(MARGIN, top, width, 12).fill(NAVY);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff').text('PAID IN FULL', MARGIN, top + 2.5, { width, align: 'center' });
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(INK)
      .text(cell ? `${cell.total}` : '', MARGIN, top + 16, { width, align: 'center' });
    doc.y = top + 40;
    doc.x = MARGIN;
    return;
  }

  // One row per season, one cell per payment.
  const seasons = [...new Set(model.schedule.map((s) => s.season))];
  for (const season of seasons) {
    const cells = model.schedule.filter((s) => s.season === season);
    const perRow = Math.max(5, cells.length);
    const cellWidth = WIDTH / perRow;
    const top = doc.y;
    if (seasons.length > 1) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(`SEASON ${season + 1}`, MARGIN, top);
    }
    const gridTop = seasons.length > 1 ? top + 10 : top;
    cells.forEach((cell, i) => {
      const x = MARGIN + i * cellWidth;
      doc.lineWidth(0.8).rect(x, gridTop, cellWidth, 32).stroke(NAVY);
      doc.rect(x, gridTop, cellWidth, 12).fill(NAVY);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff').text(cell.label, x, gridTop + 2.5, { width: cellWidth, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(cell.total, x, gridTop + 16, { width: cellWidth, align: 'center' });
    });
    doc.y = gridTop + 38;
  }
  if (model.plan_kind === 'monthly_recurring') {
    small(doc, 'Month-to-month: billed on the 1st of each month of the season until cancelled.');
  }
  doc.x = MARGIN;
}

function filledLine(doc: Doc, x: number, y: number, width: number, label: string, value: string): void {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(label, x, y, { lineBreak: false });
  const labelWidth = doc.widthOfString(label) + 6;
  doc.font('Helvetica').fontSize(8.5).text(value, x + labelWidth, y - 0.5, { width: width - labelWidth, lineBreak: false, ellipsis: true });
  doc.lineWidth(0.5).moveTo(x + labelWidth, y + 10).lineTo(x + width, y + 10).stroke(LINE);
}

/** Label on the left, value right-aligned on an underline. */
function valueLine(doc: Doc, x: number, y: number, width: number, label: string, value: string): number {
  const labelWidth = width * 0.55;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(label, x, y, { width: labelWidth, lineBreak: false });
  doc.font('Helvetica').fontSize(9).text(value, x + labelWidth, y - 0.5, { width: width - labelWidth, align: 'right', lineBreak: false });
  doc.lineWidth(0.5).moveTo(x + labelWidth, y + 10.5).lineTo(x + width, y + 10.5).stroke(LINE);
  return y + 15;
}

/** A light blue box with the signature in it, then the signer's name and the date. */
function signatureBox(
  doc: Doc,
  x: number,
  top: number,
  width: number,
  model: AgreementModel,
  box: SignatureBox,
  image: Buffer | null | undefined,
): number {
  const height = 46;
  doc.rect(x, top, width, height).fill(SIGN_FILL);
  doc.lineWidth(0.8).rect(x, top, width, height).stroke(NAVY);
  doc.font('Helvetica').fontSize(6.5).fillColor(MUTED).text('SIGNATURE', x + 4, top + 3, { lineBreak: false });
  if (model.boxes[box] && image) {
    doc.image(image, x + 8, top + 8, { fit: [width - 16, height - 12], align: 'center', valign: 'center' });
  }
  let y = top + height + 4;
  y = valueLine(doc, x, y, width, 'Name', model.status === 'signed' ? model.signer_name : '');
  y = valueLine(doc, x, y, width, 'Date', model.boxes[box] ? (model.signed_date_label ?? '') : '');
  return y;
}

function cardBox(
  doc: Doc,
  x: number,
  top: number,
  width: number,
  model: AgreementModel,
  image: Buffer | null | undefined,
): number {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text('Credit/Debit Card or Acct#:', x + 6, top + 4, { width: width - 12 });
  doc.font('Helvetica').fontSize(10).text(model.card.label, x + 6, doc.y + 2, { width: width - 12 });
  if (model.card.brand) {
    doc.fontSize(7.5).fillColor(MUTED).text(model.card.brand, x + 6, doc.y + 1, { width: width - 12 });
  }
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor(MUTED)
    .text(
      `I authorize ${COMPANY.name} to charge this payment method for the payments in the Payment Schedule. Card details are held by our payment processor, never by ${COMPANY.name}.`,
      x + 6,
      doc.y + 4,
      { width: width - 12 },
    );
  const bottom = signatureBox(doc, x + 6, doc.y + 6, width - 12, model, 'card_authorization', image);
  doc.lineWidth(0.8).rect(x, top, width, bottom - top + 4).stroke(NAVY);
  return bottom + 4;
}

function footer(doc: Doc, model: AgreementModel): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // Below the bottom margin: without dropping it for this one write, pdfkit
    // would start a new page for the footer (see layout.ts paginate).
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(MUTED)
      .text(
        `${COMPANY.name} | Service Agreement ${model.terms_version} | Page ${i + 1} of ${range.count}`,
        MARGIN,
        PAGE_HEIGHT - MARGIN - 6,
        { width: WIDTH, align: 'center', lineBreak: false },
      );
    doc.page.margins.bottom = bottom;
  }
}
