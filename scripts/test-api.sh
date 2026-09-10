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
echo "== pricing guide =="
call 200 GET '/checklist-requirements'
REQUIRED_ITEMS="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(d.filter(i => i.is_required).map(i => i.code).sort().join(','));
")"
assert "required checklist items" "$REQUIRED_ITEMS" "contact_confirmed,service_window_explained,terms_reviewed"

call 200 GET "/pricing-guide?branch_id=$KINGSTON&driveway_size_cars=2&billing_type=monthly"
assert "kingston rate card, 2 cars" "$(field data.0.initial_price)" "109.00"
# The quote screen opens on the property, not the rate card: this one is a
# 3 car driveway, so it prices a rung higher than the 2 car rate above.
call 200 GET "/pricing-guide/suggest?property_id=$PROPERTY_ID&billing_type=monthly"
assert "suggestion follows the driveway size" "$(field data.suggested_initial_price)" "129.00"

echo
echo "== quotes =="
# A second address, because signing it puts a contract on the books and the
# cleanup below can no longer delete it.
call 201 POST /properties "{
  \"customer_id\": \"$CUSTOMER_ID\",
  \"address_line1\": \"78 Smoke Test Lane $STAMP\",
  \"city\": \"Kingston\", \"province\": \"ON\", \"postal_code\": \"K7L 9Z8\",
  \"latitude\": 44.2305, \"longitude\": -76.4944,
  \"driveway_size_cars\": 2
}"
SIGNED_PROPERTY_ID="$(field data.id)"

SEASON='"season_start":"2026-11-15","season_end":"2027-04-15"'
# A discount is a discount: it cannot exceed the list price.
call 400 POST /quotes "{\"property_id\":\"$SIGNED_PROPERTY_ID\",\"billing_type\":\"monthly\",\"initial_price\":109,\"discounted_price\":149,$SEASON}"
call 400 POST /quotes "{\"property_id\":\"$SIGNED_PROPERTY_ID\",\"billing_type\":\"monthly\",\"initial_price\":109,\"discounted_price\":99,\"season_start\":\"2027-04-15\",\"season_end\":\"2026-11-15\"}"
# Sub-cent pricing is a mistake, not a rounding job.
call 400 POST /quotes "{\"property_id\":\"$SIGNED_PROPERTY_ID\",\"billing_type\":\"monthly\",\"initial_price\":109.005,\"discounted_price\":99,$SEASON}"

call 201 POST /quotes "{\"property_id\":\"$SIGNED_PROPERTY_ID\",\"billing_type\":\"monthly\",\"initial_price\":109,\"discounted_price\":99,$SEASON,\"notes\":\"Ten off at the door.\"}"
QUOTE_ID="$(field data.id)"
assert "quote starts as a draft" "$(field data.status)" "draft"
assert "money comes back as a fixed string" "$(field data.discounted_price)" "99.00"

call 200 PATCH "/quotes/$QUOTE_ID" '{"discounted_price":95}'
assert "an open quote can be re-priced" "$(field data.discounted_price)" "95.00"
call 200 GET "/quotes?property_id=$SIGNED_PROPERTY_ID"
assert "quote is listed against the property" "$(field meta.total)" "1"

echo
echo "== the signature gate =="
CHECKLIST_OK='[{"item_code":"terms_reviewed","checked":true},{"item_code":"service_window_explained","checked":true},{"item_code":"contact_confirmed","checked":true}]'
SIGN="\"signature_image_url\":\"private/signatures/smoke-$STAMP.png\",\"terms_version\":\"2026-09-01\""

# A draft has not been shown to anyone yet, so it cannot be signed.
call 409 POST /contracts "{\"quote_id\":\"$QUOTE_ID\",$SIGN,\"checklist\":$CHECKLIST_OK}"
call 200 PATCH "/quotes/$QUOTE_ID/status" '{"status":"presented"}'
assert "quote presented" "$(field data.status)" "presented"

# Required boxes block the submission and the response names them.
call 400 POST /contracts "{\"quote_id\":\"$QUOTE_ID\",$SIGN,\"checklist\":[{\"item_code\":\"terms_reviewed\",\"checked\":true}]}"
UNTICKED="$(node -e "
  const e = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).error;
  process.stdout.write(e.details.map(d => d.path).sort().join(','));
")"
assert "the gate names what is unticked" "$UNTICKED" "checklist.contact_confirmed,checklist.service_window_explained"
call 400 POST /contracts "{\"quote_id\":\"$QUOTE_ID\",$SIGN,\"checklist\":[{\"item_code\":\"nonsense\",\"checked\":true}]}"
# Ticking card_on_file without a token, and a token without the tick.
call 400 POST /contracts "{\"quote_id\":\"$QUOTE_ID\",$SIGN,\"checklist\":[{\"item_code\":\"terms_reviewed\",\"checked\":true},{\"item_code\":\"service_window_explained\",\"checked\":true},{\"item_code\":\"contact_confirmed\",\"checked\":true},{\"item_code\":\"card_on_file\",\"checked\":true}]}"
call 400 POST /contracts "{\"quote_id\":\"$QUOTE_ID\",$SIGN,\"payment_method_token\":\"tok_smoke\",\"checklist\":$CHECKLIST_OK}"
# Raw card data must never reach the database.
call 400 POST /contracts "{\"quote_id\":\"$QUOTE_ID\",$SIGN,\"payment_method_token\":\"4242 4242 4242 4242\",\"payment_method_last4\":\"4242\",\"checklist\":[{\"item_code\":\"terms_reviewed\",\"checked\":true},{\"item_code\":\"service_window_explained\",\"checked\":true},{\"item_code\":\"contact_confirmed\",\"checked\":true},{\"item_code\":\"card_on_file\",\"checked\":true}]}"

call 201 POST /contracts "{
  \"quote_id\": \"$QUOTE_ID\", $SIGN,
  \"signed_lat\": 44.2305, \"signed_lng\": -76.4944,
  \"payment_method_token\": \"tok_smoke_$STAMP\",
  \"payment_method_last4\": \"4242\",
  \"payment_method_brand\": \"visa\",
  \"checklist\": [
    {\"item_code\":\"terms_reviewed\",\"checked\":true},
    {\"item_code\":\"service_window_explained\",\"checked\":true},
    {\"item_code\":\"contact_confirmed\",\"checked\":true},
    {\"item_code\":\"card_on_file\",\"checked\":true}
  ]
}"
CONTRACT_ID="$(field data.id)"
assert "signing records the last 4 only" "$(field data.payment_method_last4)" "4242"
# field() renders a missing key as an empty string: the token never leaves the server.
assert "the processor token is never returned" "$(field data.payment_method_token)" ""
assert "signed_ip comes from the connection" "$(field data.signed_ip)" "127.0.0.1"
# Every item gets a row, ticked or not, so the record shows what was skipped.
CHECKLIST_STATE="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(d.checklist.map(i => \`\${i.item_code}=\${i.checked}\`).join(','));
")"
assert "the whole checklist is recorded" "$CHECKLIST_STATE" \
  "card_on_file=true,terms_reviewed=true,service_window_explained=true,access_notes_captured=false,photos_taken=false,contact_confirmed=true"

call 200 GET "/quotes/$QUOTE_ID"
assert "signing accepts the quote" "$(field data.status)" "accepted"
call 200 GET "/quotes/$QUOTE_ID/contract"
assert "the quote points at its contract" "$(field data.id)" "$CONTRACT_ID"

# An accepted quote is frozen, and its price is what was signed.
call 409 PATCH "/quotes/$QUOTE_ID" '{"discounted_price":50}'
call 409 PATCH "/quotes/$QUOTE_ID/status" '{"status":"declined"}'
call 409 DELETE "/quotes/$QUOTE_ID"

# A driveway can only be sold once at a time.
call 201 POST /quotes "{\"property_id\":\"$SIGNED_PROPERTY_ID\",\"billing_type\":\"monthly\",\"initial_price\":109,\"discounted_price\":109,$SEASON,\"status\":\"presented\"}"
SECOND_QUOTE_ID="$(field data.id)"
call 409 POST /contracts "{\"quote_id\":\"$SECOND_QUOTE_ID\",$SIGN,\"checklist\":$CHECKLIST_OK}"

echo
echo "== work orders: dispatch =="
call 200 GET '/operators?assignable=true'
OTTO_ID="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(d.find(u => u.email === 'otto@avcrm.test').id);
")"

SOON="$(node -e "process.stdout.write(new Date(Date.now() + 7200000).toISOString())")"
JUST_NOW="$(node -e "process.stdout.write(new Date(Date.now() - 600000).toISOString())")"

# The onboarding gate from build step 2, enforced at dispatch.
call 403 POST /work-orders "{
  \"contract_id\": \"$CONTRACT_ID\",
  \"assigned_user_id\": \"$PAT_ID\",
  \"scheduled_for\": \"$SOON\",
  \"service_type\": \"snow_clearing\"
}"
# Only an operator drives a truck.
call 400 POST /work-orders "{
  \"contract_id\": \"$CONTRACT_ID\",
  \"assigned_user_id\": \"$CORP_ID\",
  \"scheduled_for\": \"$SOON\",
  \"service_type\": \"snow_clearing\"
}"

call 201 POST /work-orders "{
  \"contract_id\": \"$CONTRACT_ID\",
  \"assigned_user_id\": \"$OTTO_ID\",
  \"scheduled_for\": \"$SOON\",
  \"service_type\": \"snow_clearing\"
}"
WORK_ORDER_ID="$(field data.id)"
assert "a new visit starts scheduled" "$(field data.status)" "scheduled"
# The address comes off the contract, never off the request.
assert "property taken from the contract" "$(field data.property_id)" "$SIGNED_PROPERTY_ID"

call 200 GET "/work-orders?contract_id=$CONTRACT_ID"
assert "the visit is on the contract" "$(field meta.total)" "1"

echo
echo "== work orders: only the assigned operator may work it =="
login nina@avcrm.test
call 403 PATCH "/work-orders/$WORK_ORDER_ID/status" '{"status":"en_route"}'
call 403 POST "/work-orders/$WORK_ORDER_ID/photos" "{
  \"photo_type\": \"before\",
  \"file_url\": \"private/service-photos/nina-$STAMP.jpg\",
  \"taken_at\": \"$JUST_NOW\"
}"
# Dispatch is corporate work, even on your own visit.
login otto@avcrm.test
call 403 POST /work-orders "{
  \"contract_id\": \"$CONTRACT_ID\",
  \"scheduled_for\": \"$SOON\",
  \"service_type\": \"salting\"
}"
call 403 PATCH "/work-orders/$WORK_ORDER_ID" '{"service_type":"salting"}'

echo
echo "== work orders: the completion gate =="
call 200 PATCH "/work-orders/$WORK_ORDER_ID/status" '{"status":"en_route"}'
call 200 PATCH "/work-orders/$WORK_ORDER_ID/status" '{"status":"in_progress"}'
assert "starting stamps started_at" "$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(String(d.started_at !== null));
")" "true"

# No photos, no completion. The 400 names which ones are missing.
call 400 PATCH "/work-orders/$WORK_ORDER_ID/status" '{"status":"completed"}'
assert "the gate names both photos" "$(node -e "
  const e = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).error;
  process.stdout.write(e.details.map(d => d.path).join(','));
")" "photos.before,photos.after"

# A photo taken in Ottawa is not proof this Kingston driveway was cleared.
call 400 POST "/work-orders/$WORK_ORDER_ID/photos" "{
  \"photo_type\": \"before\",
  \"file_url\": \"private/service-photos/elsewhere-$STAMP.jpg\",
  \"taken_at\": \"$JUST_NOW\",
  \"latitude\": 45.4215, \"longitude\": -75.6972
}"
# taken_at is EXIF time, so it cannot be in the future.
LATER="$(node -e "process.stdout.write(new Date(Date.now() + 3600000).toISOString())")"
call 400 POST "/work-orders/$WORK_ORDER_ID/photos" "{
  \"photo_type\": \"before\",
  \"file_url\": \"private/service-photos/future-$STAMP.jpg\",
  \"taken_at\": \"$LATER\"
}"

call 201 POST "/work-orders/$WORK_ORDER_ID/photos" "{
  \"photo_type\": \"before\",
  \"file_url\": \"private/service-photos/before-$STAMP.jpg\",
  \"taken_at\": \"$JUST_NOW\",
  \"latitude\": 44.2305, \"longitude\": -76.4944
}"
# The same file twice is a double upload, not a second photo.
call 409 POST "/work-orders/$WORK_ORDER_ID/photos" "{
  \"photo_type\": \"after\",
  \"file_url\": \"private/service-photos/before-$STAMP.jpg\",
  \"taken_at\": \"$JUST_NOW\"
}"
call 400 PATCH "/work-orders/$WORK_ORDER_ID/status" '{"status":"completed"}'
assert "still short an after photo" "$(node -e "
  const e = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).error;
  process.stdout.write(e.details.map(d => d.path).join(','));
")" "photos.after"

call 201 POST "/work-orders/$WORK_ORDER_ID/photos" "{
  \"photo_type\": \"after\",
  \"file_url\": \"private/service-photos/after-$STAMP.jpg\",
  \"taken_at\": \"$JUST_NOW\",
  \"latitude\": 44.2306, \"longitude\": -76.4945
}"
call 200 PATCH "/work-orders/$WORK_ORDER_ID/status" "{
  \"status\": \"completed\",
  \"operator_notes\": \"Cleared and salted.\"
}"
assert "completed" "$(field data.status)" "completed"
assert "with both photos attached" "$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(d.photos.map(p => p.photo_type).sort().join(','));
")" "after,before"

# A finished visit is a record, not a draft.
call 409 PATCH "/work-orders/$WORK_ORDER_ID/status" '{"status":"skipped","skip_reason":"changed my mind"}'
call 409 POST "/work-orders/$WORK_ORDER_ID/photos" "{
  \"photo_type\": \"issue\",
  \"file_url\": \"private/service-photos/late-$STAMP.jpg\",
  \"taken_at\": \"$JUST_NOW\"
}"
call 200 GET "/work-orders/$WORK_ORDER_ID/photos"

echo
echo "== work orders: skipping =="
login "$CORPORATE_EMAIL"
call 201 POST /work-orders "{
  \"contract_id\": \"$CONTRACT_ID\",
  \"assigned_user_id\": \"$OTTO_ID\",
  \"scheduled_for\": \"$SOON\",
  \"service_type\": \"salting\"
}"
SKIPPED_ID="$(field data.id)"
# A skip without a reason is not a record of anything.
call 400 PATCH "/work-orders/$SKIPPED_ID/status" '{"status":"skipped"}'
call 200 PATCH "/work-orders/$SKIPPED_ID/status" '{"status":"skipped","skip_reason":"Driveway already cleared by the neighbour."}'
assert "skipped with a reason" "$(field data.status)" "skipped"
call 409 PATCH "/work-orders/$SKIPPED_ID" '{"service_type":"ice_removal"}'

echo
echo "== the checklist after signature =="
call 200 PATCH "/contracts/$CONTRACT_ID/checklist/photos_taken" '{"checked":true}'
# A required item is the gate the contract passed to exist.
call 409 PATCH "/contracts/$CONTRACT_ID/checklist/terms_reviewed" '{"checked":false}'
# card_on_file and the token move together.
call 400 PATCH "/contracts/$CONTRACT_ID/checklist/card_on_file" '{"checked":false}'
call 404 PATCH "/contracts/$CONTRACT_ID/checklist/nonsense" '{"checked":true}'

call 200 PATCH "/contracts/$CONTRACT_ID" "{\"pdf_url\":\"private/contracts/$STAMP.pdf\"}"
call 400 PATCH "/contracts/$CONTRACT_ID" '{"payment_method_token":"4242424242424242"}'
call 200 PATCH "/contracts/$CONTRACT_ID/status" '{"status":"completed"}'
call 409 PATCH "/contracts/$CONTRACT_ID/status" '{"status":"cancelled"}'
call 409 PATCH "/contracts/$CONTRACT_ID/checklist/access_notes_captured" '{"checked":true}'
# A completed contract takes no more visits.
call 409 POST /work-orders "{
  \"contract_id\": \"$CONTRACT_ID\",
  \"assigned_user_id\": \"$OTTO_ID\",
  \"scheduled_for\": \"$SOON\",
  \"service_type\": \"salting\"
}"

echo
echo "== audit log =="
call 200 GET "/audit-log?entity_id=$CONTRACT_ID"
ACTIONS="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(d.map(r => r.action).sort().join(','));
")"
assert "every write on the contract is logged" "$ACTIONS" \
  "contract.checklist_updated,contract.completed,contract.created,contract.updated"
call 200 GET "/audit-log?entity_id=$CONTRACT_ID&action=contract.created"
assert "the log never carries the token" \
  "$(node -e "
    const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
    process.stdout.write(String('payment_method_token' in (d[0]?.after_json ?? {})));
  ")" "false"

echo
echo "== message templates =="
call 200 GET '/message-templates'
GLOBAL_CODES="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  const g = d.filter(t => t.branch_id === null && t.channel === 'email').map(t => t.code);
  process.stdout.write(String(g.includes('service_complete') && g.includes('review_request')));
")"
assert "the global email set is seeded" "$GLOBAL_CODES" "true"
# Halifax rewords service_complete; every other code falls back to the global row.
OVERRIDES="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(d.filter(t => t.branch_id !== null).map(t => t.code).join(','));
")"
assert "one branch override is seeded" "$OVERRIDES" "service_complete"

echo
echo "== the outbound queue =="
# Completing the visit above queued the customer notice and the office copy.
call 200 GET "/message-log?work_order_id=$WORK_ORDER_ID"
QUEUED="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  process.stdout.write(d.map(m => m.template_code).sort().join(','));
")"
assert "completion queues both notices" "$QUEUED" "service_complete,service_complete_internal"
# Rendered at enqueue time, so a later template edit cannot rewrite history.
RENDERED="$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.BODY_PATH,'utf8')).data;
  const m = d.find(x => x.template_code === 'service_complete');
  process.stdout.write(String(m.body.includes('{{') === false && m.status === 'queued'));
")"
assert "queued rendered, not sent" "$RENDERED" "true"

call 200 GET '/message-log?status=sent'
call 200 GET '/message-log?channel=sms'

echo
echo "== the review gate =="
call 200 GET '/review-requests'
call 200 GET '/review-requests?routed_to=internal_feedback'
assert "a poor rating stays in house" "$(field meta.total)" "1"
POOR_ID="$(field data.0.id)"
call 200 GET '/review-requests?routed_to=google_review'
assert "a good one goes to the review page" "$(field meta.total)" "1"
GOOD_ID="$(field data.0.id)"
call 200 GET '/review-requests?answered=false'
assert "every seeded ask has been answered" "$(field meta.total)" "0"

# The one-tap link is public: a customer has no account.
TOKEN=""
call 400 GET "/review-requests/$GOOD_ID/rate?rating=9"
call 404 GET "/review-requests/00000000-0000-0000-0000-000000000000/rate?rating=5"
# Tapping the same star again is the same answer, not an error.
call 302 GET "/review-requests/$GOOD_ID/rate?rating=5"
call 200 GET "/review-requests/$POOR_ID/rate?rating=2"
assert "a poor rating is routed internally" "$(field data.routed_to)" "internal_feedback"
assert "and is not sent to the review page" "$(field data.redirect_url)" ""
# A different answer to an answered ask is a conflict, not an overwrite.
call 409 GET "/review-requests/$GOOD_ID/rate?rating=1"
call 409 POST "/review-requests/$POOR_ID/rating" '{"rating":5}'

login "$CORPORATE_EMAIL"

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
call 403 GET "/quotes?branch_id=$HALIFAX"
call 403 GET "/contracts?branch_id=$HALIFAX"
call 403 GET "/pricing-guide?branch_id=$HALIFAX"
call 403 GET "/work-orders?branch_id=$HALIFAX"
call 403 GET "/message-log?branch_id=$HALIFAX"
call 403 GET "/review-requests?branch_id=$HALIFAX"
call 200 GET /branches
assert "operator sees only their own branch" "$(field data.1.id)" ""

# Operator-only endpoints corporate work is gated behind.
call 403 GET /audit-log
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

# The signed address and its customer stay: a contract holds them both, which
# is the point of the RESTRICT on contracts.property_id and .customer_id.
call 409 DELETE "/properties/$SIGNED_PROPERTY_ID"
call 409 DELETE "/customers/$CUSTOMER_ID"
call 200 GET "/customers/$CUSTOMER_ID"

# A customer nobody has signed still deletes cleanly.
call 201 POST /customers "{
  \"branch_id\": \"$KINGSTON\",
  \"first_name\": \"Throwaway\",
  \"last_name\": \"Test $STAMP\",
  \"email\": \"throwaway-$STAMP@example.test\"
}"
DISPOSABLE_ID="$(field data.id)"
call 204 DELETE "/customers/$DISPOSABLE_ID"
call 404 GET "/customers/$DISPOSABLE_ID"

echo
echo "== unknown route =="
call 404 GET /nope

echo
echo "All $pass checks passed."
