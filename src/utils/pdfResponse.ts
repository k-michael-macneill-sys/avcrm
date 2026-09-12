import type { Response } from 'express';

/**
 * One place to answer with a PDF, so both documents behave the same way in a
 * browser: shown inline rather than downloaded, named something a person can
 * find again, and never held by a shared cache — an invoice names a customer
 * and what they owe.
 */
export function sendPdf(
  res: Response,
  document: { bytes: Buffer; file_name: string },
): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(document.bytes.length));
  res.setHeader('Content-Disposition', `inline; filename="${document.file_name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(document.bytes);
}
