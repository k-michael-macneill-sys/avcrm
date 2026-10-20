import path from 'node:path';

/**
 * The branded HTML version of an email, built from its plain-text body.
 *
 * Templates stay plain text — that is what branches reword and what
 * message_log records — and this dresses the text at send time: the Drift
 * logo on a dark band, the body, and a footer naming the branch. The plain
 * text still goes out alongside it, for clients that will not show HTML.
 *
 * A few plain-text conventions become formatting, each chosen to read just as
 * well when nobody renders it:
 *
 * - A paragraph of "- " lines is a bulleted list; "1. " lines a numbered one.
 * - A paragraph of two or more "Label: value" lines is a two-column table.
 * - A paragraph "→ Label: https://…" is a button.
 * - A short single line with no closing punctuation, followed by more text,
 *   is a heading ("What happens next").
 * - Any other URL is a link.
 */

export const LOGO_CID = 'drift-logo@avcrm';
export const LOGO_PATH = path.resolve(__dirname, '..', '..', 'assets', 'brand', 'drift-logo.jpg');

const COLORS = {
  band: '#171717',
  page: '#f2f4f7',
  card: '#ffffff',
  text: '#1f2933',
  muted: '#6b7785',
  rule: '#e3e7ec',
  brand: '#2976d6',
  tableLabel: '#f6f8fa',
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const URL_PATTERN = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g;
const HAS_URL = /https?:\/\//;
const BUTTON = /^→\s*(.+?):\s*(https?:\/\/\S+)$/;
const TABLE_ROW = /^([^:]{1,40}):\s+(.+)$/;
const BULLET = /^[-•]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes a line of text and turns its URLs into links. */
function inline(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    out += escapeHtml(text.slice(last, index));
    const url = escapeHtml(match[0]);
    out += `<a href="${url}" style="color:${COLORS.brand};text-decoration:underline;word-break:break-all;">${url}</a>`;
    last = index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function isHeading(lines: string[], hasMore: boolean): boolean {
  if (!hasMore || lines.length !== 1) return false;
  const line = lines[0]!;
  return line.length <= 60 && !/[.,:;!?)]$/.test(line) && !/^[—–-]/.test(line) && !HAS_URL.test(line);
}

function block(lines: string[], hasMore: boolean): string {
  const p = `margin:0 0 16px;font-size:15px;line-height:1.6;color:${COLORS.text};`;
  const joined = lines.join(' ');

  const button = lines.length === 1 ? BUTTON.exec(lines[0]!) : null;
  if (button) {
    const [, label, url] = button as unknown as [string, string, string];
    return (
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>` +
      `<td style="border-radius:8px;background:${COLORS.brand};">` +
      `<a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;` +
      `font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>` +
      `</td></tr></table>`
    );
  }

  if (lines.every((l) => BULLET.test(l)) || lines.every((l) => NUMBERED.test(l))) {
    const numbered = NUMBERED.test(lines[0]!);
    const tag = numbered ? 'ol' : 'ul';
    const items = lines
      .map((l) => (numbered ? NUMBERED : BULLET).exec(l)![1]!)
      .map((item) => `<li style="margin:0 0 6px;">${inline(item)}</li>`)
      .join('');
    return `<${tag} style="margin:0 0 16px;padding-left:22px;font-size:15px;line-height:1.6;color:${COLORS.text};">${items}</${tag}>`;
  }

  if (lines.length >= 2 && !HAS_URL.test(joined) && lines.every((l) => TABLE_ROW.test(l))) {
    const rows = lines
      .map((l) => TABLE_ROW.exec(l)!)
      .map(
        ([, label, value], i) =>
          `<tr>` +
          `<td style="padding:10px 14px;background:${COLORS.tableLabel};color:${COLORS.muted};font-size:14px;` +
          `${i ? `border-top:1px solid ${COLORS.rule};` : ''}width:45%;">${escapeHtml(label!)}</td>` +
          `<td style="padding:10px 14px;color:${COLORS.text};font-size:15px;font-weight:600;` +
          `${i ? `border-top:1px solid ${COLORS.rule};` : ''}">${escapeHtml(value!)}</td>` +
          `</tr>`,
      )
      .join('');
    return (
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
      `style="margin:0 0 20px;border:1px solid ${COLORS.rule};border-radius:8px;border-collapse:separate;overflow:hidden;">` +
      `${rows}</table>`
    );
  }

  if (isHeading(lines, hasMore)) {
    return `<h2 style="margin:24px 0 10px;font-size:17px;line-height:1.3;color:${COLORS.text};">${escapeHtml(lines[0]!)}</h2>`;
  }

  return `<p style="${p}">${lines.map(inline).join('<br>')}</p>`;
}

/** The body's paragraphs: runs of non-blank lines. */
function paragraphs(body: string): string[][] {
  return body
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== ''))
    .filter((p) => p.length > 0);
}

export interface EmailLayoutOptions {
  subject: string;
  /** The branch it is sent for; named in the footer. */
  branchName?: string | null;
}

export function renderEmailHtml(body: string, options: EmailLayoutOptions): string {
  const blocks = paragraphs(body);
  const content = blocks.map((lines, i) => block(lines, i < blocks.length - 1)).join('\n');
  const sender = options.branchName ? `Drift Property Services – ${options.branchName}` : 'Drift Property Services';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(options.subject)}</title>
<style>
@media (max-width: 480px) {
  .card { padding: 24px 18px 8px !important; }
  .outer { padding: 12px 6px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${COLORS.page};">
<tr><td class="outer" align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;font-family:${FONT};">
<tr><td align="center" style="background:${COLORS.band};border-radius:12px 12px 0 0;padding:24px 24px 18px;">
<img src="cid:${LOGO_CID}" width="220" alt="Drift Property Services" style="display:block;width:220px;max-width:100%;height:auto;border:0;">
</td></tr>
<tr><td style="background:${COLORS.brand};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>
<tr><td class="card" style="background:${COLORS.card};padding:32px 32px 16px;border-radius:0 0 12px 12px;">
${content}
</td></tr>
<tr><td align="center" style="padding:20px 24px;font-size:12px;line-height:1.6;color:${COLORS.muted};">
${escapeHtml(sender)}<br>
Reply to this email and a real person will get back to you.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
