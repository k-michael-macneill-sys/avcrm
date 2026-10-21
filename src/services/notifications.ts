import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { logger } from '../utils/logger';
import { LOGO_CID, LOGO_PATH, renderEmailHtml } from './emailLayout';
import { deliverSms } from './sms';
import { storage } from './storage';
import { SendFailure, type SendResult } from './transport';

// Re-exported: the queue imports "how a message is sent" from one place.
export { SendFailure, type SendResult };

/**
 * The transport. Everything above it — templates, rendering, the queue,
 * retries, the log — is provider-agnostic; this is the only file that knows
 * how a message actually leaves the building, and the queue worker is its
 * only caller.
 *
 * SMTP covers any provider: Postmark, SES, Mailgun and SendGrid all issue
 * SMTP credentials, so changing provider is a change to .env rather than to
 * code. SendGrid also has its own driver over its web API, because some hosts
 * block the SMTP ports outright (Render's free instances do) and https is
 * the one way out that is never blocked.
 */

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  /** Correlates the provider's copy with our message_log row. */
  message_id?: string;
  /** A stored file, by its storage key, to attach. */
  attachment?: { key: string; name: string };
  /** The branch it is sent for, which signs it and takes the replies. */
  branch?: SendingBranch | null;
}

export interface SendingBranch {
  name: string;
  contact_email: string | null;
}

/**
 * Who an email is from and where replies go. Always MAIL_FROM's address —
 * the one domain the provider has verified — but named for the branch
 * ("Drift Property Services – Regina"), with replies going to the branch's
 * own inbox, else MAIL_REPLY_TO, else back to MAIL_FROM.
 */
export function senderFor(
  branch: SendingBranch | null | undefined,
  mail: { from: string; replyTo: string | null } = config.mail,
): { from: string; replyTo: string | null } {
  const replyTo = branch?.contact_email || mail.replyTo;
  if (!branch) return { from: mail.from, replyTo };
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(mail.from);
  const address = match ? match[2]!.trim() : mail.from.trim();
  const name = match?.[1]?.trim() || 'Drift Property Services';
  return { from: `"${`${name} – ${branch.name}`.replace(/"/g, '')}" <${address}>`, replyTo };
}

/** How long one send may take before it counts as failed and the queue moves on. */
const SEND_TIMEOUT_MS = 15_000;

interface MailTransport {
  send(email: OutboundEmail): Promise<SendResult>;
  close(): Promise<void>;
}

/**
 * Where a message really goes. MAIL_REDIRECT_TO exists because staging is
 * usually a copy of production, real customer addresses and all — without it,
 * the first queue drain after a database restore emails them.
 */
function recipientFor(email: OutboundEmail): { to: string; subject: string } {
  if (!config.mail.redirectTo) {
    return { to: email.to, subject: email.subject };
  }
  return {
    to: config.mail.redirectTo,
    // The real recipient has to survive the redirect or the copy is useless.
    subject: `[to: ${email.to}] ${email.subject}`,
  };
}

/** The default. Writes to the log, which is what dev and the suite want. */
class LogTransport implements MailTransport {
  async send(email: OutboundEmail): Promise<SendResult> {
    const { to, subject } = recipientFor(email);
    const { from, replyTo } = senderFor(email.branch);
    logger.info(
      {
        driver: 'log',
        channel: 'email',
        from,
        reply_to: replyTo,
        to,
        subject,
        body: email.body,
        attachment: email.attachment?.name,
      },
      'Email (not sent: MAIL_DRIVER=log)',
    );
    return { provider_message_id: `log-${randomUUID()}` };
  }

  async close(): Promise<void> {}
}

class SmtpTransport implements MailTransport {
  private transporter: Transporter | null = null;

  /** Built on first use: a process that queues nothing never connects. */
  private connection(): Transporter {
    if (this.transporter) return this.transporter;

    const { smtp } = config.mail;
    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user && smtp.password
        ? { auth: { user: smtp.user, pass: smtp.password } }
        : {}),
      // The worker drains a backlog in one run, so hold the connection open
      // rather than reconnecting per message.
      pool: true,
      maxConnections: 2,
      // A host that drops the mail ports never answers at all, and the
      // defaults would hold the queue for minutes before saying so.
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: 2 * SEND_TIMEOUT_MS,
    });

    return this.transporter;
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    const { to, subject } = recipientFor(email);
    const { from, replyTo } = senderFor(email.branch);

    try {
      const info = await this.connection().sendMail({
        from,
        ...(replyTo ? { replyTo } : {}),
        to,
        subject,
        text: email.body,
        html: renderEmailHtml(email.body, { subject: email.subject, branchName: email.branch?.name }),
        attachments: [
          // Inline, by Content-ID: a hosted image is blocked by most mail
          // clients until the reader allows it, and the logo is the header.
          { filename: 'drift-logo.jpg', path: LOGO_PATH, cid: LOGO_CID },
          ...(email.attachment
            ? [{ filename: email.attachment.name, content: storage.read(email.attachment.key) }]
            : []),
        ],
        ...(email.message_id
          ? { headers: { 'X-Avcrm-Message-Id': email.message_id } }
          : {}),
      });

      return { provider_message_id: info.messageId ?? `smtp-${randomUUID()}` };
    } catch (err) {
      throw classify(err);
    }
  }

  async close(): Promise<void> {
    this.transporter?.close();
    this.transporter = null;
  }
}

/** "Name <address>" or a bare address, as SendGrid's API takes it. */
export function parseAddress(value: string): { email: string; name?: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (!match) return { email: value.trim() };
  const name = match[1]!.trim();
  return name ? { email: match[2]!.trim(), name } : { email: match[2]!.trim() };
}

/**
 * SendGrid's web API, over https. The same mail as SmtpTransport sends —
 * text, the branded HTML, the inline logo, any attachment — but on port
 * 443, which no host blocks; Render's free instances silently drop the SMTP
 * ports, and a send there never comes back.
 */
class SendGridTransport implements MailTransport {
  async send(email: OutboundEmail): Promise<SendResult> {
    const { to, subject } = recipientFor(email);
    const { from, replyTo } = senderFor(email.branch);
    const { apiKey, apiBase } = config.mail.sendgrid;

    const attachments = [
      {
        content: (await readFile(LOGO_PATH)).toString('base64'),
        filename: 'drift-logo.jpg',
        type: 'image/jpeg',
        disposition: 'inline',
        content_id: LOGO_CID,
      },
      ...(email.attachment
        ? [
            {
              content: (await buffer(storage.read(email.attachment.key))).toString('base64'),
              filename: email.attachment.name,
              disposition: 'attachment',
            },
          ]
        : []),
    ];

    let response: Response;
    try {
      response = await fetch(`${apiBase}/v3/mail/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [parseAddress(to)] }],
          from: parseAddress(from),
          ...(replyTo ? { reply_to: parseAddress(replyTo) } : {}),
          subject,
          content: [
            { type: 'text/plain', value: email.body },
            { type: 'text/html', value: renderEmailHtml(email.body, { subject: email.subject, branchName: email.branch?.name }) },
          ],
          attachments,
          ...(email.message_id ? { headers: { 'X-Avcrm-Message-Id': email.message_id } } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      // Timed out or never connected: worth another go.
      throw new SendFailure(
        `Could not reach SendGrid: ${err instanceof Error ? err.message : String(err)}`,
        false,
        (err as { name?: string }).name,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // 400 and 413 are this message, and will be the same message next time.
      // A bad key (401) or an unverified sender (403) is the account, which
      // somebody can fix, so those keep their retries.
      const permanent = response.status === 400 || response.status === 413;
      throw new SendFailure(`SendGrid refused the email (${response.status}): ${detail.slice(0, 500)}`, permanent, String(response.status));
    }

    return { provider_message_id: response.headers.get('x-message-id') ?? `sendgrid-${randomUUID()}` };
  }

  async close(): Promise<void> {}
}

/**
 * Turns a transport error into the one thing the queue needs to know.
 *
 * nodemailer surfaces the SMTP reply code as `responseCode`. Anything in the
 * 500s is the server saying "not this address, not ever"; everything else,
 * including a connection that never opened, is worth another go.
 */
function classify(err: unknown): SendFailure {
  const error = err as { responseCode?: number; code?: string; message?: string };
  const responseCode = error.responseCode;
  const permanent = typeof responseCode === 'number' && responseCode >= 500;

  return new SendFailure(
    error.message ?? 'The mail server rejected the message',
    permanent,
    error.code ?? (responseCode ? String(responseCode) : undefined),
  );
}

const transport: MailTransport =
  config.mail.driver === 'sendgrid'
    ? new SendGridTransport()
    : config.mail.driver === 'smtp'
      ? new SmtpTransport()
      : new LogTransport();

export function sendEmail(
  to: string,
  subject: string,
  body: string,
  messageId?: string,
  attachment?: { key: string; name: string },
  branch?: SendingBranch | null,
): Promise<SendResult> {
  return transport.send({ to, subject, body, message_id: messageId, attachment, branch });
}

/** Lets a job exit instead of waiting on a pooled connection. */
export function closeTransport(): Promise<void> {
  return transport.close();
}

/**
 * SMS has no SMTP — every gateway has its own HTTP API — so instead of
 * choosing one here, the provider is configured by an administrator and read
 * at send time. See src/services/sms.ts.
 *
 * Kept in this file as a re-export so the queue has one import for "send a
 * message", whichever channel it is.
 */
export function sendSms(to: string, body: string): Promise<SendResult> {
  return deliverSms(to, body);
}
