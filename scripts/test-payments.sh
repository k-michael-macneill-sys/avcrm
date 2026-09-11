#!/usr/bin/env bash
#
# Verifies the Stripe integration by talking to a stand-in for the API.
#
#   npm run test:payments
#
# Starts scripts/stripe-fake.js and its own API server pointed at it, then
# drives the whole path over HTTP: ask for a card, complete the capture, charge
# the saved card, take a decline, refund, and prove a webhook is only believed
# when its signature checks out. Needs the database; starts everything else.

set -euo pipefail

STRIPE_PORT="${STRIPE_FAKE_PORT:-12111}"
API_PORT="${PAY_TEST_PORT:-3100}"
BASE_URL="http://127.0.0.1:$API_PORT"
PSQL_URL="${DATABASE_URL:-postgres://avcrm:avcrm@localhost:5432/avcrm}"
WEBHOOK_SECRET="whsec_test_secret_for_the_suite"
BODY="$(mktemp -t avcrm-pay.XXXXXX)"
API_LOG="$(mktemp -t avcrm-pay-api.XXXXXX)"
FAKE_LOG="$(mktemp -t avcrm-pay-fake.XXXXXX)"
pass=0

# Both servers are started with setsid, so each one is its own process group
# and a single kill takes the whole tree. Killing only the process we spawned
# leaves the real server orphaned: tsx runs it in a child, and that child keeps
# holding this script's stdout, so the caller waits forever on a pipe that
# nothing is left to close.
cleanup() {
  local pid
  for pid in "${API_PID:-}" "${FAKE_PID:-}"; do
    [[ -n "$pid" ]] && kill -TERM -- "-$pid" 2>/dev/null
  done
  rm -f "$BODY" "$API_LOG" "$FAKE_LOG"
  return 0
}
trap cleanup EXIT

export BODY_PATH="$BODY"

assert() {
  if [[ "$2" == "$3" ]]; then
    echo "  ok   $1 = $2"
    pass=$((pass + 1))
  else
    echo "  FAIL $1 = '$2' (expected '$3')"
    exit 1
  fi
}

call() {
  local expected="$1" method="$2" path="$3" body="${4:-}"
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path")
  [[ -n "${TOKEN:-}" ]] && args+=(-H "Authorization: Bearer $TOKEN")
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' -d "$body")

  local status
  status="$(curl "${args[@]}")"
  if [[ "$status" == "$expected" ]]; then
    echo "  ok   $method $path -> $status"
    pass=$((pass + 1))
  else
    echo "  FAIL $method $path -> $status (expected $expected)"
    cat "$BODY"; echo
    exit 1
  fi
}

field() {
  node -e "
    let v = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH, 'utf8'));
    for (const k of process.argv[1].split('.')) v = v?.[k];
    process.stdout.write(String(v ?? ''));
  " "$1"
}

echo "== starting the Stripe stand-in and an API pointed at it =="
setsid node scripts/stripe-fake.js "$STRIPE_PORT" >"$FAKE_LOG" 2>&1 &
FAKE_PID=$!

setsid env \
  PORT="$API_PORT" \
  PAYMENT_GATEWAY=stripe \
  STRIPE_SECRET_KEY=sk_test_suite \
  STRIPE_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  STRIPE_API_HOST=127.0.0.1 \
  STRIPE_API_PORT="$STRIPE_PORT" \
  STRIPE_API_PROTOCOL=http \
  LOG_LEVEL=warn \
  ./node_modules/.bin/tsx src/server.ts >"$API_LOG" 2>&1 &
API_PID=$!

wait_for() {
  local name="$1" url="$2" log="$3" i
  for ((i = 0; i < 30; i++)); do
    if curl -sS -m 2 "$url" >/dev/null 2>&1; then
      echo "  ok   $name is up"
      return 0
    fi
    sleep 1
  done
  echo "  FAIL $name never came up on $url"
  cat "$log"
  exit 1
}
wait_for "the Stripe stand-in" "http://127.0.0.1:$STRIPE_PORT/v1/ping" "$FAKE_LOG"
wait_for "the API" "$BASE_URL/health" "$API_LOG"

TOKEN=""
call 200 POST /auth/login '{"email":"corporate@avcrm.test","password":"Password123!"}'
TOKEN="$(field data.token)"

# The seeded Halifax contract has no card on file, which is the case this
# whole flow exists for.
call 200 GET '/contracts?status=active&page_size=20'
CONTRACT_ID="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  const c = d.find(x => x.payment_method_last4 === null);
  process.stdout.write(c ? c.id : '');
")"
if [[ -z "$CONTRACT_ID" ]]; then
  echo "  FAIL no card-less contract in the seed"
  exit 1
fi

echo
echo "== asking the customer for a card =="
call 201 POST /card-setups "{\"contract_id\":\"$CONTRACT_ID\"}"
SETUP_ID="$(field data.setup.id)"
SETUP_URL="$(field data.url)"
assert "the link points at the processor, not at us" \
  "$(node -e "process.stdout.write(String(process.argv[1].startsWith('https://checkout.stripe.test/')))" "$SETUP_URL")" \
  "true"
assert "and it starts out unfinished" "$(field data.setup.status)" "sent"
assert "the customer now exists at the processor" \
  "$(psql "$PSQL_URL" -tAc "select stripe_customer_id is not null from customers where id = (select customer_id from card_setups where id = '$SETUP_ID')")" \
  "t"
# The link is queued to the customer through the same outbound queue.
assert "the link was queued to them" \
  "$(psql "$PSQL_URL" -tAc "select count(*) from message_log where template_code = 'card_setup_request'")" \
  "1"
assert "and the queued body carries the link" \
  "$(psql "$PSQL_URL" -tAc "select body like '%checkout.stripe.test%' from message_log where template_code = 'card_setup_request'")" \
  "t"

echo
echo "== the customer finishes it on their own phone =="
call 200 POST "/card-setups/$SETUP_ID/refresh"
assert "the capture is recorded complete" "$(field data.status)" "completed"
assert "with the card's last four" "$(field data.payment_method_last4)" "4242"

call 200 GET "/contracts/$CONTRACT_ID"
assert "the card is on the contract" "$(field data.payment_method_last4)" "4242"
assert "and no card number ever reached us" \
  "$(psql "$PSQL_URL" -tAc "select payment_method_token like 'pm_%' from contracts where id = '$CONTRACT_ID'")" \
  "t"
assert "the card_on_file box ticked itself" \
  "$(node -e "
    const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
    process.stdout.write(String(d.checklist.find(i => i.item_code === 'card_on_file').checked));
  ")" "true"

echo
echo "== charging the saved card, with nobody present =="
call 201 POST /invoices "{
  \"contract_id\": \"$CONTRACT_ID\",
  \"billing_period_start\": \"2027-01-01\",
  \"billing_period_end\": \"2027-01-31\",
  \"amount_due\": 149.5,
  \"due_date\": \"2027-01-15\"
}"
INVOICE_ID="$(field data.id)"
call 200 POST "/invoices/$INVOICE_ID/send"
call 200 POST "/invoices/$INVOICE_ID/charge"
assert "the invoice is paid" "$(field data.status)" "paid"
assert "for the full amount" "$(field data.amount_paid)" "149.50"
assert "against a real payment intent" \
  "$(node -e "
    const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
    const p = d.payments.find(x => x.status === 'succeeded');
    process.stdout.write(String(p.provider_transaction_id.startsWith('pi_')));
  ")" "true"
# Charging a settled invoice is refused rather than charged twice.
call 409 POST "/invoices/$INVOICE_ID/charge"

echo
echo "== a declined card is an answer, not a crash =="
psql "$PSQL_URL" -qc "update contracts set payment_method_token = 'pm_card_declined' where id = '$CONTRACT_ID'"
call 201 POST /invoices "{
  \"contract_id\": \"$CONTRACT_ID\",
  \"billing_period_start\": \"2027-02-01\",
  \"billing_period_end\": \"2027-02-28\",
  \"amount_due\": 99,
  \"due_date\": \"2027-02-15\"
}"
DECLINED_INVOICE="$(field data.id)"
call 200 POST "/invoices/$DECLINED_INVOICE/send"
call 200 POST "/invoices/$DECLINED_INVOICE/charge"
assert "nothing was collected" "$(field data.amount_paid)" "0.00"
assert "and the failure says why" \
  "$(node -e "
    const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
    process.stdout.write(d.payments.find(p => p.status === 'failed').failure_reason);
  ")" "Your card has insufficient funds."
# The spec's rule: a failed card tells the customer and flags the manager.
assert "both notices are queued" \
  "$(psql "$PSQL_URL" -tAc "select count(*) from message_log where template_code in ('payment_failed','payment_failed_internal')")" \
  "2"

echo
echo "== webhooks are only believed when signed =="
UNSIGNED="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/webhooks/stripe" \
  -H 'Content-Type: application/json' -d '{"id":"evt_1","type":"payment_intent.succeeded"}')"
assert "an unsigned webhook is refused" "$UNSIGNED" "400"

BAD="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/webhooks/stripe" \
  -H 'Content-Type: application/json' -H 'stripe-signature: t=1,v1=deadbeef' \
  -d '{"id":"evt_1","type":"payment_intent.succeeded"}')"
assert "so is a forged signature" "$BAD" "400"

# A real refund event, signed the way Stripe signs one.
PAID_INTENT="$(psql "$PSQL_URL" -tAc "select provider_transaction_id from payments where invoice_id = '$INVOICE_ID' and status = 'succeeded'")"
node -e "
  const Stripe = require('stripe');
  const payload = JSON.stringify({
    id: 'evt_refund_1',
    type: 'charge.refunded',
    data: { object: { object: 'charge', payment_intent: process.argv[1] } },
  });
  const header = Stripe.webhooks.generateTestHeaderString({
    payload, secret: process.argv[2],
  });
  require('fs').writeFileSync('/tmp/avcrm-webhook.json', payload);
  require('fs').writeFileSync('/tmp/avcrm-webhook.sig', header);
" "$PAID_INTENT" "$WEBHOOK_SECRET"

SIGNED="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/webhooks/stripe" \
  -H 'Content-Type: application/json' \
  -H "stripe-signature: $(cat /tmp/avcrm-webhook.sig)" \
  --data-binary @/tmp/avcrm-webhook.json)"
assert "a properly signed one is accepted" "$SIGNED" "200"
assert "and the refund landed on the payment" \
  "$(psql "$PSQL_URL" -tAc "select status from payments where provider_transaction_id = '$PAID_INTENT'")" \
  "refunded"
assert "which put the invoice back to owing" \
  "$(psql "$PSQL_URL" -tAc "select amount_paid from invoices where id = '$INVOICE_ID'")" \
  "0.00"

# Stripe redelivers; doing it twice must change nothing.
curl -sS -o /dev/null -X POST "$BASE_URL/webhooks/stripe" \
  -H 'Content-Type: application/json' \
  -H "stripe-signature: $(cat /tmp/avcrm-webhook.sig)" \
  --data-binary @/tmp/avcrm-webhook.json
assert "a replayed webhook is harmless" \
  "$(psql "$PSQL_URL" -tAc "select count(*) from payments where provider_transaction_id = '$PAID_INTENT'")" \
  "1"

rm -f /tmp/avcrm-webhook.json /tmp/avcrm-webhook.sig

echo
echo "All $pass payment checks passed."
