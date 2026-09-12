import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';

/**
 * A throwaway SMTP server.
 *
 * A transport that has never talked to an SMTP server is a transport nobody
 * has tested, so delivery is verified by actually delivering. One address,
 * gone@example.test, is refused with a permanent 550, which gives the queue's
 * bounce handling something real to classify.
 */

export interface ReceivedMail {
  envelope_from: string;
  envelope_to: string[];
  from: string | null;
  reply_to: string | null;
  subject: string | null;
  correlation: string | null;
  body: string;
}

export interface MailSink {
  port: number;
  received: () => ReceivedMail[];
  clear: () => void;
  close: () => Promise<void>;
}

const headerOf = (headers: string, name: string): string | null => {
  const match = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(headers);
  return match?.[1]?.trim() ?? null;
};

export async function startMailSink(): Promise<MailSink> {
  const received: ReceivedMail[] = [];

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],

    onRcptTo(address, _session, callback) {
      if (address.address === 'gone@example.test') {
        const error = new Error('550 5.1.1 No such mailbox here') as Error & {
          responseCode?: number;
        };
        error.responseCode = 550;
        callback(error);
        return;
      }
      callback();
    },

    onData(stream, session, callback) {
      let raw = '';
      stream.on('data', (chunk) => {
        raw += String(chunk);
      });
      stream.on('end', () => {
        const split = raw.indexOf('\r\n\r\n');
        const headers = raw.slice(0, split);
        const body = raw.slice(split + 4);

        received.push({
          envelope_from: session.envelope.mailFrom
            ? session.envelope.mailFrom.address
            : '',
          envelope_to: session.envelope.rcptTo.map((r) => r.address),
          from: headerOf(headers, 'From'),
          reply_to: headerOf(headers, 'Reply-To'),
          subject: headerOf(headers, 'Subject'),
          correlation: headerOf(headers, 'X-Avcrm-Message-Id'),
          // Quoted-printable soft line breaks would otherwise split words.
          body: body.replace(/=\r\n/g, '').trim(),
        });
        callback();
      });
    },
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.server.once('listening', resolve);
    server.server.once('error', reject);
  });

  const { port } = server.server.address() as AddressInfo;

  return {
    port,
    received: () => received,
    clear: () => {
      received.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
