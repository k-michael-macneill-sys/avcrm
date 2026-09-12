import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { pdfText } from './helpers/pdf';

/**
 * The reader the PDF tests lean on, tested on its own.
 *
 * It earned this: the first version delimited a stream by the newline before
 * `endstream`, which quietly ate a byte of any deflate output ending in 0x0D.
 * That is about one stream in 256 — often enough to fail a suite run every
 * few tries, rarely enough to look like a ghost.
 */

/** A minimal PDF object wrapping one deflated content stream. */
function wrap(content: string, eol: string): Buffer {
  const body = deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from(`%PDF-1.3\n5 0 obj\n<< /Length ${body.length} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from(`${eol}endstream\nendobj\n`, 'latin1'),
  ]);
}

/**
 * Content whose deflate output ends in the byte that used to break it.
 *
 * Found by search rather than by construction: what deflate emits last is not
 * something you can ask it for, so the filler is varied until it lands.
 */
function contentEndingInCarriageReturn(): string {
  for (let i = 0; i < 20_000; i += 1) {
    const candidate = `BT /F1 12 Tf (Paid in full) Tj ET % ${i.toString(36)}${'x'.repeat(i % 17)}`;
    const deflated = deflateSync(Buffer.from(candidate, 'latin1'));
    if (deflated[deflated.length - 1] === 0x0d) return candidate;
  }
  throw new Error('Could not construct a stream ending in 0x0D');
}

describe('reading text back out of a PDF', () => {
  it('reads a plain stream', () => {
    const pdf = wrap('BT /F1 12 Tf (Total due) Tj ET', '\n');
    assert.match(pdfText(pdf), /Total due/);
  });

  it('reads hex-encoded glyph runs, which is what pdfkit writes', () => {
    // "Avalanche" as the WinAnsi codes pdfkit addresses glyphs by.
    const pdf = wrap('BT [<41> 40 <76> 20 <616c616e636865> 0] TJ ET', '\n');
    assert.match(pdfText(pdf), /Avalanche/);
  });

  it('survives a stream whose data ends in a carriage return', () => {
    const content = contentEndingInCarriageReturn();
    const pdf = wrap(content, '\n');
    assert.match(pdfText(pdf), /Paid in full/);
  });

  it('does not mind which end-of-line the writer used', () => {
    for (const eol of ['\n', '\r\n', '']) {
      const pdf = wrap('BT /F1 12 Tf (Balance owing) Tj ET', eol);
      assert.match(pdfText(pdf), /Balance owing/, `failed with eol ${JSON.stringify(eol)}`);
    }
  });

  it('passes over a stream that is not deflated, rather than throwing', () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.3\n9 0 obj\nstream\n', 'latin1'),
      // A font program, as far as this is concerned.
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]),
      Buffer.from('\nendstream\n', 'latin1'),
      wrap('BT /F1 12 Tf (Still found) Tj ET', '\n'),
    ]);
    assert.match(pdfText(pdf), /Still found/);
  });
});
