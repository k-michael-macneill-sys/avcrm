#!/usr/bin/env bash
#
# Smoke test for the avcrm API. Start the server first:
#
#   npm run migrate && npm run seed && npm run dev
#   ./scripts/test-api.sh
#
# Asserts status codes and exits non-zero on the first surprise.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
PASSWORD="${PASSWORD:-Password123!}"
CORPORATE_EMAIL="${CORPORATE_EMAIL:-corporate@avcrm.test}"

pass=0
BODY=/tmp/avcrm-body.json

# call <expected-status> <method> <path> [json-body]
call() {
  local expected="$1" method="$2" path="$3" body="${4:-}"
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path")

  [[ -n "${TOKEN:-}" ]] && args+=(-H "Authorization: Bearer $TOKEN")
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json' -d "$body")
  fi

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

# assert <label> <actual> <expected>
assert() {
  if [[ "$2" == "$3" ]]; then
    echo "  ok   $1 = $2"
    pass=$((pass + 1))
  else
    echo "  FAIL $1 = '$2' (expected '$3')"
    exit 1
  fi
}

field() {
  node -e "
    const body = require('fs').readFileSync(process.env.BODY_PATH, 'utf8');
    let value = JSON.parse(body);
    for (const key of process.argv[1].split('.')) value = value?.[key];
    process.stdout.write(String(value ?? ''));
  " "$1"
}
export BODY_PATH="$BODY"

login() {
  TOKEN=""
  call 200 POST /auth/login "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}"
  TOKEN="$(field data.token)"
}

echo "== health =="
call 200 GET /health

echo
echo "== auth =="
call 401 GET /auth/me
call 400 POST /auth/login '{"email":"not-an-email","password":"x"}'
call 401 POST /auth/login "{\"email\":\"$CORPORATE_EMAIL\",\"password\":\"wrong\"}"
login "$CORPORATE_EMAIL"
call 200 GET /auth/me
assert "corporate role" "$(field data.role)" "corporate"
CORP_ID="$(field data.id)"

echo
echo "== branches (corporate sees all) =="
call 200 GET /branches
KINGSTON="$(node -e "
  const b = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(b.find(x => x.name === 'Kingston').id);
")"
HALIFAX="$(node -e "
  const b = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(b.find(x => x.name === 'Halifax').id);
")"
echo "  kingston: $KINGSTON"

echo
echo "== document requirements (province aware) =="
call 200 GET '/document-requirements?province=ON'
ON_COUNT="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(String(d.length));
")"
call 200 GET '/document-requirements?province=NS'
NS_COUNT="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(String(d.length));
")"
# Ontario adds WSIB clearance on top of the global set.
assert "ON has one more requirement than NS" "$((ON_COUNT - NS_COUNT))" "1"

echo
echo "== operators and the onboarding gate =="
call 200 GET /operators
call 200 GET '/operators?assignable=true'
ASSIGNABLE="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(d.map(u => u.email).sort().join(','));
")"
assert "assignable pool excludes pending operator" "$ASSIGNABLE" "nina@avcrm.test,otto@avcrm.test"

call 200 GET '/users?role=operator'
PAT_ID="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(d.find(u => u.email === 'pat@avcrm.test').id);
")"
call 200 GET "/operators/$PAT_ID/compliance"
assert "operator missing required docs is not assignable" "$(field data.assignable)" "false"
call 200 GET "/operators/$PAT_ID/documents"

echo
echo "== document review flow =="
# Submit a fresh document rather than consuming seed data, so this section is
# re-runnable: rejecting frees the requirement slot again.
call 201 POST "/operators/$PAT_ID/documents" '{
  "requirement_code": "criminal_record_check",
  "file_url": "private/operator-docs/pat/crc.pdf",
  "file_name": "crc.pdf",
  "mime_type": "application/pdf",
  "file_size": 91024,
  "issued_on": "2026-02-01"
}'
DOC_ID="$(field data.id)"
# expires_on is derived from issued_on + the requirement's validity (1095 days).
assert "expiry derived from issued_on" "$(field data.expires_on)" "2029-01-31"
call 400 PATCH "/operators/documents/$DOC_ID/review" '{"status":"rejected"}'
call 200 PATCH "/operators/documents/$DOC_ID/review" '{"status":"rejected","rejection_reason":"Photo is unreadable"}'
assert "document rejected" "$(field data.status)" "rejected"
call 409 PATCH "/operators/documents/$DOC_ID/review" '{"status":"approved"}'

echo
echo "== customers =="
call 200 GET '/customers?page=1&page_size=3'
call 200 GET "/customers?branch_id=$HALIFAX"
assert "halifax customer count" "$(field meta.total)" "1"
call 200 GET '/customers?status=lead'
call 200 GET '/customers?search=raman'
assert "search finds Priya" "$(field meta.total)" "1"

# Corporate has no branch of its own, so a write must name one.
call 400 POST /customers '{"first_name":"No","last_name":"Branch","email":"nb@example.test"}'

STAMP="$(date +%s)"
call 201 POST /customers "{
  \"branch_id\": \"$KINGSTON\",
  \"first_name\": \"Smoke\",
  \"last_name\": \"Test $STAMP\",
  \"email\": \"smoke-$STAMP@example.test\",
  \"phone\": \"613-555-0999\",
  \"preferred_contact\": \"both\",
  \"status\": \"lead\"
}"
CUSTOMER_ID="$(field data.id)"
CREATED_BY="$(field data.created_by_user_id)"
assert "created_by records the signed-in rep" "$CREATED_BY" "$CORP_ID"

# preferred_contact must have the matching field on file.
call 400 POST /customers "{
  \"branch_id\": \"$KINGSTON\",
  \"first_name\": \"Bad\", \"last_name\": \"Contact\",
  \"preferred_contact\": \"sms\"
}"

call 200 GET "/customers/$CUSTOMER_ID"
call 200 PATCH "/customers/$CUSTOMER_ID" '{"status":"active"}'
call 404 GET "/customers/00000000-0000-0000-0000-000000000000"
call 400 GET "/customers/not-a-uuid"

echo
echo "== properties and the duplicate guard =="
call 200 GET "/customers/$CUSTOMER_ID/properties"

# Stamped so repeated runs do not collide with their own leftovers.
ADDR="77 Smoke Test Lane $STAMP"
ADDR_ENC="77%20Smoke%20Test%20Lane%20$STAMP"

call 201 POST /properties "{
  \"customer_id\": \"$CUSTOMER_ID\",
  \"address_line1\": \"$ADDR\",
  \"city\": \"Kingston\", \"province\": \"ON\", \"postal_code\": \"K7L 9Z9\",
  \"driveway_size_cars\": 3,
  \"access_notes\": \"Gate code 1234\",
  \"priority_flag\": true
}"
PROPERTY_ID="$(field data.id)"

# Same address, different spacing and case: the normalized index must catch it.
call 409 POST /properties "{
  \"customer_id\": \"$CUSTOMER_ID\",
  \"address_line1\": \"  77   SMOKE test LANE   $STAMP \",
  \"city\": \"Kingston\", \"province\": \"ON\", \"postal_code\": \"k7l9z9\"
}"

# And the pre-check warns before the rep ever submits.
call 200 GET "/properties/check-duplicate?postal_code=k7l9z9&address_line1=$ADDR_ENC"
assert "pre-check finds the duplicate" "$(field data.duplicate.property_id)" "$PROPERTY_ID"
call 200 GET "/properties/check-duplicate?postal_code=K1A0B1&address_line1=1%20Nowhere%20St"
# field() renders a JSON null as an empty string.
assert "pre-check clear on a fresh address" "$(field data.duplicate)" ""

call 400 POST /properties "{
  \"customer_id\": \"$CUSTOMER_ID\",
  \"address_line1\": \"9 Bad Driveway\",
  \"city\": \"Kingston\", \"province\": \"ON\", \"postal_code\": \"K7L 1A1\",
  \"driveway_size_cars\": 9
}"
call 200 PATCH "/properties/$PROPERTY_ID" '{"priority_flag":false}'
call 200 GET "/properties/$PROPERTY_ID"

echo
echo "== branch scoping: operator is hard-scoped =="
# Counts are taken now, against the same data the operator will query.
call 200 GET /customers
CORP_TOTAL="$(field meta.total)"
call 200 GET "/customers?branch_id=$KINGSTON"
KINGSTON_TOTAL="$(field meta.total)"

login otto@avcrm.test
assert "operator role" "$(field data.user.role)" "operator"
call 200 GET /customers
OP_TOTAL="$(field meta.total)"

assert "operator sees exactly their own branch" "$OP_TOTAL" "$KINGSTON_TOTAL"
if [[ "$OP_TOTAL" -ge "$CORP_TOTAL" ]]; then
  echo "  FAIL operator sees $OP_TOTAL of $CORP_TOTAL company-wide (expected fewer)"
  exit 1
fi
echo "  ok   operator sees $OP_TOTAL of $CORP_TOTAL company-wide"
pass=$((pass + 1))

call 403 GET "/customers?branch_id=$HALIFAX"
call 200 GET /branches
assert "operator sees only their own branch" "$(field data.1.id)" ""

# Operator-only endpoints corporate work is gated behind.
call 403 GET /users
call 403 POST /users "{\"email\":\"x-$STAMP@avcrm.test\",\"password\":\"Password123!\",\"first_name\":\"X\",\"last_name\":\"Y\",\"role\":\"corporate\"}"
call 403 PATCH "/operators/documents/$DOC_ID/review" '{"status":"approved"}'
call 403 GET "/operators/$PAT_ID/compliance"
call 403 GET "/operators/$PAT_ID/documents"

echo
echo "== operator self-service =="
login otto@avcrm.test
OTTO_ID="$(field data.user.id)"
call 200 GET "/operators/$OTTO_ID/compliance"
assert "otto is assignable" "$(field data.assignable)" "true"
assert "otto has no missing requirements" "$(field data.missing_required)" ""
call 409 POST "/operators/$OTTO_ID/documents" "{
  \"requirement_code\": \"drivers_license\",
  \"file_url\": \"private/x.pdf\", \"file_name\": \"x.pdf\",
  \"mime_type\": \"application/pdf\", \"file_size\": 1024,
  \"issued_on\": \"2026-01-01\"
}"
call 400 POST "/operators/$OTTO_ID/documents" "{
  \"requirement_code\": \"nonsense_code\",
  \"file_url\": \"private/x.pdf\", \"file_name\": \"x.pdf\",
  \"mime_type\": \"application/pdf\", \"file_size\": 1024
}"

echo
echo "== registration cannot escalate =="
TOKEN=""
call 201 POST /auth/register "{
  \"email\": \"selfsignup-$STAMP@avcrm.test\",
  \"password\": \"Password123!\",
  \"first_name\": \"Self\", \"last_name\": \"Signup\",
  \"branch_id\": \"$KINGSTON\",
  \"role\": \"corporate\"
}"
assert "self-registration forces operator role" "$(field data.role)" "operator"
assert "and starts unapproved" "$(field data.onboarding_status)" "pending"
call 409 POST /auth/register "{
  \"email\": \"selfsignup-$STAMP@avcrm.test\",
  \"password\": \"Password123!\",
  \"first_name\": \"Dup\", \"last_name\": \"Licate\",
  \"branch_id\": \"$KINGSTON\"
}"

echo
echo "== cleanup =="
login "$CORPORATE_EMAIL"
call 204 DELETE "/properties/$PROPERTY_ID"
call 204 DELETE "/customers/$CUSTOMER_ID"
call 404 GET "/customers/$CUSTOMER_ID"

echo
echo "== unknown route =="
call 404 GET /nope

echo
echo "All $pass checks passed."
