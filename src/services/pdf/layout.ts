import PDFDocument from 'pdfkit';

/**
 * The small amount of layout every document here needs, in one place.
 *
 * pdfkit rather than a headless browser on purpose: rendering HTML would mean
 * shipping Chromium in the container — two hundred megabytes and a sandbox to
 * worry about — to produce a two-page invoice. This draws directly, starts in
 * milliseconds, and has no moving parts at runtime.
 *
 * Only the built-in fonts are used, so there are no font files to deploy and
 * nothing to license.
 */

export const PAGE_MARGIN = 50;
/** Usable width inside the margins on Letter. */
export const CONTENT_WIDTH = 612 - PAGE_MARGIN * 2;

const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#d8d8d8';

export type Doc = PDFKit.PDFDocument;

export function newDocument(title: string, subject: string): Doc {
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: PAGE_MARGIN,
    info: { Title: title, Subject: subject, Creator: 'Avalanche CRM' },
    autoFirstPage: true,
    // Page numbers cannot be written until the page count is known, which
    // means holding the pages rather than streaming them out as they finish.
    bufferPages: true,
  });
  doc.fillColor(INK).font('Helvetica').fontSize(10);
  return doc;
}

/** Renders to a Buffer, because everything downstream wants bytes. */
export function toBuffer(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** The company block and the document's name, top of page one. */
export function letterhead(doc: Doc, branchName: string, documentTitle: string): void {
  doc.font('Helvetica-Bold').fontSize(18).text('Avalanche', PAGE_MARGIN, PAGE_MARGIN);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${branchName} branch`);

  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(INK)
    .text(documentTitle, PAGE_MARGIN, PAGE_MARGIN + 4, {
      width: CONTENT_WIDTH,
      align: 'right',
    });

  doc.y = PAGE_MARGIN + 46;
  rule(doc);
}

export function rule(doc: Doc): void {
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y)
    .strokeColor(RULE)
    .lineWidth(0.5)
    .stroke();
  doc.y += 12;
}

export function heading(doc: Doc, text: string): void {
  keepTogether(doc, 40);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(text, PAGE_MARGIN, doc.y);
  doc.y += 4;
}

export function paragraph(doc: Doc, text: string, muted = false): void {
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(muted ? MUTED : INK)
    .text(text, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.y += 6;
}

export interface Pair {
  label: string;
  value: string;
}

/**
 * Label-and-value pairs in columns. Used for the header blocks where a reader
 * is scanning for one fact — who it is for, what period, what is owed.
 */
export function pairs(doc: Doc, entries: Pair[], columns = 2): void {
  const columnWidth = CONTENT_WIDTH / columns;
  const valueWidth = columnWidth - 12;
  const rowCount = Math.ceil(entries.length / columns);

  /*
   * Row heights are measured rather than assumed. A service address runs to
   * three lines where a due date runs to one, and a fixed row pitch puts the
   * long one straight through the label underneath it.
   */
  const heights: number[] = new Array<number>(rowCount).fill(0);
  entries.forEach((entry, index) => {
    const row = index % rowCount;
    doc.font('Helvetica').fontSize(10);
    const height = 11 + doc.heightOfString(entry.value, { width: valueWidth }) + 10;
    heights[row] = Math.max(heights[row] ?? 0, height);
  });

  const top = doc.y;
  const offsets: number[] = [];
  let running = 0;
  for (const height of heights) {
    offsets.push(running);
    running += height;
  }

  entries.forEach((entry, index) => {
    const column = Math.floor(index / rowCount);
    const row = index % rowCount;
    const x = PAGE_MARGIN + column * columnWidth;
    const y = top + (offsets[row] ?? 0);

    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(entry.label.toUpperCase(), x, y, {
      width: valueWidth,
      characterSpacing: 0.4,
    });
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(entry.value, x, y + 11, {
      width: valueWidth,
    });
  });

  doc.y = top + running;
}

export interface Column<T> {
  header: string;
  width: number;
  /** Money and counts read better right-aligned against each other. */
  numeric?: boolean;
  cell: (row: T) => string;
}

export function table<T>(doc: Doc, columns: Column<T>[], rows: T[], empty: string): void {
  if (!rows.length) {
    paragraph(doc, empty, true);
    return;
  }

  const drawHeader = (): void => {
    // One y for the whole row: writing text moves the cursor, so reading
    // doc.y inside the loop would step each header down past the last.
    const y = doc.y;
    let x = PAGE_MARGIN;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
    for (const column of columns) {
      doc.text(column.header.toUpperCase(), x, y, {
        width: column.width,
        align: column.numeric ? 'right' : 'left',
        characterSpacing: 0.4,
        lineBreak: false,
      });
      x += column.width;
    }
    doc.y = y + 14;
    rule(doc);
    doc.y -= 6;
  };

  drawHeader();

  for (const row of rows) {
    // A row split across a page break is unreadable, so move it whole.
    if (keepTogether(doc, 30)) drawHeader();

    const top = doc.y;
    let x = PAGE_MARGIN;
    let deepest = top;

    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    for (const column of columns) {
      doc.text(column.cell(row), x, top, {
        width: column.width - 8,
        align: column.numeric ? 'right' : 'left',
      });
      deepest = Math.max(deepest, doc.y);
      x += column.width;
    }
    doc.y = deepest + 8;
  }

  doc.y += 4;
}

/** The bottom-line figure, set apart so it is the thing the eye lands on. */
export function total(doc: Doc, label: string, value: string): void {
  keepTogether(doc, 40);
  rule(doc);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
  doc.text(label, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH - 120 });
  doc.text(value, PAGE_MARGIN + CONTENT_WIDTH - 120, doc.y - 13, {
    width: 120,
    align: 'right',
  });
  doc.y += 10;
}

/**
 * Starts a new page when there is not room for what comes next, and says
 * whether it did so a caller can redraw a table header.
 */
export function keepTogether(doc: Doc, needed: number): boolean {
  const limit = doc.page.height - PAGE_MARGIN - 30;
  if (doc.y + needed <= limit) return false;
  doc.addPage();
  doc.y = PAGE_MARGIN;
  return true;
}

/**
 * Page numbers, written at the end because the count is not known until then.
 * Anything printed and passed around needs them.
 */
export function paginate(doc: Doc, footer: string): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);

    // The footer sits below the bottom margin, and pdfkit answers a write
    // past that margin by starting a new page — which would then need a
    // footer of its own, forever. Dropping the margin for the one write is
    // the documented way out.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `${footer}    Page ${i - range.start + 1} of ${range.count}`,
        PAGE_MARGIN,
        doc.page.height - PAGE_MARGIN + 8,
        { width: CONTENT_WIDTH, align: 'center', lineBreak: false },
      );
    doc.page.margins.bottom = bottom;
  }
}
