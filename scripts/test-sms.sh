#!/usr/bin/env bash
#
# Verifies the SMS integration by talking to a stand-in for a gateway.
#
#   npm run test:sms
#
# Starts scripts/sms-fake.js and its own API server pointed at it, then does
# what an administrator would: pick a provider, save credentials, send a test,
# switch it on, and let the queue drain a real message. Also checks the parts
# that are easy to get wrong — that a credential is never readable back, that a
# bad number is not retried and a gateway outage is, and that the custom
# provider can reach a gateway nobody wrote code for.

set -euo pipefail

SMS_PORT="${SMS_FAKE_PORT:-12222}"
API_PORT="${SMS_TEST_PORT:-3102}"
BASE_URL="http://127.0.0.1:$API_PORT"
FAKE_URL="http://127.0.0.1:$SMS_PORT"
PSQL_URL="${DATABASE_URL:-postgres://avcrm:avcrm@localhost:5432/avcrm}"
BODY="$(mktemp -t avcrm-sms.XXXXXX)"
API_LOG="$(mktemp -t avcrm-sms-api.XXXXXX)"
FAKE_LOG="$(mktemp -t avcrm-sms-fake.XXXXXX)"
pass=0

# setsid puts each server in its own process group so one kill takes the whole
# tree — tsx runs the server in a child, and an orphan holds this script's
# stdout open long after it has finished.
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
    process.stdout.write(v === undefined || v === null ? '' : String(v));
  " "$1"
}

sent_count() { curl -sS "$FAKE_URL/_sent" | node -e "
  let d = ''; process.stdin.on('data', c => d += c).on('end', () => {
    process.stdout.write(String(JSON.parse(d).sent.length));
  });
"; }

last_sent() { curl -sS "$FAKE_URL/_sent" | node -e "
  let d = ''; process.stdin.on('data', c => d += c).on('end', () => {
    const s = JSON.parse(d).sent;
    const last = s[s.length - 1] ?? {};
    process.stdout.write(String(last[process.argv[1]] ?? ''));
  });
" "$1"; }

# The worker is its own process, so it needs the stand-in's address too —
# without it the job would go looking for the real gateway.
queue() {
  SMS_API_BASE="$FAKE_URL" LOG_LEVEL=warn \
    npm run job:message-queue --silent >/dev/null 2>&1 || true
}

echo "== starting the gateway stand-in and an API pointed at it =="
setsid node scripts/sms-fake.js "$SMS_PORT" >"$FAKE_LOG" 2>&1 &
FAKE_PID=$!

setsid env \
  PORT="$API_PORT" \
  SMS_API_BASE="$FAKE_URL" \
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
wait_for "the gateway stand-in" "$FAKE_URL/_sent" "$FAKE_LOG"
wait_for "the API" "$BASE_URL/health" "$API_LOG"

TOKEN=""
call 200 POST /auth/login '{"email":"corporate@avcrm.test","password":"Password123!"}'
TOKEN="$(field data.token)"

echo
echo "== settings are the administrator's, not everyone's =="
OPERATOR="$(curl -sS -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"nina@avcrm.test","password":"Password123!"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).data.token))")"
assert "an operator cannot read them" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/settings/sms" -H "Authorization: Bearer $OPERATOR")" \
  "403"
assert "nor change them" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$BASE_URL/settings/sms" \
    -H "Authorization: Bearer $OPERATOR" -H 'Content-Type: application/json' \
    -d '{"provider":"twilio","is_enabled":true}')" \
  "403"

call 200 GET /settings/sms
assert "nothing is configured to begin with" "$(field data.provider)" "none"
assert "and nothing is being sent" "$(field data.is_enabled)" "false"

call 200 GET /settings/sms/providers
assert "the screen has providers to offer" \
  "$(node -e "
    const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
    process.stdout.write(d.map(p => p.id).join(','));
  ")" \
  "twilio,telnyx,messagebird,vonage,custom"

echo
echo "== switching it on needs the credentials it says it needs =="
call 400 PUT /settings/sms \
  '{"provider":"twilio","is_enabled":true,"settings":{"from":"+19025550123"},"secrets":{}}'
assert "and it says which ones are missing" \
  "$(node -e "
    const e = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).error;
    process.stdout.write(String(e.message.includes('Account SID') && e.message.includes('Auth token')));
  ")" "true"

echo
echo "== an administrator connects Twilio =="
call 200 PUT /settings/sms '{
  "provider": "twilio",
  "is_enabled": false,
  "settings": { "account_sid": "AC_test_account", "from": "+19025550123" },
  "secrets": { "auth_token": "super-secret-token" }
}'
assert "the provider is saved" "$(field data.provider)" "twilio"
assert "the token is recorded as set" "$(field data.secrets_set)" "auth_token"
assert "but never sent back" \
  "$(grep -c 'super-secret-token' "$BODY" || true)" "0"
assert "and it is not readable in the database either" \
  "$(psql "$PSQL_URL" -tAc "select secret_ciphertext like '%super-secret-token%' from integration_settings where key = 'sms'")" \
  "f"
assert "the change is in the audit log" \
  "$(psql "$PSQL_URL" -tAc "select count(*) from audit_log where action = 'integration.updated'")" \
  "1"
assert "with no credential in it" \
  "$(psql "$PSQL_URL" -tAc "select count(*) from audit_log where after_json::text like '%super-secret-token%'")" \
  "0"

echo
echo "== a test send goes out before it is switched on =="
call 200 POST /settings/sms/test '{"to":"+19025551234","body":"Test from the suite"}'
assert "the gateway got it" "$(sent_count)" "1"
assert "as Twilio" "$(last_sent provider)" "twilio"
assert "from the configured number" "$(last_sent from)" "+19025550123"
assert "with the credentials it was given" "$(last_sent account)" "AC_test_account"
assert "and the text that was typed" "$(last_sent body)" "Test from the suite"

echo
echo "== a refused test is an answer, not a 500 =="
call 400 POST /settings/sms/test '{"to":"+15550000400"}'
assert "a bad number will not be retried" "$(field error.details.permanent)" "true"
call 502 POST /settings/sms/test '{"to":"+15550000503"}'
assert "a gateway outage will be" "$(field error.details.permanent)" "false"

echo
echo "== queued messages only go out once it is switched on =="
psql "$PSQL_URL" -qc "delete from message_log"
psql "$PSQL_URL" -qc "
  insert into message_log (template_code, channel, recipient, body, branch_id, status)
  select 'en_route', 'sms', '+19025559999', 'Your crew is on the way.', id, 'queued'
  from branches order by name limit 1"
queue
assert "nothing left while it was off" "$(sent_count)" "1"
assert "though the row says it was handled" \
  "$(psql "$PSQL_URL" -tAc "select status from message_log where recipient = '+19025559999'")" \
  "sent"

call 200 PUT /settings/sms '{
  "provider": "twilio",
  "is_enabled": true,
  "settings": { "account_sid": "AC_test_account", "from": "+19025550123" },
  "secrets": {}
}'
assert "switched on" "$(field data.is_enabled)" "true"
assert "without retyping the token" "$(field data.secrets_set)" "auth_token"

psql "$PSQL_URL" -qc "
  insert into message_log (template_code, channel, recipient, body, branch_id, status)
  select 'en_route', 'sms', '+19025558888', 'Your crew is on the way.', id, 'queued'
  from branches order by name limit 1"
queue
assert "now it really sends" "$(sent_count)" "2"
assert "to the customer" "$(last_sent to)" "+19025558888"
assert "and the provider's id is on the row" \
  "$(psql "$PSQL_URL" -tAc "select provider_message_id like 'SM%' from message_log where recipient = '+19025558888'")" \
  "t"

echo
echo "== the queue tells a bad number from a bad afternoon =="
psql "$PSQL_URL" -qc "
  insert into message_log (template_code, channel, recipient, body, branch_id, status)
  select 'en_route', 'sms', '+15550000400', 'Bad number.', id, 'queued'
  from branches order by name limit 1"
queue
assert "a rejected number stops at once" \
  "$(psql "$PSQL_URL" -tAc "select status from message_log where recipient = '+15550000400'")" \
  "failed"
assert "after a single attempt" \
  "$(psql "$PSQL_URL" -tAc "select attempts from message_log where recipient = '+15550000400'")" \
  "1"

psql "$PSQL_URL" -qc "
  insert into message_log (template_code, channel, recipient, body, branch_id, status)
  select 'en_route', 'sms', '+15550000503', 'Gateway trouble.', id, 'queued'
  from branches order by name limit 1"
queue
assert "an outage goes back in the queue" \
  "$(psql "$PSQL_URL" -tAc "select status from message_log where recipient = '+15550000503'")" \
  "queued"

echo
echo "== switching provider does not carry the old credentials across =="
call 200 PUT /settings/sms '{
  "provider": "telnyx",
  "is_enabled": false,
  "settings": { "from": "+19025550123" },
  "secrets": {}
}'
assert "the Twilio token is gone" "$(field data.secrets_set)" ""
call 400 POST /settings/sms/test '{"to":"+19025551234"}'
assert "so Telnyx refuses without its own key" \
  "$(node -e "
    const e = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).error;
    process.stdout.write(String(e.message.includes('401')));
  ")" "true"

call 200 PUT /settings/sms '{
  "provider": "telnyx",
  "is_enabled": true,
  "settings": { "from": "+19025550123" },
  "secrets": { "api_key": "KEY_test" }
}'
call 200 POST /settings/sms/test '{"to":"+19025551234"}'
assert "Telnyx takes it in its own shape" "$(last_sent provider)" "telnyx"

echo
echo "== a gateway nobody wrote code for =="
call 200 PUT /settings/sms "{
  \"provider\": \"custom\",
  \"is_enabled\": true,
  \"settings\": {
    \"url\": \"$FAKE_URL/custom/send\",
    \"content_type\": \"json\",
    \"auth_header_name\": \"x-api-key\",
    \"from\": \"AVALANCHE\",
    \"body_template\": \"{\\\"destination\\\":\\\"{{to}}\\\",\\\"sender\\\":\\\"{{from}}\\\",\\\"message\\\":\\\"{{body}}\\\"}\",
    \"message_id_path\": \"result.reference\"
  },
  \"secrets\": { \"auth_header_value\": \"custom-secret\" }
}"
call 200 POST /settings/sms/test '{"to":"+19025557777","body":"Quoted \"text\" and a backslash \\ in it"}'
assert "it reached the custom gateway" "$(last_sent provider)" "custom"
assert "with the sender it was told to use" "$(last_sent from)" "AVALANCHE"
# The template is filled in by substitution, so a quote in the message must
# not be able to break out of the JSON string it sits in.
assert "and quoting in the message survived intact" \
  "$(last_sent body)" 'Quoted "text" and a backslash \ in it'
assert "the id came from the configured path" \
  "$(node -e "
    const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
    process.stdout.write(String(d.provider_message_id.startsWith('cx')));
  ")" "true"

echo
echo "== turning it off stops it =="
call 200 PUT /settings/sms '{"provider":"none","is_enabled":false,"settings":{},"secrets":{}}'
assert "back to nothing configured" "$(field data.provider)" "none"
BEFORE="$(sent_count)"
psql "$PSQL_URL" -qc "
  insert into message_log (template_code, channel, recipient, body, branch_id, status)
  select 'en_route', 'sms', '+19025556666', 'Nothing should send.', id, 'queued'
  from branches order by name limit 1"
queue
assert "and nothing more goes out" "$(sent_count)" "$BEFORE"

echo
echo "All $pass SMS checks passed."
