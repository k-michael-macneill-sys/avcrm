# avcrm — snow & ice removal CRM (API)

Phase 1: database schema, REST API, and auth. No frontend.

Stack: Node 20+, TypeScript, Express 4, PostgreSQL 15+, Knex (query builder and
migrations, not an ORM), Zod for validation, bcrypt, jsonwebtoken, pino.

## Setup

```bash
# 1. Dependencies
npm install

# 2. Config
cp .env.example .env
# Then edit .env: set DATABASE_URL and a real JWT_SECRET (min 32 chars).
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 3. Database
createdb avcrm            # or: psql -c 'create database avcrm'
npm run migrate
npm run seed              # development sample data

# 4. Run
npm run dev               # tsx watch, port 3000 by default
```

Verify it works:

```bash
curl -s localhost:3000/health
./scripts/test-api.sh     # 35 checks against a running server
```

### Production build

```bash
npm run build             # tsc -> dist/
npm start                 # node dist/server.js
```

Migrations in a built image still run through the TypeScript sources
(`npm run migrate`), which needs the dev dependencies present. If you want a
slimmer runtime image, run migrations from a separate build stage.

## Seed accounts

All seeded users share the password in `SEED_PASSWORD` (default `Password123!`).

| Email | Role | Branch |
| --- | --- | --- |
| `admin@avcrm.test` | admin | North Shore |
| `manager.north@avcrm.test` | manager | North Shore |
| `dispatch.north@avcrm.test` | dispatcher | North Shore |
| `operator.north@avcrm.test` | operator | North Shore |
| `manager.downtown@avcrm.test` | manager | Downtown |

## Auth

`POST /auth/login` returns a JWT. Send it as `Authorization: Bearer <token>`.

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@avcrm.test","password":"Password123!"}' | jq -r .data.token)

curl -s localhost:3000/customers -H "Authorization: Bearer $TOKEN"
```

Roles, least to most privileged: `operator`, `dispatcher`, `manager`, `admin`.

- Reads require any authenticated user.
- Creating customers and jobs requires `dispatcher` or above.
- Creating contracts and payments, and deleting customers, requires `manager` or above.

### Branch scoping

Every user except `admin` is pinned to their own `branch_id`. Passing
`?branch_id=` for a different branch returns 403. Admins may pass `?branch_id=`
to work in any branch. This is enforced in `resolveBranchScope`
(`src/middleware/auth.ts`), which every branch-scoped route calls before
touching a service.

`POST /auth/register` is open so the first environment can be bootstrapped, but
`role` and `branch_id` are only honoured when the caller presents an admin
token. Without one you get an unassigned `operator`, which cannot read any
branch until an admin assigns it. Consider closing the endpoint entirely once
user provisioning exists.

## Endpoints

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/health` | public | Liveness only |
| POST | `/auth/register` | public | Role/branch need an admin token |
| POST | `/auth/login` | public | Returns `{ token, user }` |
| GET | `/auth/me` | any | Confirms a token works |
| GET | `/branches` | any | |
| GET | `/customers` | any | Paginated; `contract_status`, `search` |
| POST | `/customers` | dispatcher+ | |
| GET | `/customers/:id` | any | |
| PATCH | `/customers/:id` | dispatcher+ | |
| DELETE | `/customers/:id` | manager+ | Refused if open jobs or payment history |
| GET | `/jobs` | any | `status`, `customer_id`, `scheduled_from`/`_to` |
| POST | `/jobs` | dispatcher+ | |
| GET | `/jobs/:id` | any | |
| PATCH | `/jobs/:id/status` | any | Maintains `completed_date` |
| GET | `/contracts` | any | `customer_id`, `active_on` |
| POST | `/contracts` | manager+ | Sets the customer to `active` |
| GET | `/contracts/:id` | any | |
| GET | `/payments` | any | `customer_id`, `status` |
| POST | `/payments` | manager+ | Card/ACH go through the mock gateway |
| GET | `/payments/:id` | any | |

### Response shapes

Single resource:

```json
{ "data": { "id": "…" } }
```

List (paginated with `?page=` and `?page_size=`, max 100):

```json
{ "data": [], "meta": { "page": 1, "page_size": 25, "total": 0, "total_pages": 0 } }
```

Error:

```json
{ "error": { "code": "bad_request", "message": "Request validation failed", "details": [] } }
```

## What is mocked

These are deliberately fake in phase 1. Swap the function bodies, not the
signatures.

- `src/services/paymentGateway.ts` — stands in for Stripe/Square. `createCharge`
  always succeeds and returns a `mock_ch_…` reference.
- `src/services/notifications.ts` — `sendEmail` / `sendSms` write to the log.

Not started at all: weather triggers, routing, GPS, reporting, any frontend.

## Layout

```
src/
  server.ts            process entry: connect, listen, shut down
  app.ts               builds the Express app (importable without a port)
  config/              dotenv + Zod; throws at startup on bad config
  db/
    client.ts          the single Knex instance and its config
    knexfile.ts        config file for the knex CLI
    migrations/        one file per table, in dependency order
    seeds/             development sample data
  routes/              HTTP only: validate, scope, call a service, respond
  middleware/          auth, error handler, request logger
  services/            business logic; plain functions, no classes
  types/               row shapes, JWT payload, module augmentation
  utils/               errors, async wrapper, Zod helper, pagination
scripts/test-api.sh    curl smoke test
```

### Conventions

There is no DI container and no repository layer. Services are exported
functions that take their arguments plus an optional `Knex` (defaulting to the
shared `db`), so a caller can pass a transaction in:

```ts
await db.transaction((trx) => createContract(branchId, input, trx));
```

Adding a resource is three steps, no refactor required:

1. Add a migration in `src/db/migrations/`, and the row type in
   `src/types/models.ts` plus the `Tables` entry in `src/types/knex.d.ts`.
2. Write `src/services/<thing>.ts` — functions that take arguments and return data.
3. Write `src/routes/<thing>.ts` and mount it in `src/routes/index.ts`.

`src/routes/customers.ts` and `src/services/customers.ts` are the reference
pair; they show the full CRUD shape including filtering, pagination, role
guards, branch scoping, and translating Postgres constraint violations into
409s.

Other conventions worth keeping:

- Enums are `text` plus a `CHECK` constraint, not Postgres enum types — adding a
  value later is a constraint swap instead of `ALTER TYPE`.
- Money is `numeric(12,2)` and comes back from `pg` as a **string**. Do not do
  arithmetic on it in JavaScript without deciding on a representation first.
- Async route handlers are wrapped in `asyncHandler` so rejections reach the
  error handler. Express 4 does not do this for you.
- Throw `ApiError` (or the `badRequest` / `notFound` / … helpers) for anything
  the client should see. Everything else becomes a logged 500.

## Known gaps for later

- No refresh tokens or logout; a JWT is valid until it expires (`JWT_EXPIRES_IN`).
- No rate limiting on `/auth/login`.
- No automated test suite — `scripts/test-api.sh` is a smoke test, not a substitute.
- `GET /jobs` and `GET /payments` paginate with `OFFSET`, which will need to
  become keyset pagination once tables get large.
