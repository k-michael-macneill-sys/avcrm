# avcrm — Avalanche CRM

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
with the seeded password. The login screen lists the other accounts.

Verify:

```bash
curl -s localhost:3000/health
./scripts/test-api.sh   # 285 checks against a running server; safe to re-run
npm run test:mail       # 17 checks against a real SMTP server; no server needed
```

While working on the client, `npm run dev:web` recompiles it on save; the API's
own `npm run dev` does not watch it.

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

All seeded users share the password in `SEED_PASSWORD` (default `Password123!`).

| Email | Role | Branch | Notes |
| --- | --- | --- | --- |
| `corporate@avcrm.test` | corporate | — | Sees every branch |
| `kingston.manager@avcrm.test` | corporate | Kingston | Branch manager |
| `halifax.manager@avcrm.test` | corporate | Halifax | Branch manager |
| `otto@avcrm.test` | operator | Kingston | Fully compliant, assignable |
| `nina@avcrm.test` | operator | Kingston | Abstract expires in 21 days |
| `pat@avcrm.test` | operator | Halifax | Documents submitted, awaiting review |

The seed also lays down a rate card per branch and six quotes spread across the
lifecycle: three signed into active contracts (two with a card on file, one
paid upfront by cheque), one still a draft, one declined, and one presented and
sitting with the customer — that last one is what the signature screen has to
work on.

Six work orders sit on those contracts, including three completed with their
before and after photos, one skipped with a reason, and one unassigned in
Halifax because that branch has no approved operator yet.

Two review requests are already answered — five stars routed to the public
page, two stars routed to the branch manager — and one finished visit is
deliberately left unasked, so `npm run job:review-requests` has something to
pick up on a fresh seed.

Both seasonal contracts are already invoiced: one paid by cheque, one overdue
with a declined card against it. The monthly contract has no invoice yet,
because its season has not started — run `npm run job:billing -- 2027-01-20`
to watch the periods get raised.

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
| GET | `/card-setups` | any | `contract_id`, `customer_id`, `status` |
| POST | `/card-setups` | any | Asks the customer for a card; returns the link |
| POST | `/card-setups/:id/refresh` | any | Asks the processor whether they finished yet |
| POST | `/webhooks/stripe` | **public** | Signature-verified; refuses anything unsigned |
| POST | `/uploads` | any | Asks for somewhere to put a file |
| PUT | `/uploads/:token` | the token | Sends the bytes; no session, by design |
| GET | `/files/*` | any | Reads one back, authorized by what it is |
| GET | `/reports/branch-summary` | corporate | One row per branch; `from`, `to`, `branch_id` |
| GET | `/reports/revenue` | corporate | Bucketed by billing month |
| GET | `/reports/operators` | corporate | Visits done, skipped, and the ratings after |
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
branch can reword a message without a deploy — the seed ships one Halifax
override of `service_complete` to show the mechanism. An unknown or empty
token renders blank and logs a warning: mailing a customer a literal
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

A small single-page app at `/app`, served by the same Express process.

**It adds no dependencies.** The client is TypeScript compiled by the `tsc`
that was already here into native browser ES modules — no bundler, no
framework, no npm install. `web/` is the source, `public/assets/` is the
output, and `public/index.html` loads it with a plain `<script type="module">`.

That is a real trade, so it is worth naming: the cost is roughly 150 lines of
hand-written router and DOM helpers that a framework would have supplied. What
it buys is a dependency tree that stays at nine runtime packages, one language
and one toolchain across the whole repo, and **shared types** — the client
imports `src/types/models.ts` directly, so a column that changes shape in a
migration breaks the UI at compile time rather than in front of a customer.

```
web/
  base.ts        where the client lives (/app), in one place
  api.ts         the only thing that talks to the API
  router.ts      path routing, one screen at a time
  dom.ts         h(), table(), link() — real nodes, never innerHTML
  form.ts        small forms, and turning an ApiError back into text
  format.ts      money, dates, and what a status looks like
  upload.ts      the two-step upload, and reading files back
  signature.ts   the canvas the customer signs on
  components.ts  hero figure, stat tiles, page furniture
  views/         one file per screen
public/
  index.html     the shell
  app.css        one stylesheet, no framework
  assets/        tsc output — gitignored, built by `npm run build:web`
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
- No charts. Two branches and a handful of figures is exactly the case where a
  one-bar bar chart says less than the number itself; stat tiles and tables
  carry it. A chart earns its place when there is a trend with a shape.
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

`web/signature.ts` is a canvas the customer signs with a finger or a mouse.
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
MAIL_FROM="Avalanche CRM <no-reply@example.test>"
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

```bash
npm run test:mail
```

Starts a throwaway SMTP server (`scripts/mail-sink.js`), queues messages into
`message_log`, drains them with the real driver, and asserts on what actually
arrived: the envelope, the headers, the body, the correlation id, a permanent
rejection not being retried, the redirect diverting, and the `log` driver
sending nothing. A transport that has never talked to an SMTP server is a
transport nobody has tested.

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

```bash
npm run test:payments
```

Starts `scripts/stripe-fake.js` — a stand-in that speaks Stripe's own request
and response shapes, including the 402 `card_error` a real decline produces —
and an API pointed at it, then drives the whole path over HTTP: ask for a card,
complete the capture, charge the saved card, take a decline, refund by webhook,
and prove an unsigned or forged webhook is refused. The real SDK builds, signs
and parses every request; only the far end is fake.

The suite asserts against the database, not just the responses: that the
customer exists at the processor, that the link was queued, that the stored
token is a `pm_…` and never a card number, that the checklist box ticked
itself, and that a replayed webhook leaves one payment row.

### Known gaps

- **The rep cannot read a card out even if they want to.** There is no Elements
  form and no manual-entry path, which is the point, but it means a customer
  with no phone and no email cannot be set up at the door — that one waits for
  Terminal.
- A setup that is never completed stays `sent` until it expires; nothing sweeps
  the expired ones yet.
- `message_log.status` still has no `bounced` path from a provider webhook.

## What is mocked

- **SMS only.** `sendSms` in `src/services/notifications.ts` logs and does
  nothing else. There is no SMTP equivalent for text messages — every gateway
  has its own HTTP API — so that one needs a provider chosen and an account
  opened. The queue, templates, retries and log around it are real; only that
  function body is not, and `review_request` and `en_route` both have SMS
  templates waiting for it.

  Email is no longer mocked: see [Mail](#mail).

Contract and invoice PDFs are a `pdf_url` column that something else has to
fill in; nothing generates one yet.

Payments are no longer mocked either, though they are opt-in: see
[Payments](#payments). Left on the default `PAYMENT_GATEWAY=manual`, this is
still a system of record — `POST /invoices/:id/payments` books what a processor
or a rep with a cheque says happened, and nothing here talks to a processor.

## Layout

```
src/                   the API
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
scripts/test-mail.sh   mail transport test, against a real SMTP server
scripts/mail-sink.js   the throwaway SMTP server it runs
web/                   the browser client (see above)
public/                index.html, app.css, and tsc's output
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
- No automated test suite. `scripts/test-api.sh`, `scripts/test-mail.sh` and
  `scripts/test-payments.sh` are smoke tests against real servers, not a
  substitute for one.
- `audit_log` covers contracts, quote pricing and payments. User role changes
  are not logged yet.
- `message_log.status` never becomes `bounced`. A 5xx *during* the SMTP
  conversation is caught and marked `failed`; an asynchronous bounce that
  arrives minutes later needs a provider webhook or a VERP return path, and
  neither is wired up.
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
