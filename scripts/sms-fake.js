/*
 * A stand-in for an SMS gateway, so the driver is verified by talking to
 * something rather than by trusting that it would.
 *
 *   node scripts/sms-fake.js <port>
 *
 * It answers on Twilio's, Telnyx's and Vonage's own URL shapes, checks the
 * credential the way they do, and records what it was asked to send so the
 * suite can assert on it. A custom-provider endpoint is here too, since
 * "anything else" is the path most likely to be wrong.
 *
 * Behaviour is chosen by the recipient:
 *   +15550000401  -> 401, an unusable credential (permanent)
 *   +15550000400  -> 400, a bad number         (permanent)
 *   +15550000503  -> 503, gateway trouble      (temporary)
 *   +15550000200  -> Vonage-style 200 that is actually a refusal
 *   anything else -> accepted
 */
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const port = Number(process.argv[2] ?? 12222);
const id = (prefix) => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 24)}`;

/** Every accepted message, so the suite can check what really went out. */
const sent = [];

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/** The recipient decides the outcome, so one gateway covers every case. */
const outcomeFor = (to) => {
  if (to.endsWith('0401')) return 401;
  if (to.endsWith('0400')) return 400;
  if (to.endsWith('0503')) return 503;
  if (to.endsWith('0200')) return 200;
  return null;
};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const [path] = req.url.split('?');

    // What the suite reads back. Not part of any real gateway's API.
    if (req.method === 'GET' && path === '/_sent') {
      return json(res, 200, { sent });
    }
    if (req.method === 'DELETE' && path === '/_sent') {
      sent.length = 0;
      return json(res, 200, { cleared: true });
    }

    const isJson = (req.headers['content-type'] ?? '').includes('json');
    let body;
    try {
      body = isJson ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    } catch {
      return json(res, 400, { message: 'Body was not valid JSON' });
    }

    // Twilio: basic auth, form body, account SID in the path.
    if (req.method === 'POST' && /^\/2010-04-01\/Accounts\/[^/]+\/Messages\.json$/.test(path)) {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Basic ')) {
        return json(res, 401, { message: 'Authenticate' });
      }
      const [account, token] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      if (!account || !token) {
        return json(res, 401, { message: 'Authenticate' });
      }

      const to = body.To ?? '';
      const outcome = outcomeFor(to);
      if (outcome === 401) return json(res, 401, { message: 'Authenticate' });
      if (outcome === 400) return json(res, 400, { message: "The 'To' number is not valid" });
      if (outcome === 503) return json(res, 503, { message: 'Service unavailable' });

      sent.push({ provider: 'twilio', to, from: body.From, body: body.Body, account });
      return json(res, 201, { sid: id('SM'), status: 'queued' });
    }

    // Telnyx: bearer token, JSON body, id nested under data.
    if (req.method === 'POST' && path === '/v2/messages') {
      if (!(req.headers.authorization ?? '').startsWith('Bearer ')) {
        return json(res, 401, { message: 'Invalid API key' });
      }
      const outcome = outcomeFor(body.to ?? '');
      if (outcome === 401) return json(res, 401, { message: 'Invalid API key' });
      if (outcome === 400) return json(res, 400, { message: 'Invalid destination' });
      if (outcome === 503) return json(res, 503, { message: 'Service unavailable' });

      sent.push({ provider: 'telnyx', to: body.to, from: body.from, body: body.text });
      return json(res, 200, { data: { id: id('msg_') } });
    }

    // Vonage: credentials in the body, and a refusal that arrives as a 200.
    if (req.method === 'POST' && path === '/sms/json') {
      const to = body.to ?? '';
      if (outcomeFor(to) === 200) {
        return json(res, 200, {
          messages: [{ status: '4', 'error-text': 'Bad credentials' }],
        });
      }
      sent.push({ provider: 'vonage', to, from: body.from, body: body.text });
      return json(res, 200, { messages: [{ status: '0', 'message-id': id('vg') }] });
    }

    // A gateway that is not in the catalogue: the custom provider's target.
    if (req.method === 'POST' && path === '/custom/send') {
      if (req.headers['x-api-key'] !== 'custom-secret') {
        return json(res, 401, { message: 'Bad key' });
      }
      const to = body.destination ?? '';
      const outcome = outcomeFor(to);
      if (outcome === 400) return json(res, 400, { message: 'Unroutable' });
      if (outcome === 503) return json(res, 503, { message: 'Try later' });

      sent.push({ provider: 'custom', to, from: body.sender, body: body.message });
      return json(res, 200, { result: { reference: id('cx') } });
    }

    json(res, 404, { message: `Unhandled ${req.method} ${path}` });
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`sms stand-in listening on ${port}\n`);
});
