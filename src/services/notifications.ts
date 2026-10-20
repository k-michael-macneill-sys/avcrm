import { randomUUID } from 'node:crypto';
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
 * SMTP rather than a vendor's HTTP API on purpose. Postmark, SES, Mailgun and
 * SendGrid all issue SMTP credentials, so one driver covers any of them and
 * changing provider is a change to .env rather than to code.
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
  config.mail.driver === 'smtp' ? new SmtpTransport() : new LogTransport();

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
