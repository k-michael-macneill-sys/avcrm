#!/usr/bin/env bash
#
# Verifies the mail transport by delivering to a real SMTP server.
#
#   npm run test:mail
#
# Starts a throwaway SMTP sink, queues messages straight into message_log,
# drains them with the real driver, and asserts on what arrived. Needs the
# database (npm run migrate), but not the API server.

set -euo pipefail

PORT="${MAIL_SINK_PORT:-2526}"
INBOX="$(mktemp -t avcrm-inbox.XXXXXX)"
PSQL_URL="${DATABASE_URL:-postgres://avcrm:avcrm@localhost:5432/avcrm}"
pass=0

cleanup() {
  [[ -n "${SINK_PID:-}" ]] && kill "$SINK_PID" 2>/dev/null || true
  rm -f "$INBOX"
}
trap cleanup EXIT

assert() {
  if [[ "$2" == "$3" ]]; then
    echo "  ok   $1 = $2"
    pass=$((pass + 1))
  else
    echo "  FAIL $1 = '$2' (expected '$3')"
    exit 1
  fi
}

# received <index> <field>
received() {
  node -e "
    const lines = require('fs').readFileSync(process.argv[1], 'utf8').trim().split('\n').filter(Boolean);
    const row = lines[Number(process.argv[2])];
    if (!row) { process.stdout.write(''); process.exit(0); }
    const value = JSON.parse(row)[process.argv[3]];
    process.stdout.write(Array.isArray(value) ? value.join(',') : String(value ?? ''));
  " "$INBOX" "$1" "$2"
}

count_received() {
  # awk rather than grep -c: grep exits non-zero on no matches, which under
  # `set -e` turns an empty inbox into a failure instead of a zero.
  awk 'END { print NR }' "$INBOX"
}

queue() {
  psql "$PSQL_URL" -qc "
    insert into message_log (branch_id, template_code, channel, recipient, subject, body, status)
    values ((select id from branches order by name limit 1), 'service_complete', 'email',
            '$1', '$2', '$3', 'queued')"
}

drain() {
  MAIL_DRIVER=smtp \
  MAIL_FROM='Avalanche CRM <no-reply@avcrm.test>' \
  MAIL_REPLY_TO='office@avcrm.test' \
  SMTP_HOST=127.0.0.1 SMTP_PORT="$PORT" SMTP_SECURE=false \
  "$@" \
  npm run --silent job:message-queue 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g'
}

echo "== starting a real SMTP server on $PORT =="
node scripts/mail-sink.js "$PORT" "$INBOX" &
SINK_PID=$!
sleep 1.5

# Nothing left over from another run should be in flight.
psql "$PSQL_URL" -qc "update message_log set status = 'sent', sent_at = now() where status = 'queued'"

echo
echo "== a queued message is delivered over SMTP =="
queue 'harold.bell@example.test' 'Driveway done' 'Hi Harold, the driveway is clear.'
drain > /dev/null
assert "one message arrived" "$(count_received)" "1"
assert "envelope sender" "$(received 0 envelope_from)" "no-reply@avcrm.test"
assert "envelope recipient" "$(received 0 envelope_to)" "harold.bell@example.test"
assert "From header" "$(received 0 from)" "Avalanche CRM <no-reply@avcrm.test>"
assert "Reply-To header" "$(received 0 reply_to)" "office@avcrm.test"
assert "subject" "$(received 0 subject)" "Driveway done"
assert "body" "$(received 0 body)" "Hi Harold, the driveway is clear."
# The log row and the provider's copy can be tied together afterwards.
CORRELATION="$(received 0 correlation)"
assert "carries a correlation header" \
  "$(node -e "process.stdout.write(String(/^[0-9a-f-]{36}$/.test(process.argv[1])))" "$CORRELATION")" \
  "true"
assert "and it is the message_log id" \
  "$(psql "$PSQL_URL" -tAc "select count(*) from message_log where id = '$CORRELATION'")" "1"

echo
echo "== a permanent rejection is not retried =="
: > "$INBOX"
queue 'gone@example.test' 'Bounce' 'This address does not exist.'
drain > /dev/null
assert "nothing was delivered" "$(count_received)" "0"
assert "the row is failed, not queued" \
  "$(psql "$PSQL_URL" -tAc "select status from message_log where recipient = 'gone@example.test' order by created_at desc limit 1")" \
  "failed"
# One attempt, not the full budget: a 550 is an answer, not a blip.
assert "after a single attempt" \
  "$(psql "$PSQL_URL" -tAc "select attempts from message_log where recipient = 'gone@example.test' order by created_at desc limit 1")" \
  "1"
# Assert against the row rather than the log: if a later run had picked it up
# again, attempts would have moved.
drain > /dev/null
assert "and a later run leaves it alone" \
  "$(psql "$PSQL_URL" -tAc "select attempts from message_log where recipient = 'gone@example.test' order by created_at desc limit 1")" \
  "1"

echo
echo "== the staging valve diverts everything =="
: > "$INBOX"
queue 'priya.raman@example.test' 'Your invoice' 'Hi Priya, your invoice is ready.'
MAIL_REDIRECT_TO='staging@avcrm.test' drain > /dev/null
assert "delivered to the redirect" "$(received 0 envelope_to)" "staging@avcrm.test"
assert "with the real recipient kept in the subject" \
  "$(received 0 subject)" "[to: priya.raman@example.test] Your invoice"

echo
echo "== the default driver sends nothing =="
: > "$INBOX"
queue 'nobody@example.test' 'Log only' 'Should not leave the process.'
npm run --silent job:message-queue > /dev/null 2>&1
assert "nothing reached the mail server" "$(count_received)" "0"
assert "but the row is marked sent" \
  "$(psql "$PSQL_URL" -tAc "select status from message_log where recipient = 'nobody@example.test' order by created_at desc limit 1")" \
  "sent"

echo
echo "All $pass mail checks passed."
