# avcrm — Drift Property Services CRM

Snow and ice removal CRM for a multi-branch operation: a JSON API, four scheduled
jobs, and a browser client that runs on top of them.

Stack: Node 20+, TypeScript, Express 4, PostgreSQL 15+, Knex (query builder and
migrations, not an ORM), Zod for validation, bcrypt, jsonwebtoken, pino,
nodemailer. The client adds no runtime dependencies at all — see [The browser client](#the-browser-client).

## Where this is in the build order

Build order from the spec, and what exists today:

| # | Step | Status |
| --- | --- | --- |
| 1 | Migrations for branches, users, onboarding, customers, properties + seeds | **done** |
| 2 | Auth, role middleware, branch scoping | **done** |
| 3 | Quotes → contracts → checklist, signature and payment token capture | **done** |
| 4 | Work orders, photo upload, completion gate | **done** |
| 5 | Email queue + templates, then review automation | **done** |
| 6 | Invoicing and payments | **done** |
| 7 | Reporting views | **done** |
| — | Browser client on top of the API | **done** |
| — | File storage: signature capture, photos, documents | **done** |
| — | Real SMTP mail transport | **done** |
| — | Card capture and charging through Stripe | **done** |
| — | SMS provider, connected by an administrator | **done** |
| — | Invoice and service report PDFs | **done** |
| — | Automated test suite | **done** |
| — | Containerised deployment, scheduler and CI | **done** |

Every step landed in the same structure — a migration, a service of plain
functions, a router — without reshaping what came before it. The known gaps
are listed at the bottom.

## Setup

```bash
npm install

cp .env.example .env
# Edit .env: set DATABASE_URL and a real JWT_SECRET (min 32 chars).
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

createdb avcrm
npm run migrate
npm run seed          # development sample data

npm run build:web     # compile the browser client into public/assets
npm run dev           # tsx watch, port 3000
```

Then open **http://localhost:3000/app** and sign in as `corporate@avcrm.test`
with the seeded password (see [Seed accounts](#seed-accounts)).

Verify:

```bash
curl -s localhost:3000/health
npm test                # the whole suite; makes and migrates its own database
```

To run the whole thing the way it deploys — database, jobs, TLS and all — see
[Deployment](#deployment).

While working on the client, `npm run dev:web` recompiles it on save; the API's
own `npm run dev` does not watch it.

The database owner needs to be able to `create extension citext`. It is a
trusted extension on PostgreSQL 13+, so the owner of the database can do this
without superuser rights.

### Production build

```bash
npm run build         # tsc -> dist/ and public/assets/
npm start             # node dist/server.js
```

Migrations have one entry point, `src/db/migrate.ts`, run either way:

```bash
npm run migrate          # from source, via tsx
node dist/db/migrate.js  # from the built image
```

Both record the same names, so either can run against the same database — see
[Deployment](#deployment) for why that took doing.

In production this is all handled by `docker compose up -d --build`.

## Scheduled jobs

```bash
npm run job:billing            # raise and send what is due, flag what is late
npm run job:message-queue      # drain the outbound queue
npm run job:review-requests    # ask about yesterday's finished visits
npm run job:document-expiry    # nightly compliance sweep
```

Each exits non-zero on failure, so a scheduler can alert on them.

### `job:billing`

The daily billing pass, in two phases: raise and send any invoice a live
contract owes by today, then mark anything sent, past its date and still short
as overdue, which queues the reminder. Safe to run twice in a night — a period
already invoiced is skipped, and a partial unique index backs that up if two
runs race.

It takes an optional date, which runs the pass as if it were that day:

```bash
npm run job:billing -- 2027-01-20
```

That is how you exercise a season that has not started yet, or backfill a
night the scheduler missed.

### `job:message-queue`

The outbound worker. Claims what is due, sends it, records the outcome, and
loops until there is nothing left — so one run empties a backlog rather than
trickling a batch per minute. Run it every minute.

Claiming uses `FOR UPDATE SKIP LOCKED` plus a five minute lease, so several
copies can run at once without sending anything twice, and a worker killed
mid-send holds nothing: the row simply becomes eligible again once the lease
runs out.

### `job:review-requests`

Asks for a rating a day after each finished visit. Run it daily; missing a
night is not a problem, because the window looks a week back and the next run
catches up. `runReviewRequests(now)` takes an injectable clock.

### `job:document-expiry`

The nightly compliance sweep. It expires approved documents past their date,
suspends any operator who loses a **required** document, and warns operators at
30, 14 and 7 days out, copying the branch manager. Each window is sent once.
`runDocumentExpiry(today)` takes an injectable date, so the whole ladder can be
exercised without waiting for real time to pass. It queues its warnings rather
than sending them, like everything else.

## Seed accounts

The seed installs no sample business data — no demo branches, crew or
customers. All of that is the operator's own, added through the app itself
(Company admin → Add a branch / Add someone, and Add customer on the
Customers screen) once they have signed in. The one thing a fresh database
cannot bootstrap through its own UI is the first login, so the seed creates
exactly one account for that:

| Email | Role | Branch | Notes |
| --- | --- | --- | --- |
| `corporate@avcrm.test` | corporate | — | Sees every branch; add the first one from here |

It shares the password in `SEED_PASSWORD` (default `Password123!`). Sign in,
change the password, then add branches, crew and customers as they come in.

## Auth and permissions

`POST /auth/login` returns a JWT. Send it as `Authorization: Bearer <token>`.

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"corporate@avcrm.test","password":"Password123!"}' | jq -r .data.token)

curl -s localhost:3000/customers -H "Authorization: Bearer $TOKEN"
```

Three roles:

- **corporate** — sees all branches and all roll-up reporting. Creates users,
  reviews documents, manages branches. Adding a branch also takes the owner
  password in `BRANCH_PASSWORD` (unset locks it), because branch managers are
  corporate too.
- **sales** — a door-to-door rep, hard-scoped to their own `branch_id`. The
  leads map, customers, quotes, contracts and the sign-up flow.
- **operator** — clears driveways, hard-scoped to their own `branch_id`.
  Dispatch, their visits and their document vault.

Selling and clearing are split by writes, not reads (`writesOnlyFor` in
`src/middleware/auth.ts`): only corporate and sales may create or change
customers, properties, quotes, contracts and card requests; only corporate
and operators may change visits. Reads stay shared within a branch — an
operator needs the address of the house they are clearing.

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

### Signing in

`/auth/login` is a password oracle open to the internet: without a limit, a
list of common passwords against one known address is free, and nothing in the
log distinguishes it from ordinary traffic until somebody gets in.

Two rules run on every sign-in and both must pass, because they stop different
attacks — **by address**, which catches one host working through many
accounts, and **by email**, which catches many hosts working on one account.
A refusal is a `429` carrying `Retry-After`, so a client is told when to come
back rather than left guessing.

**Only failures count.** The attempt is recorded first and released when the
response comes back under 400, so an operator signing in on the truck, the
office desktop and a phone never spends the budget. That is what makes a tight
limit safe: eight failures per account per fifteen minutes stops guessing
without ever troubling somebody who knows their own password.

Registration is throttled too, and it is the one place where success counts
against the limit rather than being forgiven — a script creating one valid
account after another is exactly what is being prevented, so forgiving it
would defeat the rule entirely.

| Setting | Default | |
| --- | --- | --- |
| `AUTH_RATE_LIMIT_WINDOW_S` | `900` | The window, in seconds |
| `AUTH_RATE_LIMIT_MAX` | `8` | Failed sign-ins per email address |
| `AUTH_RATE_LIMIT_MAX_PER_IP` | `30` | Failed sign-ins per address, across accounts |

The count lives in the application's memory, which suits a deployment running
one container. A second one would keep its own counters and the effective
limit would double; moving the store to Postgres is the change to make then,
and nothing around it would move. Set `AUTH_RATE_LIMIT_MAX=0` to switch a rule
off entirely.

The address it keys on is `req.ip`, so it depends on `TRUST_PROXY` being right
for the same reason `signed_ip` on a contract does — see
[Why the application port is not published](#why-the-application-port-is-not-published).

### Accounts are made, not signed up for

**`POST /auth/register` is off by default.** It only ever produced a pending
operator — the role is set on the backend and never read from the request, so
it could not mint a corporate account — but an endpoint that creates rows has
no business facing the internet on a system holding customers' names and
addresses. `ALLOW_SELF_REGISTRATION=true` opens it again; the rule that it
cannot grant itself a role is still tested, in `tests/selfRegistration.test.mts`.

Corporate adds people under **Company** in the browser client, which is the
only way an account comes into existence on a default install. Three positions
over the two roles the database has:

| On screen | Role | Branch | |
| --- | --- | --- | --- |
| Operator | `operator` | theirs | Sees their branch, works only visits assigned to them |
| Branch manager | `corporate` | theirs | Full access, and named as that branch's `manager_user_id`, so the failed-charge and expiry notices reach them |
| Corporate | `corporate` | none | Every branch |

The same screen adds branches. Both are corporate-only, at the API as well as
in the nav — an operator asking for `/app/admin` gets a plain explanation, and
the endpoints behind it refuse them regardless.

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
| GET | `/health` | public | Liveness — is the process answering |
| GET | `/ready` | public | Readiness — database, queue and storage; 503 when degraded |
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
| GET | `/work-orders/:id/report.pdf` | any | What was done, with the photos |
| GET | `/message-templates` | any | Global set plus the caller's branch overrides |
| GET | `/message-log` | any | `status`, `channel`, `template_code`, `customer_id` |
| GET | `/review-requests` | any | `routed_to`, `answered`, `customer_id` |
| GET | `/review-requests/:id` | any | |
| GET | `/review-requests/:id/rate?rating=N` | **public** | The one-tap link; 302s to the review page on 4-5 |
| POST | `/review-requests/:id/rating` | **public** | The same action for an API client |
| GET | `/invoices` | any | `status`, `customer_id`, `contract_id`, `outstanding` |
| POST | `/invoices` | corporate | A manual bill; raises a draft |
| GET | `/invoices/:id` | any | Includes its payments |
| GET | `/invoices/:id/payments` | any | |
| POST | `/invoices/:id/send` | corporate | draft → sent, and queues the notice |
| POST | `/invoices/:id/void` | corporate | 409 if money has been taken |
| POST | `/invoices/:id/payments` | any | Books money, or records a failed charge |
| GET | `/payments` | any | `status`, `method`, `invoice_id` |
| POST | `/payments/:id/refund` | corporate | Flips the payment; the invoice recomputes |
| POST | `/invoices/:id/charge` | corporate | Charges the card on the contract, nobody present |
| GET | `/invoices/:id/pdf` | any | The bill, rendered and kept |
| GET | `/card-setups` | any | `contract_id`, `customer_id`, `status` |
| POST | `/card-setups` | any | Asks the customer for a card; returns the link |
| POST | `/card-setups/:id/refresh` | any | Asks the processor whether they finished yet |
| POST | `/webhooks/stripe` | **public** | Signature-verified; refuses anything unsigned |
| GET | `/webhooks/meta` | **public** | Meta's subscription handshake; checks `META_VERIFY_TOKEN` |
| POST | `/webhooks/meta` | **public** | Facebook/Instagram messages; `X-Hub-Signature-256` verified against `META_APP_SECRET` |
| GET | `/meta/conversations` | corporate, sales | Paginated inbox; `platform`, `customer_id`, `unassigned=true` |
| PATCH | `/meta/conversations/:id` | corporate, sales | Route to a branch (corporate) or link a customer |
| GET | `/meta/conversations/:id/messages` | corporate, sales | The thread, oldest first |
| POST | `/meta/conversations/:id/messages` | corporate, sales | Queues a reply; `202`, the worker sends it |
| POST | `/uploads` | any | Asks for somewhere to put a file |
| PUT | `/uploads/:token` | the token | Sends the bytes; no session, by design |
| GET | `/files/*` | any | Reads one back, authorized by what it is |
| GET | `/reports/branch-summary` | corporate | One row per branch; `from`, `to`, `branch_id` |
| GET | `/reports/revenue` | corporate | Bucketed by billing month |
| GET | `/reports/operators` | corporate | Visits done, skipped, and the ratings after |
| GET | `/settings/sms` | corporate | Current provider; credentials never returned |
| PUT | `/settings/sms` | corporate | Connects a provider, or switches it off |
| GET | `/settings/sms/providers` | corporate | The catalogue the screen renders itself from |
| POST | `/settings/sms/test` | corporate | One real message through the saved credentials |
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

The token gets there without anyone reading a card number aloud — see
[No CVV at the door](#no-cvv-at-the-door).

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

## Signing up a customer, and the leads map

**Add customer** (`/app/customers/new`) is three pages. Page one is the
customer and the service address. Page two is the upsells (salt, vehicle
package, stairs — flags on the quote, no price of their own), monthly or
seasonal billing, and three prices: *initial* (the list price the discount is
shown against), *discounted* (what the first visit costs) and, for monthly,
*recurring* (every month after). A recurring price under $100 gets a second
look but is never refused. Nothing is written until the rep leaves page two;
then `POST /sales/deals` creates the customer, property and quote in one
transaction. Customers stay leads until they sign.

Page three either takes the signature on the rep's screen and goes straight
to the Stripe card page (or records cash or cheque taken for a seasonal
contract), or sends **email completion**: a single-use signed link
(`/app/sign/:token`, 14 days) where the customer confirms the terms, signs and
adds their card themselves. The billing run charges the discounted price for
the first period and the recurring price after it.

**Leads** (`/app/leads`) is a Google Map. Tap a house: *Not home*, *Not
interested*, *Lead* (optionally with a name and number, which files a lead
customer at that address), or *Add customer*, which opens the sign-up with the
address filled in. Tapping an existing pin is a revisit and counts the knock.
Signed customers are green pins drawn from their property, with what they pay
for and the permanent job notes — `GET /leads/customers`, which operators may
read too; door-knock pins are for sales and corporate only. The map needs
`GOOGLE_MAPS_API_KEY`: a browser key with the Maps JavaScript and Geocoding
APIs enabled, restricted to the site's address in Google Cloud.

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

## Messaging: the queue and the review gate

Nothing in the application talks to an email or SMS provider. Callers
`enqueueMessage`, and the worker sends — which is what makes `message_log` a
complete record of everything the system has ever said to anyone, and what
keeps an API response from waiting on SMTP.

```
caller ──enqueue──► message_log (queued) ──worker──► provider
                          │                            │
                          └────── sent / failed ◄──────┘
```

**Templates** are seeded config with `{{mustache}}` tokens. A row with a
`branch_id` overrides the global row for the same code and channel, so a
branch can reword a message without a deploy. An unknown or empty token
renders blank and logs a warning: mailing a customer a literal
`{{customer_first_name}}` is worse than a gap.

**Rendering happens at enqueue, not at send.** The rendered subject and body
are stored on the row, which is one column pair more than the spec lists. The
render context is gone by the time the worker runs, and a log whose rows
cannot show what was actually sent is not much of a log — editing a template
later must not rewrite history.

**Retries** are bounded by `MESSAGE_MAX_ATTEMPTS`. A send that throws leaves
the row `queued` with `attempts` incremented until the budget is spent, then
`failed`. `bounced` exists for a provider webhook to set; nothing sets it yet.

Because everything routes through here, the two previously-mocked senders now
do too: service completion notices and the whole document-expiry ladder are
queued rows, not direct calls.

### The review gate

A day after a finished visit, `job:review-requests` asks the customer for a
1-5 rating — one tap, no form. **4-5 redirects to the public review page; 1-3
stays in house and the branch manager is emailed** with the customer's name
and number. That routing is the entire point: a bad experience should reach
someone who can fix it, not a public star rating.

One ask per customer per 90 days. A season is long, and a list that gets asked
after every snowfall stops answering — which costs more than the reviews are
worth.

`GET /review-requests/:id/rate?rating=4` is **public and unauthenticated**: the
customer has no account, and the row's random v4 id is the capability. It is a
GET that writes, which is not something to do lightly — but an emailed link is
a GET and nothing else, and the whole feature is one tap. Tapping the same
star twice is treated as the same answer rather than an error; tapping a
different one is a 409.

## Billing

Two rules from the spec, and they differ:

- **A seasonal contract is billed at signature.** `createContract` raises the
  invoice inside the same transaction as the signature, so the customer never
  has a contract without a bill.
- **A monthly contract is billed per period, as each period starts.** Not all
  five at signature — that way cancelling mid-season simply stops the next one
  being raised, instead of leaving future invoices to chase and void.

`billingPeriods` splits a season into monthly periods, the last one ending on
`season_end` rather than running past it: Nov 15 to Apr 15 is five periods.
Month arithmetic clamps to the end of the target month, so 31 January plus one
month is 28 February and not 3 March.

```
draft ──send──► sent ──────► paid
                 │            ▲
                 └► overdue ──┘
   any of the above (unpaid) ──► void
```

**`amount_paid` is derived, never incremented.** It is recomputed from the
payments table after every payment write, so a refund cannot leave the total
drifting from the rows that explain it. A refund flips the original payment to
`refunded` rather than deleting it or writing a negative row — the history of a
disputed charge has to stay readable — and if that pulls an invoice back under
its total, the invoice returns to `sent` or `overdue` on its own.

**A failed card charge tells the customer and flags the branch manager**, per
the spec. Only a card gets the customer email: its wording is about a declined
card, and a bounced cheque is a conversation for the office rather than an
automated notice. The manager hears about either.

`provider_transaction_id` is unique where present, so a replayed processor
webhook cannot book the same charge twice. As with contracts, no card data
lands in `payments` — the token stays on the contract and is never copied.

Every payment write is audited, per the spec's list of things you will want
the first time a charge is disputed.

## Reporting

Three read-only views, all corporate — the spec puts roll-up reporting there,
and an operator gets their own run sheet through `/work-orders` rather than the
branch's numbers.

`GET /reports/branch-summary` is both of the spec's bullets in one endpoint.
Corporate with no `branch_id` gets every branch side by side, which is the
cross-branch comparison; narrowing with `?branch_id=` gives that branch's own
roll-up. Same query, same definitions, different scope. The skeleton comes from
`branches` rather than from activity, so a branch that sold nothing in the
window shows as zeroes instead of dropping out of the comparison.

**It is a revenue roll-up, not a P&L.** Nothing in the schema records a cost —
no operator pay, no fuel, no salt, no vehicle — so there is no margin here,
because any margin would be invented. Costs need their own tables before the
other half of a P&L can exist.

### What each figure means

A number without a definition is not worth acting on, so:

| Figure | Definition |
| --- | --- |
| `pipeline.win_rate` | `accepted ÷ (accepted + declined + expired)`. Open quotes are not losses yet, so drafts and presented quotes stay out of the denominator. `null` until something is answered. |
| `revenue.invoiced` | Sum of `amount_due` on non-void invoices. |
| `revenue.collected` | Sum of `amount_paid`, which is itself derived from succeeded payments. |
| `revenue.outstanding` | `amount_due − amount_paid` on `sent` and `overdue` invoices. |
| `revenue.overdue` | The same, on `overdue` invoices only. |
| `reviews.promoters` | Answers of 4 or 5 — the ones routed to the public review page. |
| `crew.pending` | `pending` and `docs_submitted` together: everyone not yet assignable. |

Void invoices are excluded from every money figure. A cancelled bill is not
revenue that went missing; it is a bill that never existed.

### Which date a window filters on

`?from=` and `?to=` are inclusive, and every response echoes the window back —
a figure without its date range is not a figure anyone should act on. Each
domain is filtered on the date that answers the question being asked:

| Domain | Date column |
| --- | --- |
| Customers | `created_at` — when the rep first put them on the books |
| Quotes | `created_at` — when it was written |
| Contracts | `signed_at` |
| Invoices and revenue | `billing_period_start` — the period the money belongs to, not the day the row was written |
| Work orders | `scheduled_for` — the day the visit was on the board for |
| Reviews | `sent_at` — when we asked, not when they got round to it |
| Crew | none; a head count is current state |

### How it is built

Each report is a handful of grouped aggregates, one per domain, stitched
together in TypeScript — deliberately not one enormous CTE. Every query can be
read, run and checked on its own, and the number of queries stays flat however
many branches there are.

`GET /reports/operators` uses a left join with the window *on the join*, not in
the where clause: filtering there would drop the operators who did no work, and
those are exactly the rows worth looking at.

## The browser client

A single-page app at `/app`, served by the same Express process.

**React, Tailwind and shadcn/ui**, built by Vite. `client/` is the source,
`client/dist/` is the build Express serves at `/app` (gitignored, built by
`npm run build:web`); `public/` holds only the one page outside the SPA —
`card-complete.html`, see below. **Shared types survive the framework
change**: the client still imports `src/types/models.ts` directly, so a
column that changes shape in a migration breaks the UI at compile time
rather than in front of a customer.

Dark is the default look — a deep navy background, glass-panel cards,
electric-blue accents — with light available from the toggle in the sidebar.
The choice is remembered per browser; nothing about it is stored server-side.

```
client/
  index.html          Vite's entry HTML
  vite.config.ts       base /app/, dev-proxies the API's routes to :3000
  tailwind.config.ts   shadcn's token setup — colors are all CSS variables
  src/
    main.tsx, App.tsx  providers, then the route table
    lib/
      api.ts            the only thing that talks to the API
      format.ts          money, dates, and what a status looks like
      upload.ts          the two-step upload, and reading files back
      useQuery.ts, useSubmit.ts   the two data-fetching/mutation hooks
                                   every screen is built from
    auth/               session context, the route guard, the corporate gate
    theme/              light/dark context and the toggle
    components/
      ui/                hand-written shadcn primitives (Button, Card, …)
      DataTable, DataForm, SignaturePad, FileWidgets, …
    routes/             one file per screen
```

### Why `/app`

The API owns the root paths — `/customers` is an endpoint — so the client
needs its own prefix rather than a fight over them. `/` redirects to `/app`,
anything under `/app` that is not a file serves the shell, and every in-app
link carries the real `/app/…` href so middle-click, "open in new tab" and
"copy link address" all land on the screen instead of on the JSON behind it.

### What it shows

| Screen | What it does |
| --- | --- |
| Dashboard | Corporate: the roll-up, next visits, money to chase. Operator: their own visits and paperwork |
| Customers | List, detail, add a customer or a property |
| Quotes | The lifecycle, and **signature capture** — the checklist, the terms, the card token |
| Contracts | The signed record, its checklist, its visits and its invoices |
| Dispatch | The board, booking a visit, and driving one to completion with photos |
| Invoices | Send, record a payment, refund, void |
| Crew | Compliance per operator, and approving documents |
| Company | Branches, and adding staff — corporate only |
| Reports | The branch comparison, revenue by month, operator scorecards |

**The two roles get genuinely different apps.** An operator's nav has no
Invoices or Reports, their dashboard is their run sheet rather than a company
revenue figure, and asking for a corporate screen by URL gets a plain
explanation. None of that is the security boundary — the API is, and it
refuses them the same way with no UI at all.

### The gates, on screen

The API's rules are the client's rules; it does not re-implement them, it
surfaces them. Both gates from the build are visible:

- **Signing** shows the checklist, and a submission missing a required box
  comes back naming each one — `checklist.terms_reviewed: not ticked` — because
  the client renders the API's `details` array rather than swallowing it.
- **Completing a visit** shows a running count of before and after photos on
  file before you try, and the refusal names which is missing if you do.

### Known gaps

- **The token is in `localStorage`.** That is the ordinary trade for a
  Bearer-token SPA — it survives a reload, and any script that gets onto the
  page can read it. The fix is an httpOnly cookie, which is an API change
  rather than a UI one.
- One chart — revenue by month on Reports, where there is finally a trend
  with a shape. Everywhere else stat tiles and tables still carry it; two
  branches and a handful of figures is exactly the case where a bar chart
  says less than the number itself.
- Lists page at 50–100 rows and stop; there is no pagination control yet,
  which is the same `OFFSET` limitation the API has.
- No automated browser tests. The screens were driven and screenshotted by
  hand through headless Chromium during the build, which is a check, not a
  suite.

## Files and signature capture

Uploading is two steps, the way an object store does it: **ask for a target,
then send the bytes to it.**

```
POST /uploads          →  { key, upload_url, max_bytes, expires_at }
PUT  <upload_url>      →  the bytes
…store the key on the row that needs it (a contract, a photo, a document)
GET  /files/<key>      →  read it back
```

The target carries a short-lived signed token, so **the URL is the
permission** — `PUT` deliberately sits outside `requireAuth`, exactly as it
would when a browser uploads straight to a bucket. That is the whole reason
for the two-step shape: swapping the local driver for S3 means handing back
the bucket's presigned URL from `POST /uploads` and changing nothing else, on
either side.

### The storage driver

`STORAGE_DRIVER=local` writes under `STORAGE_LOCAL_DIR`. That is a real
implementation, not a stand-in — it needs no credentials, works offline, and
is the right answer for a single server. A bucket driver implements the same
three methods (`put`, `read`, `exists`) in `src/services/storage.ts`.

### What a purpose decides

Every upload names a purpose, and the purpose — not the client — decides the
key prefix, the allowed content types and the size limit:

| Purpose | Types | Limit |
| --- | --- | --- |
| `signature` | PNG | 2 MB |
| `service_photo` | JPEG, PNG, WebP | 12 MB |
| `operator_document` | PDF, JPEG, PNG | 10 MB |
| `contract_pdf`, `invoice_pdf` | PDF | 10 MB |

**Keys are generated, never supplied.** The filename is a uuid, so nothing a
user typed reaches the filesystem and two uploads cannot collide. Keys are
still pattern-checked before touching a path, and the local driver re-checks
that the resolved path is inside its root — the one bug worth catching twice.

An oversized upload is refused on its declared `Content-Length` before a byte
is read, so the client gets a sentence rather than a reset connection; the
streaming cap still backstops a client that lies or sends chunked.

### Who may read a file

`uploads` records every issued target — who asked, for what, and whether the
bytes ever landed. That row is what makes read authorization possible for a
key nothing references yet: a signature is uploaded *before* the contract that
will point at it exists.

- Corporate reads anything.
- The uploader reads their own.
- An **operator document** is otherwise between that operator and corporate,
  matching the rule on `/operators/:id/documents`.
- Everything else is readable by the branch it belongs to.

A key with no stored bytes behind it is a 404, not a 403 — saying otherwise
would confirm which keys exist.

### The signature pad

`client/src/components/SignaturePad.tsx` is a canvas the customer signs with a finger or a mouse.
Pointer events, so a stylus, a fingertip and a trackpad are one code path;
backed at device pixel ratio, so a signature on a phone is not a blurry
approximation of one; `touch-action: none`, so a finger drag draws instead of
scrolling the page. It keeps its ink on a white pad in both themes, because
the image gets printed and emailed where the reader's dark mode does not
follow it.

Submitting uploads the PNG first and only then posts the contract — a contract
without a signature is not a contract, so there is no point sending the rest
if that fails.

### Reading files in the browser

A browser puts no `Authorization` header on an `<img src>` or a plain link, so
`/files/:key` would 401 for both. Stored files are fetched with the token and
handed to the page as blob URLs instead. The alternative is a signed read URL
like the upload target — worth doing when images get numerous, and it trades a
session check for a URL that works for anyone who copies it.

### Seeded files are real files

`npm run seed` writes actual bytes through the storage driver and records the
matching `uploads` row, because that row is what a read is authorized against.

It used to record keys like `private/signatures/harold-bell.png` that nothing
had ever written to, which is a 404 by design — so a freshly seeded install
showed a broken image on every completed visit, a signature nobody could open,
and a service report whose photos all read *"This photo could not be
included"*. The demo data disagreed with the feature it was meant to
demonstrate.

The images are drawn rather than checked in (`src/db/seedFiles.ts`): a
repository is a poor place for sample JPEGs, and a generated driveway can be
snow-covered in the before and cleared in the after, which is the one thing
that pair has to show.

### Known gaps

- **Nothing checks that a key exists when a row records it.** `POST /contracts`
  still accepts any string as `signature_image_url`. A `HEAD` against the
  store belongs with the bucket driver.
- Orphans are not collected. `uploads` rows that were issued and never stored,
  or stored and never referenced, accumulate; the table has what a sweeper
  needs, but there is no sweeper.
- No virus scanning, and no image re-encoding to strip EXIF. A service photo's
  geotag is read from what the client sends, not from the file itself.

## Mail

`MAIL_DRIVER=smtp` sends real email through nodemailer. SMTP rather than a
vendor's HTTP API on purpose: Postmark, SES, Mailgun and SendGrid all issue
SMTP credentials, so one driver covers any of them and changing provider is a
change to `.env` rather than to code.

`MAIL_DRIVER=log` is the default and writes to the application log. A dev box
and the API test suite should not need a mail server, and nothing should be
one missing environment variable away from emailing real customers.

```bash
MAIL_DRIVER=smtp
MAIL_FROM="Drift CRM <no-reply@example.test>"
SMTP_HOST=smtp.postmarkapp.com
SMTP_USER=…
SMTP_PASSWORD=…
```

Both are checked at startup: `MAIL_DRIVER=smtp` without `SMTP_HOST` or
`MAIL_FROM` refuses to boot, rather than failing when the first invoice goes
out.

### The staging valve

```bash
MAIL_REDIRECT_TO=staging@example.test
```

Sends **every** message there instead of to the customer, keeping the real
recipient in the subject (`[to: harold@…] Your invoice`). Staging is usually a
copy of production with real addresses in it; without this, the first queue
drain after a restore mails them all.

### A bounce is not a blip

The queue now distinguishes the two, because they want opposite treatment:

| What happened | What the queue does |
| --- | --- |
| SMTP 5xx — no such mailbox | `failed` immediately, after one attempt |
| SMTP 4xx, or no connection | stays `queued`, retried until `MESSAGE_MAX_ATTEMPTS` |

Retrying a 550 three more times wastes the budget and looks like spam to the
server refusing it. The run summary counts the two separately: `rejected` for
refusals, `failed` for things that ran out of attempts.

Every message carries an `X-Avcrm-Message-Id` header holding its `message_log`
id, so a message in the provider's dashboard can be tied back to the row that
produced it.

### Verifying it

`tests/mail.test.mts` and `tests/mailRedirect.test.mts` start a throwaway SMTP
server, queue messages, drain them with the real driver, and assert on what
actually arrived: the envelope, the headers, the body, the correlation id, a
permanent rejection not being retried, and the redirect diverting. A transport
that has never talked to an SMTP server is a transport nobody has tested.

## Payments

Card handling is a port with two drivers, chosen by `PAYMENT_GATEWAY`:

- **`manual`** (the default) is the system as it was: `POST /invoices/:id/payments`
  records what a processor, a cheque or an e-transfer says happened. Nothing
  here talks to anyone. Asking it to charge a card returns `NOT_CONFIGURED`
  rather than pretending.
- **`stripe`** actually moves money.

```
PAYMENT_GATEWAY=stripe
PAYMENT_CURRENCY=cad
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
```

Both keys are required when the gateway is `stripe` — config refuses to start
without them rather than failing at the first charge. `STRIPE_API_HOST`,
`STRIPE_API_PORT` and `STRIPE_API_PROTOCOL` exist only to point the SDK at the
stand-in used by the test suite.

### No CVV at the door

The rep never touches a card. They press **Ask the customer for a card** on the
contract screen; the customer gets a link, opens the processor's own hosted
page, and types the card in themselves. So:

- no card number and no CVV is ever read out on a doorstep;
- no card data reaches this server, this client, or the rep's phone;
- what comes back is a reusable payment method, which is what a seasonal
  contract needs — next month's invoice charges it with nobody present.

At the door the fastest path is usually to hand the customer the phone, so
`POST /card-setups` returns the link as well as queueing it: the response has
`url` alongside the queued email or text.

```
POST /card-setups          → session at the processor, link queued, status `sent`
   customer types the card on the processor's page
webhook (or POST /card-setups/:id/refresh)
                           → token on the contract, last4 + brand stored,
                             the `card_on_file` checklist box ticks itself
```

The refresh endpoint exists for the case the webhook has not landed yet and a
rep is standing on the step waiting. It is the same code path as the webhook
and is idempotent, so both firing changes nothing.

`card_setups` stores the session id, the link and the status — never a card.
Completing one writes `payment_method_token`, `payment_method_last4` and
`payment_method_brand` onto the contract and ticks `card_on_file` **in one
transaction**, because the contract service treats a token on file and that
box as a single fact and will not let them disagree.

**The later upgrade is tap-to-pay.** Stripe Terminal turns the rep's phone into
a contactless reader, so the customer taps their own card or watch and there is
still no number to read out. It needs a native iOS/Android app — the reader SDK
cannot run in a browser — so it is a second client against this same API, not a
change to it. The hosted link works today on any phone.

### Charging

`POST /invoices/:id/charge` charges the card on the contract off-session. The
billing job does the same thing unattended for every sent invoice with a card.

Every charge carries an idempotency key of `invoice:<id>:<amount in cents>`, so
a retried request, a timed-out response or a re-run of the job books one charge
and not two. Money is converted to minor units once, from the string the
database holds — it is never a float.

A decline is an answer, not an error: the charge comes back `failed` with the
processor's own reason, which is stored on the payment row and goes out in the
two notices the spec asks for (the customer hears about a declined card, the
branch manager hears about any failure). The invoice stays owing.

Refunds go through the same port, and the invoice recomputes its `amount_paid`
from the payment rows as it always has.

### Webhooks

`POST /webhooks/stripe` is public, because the processor has no account here.
What makes it trustworthy is the signature, so the route is mounted **before**
`express.json` and reads a raw `Buffer`: a parsed and re-serialised body is not
the bytes that were signed, and the check would fail on honest traffic while
still passing nothing useful. An unsigned or forged request is a 400.

It handles four events:

| Event | What it does |
| --- | --- |
| `checkout.session.completed` | Finishes the card capture |
| `payment_intent.succeeded` | Reconciles a charge we already booked |
| `payment_intent.payment_failed` | Marks the payment failed with the reason |
| `charge.refunded` | Flips the payment to `refunded` |

Stripe redelivers, so every handler is keyed on the provider's own id and doing
it twice changes nothing.

### Verifying it

`tests/payments.test.mts` runs against a stand-in that speaks Stripe's own
request and response shapes, including the 402 `card_error` a real decline
produces. It drives the whole path: ask for a card, complete the capture,
charge the saved card, take a decline, refund by webhook, and refuse an
unsigned or forged one. The real SDK builds, signs and parses every request;
only the far end is fake.

It asserts against the database, not just the responses: that the customer
exists at the processor, that the link was queued, that the stored token is a
`pm_…` and never a card number, that the checklist box ticked itself, and that
a replayed webhook leaves one payment row.

### Known gaps

- **The rep cannot read a card out even if they want to.** There is no Elements
  form and no manual-entry path, which is the point, but it means a customer
  with no phone and no email cannot be set up at the door — that one waits for
  Terminal.
- A setup that is never completed stays `sent` until it expires; nothing sweeps
  the expired ones yet.
- `message_log.status` still has no `bounced` path from a provider webhook.

## Documents

Two things a customer is handed: what they owe, and what was done at their
property. `GET /invoices/:id/pdf` and `GET /work-orders/:id/report.pdf`, and a
download button on each screen.

**pdfkit rather than a headless browser.** Rendering HTML would mean shipping
Chromium in the container — two hundred megabytes and a sandbox to worry about
— to produce a two-page invoice. These draw directly, start in milliseconds,
and use only the built-in fonts, so there are no font files to deploy and
nothing to license.

The documents take plain data rather than reaching for the database
(`src/services/pdf/documents.ts`), so one can be rendered in a test without a
server — which is how the suite checks that a name, a balance and a missing
photo really appear on the page.

### Rendered when wanted, not when written

Most invoices are paid by a card on file and never printed, and most visits are
never asked about, so nothing is rendered on a schedule. A document is made the
first time someone asks for it, stored through the same object store as
photos and signatures, and the key kept on the row (`invoices.pdf_url`,
`work_orders.report_pdf_url`).

It is then regenerated by itself once the thing it describes has moved on — a
payment lands, a visit is re-completed — by comparing the stored file's
timestamp against the row's `updated_at`. Nobody is handed a bill that
disagrees with the screen.

Reads go through the same branch rules as everything else, and the response is
`private, no-store`: an invoice names a customer and what they owe, so it has
no business in a shared cache.

### What is on them

The invoice carries the customer, the service address, the period, what is
owed, and the payments that settled it. A **failed** charge is deliberately not
on it — the office needs to know a card was declined; the customer's copy of
their bill is not where that belongs. The balance line only appears once
something has been paid, because on an untouched invoice the balance is the
total and saying it twice reads as an error.

The service report carries the times, the operator, the access notes, any skip
reason, and the photographs with their timestamps and coordinates. pdfkit
embeds JPEG and PNG only, so a WebP from a newer phone — or a file storage has
lost — is reported as *"This photo could not be included"* rather than silently
dropped. A gap in a record is worse than a note about it.

### Known gaps

- A customer cannot fetch their own invoice: both routes need a session, and
  customers have no account. Emailing the PDF, or a signed read link like the
  upload targets use, is the next step.
- Contracts still have a `pdf_url` that nothing fills in. The toolkit is there;
  the document is not written yet.

## Text messages

Mail has SMTP, so one driver covers every provider. SMS has no such thing —
every gateway has its own HTTP API — which normally means picking a vendor at
build time and writing code against them. Since that decision is a business
one, and gets revisited, it is a setting instead.

**A corporate user connects a provider at `/app/settings`.** Pick one, fill in
the credentials it asks for, send a test, switch it on. No redeploy, no .env
edit, and a manager can do it.

### The catalogue

`src/services/smsProviders.ts` describes each provider as data — the fields an
admin must fill in, how to turn those into one HTTP request, and where the
message id turns up in the reply:

| Provider | Needs |
| --- | --- |
| Twilio | Account SID, auth token, sending number |
| Telnyx | API key, sending number |
| MessageBird (Bird) | Access key, originator |
| Vonage (Nexmo) | API key, API secret, sending number |
| Anything else (HTTP) | URL, content type, auth header, body template |

The screen renders itself from `GET /settings/sms/providers`, so adding a
provider to that file adds it to the UI with no change to the client.

**The custom shape is the point of the list, not an afterthought.** A regional
carrier, a reseller, or an internal relay is configured by giving the endpoint
and a body template using `{{to}}`, `{{from}}` and `{{body}}`. Substitution
escapes per content type, so a quote or a newline in a customer's message
cannot break out of the JSON string it sits in and rewrite the request — the
suite sends `Quoted "text" and a backslash \` through it and checks what the
gateway received.

### Credentials

Secret fields are encrypted with AES-256-GCM before they are written
(`src/utils/secrets.ts`), and:

- never returned by the API — `GET /settings/sms` says *which* secret fields
  have a value, not what they are;
- never written to the audit log, though the change itself is audited: this is
  the switch that decides whether customers get texted and whose account pays
  for it;
- write-only in the UI. A blank field means "keep what is stored", so changing
  the sending number does not mean retyping the token.

Switching provider drops the old credentials rather than carrying them across.
A Twilio token is not a Telnyx key, and keeping it would leave a secret nobody
can see and nobody meant to keep.

The encryption key is derived from `JWT_SECRET` by default, so an existing
install needs no new variable. Set `SECRETS_KEY` to decouple them — then
rotating `JWT_SECRET` signs everyone out without also making stored
credentials unreadable. Either way this defends against a leaked database
dump, not against someone who already has the application's environment; the
upgrade is a KMS behind the same two functions.

### Sending

Nothing is sent until an administrator switches it on. Until then an SMS is
still queued, rendered and logged — it just does not leave, exactly as the old
mock behaved. The difference is that replacing the mock is now a form.

`SMS_REDIRECT_TO` is the same safety valve as `MAIL_REDIRECT_TO`, for the same
reason: a staging database is a copy of production with real phone numbers in
it, and a text cannot be unsent.

Failures are classified the way mail's are, because the queue needs the same
answer. A 4xx is the gateway saying the number is wrong or the credential is
not accepted, and no amount of retrying changes either — that stops after one
attempt. A 429, a 5xx, or a connection that never opened is timing rather than
judgement, and goes back in the queue. A gateway that answers `200` and puts
the refusal in the body — Vonage does this — is treated as the refusal it is.

A test send is deliberately not a silent success or a 500: a refused test
comes back as `400` when it is permanent and `502` when it is worth retrying,
carrying the gateway's own words, because "401: authenticate" is what tells an
admin the token is wrong.

### Verifying it

`tests/sms.test.mts` runs against a stand-in answering on Twilio's, Telnyx's
and Vonage's own URL shapes and checking credentials the way they do, then does
what an administrator would: connect a provider, send a test, switch it on, and
let the queue drain. It also checks the things worth being sure of: that an
operator cannot read or change the settings, that the token never comes back
out of the API or appears in the database or the audit log, that a bad number
is not retried and an outage is, that switching provider drops the old
credentials, and that the custom provider can reach a gateway nobody wrote code
for.

### Known gaps

- **Inbound is not handled.** A STOP reply unsubscribes the customer at the
  carrier, and this system will not know — it needs a webhook per provider, and
  the same delivery-receipt path that would give `message_log` a `bounced`
  status.
- Numbers are stored as typed. A provider that insists on E.164 will reject
  anything else, and the error will say so, but nothing normalises them first.
- One provider for the whole company. Per-branch numbers would be a `branch_id`
  on the settings row.

## Facebook and Instagram messages

Direct messages to the Facebook Page, and to the Instagram business account
linked to it, land in `meta_conversations` and `meta_messages`: one
conversation per person per platform, and every message in and out of it.

**Setting it up.** In the Meta app dashboard, add the Messenger product (and
Instagram messaging, if the account is linked), subscribe the Page to the
`messages` and `message_echoes` fields, and point the webhook at
`https://<your domain>/webhooks/meta`. Then set, in Render or `.env`:

| Variable | What it is |
| --- | --- |
| `META_PAGE_ACCESS_TOKEN` | The Page's access token. Sends replies. Without it, replying answers 503. |
| `META_APP_SECRET` | The app secret. Every webhook's `X-Hub-Signature-256` is checked against it; without it every delivery is refused. |
| `META_VERIFY_TOKEN` | Any string you choose; type the same one into the dashboard when subscribing. |
| `META_GRAPH_API_BASE` | Optional. Defaults to `https://graph.facebook.com/v19.0`. |

**Incoming.** The webhook checks the signature over the raw body — it is
mounted before the JSON parser, like Stripe's — then stores each message.
Meta redelivers anything it did not get a 200 for, so storage is idempotent
on Meta's message id. A photo or voice note with no text is stored as
`[image]`, `[audio]` and so on. Replies somebody types into Meta's own inbox
come back as echoes and are stored as outbound, so the thread here is whole.

**Which branch.** A message says which Page it reached, not which town the
sender is in. With one active branch, new conversations go straight to it.
With several, they wait unassigned: corporate sees them
(`GET /meta/conversations?unassigned=true`) and routes them with `PATCH`,
and linking a customer routes the conversation to that customer's branch.
Sales reps see only their own branch's conversations; operators none.

**Replying** follows the message queue's rule: nothing talks to Meta inside a
request. `POST /meta/conversations/:id/messages` writes a `queued` row and
answers 202, and `job:message-queue` — which now drains `meta_messages` as
well as `message_log`, with the same claim, lease and retry budget — sends
it. A rate limit or an outage is retried; a refusal that will not change (the
person blocked the Page, the token is bad) fails at once with Meta's reason
in `error`.

Meta only allows a reply within **24 hours** of the person's last message.
The endpoint checks that first and answers 409 rather than queueing
something certain to fail.

### Verifying it

`tests/metaMessaging.test.mts` runs against a stand-in Graph API
(`tests/helpers/graphApi.ts`) that checks the bearer token and answers with
Meta's own error shape. It covers the handshake, unsigned, wrongly signed and
tampered deliveries, redeliveries, Instagram versus Page, branch routing and
scoping, the 24-hour window, a permanent refusal against a retried rate
limit, and the echo of our own reply arriving before and after the worker
records it.

### Known gaps

- **No screen yet.** The API is complete; the inbox page in the app is the
  next step.
- **No names.** Meta identifies people by a Page-scoped id. Showing their
  name means a Graph API profile lookup per new conversation, which is not
  done yet, so a conversation is anonymous until someone links a customer.
- **Text only, one Page.** Outbound attachments, message tags for replies
  after 24 hours (`HUMAN_AGENT` needs Meta's approval), and more than one
  Page are not handled.

## What is mocked

Nothing is mocked any more. Email goes out over SMTP ([Mail](#mail)), text
messages go through whichever gateway an administrator connects
([Text messages](#text-messages)), and cards are charged through Stripe
([Payments](#payments)).

Two of those are off by default, which is not the same as mocked: an install
with no SMS provider connected and `PAYMENT_GATEWAY=manual` queues, renders and
logs everything it would have sent, and records payments as a system of record.
That is a deliberate state — it is what a new install should do before anyone
has opened an account — and switching it on is configuration rather than code.

Contract and invoice PDFs are a `pdf_url` column that something else has to
fill in; nothing generates one yet.

## Deployment

### Running it locally

Two ways to run this without a domain or TLS.

**Option A: without Docker** (good for development)

```bash
npm install

cp .env.example .env
# Edit .env: set DATABASE_URL and JWT_SECRET (min 32 chars).

createdb avcrm
npm run migrate
npm run seed

npm run build:web
npm run dev
```

Open **http://localhost:3000/app** and sign in as `corporate@avcrm.test` (see
[Seed accounts](#seed-accounts) for the password).

**Option B: with Docker Compose** (runs the whole system the way it deploys)

```bash
cp deploy/env.local.example .env
docker compose -f docker-compose.yml -f deploy/compose.local.yml up -d --build
```

That brings up Postgres, the migrations, the application, and the four scheduled
jobs. Open **http://localhost:3000/app**.

The local override (`compose.local.yml`) strips out Caddy and backups and
publishes the app on port 3000. Both files use a single `.env`; the base
compose checks `DOMAIN` and `ACME_EMAIL` at parse time even though Caddy will
not run, so placeholder values are fine.

### Production deployment

Five steps, in this order:

```bash
cp deploy/env.example .env
npm run secrets                # generates the three it cannot guess
$EDITOR .env                   # paste those in, plus DOMAIN, SMTP, Stripe
npm run preflight              # refuses to bless a half-filled .env
docker compose up -d --build

docker compose exec app node dist/ops/bootstrap.js \
  --branch "Kingston" --province ON \
  --email you@example.ca --first-name Your --last-name Name
```

`npm run preflight` is the step worth not skipping. The application already
refuses to boot on a missing `DATABASE_URL`, so that class of mistake is
caught anyway; preflight catches the other kind — the settings that are
individually valid and still wrong for production. A `DOMAIN` still reading
`crm.example.ca`. `MAIL_DRIVER=log`, so every invoice is written to a file
instead of sent. `MAIL_REDIRECT_TO` left over from staging, so every message
goes to you and no customer ever hears anything. It exits non-zero on those
and lists them; things that are your call, like running without an offsite
backup, come back as warnings rather than refusals.

That brings up Postgres, the migrations, the application, the four scheduled
jobs, TLS, and a nightly dump. Only Caddy is published; the database and the
application are reachable only from inside the compose network.

**The bootstrap step is not optional.** Migrations create the schema and
nothing else, so a new database is empty in a way there is no way out of
through the API: signing in needs a user, creating a user needs a corporate
session, creating a branch needs a corporate session, and self-signup is off
(and only ever made a pending operator anyway). Every route in is a dead end.
The development seed would solve it and deliberately refuses to run with
`NODE_ENV=production` once a single user exists, which is right — it wipes
every table it owns, and a production database is not something to wipe.

So `bootstrap` does the three things a new install cannot do for itself:
installs the configuration the application treats as given (document
requirements, the signing checklist, every message template), creates the
first branch, and creates the first corporate user. It prints that user's
password once. It refuses to create a second administrator on an install that
already has users, so it is safe to re-run after an upgrade — which is worth
doing, because that is also how a newly added message template gets installed.

Afterwards, check it is actually working rather than merely running:

```bash
curl -s https://your-domain/ready | jq
```

### What it needs

- A host with a **persistent disk**. Signatures, service photos, operator
  documents and generated PDFs are written to a volume
  (`STORAGE_LOCAL_DIR=/data/storage`). Anywhere with an ephemeral filesystem
  loses all of it on every deploy — see [Files](#files-and-signature-capture)
  for the bucket driver that would lift that requirement.
- A domain already pointing at the machine, and ports 80 and 443 open. Caddy
  gets a certificate on first boot, which is a real HTTP request to this
  server.
- Roughly 2GB of memory. Postgres, Node and Caddy are not demanding, and this
  is one company rather than a platform.

A small VPS in a Canadian region is the honest fit: this holds Canadian
customers' names, addresses, phone numbers and signed contracts, and Toronto
or Montreal costs the same as anywhere else.

### The environment file

`.env` beside `docker-compose.yml` holds every secret the system has. Own it
as root, mode 600, and keep it out of the repository — it is also the thing to
back up alongside the database, because **losing `SECRETS_KEY` makes the
stored SMS credentials unreadable**.

Three settings decide whether the system works rather than merely runs:

| Setting | Why it matters |
| --- | --- |
| `APP_BASE_URL` | Card-setup links and review links are built from it. Wrong, and a customer at the door gets a link to nowhere. |
| `TRUST_PROXY` | Set to `true` by the compose file. Behind Caddy the client address arrives in a header, and a contract records the IP its signature came from. |
| `DATABASE_URL` | The host is `postgres`, the compose service name, not `localhost`. |

#### Why the application port is not published

`TRUST_PROXY=true` tells Express to believe `X-Forwarded-For`. That is correct
behind Caddy and **only** behind Caddy, because Caddy does not trust an inbound
`X-Forwarded-For` either: it discards whatever the client sent and rewrites the
header with the address the connection actually came from. Measured, signing
the same contract three ways:

| Reached via | Client sends `X-Forwarded-For: 203.0.113.77` | `signed_ip` recorded |
| --- | --- | --- |
| Caddy, `TRUST_PROXY=true` | Caddy replaces it | `127.0.0.1` — the real peer |
| The app directly, `TRUST_PROXY=true` | believed as sent | **`203.0.113.77` — forged** |
| The app directly, `TRUST_PROXY=false` | ignored | `127.0.0.1` — the real peer |

So `signed_ip` is evidence only while Caddy is the sole way in. The compose
file keeps it that way by publishing ports on Caddy alone — **publishing the
`app` service's port, even briefly to debug something, makes every signature
taken in that window attributable to an address the signer chose.** If the
application does need to be reachable directly, set `TRUST_PROXY=false` with
it, which is what `deploy/compose.local.yml` does.

### How it starts

`migrate` runs to completion before `app` and `scheduler` start, so the schema
is never behind the code that expects it. It is a separate service rather than
something in the entrypoint because two application containers starting at
once would otherwise both try to migrate.

Migration names are recorded **without a file extension**
(`src/db/migrationSource.ts`). Under tsx a migration is a `.ts` file; in the
image it has been compiled to `.js`, and Knex compares the recorded names
against what it finds on disk. Without this, pointing a local checkout at the
server's database once would leave the container unable to migrate ever again,
with nothing but *"the migration directory is corrupt"* to explain itself.

A database created before that change has the old names in it, so
`src/db/migrate.ts` strips the extensions on the way past. It is idempotent
and a no-op on a new database, which means upgrading an existing deployment is
still just `docker compose up -d --build`.

### The jobs

`scheduler` runs all four in one process, so a deployment is `docker compose
up` and nothing else — rather than a machine where everything looks healthy
and no customer has been emailed for a week because one crontab line was never
added.

| Job | Runs |
| --- | --- |
| `message-queue` | every minute — nothing reaches a customer until it does |
| `review-requests` | hourly |
| `document-expiry` | daily |
| `billing` | daily |

Intervals run from boot rather than at a wall-clock hour. Every one of them is
safe to run twice, so a redeploy shifting the hour costs nothing. A job that
throws is logged and the others carry on; a job never overlaps itself; and
`SIGTERM` waits for what is mid-run, so a deploy cannot cut a billing pass in
half.

**If you would rather use host cron**, drop the `scheduler` service and run:

```cron
*  *    * * *  cd /srv/avcrm && docker compose run --rm app node dist/jobs/messageQueue.js
15 *    * * *  cd /srv/avcrm && docker compose run --rm app node dist/jobs/reviewRequests.js
30 2    * * *  cd /srv/avcrm && docker compose run --rm app node dist/jobs/documentExpiry.js
0  3    * * *  cd /srv/avcrm && docker compose run --rm app node dist/jobs/billing.js
```

That buys you billing at 3am specifically, at the cost of configuration that
lives outside the repository.

### Backups

`deploy/backup.sh` dumps nightly, keeps a fortnight, and writes to a temporary
name first so an interrupted dump is never left looking like a good one.

**A dump on the same machine as the database is not a backup.** It survives a
bad migration, not a dead disk. `BACKUP_OFFSITE_CMD` is what takes a copy off
the machine; it is given the dump's path as `$1`, so anything that can be
written as a shell line works:

```bash
BACKUP_OFFSITE_CMD='rclone copy "$1" remote:avcrm-backups/'
BACKUP_OFFSITE_CMD='aws s3 cp "$1" s3://avcrm-backups/'
BACKUP_OFFSITE_CMD='scp "$1" backups@elsewhere:/srv/avcrm/'
```

Where that points is deliberately your decision, because it decides who holds
your customers' data. Leave it empty and the system keeps working and says so
in the log every night — there is then exactly one copy of everything.

Two things the script does that are easy to leave out:

- **A dump is verified before it counts.** `pg_dump` exiting zero says nothing
  about whether the bytes that reached the disk decompress, and an archive
  nobody can open is discovered at the worst possible moment. It is
  `gzip -t`ed under a `.part` name and only then moved into place.
- **Pruning waits for the offsite copy.** If tonight's upload failed, the
  fortnight of older dumps is kept rather than rotated away — otherwise a
  quietly broken upload would eat the backups it was supposed to be
  replacing. With no `BACKUP_OFFSITE_CMD` set at all, pruning runs as normal,
  because that operator has accepted one copy and still needs the disk not to
  fill.

Restoring:

```bash
docker compose stop app scheduler
gunzip -c backups/avcrm-<stamp>.sql.gz | docker compose exec -T postgres psql -U avcrm -d avcrm
docker compose start app scheduler
```

Test that before you need it. A backup nobody has restored is a hypothesis.

### Updating

```bash
git pull && docker compose up -d --build
```

Migrations run first, then the application restarts. The storage volume and
the database are untouched.

### Watching it

Two endpoints, answering different questions:

| | Asks | Who polls it | On failure |
| --- | --- | --- | --- |
| `GET /health` | Is this process answering? | the container healthcheck | Docker restarts the container |
| `GET /ready` | Is the system doing its job? | an external uptime monitor | 503 |

`/ready` checks the database, the outbound queue and the storage volume. The
queue one is the point of it. Nothing in the application sends anything
directly — everything is queued and drained by the scheduler — so if that
process dies, or an SMTP credential is rotated, every screen keeps working,
every request still returns 200, and no customer hears anything. That is the
failure that goes unnoticed for weeks. It reports the age of the oldest
message still waiting, not the size of the queue: a large backlog draining
steadily is fine, one message stuck for an hour means nothing is draining.

It answers without a session, because a monitor has no account, and its
details are coarse on purpose — `"unreachable"` rather than the driver's
message, which can carry a host and port. The real error goes to the log.

Deliberately **not** wired to the container healthcheck: restarting the
application because a separate process stopped draining the queue would
achieve nothing and hide the problem.

### Still to do before this is properly production

- **No logout and no refresh tokens** — a JWT is valid until it expires.
  Sign-in itself is throttled (see [Signing in](#signing-in)), but a leaked
  token cannot be revoked short of rotating `JWT_SECRET`, which signs
  everybody out.
- **Nothing is alerted automatically.** `/ready` will tell a monitor the
  truth, but something still has to be pointed at it and told whom to wake.
- One machine is one point of failure. That is a reasonable trade at this
  size, but it is a trade: with no `BACKUP_OFFSITE_CMD` set, a dead disk is
  the end of the business's records.

## Tests

```bash
npm test                       # everything
npm test tests/billing.test.ts # one file
npm run typecheck              # the application, the client and the suite
```

`npm test` creates `avcrm_test` if it is not there, migrates it to head, and
runs the suite with `node --test`. A forgotten migration fails here rather than
in production, and the database is a separate one from the dev database so a
run can truncate freely.

**Real Postgres, not a fake.** Every constraint and trigger in this schema is
load-bearing — the append-only audit trigger, one active contract per property,
one non-void invoice per period, the timestamps that must agree with a status —
and a test that does not exercise them is testing something other than this
system.

**Real HTTP, not a mocked request.** The app is started on an ephemeral port
and called with `fetch`. The things most worth testing are middleware-shaped:
the branch scope resolved from a token, the raw body a webhook signature is
computed over, a PDF's content type and cache headers.

### How a suite is put together

`tests/helpers/harness.ts` gives a file a server, an empty database before each
test, and a freshly built world — two branches, the people who work in them,
and the config rows the application treats as given. No test can be made to
pass or fail by the one before it.

Fixtures insert rather than post. A test about the completion gate should fail
because the gate is wrong, not because signing a contract six calls earlier
changed shape — so only the thing under test goes through HTTP.

Message templates are generated from `TEMPLATE_CODES` rather than listed, so a
code added to the application arrives in the fixtures with it. A suite that has
to be edited every time a message is added stops being run.

### The stand-ins

Three suites configure the application differently from the rest — a payment
gateway, an SMS provider, an SMTP host — and configuration is read once at
load. Node runs each test file in its own process, so those files set their
environment and then import the application, which top-level `await` expresses
and CommonJS cannot; hence `.mts` for `payments`, `sms`, `mail` and
`mailRedirect`.

Their far ends are in-process servers (`tests/helpers/`) that speak the real
vendors' request and response shapes. The application genuinely builds, signs
and sends every request; only what answers is ours.

### Reading a PDF back

A test that checks the bytes start with `%PDF` proves nothing about what is on
the page, so `tests/helpers/pdf.ts` inflates the content streams and decodes
the text operators. That is how the suite knows a customer's name, a balance,
and the note about a photo that could not be embedded are really there.

It has tests of its own (`tests/pdfExtractor.test.ts`), which it earned. The
first version delimited a stream by the newline before `endstream`, which ate
a byte of any deflate output happening to end in `0x0D` — about one stream in
256, which is often enough to fail a suite run every few tries and rare enough
to look like a ghost. Writing the regression test found a second bug in the
same reader: after a stream it could not inflate, it resumed scanning *inside*
the word `endstream` and lost everything after it.

### What is covered

| File | What it holds the line on |
| --- | --- |
| `auth` | Sign-in, the registration gate, role guards, branch scoping |
| `customers` | CRUD, the duplicate address warning, the delete conflicts |
| `contracts` | The signature gate, card-data rules, the audit trail |
| `workOrders` | Dispatch rules, the completion gate, geotagging |
| `billing` | Period splitting, invoice lifecycle, derived totals, refunds |
| `messaging` | The queue's claim and retries, the review rating gate |
| `reports` | The three roll-ups, and that they are corporate work |
| `uploads` | Signed targets, and who may read a file |
| `pdf` | Both documents, rendered and downloaded |
| `payments` | Card capture, charging, declines, webhooks |
| `sms` | Connecting a provider, credentials, sending |
| `mail` | Real delivery, bounces, the staging redirect |
| `scheduler` | Graceful shutdown, the overlap guard, a job that throws |
| `rateLimit` | Sign-in throttling, and that success is forgiven |
| `preflight` | What a deploy check refuses, and what it only warns about |
| `health` | Readiness going red on a queue that stopped draining |
| `pdfExtractor` | The reader the PDF tests lean on |

## Layout

```
src/                   the API
  server.ts            process entry: connect, listen, shut down
  app.ts               builds the Express app (importable without a port)
  config/              dotenv + Zod; throws at startup on bad config
  db/
    client.ts          the single Knex instance, pool and type parsers
    knexfile.ts        config file for the knex CLI
    migrationSource.ts names migrations without an extension, so .ts and .js agree
    migrations/        one file per table, in dependency order
    seedFiles.ts       draws the seed's signatures, photos and documents
    seeds/             development sample data
  jobs/                scheduled work: each runs as a script or from scheduler.ts
  ops/                 deploy tooling: secret generation and the preflight check
  routes/              HTTP only: validate, scope, call a service, respond
  middleware/          auth, error handler, request logger, rate limiting
  services/
    pdf/               the layout toolkit and the two documents
    ...                business logic; plain functions, no classes
  types/               row shapes, JWT payload, module augmentation
  utils/               errors, async wrapper, Zod helper, pagination, scope
tests/                 the suite; helpers/ holds the harness and the stand-ins
client/                the browser client — React, Tailwind, shadcn/ui (see above)
public/                card-complete.html, the one page outside the SPA
Dockerfile             multi-stage: build with dev deps, run dist without them
docker-compose.yml     postgres, migrate, app, scheduler, caddy, backup
deploy/                Caddyfile, backup.sh, env.example
scripts/test-setup.sh  makes and migrates the test database, then runs the suite
.github/workflows/     typecheck, test, build, and build the image
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
- Sign-in throttling counts attempts in the application's own memory, which
  suits one container and would become per-container if there were two — see
  [Signing in](#signing-in).
- Nothing is alerted automatically. `GET /ready` reports the truth to whatever
  polls it, but pointing a monitor at it is a deployment step, not something
  the repository can do — see [Watching it](#watching-it).
- Coverage is by behaviour rather than by line, and is thin in places: the
  document vault's expiry job, pricing suggestions, and the browser client have
  no tests of their own.
- `audit_log` covers contracts, quote pricing and payments. User role changes
  are not logged yet.
- `message_log.status` never becomes `bounced`. A 5xx *during* the SMTP
  conversation is caught and marked `failed`; an asynchronous bounce that
  arrives minutes later needs a provider webhook or a VERP return path, and
  neither is wired up. The same hole on the SMS side means a STOP reply or a
  delivery receipt never reaches this system — see
  [Text messages](#text-messages).
- The internal feedback route returns JSON. A real deployment would redirect a
  1-3 rating to a feedback form the way a 4-5 redirects to the review page.
- Files are stored on local disk by default. That is a driver choice rather
  than a gap, but it means a second server does not see the first one's files
  — see [Files and signature capture](#files-and-signature-capture).
- List endpoints paginate with `OFFSET`, which should become keyset pagination
  before the tables get large.
- Reports run their aggregates live against the operational tables. That is
  right at this size and will not be past a few hundred thousand invoices —
  materialise them, or read from a replica, before it becomes a problem.
- There is no cost data anywhere, so `/reports/branch-summary` is revenue only.
  A real P&L needs operator pay, materials and vehicle costs first.
- Taking a card at the door needs the customer to have a phone or an email.
  Tap-to-pay would close that, and needs a native app — see
  [Payments](#payments).
