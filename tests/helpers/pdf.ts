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

  /*
   * Streams are found by their opening keyword and closed by searching for
   * `endstream`, rather than by matching a newline before it.
   *
   * A single regex is wrong here: deflate output is arbitrary bytes, and one
   * ending in 0x0D would have that byte eaten as part of an `\r?\n`
   * delimiter, truncating the data and failing to inflate. That is about one
   * stream in 256 — rare enough to look like a haunted test suite, common
   * enough to happen.
   */
  const starts = /stream\r?\n/g;
  let start: RegExpExecArray | null;

  while ((start = starts.exec(raw)) !== null) {
    const from = start.index + start[0].length;
    const to = raw.indexOf('endstream', from);
    if (to === -1) break;

    const body = Buffer.from(raw.slice(from, to), 'latin1');
    // The writer puts an EOL between the data and `endstream`, and which one
    // is its business; try the plausible trims rather than assume.
    const content = inflateAny([body, body.subarray(0, -1), body.subarray(0, -2)]);
    // Past the keyword, not to it: `endstream` itself contains `stream`, so
    // resuming at `to` finds a phantom stream inside the word and loses
    // whatever really came next.
    starts.lastIndex = to + 'endstream'.length;
    if (content === null) continue;

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

/** The first candidate that inflates, or null when none is a deflate stream. */
function inflateAny(candidates: Buffer[]): string | null {
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    try {
      return inflateSync(candidate).toString('latin1');
    } catch {
      // Not this trim — or not a deflated stream at all, which a font
      // program or an embedded image would not be.
    }
  }
  return null;
}

/** How many pages the document actually has. */
export function pdfPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}
