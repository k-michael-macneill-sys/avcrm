import { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';
import type { Knex } from 'knex';
import type { UploadPurpose } from '../types/models';
import { keyFor, ruleFor, storage } from '../services/storage';

/**
 * Real bytes for the development seed.
 *
 * The seed used to record file keys like `private/signatures/harold-bell.png`
 * that nothing had ever written to. Every one of them was a 404: reads are
 * authorized against an `uploads` row, and a key with no stored bytes is a
 * miss by design. So a freshly seeded install showed broken images on every
 * completed visit and a signature nobody could open.
 *
 * These are drawn rather than checked in as binaries — a repository is a poor
 * place for sample JPEGs, and generated ones can say what they are.
 */

/** A PNG chunk: length, type, payload, CRC. */
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([head, typed, crc]);
}

type Painter = (x: number, y: number) => [number, number, number];

/** Truecolour PNG, one filter byte per scanline, no interlacing. */
function png(width: number, height: number, paint: Painter): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0;
    at += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      at += 3;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Deterministic value noise, so a seeded database looks the same twice and a
 * screenshot diff means something.
 */
function noise(x: number, y: number, salt: number): number {
  const n = Math.sin((x * 127.1 + y * 311.7 + salt * 74.7) ) * 43758.5453;
  return n - Math.floor(n);
}

/** A signature: dark ink on a white pad, with a baseline stroke. */
export function signaturePng(salt: number): Buffer {
  const w = 420;
  const h = 140;
  return png(w, h, (x, y) => {
    const base = h * 0.62;
    // Two overlaid waves plus a slow drift reads as handwriting at a glance.
    const stroke =
      base +
      26 * Math.sin((x / w) * 11 + salt) +
      12 * Math.sin((x / w) * 27 + salt * 2) -
      (x / w) * 14;
    const weight = 2.4 + 1.6 * Math.sin((x / w) * 6 + salt);
    const inked = x > 26 && x < w - 26 && Math.abs(y - stroke) < weight;
    return inked ? [26, 28, 38] : [255, 255, 255];
  });
}

/**
 * A driveway, before or after. Snow-covered versus cleared asphalt with the
 * banks pushed to the edges — the pair has to be tellable apart at thumbnail
 * size, because that is the whole point of a before and an after.
 */
export function drivewayPng(cleared: boolean, salt: number): Buffer {
  const w = 480;
  const h = 320;
  const horizon = h * 0.34;
  return png(w, h, (x, y) => {
    const grain = noise(x >> 1, y >> 1, salt);

    if (y < horizon) {
      // Overcast sky, darker towards the top.
      const v = 150 + Math.round((y / horizon) * 42 + grain * 10);
      return [v, v + 2, v + 8];
    }

    // The drive narrows towards the house, so its edges converge.
    const depth = (y - horizon) / (h - horizon);
    const halfWidth = w * (0.1 + 0.34 * depth);
    const offset = Math.abs(x - w / 2);

    if (offset > halfWidth) {
      // Snow banks either side, brighter where they have been piled up.
      const pile = Math.min(1, (offset - halfWidth) / 40);
      const v = 228 + Math.round(pile * 18 + grain * 12);
      return [Math.min(255, v), Math.min(255, v), 255];
    }

    if (!cleared) {
      // Untouched snow lying on the drive: bright, slightly blue in shadow.
      const v = 214 + Math.round(grain * 26);
      return [v, v + 3, Math.min(255, v + 12)];
    }

    // Cleared asphalt, wet and dark, with a little salt scatter left behind.
    const salted = grain > 0.93;
    const v = 62 + Math.round(grain * 16 + depth * 10);
    return salted ? [206, 208, 214] : [v, v + 1, v + 4];
  });
}

/** A one-page PDF carrying a line of text — enough to open and to prove a type. */
export function documentPdf(title: string): Buffer {
  const text = title.replace(/[\\()]/g, '');
  const content = `BT /F1 16 Tf 62 706 Td (${text}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * Writes bytes through the real storage driver and records the `uploads` row
 * that read authorization is decided from, exactly as a live upload would.
 * Returns the generated key for the row that will reference it.
 */
export async function storeSeedFile(
  knex: Knex,
  purpose: UploadPurpose,
  contentType: string,
  bytes: Buffer,
  fileName: string,
  uploadedByUserId: string,
  branchId: string | null,
): Promise<string> {
  const key = keyFor(purpose, contentType);
  const stored = await storage.put(
    key,
    Readable.from(bytes),
    contentType,
    ruleFor(purpose).maxBytes,
  );

  await knex('uploads').insert({
    key,
    purpose,
    content_type: contentType,
    file_name: fileName,
    byte_size: stored.byte_size,
    status: 'stored',
    uploaded_by_user_id: uploadedByUserId,
    branch_id: branchId,
    stored_at: new Date(),
  });

  return key;
}
