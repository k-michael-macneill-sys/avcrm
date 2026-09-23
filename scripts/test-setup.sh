#!/usr/bin/env bash
#
# Prepares the database the automated suite runs against, then runs it.
#
#   npm test
#
# A separate database from the dev one, created if it is not there and
# migrated to head every run — so a test never depends on what the last person
# happened to leave lying around, and a forgotten migration fails here rather
# than in production.

set -euo pipefail

TEST_DB="${TEST_DB_NAME:-avcrm_test}"
ADMIN_URL="${TEST_ADMIN_URL:-postgres://avcrm:avcrm@localhost:5432/postgres}"
export DATABASE_URL="${TEST_DATABASE_URL:-postgres://avcrm:avcrm@localhost:5432/$TEST_DB}"

# Values the application refuses to start without, fixed here so the suite does
# not inherit whatever is in .env — a test run must not be able to reach a real
# mail server, a real gateway, or a real processor.
export NODE_ENV=test
export LOG_LEVEL="${TEST_LOG_LEVEL:-silent}"
export JWT_SECRET='test-secret-that-is-long-enough-for-the-schema'
export MAIL_DRIVER=log
export PAYMENT_GATEWAY=manual
export GOOGLE_REVIEW_URL='https://example.test/review'
export BRANCH_PASSWORD='test-owner-password'
export APP_BASE_URL='http://127.0.0.1:3000'
export STORAGE_LOCAL_DIR="${STORAGE_LOCAL_DIR:-./storage-test}"
unset SMS_API_BASE SMS_REDIRECT_TO MAIL_REDIRECT_TO STRIPE_SECRET_KEY || true

psql "$ADMIN_URL" -tAc "select 1 from pg_database where datname = '$TEST_DB'" \
  | grep -q 1 || psql "$ADMIN_URL" -qc "create database \"$TEST_DB\""

npm run migrate --silent >/dev/null

# Concurrency 1: the suites share one database and truncate between tests, so
# running them in parallel would have them clearing each other's rows.
# .mts for the suites that must configure the application before it loads —
# a payment gateway, an SMS provider — which needs top-level await, and so
# needs a module the runtime treats as ESM.
if [[ $# -gt 0 ]]; then
  exec node --import tsx --test --test-concurrency=1 "$@"
fi
exec node --import tsx --test --test-concurrency=1 \
  "tests/**/*.test.ts" "tests/**/*.test.mts"
