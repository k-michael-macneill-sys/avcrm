/*
 * A throwaway SMTP server for testing the mail transport.
 *
 * The point is to verify delivery by actually delivering — a transport that
 * has never talked to an SMTP server is a transport nobody has tested. Every
 * message it receives is appended to a JSONL file for the test to assert on.
 *
 *   node scripts/mail-sink.js <port> <out-file>
 *
 * One address, gone@example.test, is refused with a permanent 550 so the
 * queue's bounce handling has something real to classify.
 */
const fs = require('node:fs');
const { SMTPServer } = require('smtp-server');

const port = Number(process.argv[2] ?? 2525);
const out = process.argv[3] ?? '/tmp/avcrm-inbox.jsonl';
fs.writeFileSync(out, '');

const headerOf = (headers, name) => {
  const match = headers.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
  return match ? match[1].trim() : null;
};

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],

  onRcptTo(address, _session, callback) {
    if (address.address === 'gone@example.test') {
      const error = new Error('550 5.1.1 No such mailbox here');
      error.responseCode = 550;
      callback(error);
      return;
    }
    callback();
  },

  onData(stream, session, callback) {
    let raw = '';
    stream.on('data', (chunk) => {
      raw += chunk;
    });
    stream.on('end', () => {
      const split = raw.indexOf('\r\n\r\n');
      const headers = raw.slice(0, split);
      const body = raw.slice(split + 4);

      fs.appendFileSync(
        out,
        `${JSON.stringify({
          envelope_from: session.envelope.mailFrom.address,
          envelope_to: session.envelope.rcptTo.map((r) => r.address),
          from: headerOf(headers, 'From'),
          reply_to: headerOf(headers, 'Reply-To'),
          subject: headerOf(headers, 'Subject'),
          correlation: headerOf(headers, 'X-Avcrm-Message-Id'),
          body: body.replace(/=\r\n/g, '').trim(),
        })}\n`,
      );
      callback();
    });
  },
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`sink listening on ${port}\n`);
});
