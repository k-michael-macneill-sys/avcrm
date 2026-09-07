# avcrm — Avalanche CRM (API)

Snow and ice removal CRM for a multi-branch operation. No frontend; JSON only.

Stack: Node 20+, TypeScript, Express 4, PostgreSQL 15+, Knex (query builder and
migrations, not an ORM), Zod for validation, bcrypt, jsonwebtoken, pino.

## Where this is in the build order

Build order from the spec, and what exists today:

| # | Step | Status |
| --- | --- | --- |
| 1 | Migrations for branches, users, onboarding, customers, properties + seeds | **done** |
| 2 | Auth, role middleware, branch scoping | **done** |
| 3 | Quotes → contracts → checklist, signature and payment token capture | not started |
| 4 | Work orders, photo upload, completion gate | not started |
| 5 | Email queue + templates, then review automation | mock only |
| 6 | Invoicing and payments | not started |
| 7 | Reporting views | not started |

Steps 3 to 7 mount into the same structure — a migration, a service of plain
functions, a router — without reshaping what is already here.

## Setup

```bash
npm install

cp .env.example .env
# Edit .env: set DATABASE_URL and a real JWT_SECRET (min 32 chars).
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

createdb avcrm
npm run migrate
npm run seed          # development sample data

npm run dev           # tsx watch, port 3000
```

Verify:

```bash
curl -s localhost:3000/health
./scripts/test-api.sh   # 78 checks against a running server; safe to re-run
```

The database owner needs to be able to `create extension citext`. It is a
trusted extension on PostgreSQL 13+, so the owner of the database can do this
without superuser rights.

### Production build

```bash
npm run build         # tsc -> dist/
npm start             # node dist/server.js
```

Migrations run through the TypeScript sources (`npm run migrate`), which needs
the dev dependencies present.

## Scheduled jobs

```bash
npm run job:document-expiry
```

The nightly compliance sweep. It expires approved documents past their date,
suspends any operator who loses a **required** document, and warns operators at
30, 14 and 7 days out, copying the branch manager. Each window is sent once.
Point cron or your scheduler at it; it exits non-zero on failure.

`runDocumentExpiry(today)` takes an injectable date, so the whole ladder can be
exercised without waiting for real time to pass.

## Seed accounts

All seeded users share the password in `SEED_PASSWORD` (default `Password123!`).

| Email | Role | Branch | Notes |
| --- | --- | --- | --- |
| `corporate@avcrm.test` | corporate | — | Sees every branch |
| `kingston.manager@avcrm.test` | corporate | Kingston | Branch manager |
| `halifax.manager@avcrm.test` | corporate | Halifax | Branch manager |
| `otto@avcrm.test` | operator | Kingston | Fully compliant, assignable |
| `nina@avcrm.test` | operator | Kingston | Abstract expires in 21 days |
| `pat@avcrm.test` | operator | Halifax | Documents awaiting review |

## Auth and permissions

`POST /auth/login` returns a JWT. Send it as `Authorization: Bearer <token>`.

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"corporate@avcrm.test","password":"Password123!"}' | jq -r .data.token)

curl -s localhost:3000/customers -H "Authorization: Bearer $TOKEN"
```

Two roles, per the spec:

- **corporate** — sees all branches and all roll-up reporting. Creates users,
  reviews documents, manages branches.
- **operator** — hard-scoped to their own `branch_id`.

The scoping is enforced in middleware at the query layer, not in the UI.
`resolveBranchScope` (`src/middleware/auth.ts`) is the only place that decides
which branches a request may read; `resolveWriteBranch` decides where a write
lands. Services take the resulting scope and never look at the request.

Passing `?branch_id=` for another branch as an operator returns 403. Corporate
may pass it to narrow to one branch, and must pass it on writes because they
are not tied to one.

`requireAuth` re-reads the user row on every request rather than trusting the
token, so a suspension, deactivation or role change takes effect immediately
instead of whenever the token expires. That is one indexed primary-key lookup
per request.

### Registration

`POST /auth/register` is open so a branch can onboard operators, but the role is
set on the backend and never read from the request: self-signup always produces
an `operator` with `onboarding_status = 'pending'`, which cannot be assigned
work. Corporate creates staff with `POST /users`, where the role is explicit.

### The onboarding gate

An operator with `onboarding_status != 'approved'` cannot be assigned work
orders. `assertOperatorAssignable` (`src/services/operators.ts`) is that rule,
and `GET /operators?assignable=true` returns the eligible pool the dispatcher
picks from in build step 4.

Onboarding status moves automatically as documents change:

- no documents → `pending`
- some submitted, required set incomplete → `docs_submitted`
- every required document approved → `approved`
- a required document expires → `suspended` (nightly job)

A suspension is only lifted by corporate, never by the automatic refresh.

## Endpoints

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| GET | `/health` | public | |
| POST | `/auth/register` | public | Always creates a pending operator |
| POST | `/auth/login` | public | Returns `{ token, user }` |
| GET | `/auth/me` | any | |
| GET | `/branches` | any | Operators see only their own |
| POST | `/branches` | corporate | |
| PATCH | `/branches/:id` | corporate | Validates `manager_user_id` is in the branch |
| GET | `/users` | corporate | Paginated; `role`, `onboarding_status` |
| POST | `/users` | corporate | Role set explicitly here |
| PATCH | `/users/:id` | corporate | `is_active`, `onboarding_status`, branch move |
| GET | `/document-requirements` | any | `?province=ON` returns global + provincial |
| GET | `/operators` | any | `?assignable=true` for the work-order pool |
| GET | `/operators/:id/compliance` | self or corporate | Requirements vs live documents |
| GET | `/operators/:id/documents` | self or corporate | |
| POST | `/operators/:id/documents` | self or corporate | Records an uploaded file |
| PATCH | `/operators/documents/:documentId/review` | corporate | Approve or reject |
| GET | `/customers` | any | Paginated; `status`, `search`, `created_by_user_id` |
| POST | `/customers` | any | |
| GET | `/customers/:id` | any | |
| GET | `/customers/:id/properties` | any | |
| PATCH | `/customers/:id` | any | |
| DELETE | `/customers/:id` | any | |
| GET | `/properties` | any | `customer_id`, `priority_flag`, `search` |
| GET | `/properties/check-duplicate` | any | Warns before the rep signs |
| POST | `/properties` | any | 409 with details if the address exists |
| GET | `/properties/:id` | any | |
| PATCH | `/properties/:id` | any | |
| DELETE | `/properties/:id` | any | |

### Response shapes

```json
{ "data": { "id": "…" } }
{ "data": [], "meta": { "page": 1, "page_size": 25, "total": 0, "total_pages": 0 } }
{ "error": { "code": "bad_request", "message": "…", "details": [] } }
```

### The duplicate address guard

`properties` carries a unique index on the *normalized* `(postal_code,
address_line1)`: postal code with case and spacing stripped, street line with
case folded and internal whitespace collapsed. So `12  Main   St` / `k7l 3n6`
collides with `  12 MAIN st ` / `K7L3N6`.

Two ways to surface it:

- `GET /properties/check-duplicate?postal_code=…&address_line1=…` returns
  `{ data: { duplicate: … } }` — call it at the door, before signing.
- `POST /properties` returns 409 with the same payload as `details`.

The check spans every branch, because the case it exists for is a second rep
selling an address another branch already holds. The branch is always named;
the customer is only identified when the caller can already see that branch.

## What is mocked

- `src/services/notifications.ts` — `sendEmail` / `sendSms` write to the log.
  Build step 5 replaces the bodies with a real queue and templates; callers do
  not change.

Not started: quotes, contracts, work orders, service photos, invoicing,
payments, reporting, and any frontend.

## Layout

```
src/
  server.ts            process entry: connect, listen, shut down
  app.ts               builds the Express app (importable without a port)
  config/              dotenv + Zod; throws at startup on bad config
  db/
    client.ts          the single Knex instance, pool and type parsers
    knexfile.ts        config file for the knex CLI
    migrations/        one file per table, in dependency order
    seeds/             development sample data
  jobs/                scheduled work, run as scripts
  routes/              HTTP only: validate, scope, call a service, respond
  middleware/          auth, error handler, request logger
  services/            business logic; plain functions, no classes
  types/               row shapes, JWT payload, module augmentation
  utils/               errors, async wrapper, Zod helper, pagination, scope
scripts/test-api.sh    curl smoke test
```

### Conventions

No DI container and no repository layer. Services are exported functions that
take their arguments plus an optional `Knex` (defaulting to the shared `db`), so
a caller can pass a transaction in:

```ts
await db.transaction((trx) => createCustomer(branchId, userId, input, trx));
```

Adding a resource is three steps, no refactor:

1. Add a migration in `src/db/migrations/`, the row type in
   `src/types/models.ts`, and the `Tables` entry in `src/types/knex.d.ts`.
2. Write `src/services/<thing>.ts` — functions that take arguments and return data.
3. Write `src/routes/<thing>.ts` and mount it in `src/routes/index.ts`.

`customers` and `properties` are the reference pair. They show filtering,
pagination, branch scoping, and translating Postgres constraint violations into
409s and 400s.

Other conventions worth keeping:

- Enumerated columns are `text` plus a `CHECK` constraint, not Postgres enum
  types, so adding a value later is a constraint swap instead of `ALTER TYPE`.
  The const tuples in `src/types/models.ts` are the single source of truth for
  both the TypeScript unions and the Zod schemas.
- `DATE` columns come back as `YYYY-MM-DD` **strings**, not JS `Date`s — see the
  type parser in `src/db/client.ts` and the comment explaining why. `NUMERIC`
  is a string too, so money and coordinates are typed that way.
- `created_at` / `updated_at` are on every table; `updated_at` is maintained by
  a database trigger, not by application code.
- Async route handlers are wrapped in `asyncHandler` so rejections reach the
  error handler. Express 4 does not do this for you.
- Throw `ApiError` (or the `badRequest` / `notFound` / … helpers) for anything
  the client should see. Everything else becomes a logged 500.

## Known gaps

- No refresh tokens or logout; a JWT is valid until it expires (`JWT_EXPIRES_IN`).
- No rate limiting on `/auth/login`.
- No automated test suite. `scripts/test-api.sh` is a smoke test, not a substitute.
- No `audit_log` yet. The spec puts it alongside contracts, payments and pricing,
  none of which exist, so it lands with build step 3.
- File uploads are recorded, not performed: `POST /operators/:id/documents`
  stores an object key that something else must have already written to a
  private bucket. No presigned-URL endpoint yet.
- List endpoints paginate with `OFFSET`, which should become keyset pagination
  before the tables get large.
