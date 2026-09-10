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
| 3 | Quotes → contracts → checklist, signature and payment token capture | **done** |
| 4 | Work orders, photo upload, completion gate | **done** |
| 5 | Email queue + templates, then review automation | mock only |
| 6 | Invoicing and payments | not started |
| 7 | Reporting views | not started |

Steps 5 to 7 mount into the same structure — a migration, a service of plain
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
./scripts/test-api.sh   # 179 checks against a running server; safe to re-run
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

The seed also lays down a rate card per branch and five quotes spread across
the lifecycle — two signed into active contracts (one with a card on file, one
paid upfront by cheque), one presented and waiting, one still a draft, and one
declined. Four work orders sit on those contracts: one completed with its
before and after photos, one on tomorrow's board, one skipped with a reason,
and one unassigned in Halifax, because that branch has no approved operator
yet.

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
picks from. `POST /work-orders` calls the same gate, so an operator who loses a
required document overnight cannot be handed tomorrow's route.

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
| DELETE | `/properties/:id` | any | 409 once a contract holds the address |
| GET | `/pricing-guide` | any | `driveway_size_cars`, `billing_type` |
| GET | `/pricing-guide/suggest` | any | `?property_id=&billing_type=` pre-fills a quote |
| GET | `/quotes` | any | `property_id`, `customer_id`, `status`, `billing_type` |
| POST | `/quotes` | any | Defaults to `draft` |
| GET | `/quotes/:id` | any | |
| GET | `/quotes/:id/contract` | any | `null` until it is signed |
| PATCH | `/quotes/:id` | any | Re-pricing; 409 once the quote is answered |
| PATCH | `/quotes/:id/status` | any | The lifecycle move |
| DELETE | `/quotes/:id` | any | Drafts only |
| GET | `/checklist-requirements` | any | The boxes the signature screen renders |
| GET | `/contracts` | any | `status`, `customer_id`, `property_id`, `quote_id` |
| POST | `/contracts` | any | Signature capture; 400 naming any unticked required box |
| GET | `/contracts/:id` | any | Includes the full checklist |
| PATCH | `/contracts/:id` | any | `pdf_url` and the payment method |
| PATCH | `/contracts/:id/status` | any | `active` → `cancelled` or `completed` |
| PATCH | `/contracts/:id/checklist/:code` | any | Ticking an optional box afterwards |
| GET | `/work-orders` | any | `status`, `service_type`, `assigned_user_id`, `scheduled_from`/`_to` |
| POST | `/work-orders` | corporate | Dispatch; refuses an unapproved operator |
| GET | `/work-orders/:id` | any | Includes the photo set |
| PATCH | `/work-orders/:id` | corporate | Reschedule and reassign |
| PATCH | `/work-orders/:id/status` | assigned operator or corporate | The completion gate lives here |
| GET | `/work-orders/:id/photos` | any | |
| POST | `/work-orders/:id/photos` | assigned operator or corporate | Geotag checked against the property |
| GET | `/audit-log` | corporate | `entity_type`, `entity_id`, `user_id`, `action` |

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

## Quotes, contracts and the signature gate

A deal is two records. A **quote** is what the rep prices and shows; a
**contract** is what gets signed. The money lives on the quote, and freezing it
is what makes the contract mean something.

```
draft ──► presented ──► accepted
  │           │            │
  └──────► declined / expired
```

Everything past `presented` is final: `PATCH /quotes/:id` returns 409 on an
answered quote, and a re-price means writing a new one. That keeps a record of
what was actually offered when a rep disputes a commission later.

`POST /contracts` is the signature. It runs in one transaction and does four
things or none of them: writes the contract, writes a checklist row for every
configured item, moves the quote to `accepted`, and writes the audit entry.

Three rules gate it:

- **The quote must have been presented.** Signing a `draft` is a 409 — nobody
  has seen it yet.
- **Every required checklist item must be ticked.** A 400 comes back naming the
  ones that are not, in the usual `details` array. Which items are required is
  seeded config (`checklist_requirements`), so the office can add one without a
  migration or a deploy.
- **`card_on_file` and the payment token move together.** Ticking the box
  without a token, or sending a token without the box, is a 400 either way.

`contracts_one_active_per_property` is a partial unique index: a driveway can
only be sold once at a time. Cancelled and completed contracts stay for the
audit trail and do not block next season.

### Card data

`payment_method_token` is a processor token and nothing else. It is:

- rejected if it looks like a card number — by `assertNotRawCard`, which catches
  the spaced and dashed forms, and by a `CHECK` constraint on the column as the
  last line of defence;
- never returned by the API (`PUBLIC_CONTRACT_COLUMNS`, the same idea as
  `password_hash` and `PublicUser`);
- never written to the audit log, which keeps `last4` and `brand` only.

`signed_ip` is taken from the connection, never the request body — that is what
makes it evidence. Behind a load balancer, set `TRUST_PROXY` or every contract
is stamped with the proxy's address.

### The audit log

`audit_log` is append-only, and a trigger enforces it: `UPDATE` and `DELETE`
raise. (`TRUNCATE` does not fire row triggers, which is how the dev seed resets
it.) Entries are written by the service that made the change, inside the same
transaction, so the log cannot drift from what happened. Contracts and quote
pricing are covered today; payments join in build step 6.

### Pricing guide

`pricing_guide` is seeded config keyed on `(branch_id, driveway_size_cars,
billing_type)`, read-only over the API like `document_requirements`.
`GET /pricing-guide/suggest?property_id=…&billing_type=…` is what the quote
screen opens with. It returns a null price rather than an error when the branch
has no row for that driveway size — an unpriced size is a gap in config, not a
failed request — and the rep can always override it.

## Work orders and the completion gate

A contract is a promise; a work order is one visit against it. The property
and branch come off the contract, so a visit cannot be filed against an
address the contract does not cover.

```
scheduled ──► en_route ──► in_progress ──► completed
    └─────────────┴──────────────┴────────► skipped
```

`scheduled` straight to `in_progress` is allowed on purpose — an operator who
starts clearing before remembering to tap "en route" should not be fighting
the app. A skip stays available until the job is finished, because the reason
to skip one is usually found on site, and `skip_reason` is required by a
`CHECK` constraint, not just by the service.

**Two different questions decide who may do what.** Branch scope says which
visits you can *see*; the assignment says whose you may *touch*. An operator
can read their branch's board but only work the visits assigned to them —
without that, any operator in the branch could complete a colleague's job.
Dispatch (creating, rescheduling, reassigning) is corporate.

### The completion gate

A visit cannot reach `completed` without at least one `before` and one `after`
photo. The 400 names which one is missing, in the usual `details` array, so
the app can say "take an after photo" rather than "something went wrong".

Photos carry `taken_at` **from the image EXIF, not the upload time** — an
operator with no signal finishes the street and uploads from the truck an hour
later, and the record has to say when the driveway was actually cleared. A
future `taken_at` is rejected as a broken clock.

Geotags are checked against the property, within `GEOTAG_RADIUS_M` (500m).
That is generous on purpose: phone GPS drifts badly between buildings and in
heavy snow, and a rejected upload strands an operator who did the work. Half a
kilometre still catches the case the check exists for — a photo taken
somewhere other than the address being billed. The check only runs when both
the property and the photo have coordinates; plenty of seeded addresses have
none, and refusing a photo over a gap in the office's data would punish the
wrong person.

### On completion

The customer and the branch manager are emailed the photo set, the finish time
and the operator's name. That send is deliberately **not awaited**: the
operator's phone should not wait on SMTP, and a failed send must not undo a
finished job. `sendEmail` is still the mock in `src/services/notifications.ts`
— build step 5 puts a real queue behind it and `notifyServiceComplete` does not
change.

## What is mocked

- `src/services/notifications.ts` — `sendEmail` / `sendSms` write to the log.
  Build step 5 replaces the bodies with a real queue and templates; callers do
  not change.

- `notifyServiceComplete` in `src/services/workOrders.ts` builds the real
  completion email but hands it to that same mock.

Not started: invoicing, payments, reporting, and any frontend. Contract PDFs
are a `pdf_url` column that something else has to fill in; nothing generates
one yet.

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
409s and 400s. `quotes` and `contracts` are the pair to copy when a resource
needs a transaction, a status machine, or an audit entry.

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
- `audit_log` covers contracts and quote pricing. Payments join it in build
  step 6; user role changes are not logged yet.
- File uploads are recorded, not performed: operator documents, contract
  signatures and service photos all store an object key that something else
  must have already written to a private bucket. No presigned-URL endpoint yet.
- List endpoints paginate with `OFFSET`, which should become keyset pagination
  before the tables get large.
