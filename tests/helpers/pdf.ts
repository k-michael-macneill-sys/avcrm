import { inflateSync } from 'node:zlib';

/**
 * Reading a PDF back, without a PDF library.
 *
 * A test that only checks the bytes start with %PDF proves nothing about what
 * is on the page. So this inflates the content streams and decodes the text
 * operators, which is enough to assert that a customer's name, a balance, or
 * a note about a missing photo really is in the document.
 *
 * pdfkit writes text as `[<hex> kerning <hex>] TJ` — hex because it addresses
 * glyphs by code. With the built-in fonts those codes are WinAnsi, which is
 * ASCII for everything these documents contain.
 */

function decodeHex(hex: string): string {
  return Buffer.from(hex.replace(/\s+/g, ''), 'hex').toString('latin1');
}

function unescapeLiteral(value: string): string {
  return value.replace(/\\([()\\])/g, '$1');
}

/** The pieces of one TJ array or Tj string, kerning numbers discarded. */
function operandText(operand: string): string {
  let out = '';
  const pattern = /<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\()])*)\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(operand)) !== null) {
    out += match[1] !== undefined ? decodeHex(match[1]) : unescapeLiteral(match[2] ?? '');
  }
  return out;
}

export function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const pieces: string[] = [];

  const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let stream: RegExpExecArray | null;

  while ((stream = streams.exec(raw)) !== null) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(stream[1] ?? '', 'latin1')).toString('latin1');
    } catch {
      // Not a deflated content stream — a font program, or an image.
      continue;
    }

    const shows = /(\[[^\]]*\]|<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\()])*\))\s*(TJ|Tj)/g;
    let show: RegExpExecArray | null;
    while ((show = shows.exec(content)) !== null) {
      pieces.push(operandText(show[1] ?? ''));
    }
  }

  // Each show operation is a run of text; joining with spaces keeps words
  // from running together across them.
  return pieces.join(' ');
}

/** How many pages the document actually has. */
export function pdfPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}
