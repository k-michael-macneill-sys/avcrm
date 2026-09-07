#!/usr/bin/env bash
#
# Smoke test for the avcrm API. Start the server first:
#
#   npm run migrate && npm run seed && npm run dev
#   ./scripts/test-api.sh
#
# Every step prints the request and the response body. The script exits
# non-zero on the first unexpected HTTP status.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
EMAIL="${EMAIL:-admin@avcrm.test}"
PASSWORD="${PASSWORD:-Password123!}"

pass=0

# call <expected-status> <method> <path> [json-body] -- prints body, sets RESPONSE
call() {
  local expected="$1" method="$2" path="$3" body="${4:-}"
  local args=(-sS -o /tmp/avcrm-body.json -w '%{http_code}' -X "$method" "$BASE_URL$path")

  [[ -n "${TOKEN:-}" ]] && args+=(-H "Authorization: Bearer $TOKEN")
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json' -d "$body")
  fi

  local status
  status="$(curl "${args[@]}")"
  RESPONSE="$(cat /tmp/avcrm-body.json)"

  if [[ "$status" == "$expected" ]]; then
    echo "  ok   $method $path -> $status"
    pass=$((pass + 1))
  else
    echo "  FAIL $method $path -> $status (expected $expected)"
    echo "$RESPONSE"
    exit 1
  fi
}

# Reads a top-level-ish field out of the JSON body without needing jq.
field() {
  node -e "
    const body = require('fs').readFileSync('/tmp/avcrm-body.json', 'utf8');
    const path = process.argv[1].split('.');
    let value = JSON.parse(body);
    for (const key of path) value = value?.[key];
    process.stdout.write(String(value ?? ''));
  " "$1"
}

echo "== health =="
call 200 GET /health

echo
echo "== auth =="
call 401 GET /auth/me
call 200 POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
TOKEN="$(field data.token)"
echo "  token: ${TOKEN:0:24}..."
call 200 GET /auth/me
call 401 POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"wrong-password\"}"
call 400 POST /auth/login '{"email":"not-an-email","password":"x"}'

# Registering without an admin token must not grant the requested role.
SAVED_TOKEN="$TOKEN"
TOKEN=""
call 201 POST /auth/register "{
  \"email\": \"selfsignup-$$@avcrm.test\",
  \"password\": \"Password123!\",
  \"name\": \"Self Signup\",
  \"role\": \"admin\"
}"
ROLE="$(field data.role)"
if [[ "$ROLE" != "operator" ]]; then
  echo "  FAIL self-registration granted role '$ROLE' (expected operator)"
  exit 1
fi
echo "  ok   self-registration downgraded admin -> operator"
pass=$((pass + 1))
TOKEN="$SAVED_TOKEN"

# An admin token may set the role.
call 201 POST /auth/register "{
  \"email\": \"admin-made-$$@avcrm.test\",
  \"password\": \"Password123!\",
  \"name\": \"Admin Made\",
  \"role\": \"dispatcher\"
}"
call 409 POST /auth/register "{
  \"email\": \"admin-made-$$@avcrm.test\",
  \"password\": \"Password123!\",
  \"name\": \"Duplicate\"
}"

echo
echo "== branches =="
call 200 GET /branches
BRANCH_ID="$(field data.0.id)"
echo "  branch: $BRANCH_ID"

echo
echo "== customers (full CRUD) =="
call 200 GET "/customers?page=1&page_size=2"
echo "  total: $(field meta.total)"
call 200 GET "/customers?contract_status=active"
call 200 GET "/customers?search=harbour"

STAMP="$(date +%s)"
call 201 POST /customers "{
  \"name\": \"Smoke Test Property $STAMP\",
  \"phone\": \"902-555-0199\",
  \"address\": \"1 Test Lane\",
  \"email\": \"smoke-$STAMP@example.test\",
  \"contract_status\": \"pending\"
}"
CUSTOMER_ID="$(field data.id)"
echo "  customer: $CUSTOMER_ID"

call 200 GET "/customers/$CUSTOMER_ID"
call 200 PATCH "/customers/$CUSTOMER_ID" '{"contract_status":"active","phone":"902-555-0200"}'
call 400 POST /customers '{"name":""}'
call 404 GET "/customers/00000000-0000-0000-0000-000000000000"
call 400 GET "/customers/not-a-uuid"

echo
echo "== jobs =="
call 200 GET "/jobs?status=scheduled"
call 201 POST /jobs "{
  \"customer_id\": \"$CUSTOMER_ID\",
  \"status\": \"scheduled\",
  \"scheduled_date\": \"2026-01-15T06:00:00.000Z\",
  \"notes\": \"Smoke test job\"
}"
JOB_ID="$(field data.id)"
call 200 PATCH "/jobs/$JOB_ID/status" '{"status":"completed"}'
echo "  completed_date: $(field data.completed_date)"

echo
echo "== contracts =="
call 200 GET /contracts
call 201 POST /contracts "{
  \"customer_id\": \"$CUSTOMER_ID\",
  \"price\": 7500.00,
  \"start_date\": \"2026-11-01\",
  \"end_date\": \"2027-04-30\",
  \"auto_renew\": true,
  \"terms\": \"Smoke test seasonal contract\"
}"
call 400 POST /contracts "{
  \"customer_id\": \"$CUSTOMER_ID\",
  \"price\": 100,
  \"start_date\": \"2027-01-01\",
  \"end_date\": \"2026-01-01\"
}"

echo
echo "== payments (mock gateway) =="
call 200 GET /payments
call 201 POST /payments "{
  \"customer_id\": \"$CUSTOMER_ID\",
  \"amount\": 3750.00,
  \"method\": \"card\",
  \"description\": \"Smoke test deposit\"
}"
echo "  status: $(field data.status)  reference: $(field data.reference)"
call 201 POST /payments "{
  \"customer_id\": \"$CUSTOMER_ID\",
  \"amount\": 100.00,
  \"method\": \"check\"
}"
call 400 POST /payments "{\"customer_id\":\"$CUSTOMER_ID\",\"amount\":-5,\"method\":\"card\"}"

echo
echo "== delete guards =="
# This customer now has payment history, so the delete is refused.
call 409 DELETE "/customers/$CUSTOMER_ID"

# A customer with no payments and no open jobs deletes cleanly.
call 201 POST /customers "{\"name\": \"Disposable Property $STAMP\"}"
THROWAWAY_ID="$(field data.id)"
call 204 DELETE "/customers/$THROWAWAY_ID"
call 404 GET "/customers/$THROWAWAY_ID"

echo
echo "== unknown route =="
call 404 GET /nope

echo
echo "All $pass checks passed."
