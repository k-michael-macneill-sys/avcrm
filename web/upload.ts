import * as api from './api.js';

/**
 * Sending a file, in the two steps the API asks for: get a target, PUT the
 * bytes to it. The second step deliberately does not carry the session token
 * — the signed URL is the permission, so this works unchanged the day the
 * target points at a bucket instead of at us.
 */

export type UploadPurpose =
  | 'signature'
  | 'service_photo'
  | 'operator_document'
  | 'contract_pdf'
  | 'invoice_pdf';

interface UploadTarget {
  upload_id: string;
  key: string;
  upload_url: string;
  method: 'PUT';
  content_type: string;
  max_bytes: number;
  expires_at: string;
}

/** Returns the stored key, which is what every table records. */
export async function uploadBlob(
  purpose: UploadPurpose,
  blob: Blob,
  fileName: string | null = null,
): Promise<string> {
  const target = await api.post<UploadTarget>('/uploads', {
    purpose,
    content_type: blob.type || 'application/octet-stream',
    file_name: fileName,
  });

  if (blob.size > target.max_bytes) {
    throw new api.ApiError(
      400,
      'bad_request',
      `That file is ${formatBytes(blob.size)}; the limit is ${formatBytes(target.max_bytes)}`,
      [],
    );
  }

  const response = await fetch(target.upload_url, {
    method: target.method,
    headers: { 'Content-Type': target.content_type },
    body: blob,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const error = (payload.error ?? {}) as Record<string, unknown>;
    throw new api.ApiError(
      response.status,
      String(error.code ?? 'error'),
      String(error.message ?? 'That upload failed'),
      [],
    );
  }

  return target.key;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A file picker that hands back the chosen File.
 *
 * `capture` asks a phone for the camera rather than the gallery, which is
 * what an operator standing in a driveway wants.
 */
export interface FilePicker {
  node: HTMLElement;
  file: () => File | null;
}

/**
 * Reading a file back.
 *
 * `/files/:key` is authorized by the session, and a browser does not put an
 * Authorization header on an <img src> or a plain link — so stored files are
 * fetched with the token and handed to the page as blob URLs. The alternative
 * is a signed read URL like the upload target, which is what a bucket would
 * give you; that is worth doing when images get numerous, and it trades a
 * session check for a URL that works for anyone who copies it.
 */
async function fetchFile(key: string): Promise<Blob> {
  const auth = api.token();
  const response = await fetch(`/files/${key}`, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  });
  if (!response.ok) {
    throw new api.ApiError(
      response.status,
      'not_found',
      response.status === 403 ? 'You cannot open that file' : 'That file is not on file',
      [],
    );
  }
  return response.blob();
}

/** An <img> that fills itself in, and says so plainly when it cannot. */
export function fileImage(key: string, alt: string, className = ''): HTMLElement {
  const image = document.createElement('img');
  image.alt = alt;
  image.className = className;

  const wrap = document.createElement('div');
  wrap.appendChild(image);

  fetchFile(key)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      // Safe once the image has decoded, and it keeps the page from holding
      // every blob it has ever shown.
      image.onload = () => URL.revokeObjectURL(url);
      image.src = url;
    })
    .catch((err: unknown) => {
      const note = document.createElement('p');
      note.className = 'file-note';
      note.textContent = err instanceof api.ApiError ? err.message : 'That file did not load';
      wrap.replaceChildren(note);
    });

  return wrap;
}

/** Opens a stored file in a new tab, with the session behind it. */
export async function openFile(key: string, fileName: string): Promise<void> {
  const blob = await fetchFile(key);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  anchor.download = fileName;
  anchor.click();
  // Long enough for the tab to take it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Built here rather than in dom.ts because it carries the chosen file. */
export function filePicker(options: {
  accept: string;
  capture?: boolean;
  note?: string;
}): FilePicker {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = options.accept;
  if (options.capture) input.setAttribute('capture', 'environment');

  const chosen = document.createElement('p');
  chosen.className = 'file-note';
  chosen.textContent = options.note ?? '';

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    chosen.textContent = file
      ? `${file.name} — ${formatBytes(file.size)}`
      : (options.note ?? '');
  });

  const node = document.createElement('div');
  node.className = 'file-pick';
  node.append(input, chosen);

  return { node, file: () => input.files?.[0] ?? null };
}
