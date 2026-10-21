# Phase 2 — Booking platform (design v7) — build plan & progress log

Source design: `docs/design/Hajj_Booking_Platform_Architecture_v7.pdf` (Bengali, 45 pages).
Branch: `dev` (every step is reviewed, verified with `pnpm verify`, committed and pushed to `origin/dev`).

## Working rules

- One step = one reviewed, green, pushed unit. Review = the code-review skill/agents on the step's diff,
  plus `security-reviewer` for auth/PII/money/DB-constraint work and `database-reviewer` for migrations.
- DRY / SOLID / KISS: new code follows the existing layering (thin `server/api` routes →
  `server/services` → pure `server/domain` → `server/repositories`, scoped by branded scopes).
- New business modules live in per-module subfolders of each layer (`server/{services,domain,repositories}/<module>/`).
  A module's services are used by other modules only through `server/services/<module>/index.ts`.
- Money: integer halalas, never floats. Dates: `date` for nights, `daterange '[)'` for stays.
- Ambiguities are decided as a senior engineer and recorded in **Decision log** below (no blocking questions).

## Steps

| # | Step | Status |
|---|------|--------|
| 0 | Baseline `pnpm verify` on `dev` (unit 486, integration 902, http 128) | done |
| 1 | Phase 2-0: pnpm workspaces + Turborepo | done (bef70c1) |
| 2 | Phase 2-0: app → `apps/api` | done (acb9638) |
| 3 | Phase 2-0: `shared/` → `packages/contracts` (`@hajj/contracts`) | done (155deb8) |
| 4 | Phase 2-0: `db/` (schema, migrations, client, migrate, drift) → `packages/db` (`@hajj/db`); seed + test reset stay in `apps/api` | done (b47c6f5) |
| 5 | Docs: v7 PDF, open client questions, Phase 2a tickets, schema-per-module decision | done |
| 6 | pg-boss transaction spike (Drizzle/postgres.js `tx.unsafe` adapter) + jobs foundation | done |
| 7 | 2a: security prerequisites (rate limit, CSRF origin check, principal kinds, staff 2FA, PII crypto) | done |
| 8 | 2a: booking-platform schema (agency, customer, pricing, pilgrim, booking*, guest_stay, view, constraints) | done |
| 9 | 2a: inventory ↔ booking conflict rules + Phase 1 lock gaps (floor deactivate, room reactivate, period delete) | done |
| 10a | 2a: agency accounts — registration, staff approval, agency users, agency sign-in (`AgencyScope`), RBAC sync | done |
| 10b | 2a: customers — phone OTP sign-up/sign-in (`CustomerScope`) | done |
| 10c | 2a: booking settings, rates, quotas, room-mix rules, extra-bed policies (staff admin) | done |
| 10d | 2a: WhatsApp quotes and price resolution (quote → agency default → public, per night) | done |
| 11 | 2b: allocation engine (DP, property tests), locked holds, sweep, concurrency tests | done |
| 12 | 2c: agency booking API (search, quote, hold, confirm, receipt/QR), staff on-behalf booking | done |
| 13 | 2d: guest details, passport pipeline (MRZ, OCR worker, AI fallback, review), check-in, extra-bed tasks, reminders, occupancy calendar | 13a guest details, 13b passport pipeline done |
| 14 | 2e: changes & cancellation (add/remove guest, date change, room move, cancel, no-show, early checkout) | |
| 15 | 2f: public booking API (REQUESTED flow, OTP, abuse limits) | |
| 16 | Frontends: `packages/ui`, `apps/ops-console`, `apps/agency-portal`, `apps/public-site` | |
| 17 | Final review (code, security, database, architecture) and docs | |

## Local environment note

Port 5433 on the development machine used for this build is taken by an unrelated SSH tunnel, so the
suites were run against a local PostgreSQL 16 on 5434 with `DATABASE_URL` exported. CI is unaffected
(it uses its own 5433 service container).

## Decision log

(Appended as steps land.)

- **D-P2-1 (2-0) Logical layer paths.** The layering checker keeps its rules in logical paths
  (`server/`, `shared/`, `db/`) and mounts each workspace package at its logical prefix
  (`WORKSPACE_LAYOUT`), so the rules and their meta-tests did not change with the folder layout.
- **D-P2-2 (2-0) Packages ship TypeScript sources.** `@hajj/contracts` and `@hajj/db` export `.ts`
  files directly (no build step); Nitro inlines them, Vitest/tsx/drizzle-kit resolve them natively.
- **D-P2-3 (2-0) Seed stays in the app.** The seed writes through `apps/api` repositories, so it
  stays in `apps/api/db/seed`; `@hajj/db` never depends on the app.
- **D-P2-4 (2-0) DB CLI environment.** `packages/db/env.ts` loads process env, then
  `packages/db/.env`, then `apps/api/.env` (development convenience).
- **D-P2-5 (2-0) Data ownership.** One `public` schema; ownership enforced in code
  (`docs/decisions/0001-module-data-ownership.md`).
- **D-P2-6 Push access.** `git push origin dev` is denied for the current GitHub account
  (pull-only on `SarafatUllah/hajj-umrah-hotel-ops`); every step is committed on local `dev` and the
  push is retried after each step.
- **D-P2-7 (jobs) pg-boss inside the caller's transaction.** The spike works
  (`docs/spikes/2026-10-21-pg-boss-transactional-send.md`): `enqueue(job, data, { tx })` writes the job
  in the Drizzle transaction; no outbox table. Tiers: `light` jobs run in API processes
  (`JOBS_MODE=light`, default), `heavy` jobs only in the worker process (`pnpm --filter @hajj/api worker`).
  Dedupe is a queue policy (`short`/`singleton`/`stately`), not a bare `singletonKey`.

- **D-P2-8 (security) Rate limits in PostgreSQL, consumed before the check.** Fixed windows in
  `rate_limit_bucket`, subjects stored as SHA-256 digests. Every attempt takes its slot with one atomic UPSERT
  BEFORE the guarded check, so parallel requests never pass more checks than the limit (review finding: a
  check-then-record pair let a burst through); a success clears the identity's counters. Login: 60 attempts /
  15 min per client address; 5 per (organization+email, client address); 30 per organization+email from
  anywhere (a stranger needs several addresses to lock a user out, distributed guessing stays bounded — the
  accepted lockout trade-off); TOTP codes 5 / 15 min per user (login and disable; needs the password first).
  Client address = socket address, or with `TRUST_PROXY` the LAST `X-Forwarded-For` entry (exactly one
  trusted proxy; the API must not be reachable around it); IPv6 grouped by /64, IPv4-mapped unwrapped. A hit
  stamped with an older window (clock skew between processes) counts against the newer window.
- **D-P2-9 (security) A used TOTP step never works again.** `totp_last_step` is advanced atomically
  (`… where totp_last_step is null or < step`); the enrolment code's step is recorded too. A user who just
  logged in must therefore wait for the next 30-second step before a code is accepted again (e.g. to disable
  2FA) — the standard trade-off.
- **D-P2-10 (security) CSRF.** SameSite=Lax cookies plus the origin check middleware; requests with
  neither `Origin` nor `Sec-Fetch-Site: cross-site` pass: browsers send `Origin` on every cross-origin unsafe
  request, so only non-browser clients (curl, server-to-server) lack both. The same-host comparison ignores the
  scheme (behind a TLS-terminating proxy the API may see `http`); HSTS and Secure cookies cover the http origin.
- **D-P2-11 (security) Session version and 2FA recovery.** `app_user.session_version` travels in the sealed
  session; enabling or disabling 2FA bumps it (the acting session gets a re-issued cookie, every other session
  of the user is rejected) and so does an administrator reset (`POST /api/users/:userId/2fa/reset`,
  `user.manage`, never oneself, never a user with `allHotels` without having it, audited with a reason). This
  answers the review's "attacker with the password enrols their own authenticator" case: the owner's admin
  resets it and the attacker's sessions end. Setup start is audited too. Out-of-band enrolment proof (e-mail)
  needs a mail channel and is left to a later phase.
- **D-P2-12 (security) Accepted for now.** `TWO_FACTOR_REQUIRED` tells a caller the password was right (the
  usual step-up trade-off; the attempt limits apply). Logout clears only the browser's sealed cookie (stateless
  sessions, 8 h); the session version covers the 2FA events. No security-event log stream yet besides the
  audit rows (planned with observability).

- **D-P2-13 (schema) Dates.** Stays are `check_in`/`check_out` date columns (`[check_in, check_out)`), and
  constraints build `daterange(check_in, check_out, '[)')` — the same date-column style as Phase 1, so Drizzle
  and the app keep plain `YYYY-MM-DD` strings. Seasons (rates, quotas) are inclusive night ranges like
  `capacity_period`.
- **D-P2-14 (schema) Quote use lives on the booking.** No `price_quote.used_by_booking_id`: `booking.quote_id`
  with the partial unique index `booking_quote_once` (`status <> 'EXPIRED'`) — an expired hold gives the quote
  back for a retry within its validity, a cancelled booking keeps it used (v7 §12).
- **D-P2-15 (schema) What is encrypted.** Passport numbers, the booker's free-form extras (address, place of
  birth, issue data, phone), extracted scan fields and passport images are encrypted. Name, gender,
  nationality, date of birth and passport expiry stay in clear text in the access-controlled tables: the
  calendar, check-in, age-group and expiry rules need them. Logs (`audit_log`, `booking_change`,
  `pii_access_log`) carry ids only.
- **D-P2-16 (schema) Owner integrity.** Besides the v7 checks, `booking_room (org, booking_id,
  owner_agency_id)` references `booking (org, id, agency_id)`, so a claim's owner agency is always its
  booking's agency.
- **D-P2-17 (schema) Settings and receipts.** `booking_setting` is one row per organization (hotel-level
  overrides if ever needed); a missing row means all defaults (readers fall back, the first write upserts).
  v7's `receipt_no` is the booking number; the QR carries the random `receipt_token`.
- **D-P2-18 (schema) Shared value lists.** `@hajj/db` depends on `@hajj/contracts` for every status/kind list,
  so the CHECK constraints, index predicates and the API validate the same values, and changing a list
  without a migration fails `db:drift`. The hand-written SQL (exclusion constraints, the seat function) is
  outside Drizzle, so `schemaInvariants.test.ts` compares it with the constants. `booking_change.kind`
  deliberately has no CHECK (like `audit_log.action`).
- **D-P2-20 (schema, database review) Seat counting is a function, not a view.** v7's `room_night_occupancy`
  view expands every stay of the hotel's whole history (a LATERAL `generate_series` cannot be filtered
  first); `room_night_occupancy(org, hotel, from, to, rooms)` applies the night range before expanding and
  uses date arithmetic (no time-zone dependence). Infants are identified by `booking_guest.age_group`, so
  `guest_stay.occupies_seat` was dropped (a separate flag could disagree with the age group).
- **D-P2-21 (schema, database review) Status and containment in the database.** `booking_room.status` is
  denormalized for the exclusion constraints, so triggers keep it equal to the booking's status (except a
  RELEASED claim). Deferred constraint triggers (checked at COMMIT, so a date change may reorder its
  statements) keep stays within claims and claims within the booking. Capacity per room-night is NOT a
  constraint: the hold and inventory transactions lock the rooms (`ORDER BY id FOR UPDATE`) before counting.
  One bed per pilgrim SLOT (the same person in two bookers' bookings is a staff warning, v7 §13).
- **D-P2-19 (schema) Schema invariants test.** `tests/integration/db/schemaInvariants.test.ts` asserts on the
  migrated catalog that every non-platform table has `organization_id NOT NULL` and every foreign key has a
  covering index (it found `role_permission`'s, fixed in 0009).

- **D-P2-22 (inventory) Write, then verify against bookings.** Instead of modelling each inventory operation's
  proposed state, the operation writes inside its transaction and then `assertBookingsStillFit` re-reads
  the rooms' inventory as it now is (the same `loadRoomInputs` + calendar engine the calendar uses) and
  compares it with the live claims and `room_night_occupancy(...)` seat counts; a misfit throws and the
  transaction rolls back. One rule for every operation, no duplicated capacity logic. Freeing operations
  (cancelling or ending a block early, raising capacity) skip the check. The hotel setting
  `inventory.maintenanceBlocksSales` turning ON is guarded too (code review): it locks the rooms of every
  running/future MAINTENANCE block and re-checks their nights. Consequence for step 11: a hold reads the
  calendar options AFTER taking its room locks, so it always sees a committed setting change.
- **D-P2-23 (inventory) Lock order floor → room.** Floor deactivation locks the floor, then its rooms; room
  create / move / reactivation lock the target floor first (reactivation now also requires an active
  floor, 409 `FLOOR_INACTIVE`). Period → rooms for every override change, including deletes. Cost: room
  creates and moves on one floor serialize on that floor's row (admin operations; acceptable).
- **D-P2-24 (architecture) Ticket 5 module boundary.** `BUSINESS_MODULES = ['booking']`: only a module's own
  `server/{services,domain,repositories}/<module>/` files reach its internals; everything else imports
  `server/services/<module>/index.ts`. Phase 1's flat services are not a module.

- **D-P2-25 (accounts) Agencies.** The `accounts` module owns `agency`, `agency_user` (and `customer`, 10b).
  Self-registration is public, rate limited per address (5/h) and per organization (50/h), and always answers
  202 `{ received: true }`: a licence number (compared upper-cased, trimmed) or e-mail already known is silently
  not registered again, after the same Argon2 work (security review: no enumeration, no PENDING squatting
  signal); the audit row records the client address. The agency starts PENDING. Staff with
  `agency.manage` approve, suspend or reject with a reason (PENDING→APPROVED|REJECTED, APPROVED→SUSPENDED,
  SUSPENDED→APPROVED|REJECTED, REJECTED→APPROVED), or create an agency verified offline (APPROVED at once). An
  agency user may sign in whatever the agency's status (to see it); `auth: 'agency'` routes require an APPROVED
  agency by default (403 `AGENCY_NOT_APPROVED`) and only `auth: 'agency-any-status'` (the portal's `me`) opts
  out. The staff's `statusReason` stays internal (never in the agency's `me`). Sign-in shares the staff throttle
  (`security/loginThrottle.ts`), with counters keyed by principal kind. Agency sessions carry `kind: 'agency'`,
  the agency id and a session version (deactivating a user ends its sessions); `/api/agency/**` routes use
  `auth: 'agency'`, staff routes refuse agency sessions and vice versa. `server/security` may call a module's
  repository factory (principal resolution), nothing else outside the module may.
- **D-P2-25b (accounts) Follow-ups.** Agency-user password change/reset and invitations (staff currently set the
  first password) come with the agency portal UI (step 16). `agency.view` is organization-wide by design
  (agencies are not hotel-scoped).
- **D-P2-27 (accounts) Customers sign in by SMS code.** Sign-up and sign-in are one flow (v7 §21): request a
  code (202 whatever the phone), then verify it (a new customer gives a name: 422 `FULL_NAME_REQUIRED`, the
  code stays usable). Six digits from a CSPRNG, valid 5 minutes, 5 attempts per challenge counted atomically,
  consumed once inside the sign-in transaction; only HMAC(lookup key, challenge id + code) is stored; every
  failure is 401 `OTP_INVALID`. Security review (SMS pumping, guessing, harassment): only allowed countries
  receive codes (`SMS_ALLOWED_CALLING_CODES`, default 966); an optional Cloudflare Turnstile bot check
  (`CAPTCHA_DRIVER`); one code per phone per minute and 3 per 15 minutes, a new code closing the older ones (one
  live code per phone); 10 verifications per phone per hour across challenges and addresses; generous per-address
  limits (carrier NAT); an organization SMS budget per hour and per day (env, with a log warning). SMS goes
  through a pluggable sender (`SMS_DRIVER=disabled|log|webhook`; `log` only in development, phone masked;
  webhook https-only, no redirects). Customer sessions carry `kind: 'customer'` and a session version ("sign out
  everywhere" bumps it); `defineApiHandler({ auth: 'customer' })`; `CustomerScope`.
- **D-P2-27b (accounts) Accepted risk: the phone is the identity.** Whoever controls the number (SIM swap,
  recycled number) gets the account. When bookings and passport data attach to customers (step 15), sensitive
  actions get a fresh-code step-up and the UI masks the phone.
- **D-P2-28 (booking) One implementation for the hotel booking rules.** Rates, agency quotas, room-mix rules and
  extra-bed policies are hotel-scoped rows a manager lists, adds, edits and removes, so one repository base
  (`ScopedRuleTable`, a concrete `*Repository` per table for the isolation registry), one service driven by a
  per-kind config (permissions, audit entity type) and one route set
  `/api/hotels/:hotelId/booking-rules/:kind` (`rates|agency-quotas|allocation-rules|extra-bed-policies`) serve
  them. Rates use `rate.view` / `rate.manage` (so the Accountant role, which holds `rate.manage`, maintains
  prices), the others `booking.view` / `booking.settings`. A PATCH is merged onto the stored rule (row-locked:
  concurrent edits serialize) and validated as a whole with the kind's schema (an unknown key is a 422; a no-op
  writes nothing); overlaps and duplicates come from the table constraints (409 `RANGE_OVERLAP` /
  `ALREADY_EXISTS`). Every change is audited
  (`BOOKING_RULE_CREATED|UPDATED|DELETED`). Booking settings (`/api/booking-settings`, organization-wide) are
  read with get-or-create (an existing row is read without writing), so the defaults live only in the schema;
  changes are audited with the changed fields.
- **D-P2-29 (booking) Quotes.** An approved agency asks (`POST /api/agency/quotes`) or staff open one for an
  approved agency; a REQUESTED quote gets `Q-<year>-<n>` from `document_sequence` (one atomic UPSERT per
  organization, kind and year; the row lock serializes concurrent requests) and a WhatsApp click-to-chat link
  (`wa.me`, the organization's number and template from the booking settings; null while unset). Staff with
  `quote.manage` on the hotel offer the price (REQUESTED or OFFERED → OFFERED, valid `validHours`, default the
  48 h setting; the answer flags a price above the highest public rate for the stay) or decline with a reason
  (audit only). An OFFERED quote past its validity reads EXPIRED at once and an hourly light job stores it. An
  agency only ever sees its own quotes; staff only quotes of hotels they can access (others are 404). A quote
  never holds rooms (v7 §8). The reference year is the hotel's local year; agency requests are limited to 30
  an hour per agency; an inactive hotel's quotes can be read but not offered or declined (409). The expiry
  sweep logs a failing organization and carries on with the rest, then fails the job so pg-boss retries it.
- **D-P2-30 (booking) Pricing domain.** `domain/booking/pricing.ts`: per night and room type, a quote's price,
  else (agency) the AGENCY_DEFAULT rate, else the PUBLIC rate; GROUP per person (seated pilgrims only — empty
  seats are never charged), FAMILY per room (a quote's unit wins); extra beds per room type at the policy price;
  a night without a price leaves the stay unpriced (the hold refuses it, step 11). Lines are what
  `booking_price_line` stores, frozen at booking time.
- **D-P2-31 (security) Organization-wide changes need every hotel.** Booking settings, agency approval and
  agency users serve every hotel, so (like Phase 1's organization-level writes) they also require `allHotels`
  besides the permission (an automated review caught the gap in the settings).
- **D-P2-32 (booking) Allocation engine.** `domain/booking/allocation/roomOptions.ts` is v7 §9.4's dynamic programme
  (state: seats, extra-bed space, capped rooms; a per-size knapsack for price and extra-bed space; capped sizes
  first, then the cap dimension merged away) with four deliberate changes, all checked by a property test
  against a brute force over every subset of the actual rooms (10,000 seeded cases; each room's own price and
  extra-bed space, 6-seat rooms, the "5 or more seats" cap, an individual's room limit): options are distinct
  room mixes; an option never contains a room nobody sleeps in; equal options prefer bigger rooms (§9.2 step 4e);
  each state keeps its best three distinct mixes in place (no per-state list growth and sort).
- **D-P2-33 (booking) Planner rules.** GROUP: children sit on the requested side (default the setting's, §23 Q16);
  each side first fills the agency's own rooms — every live claim the same agency, the same gender and exactly the
  same dates (§23 Q10) — with rooms that become completely full first (subset sum); then new rooms that are free for
  the whole stay, the room-mix rule chosen and applied per side (§23 Q11). The side with more pilgrims left is
  placed first; the other side is planned on the rooms left, so options never share a room. FAMILY: whole free rooms
  only, no room-mix rule, an individual's room limit. Extra beds only in the booking's new rooms, slept in, within
  each room type's per-booking limit. Concrete rooms (§9.2 step 6): around the median floor of the agency's rooms
  for the stay, else around whichever floor keeps the rooms closest; then cheaper; then by room number. Infants
  sleep in the first room of the children's side. The hold re-check (`stayPlanCheck.ts`) applies the same rules;
  a property test proves every offered option passes it.
- **D-P2-34 (booking) An extra-bed pilgrim pays the extra-bed price.** v7 §8's shown price is "seated pilgrims ×
  the person price + extra beds": the pilgrim on an extra bed is charged the extra-bed price instead of a seat;
  per-room pricing charges the rooms plus the extra beds.
- **D-P2-35 (booking) The hold transaction.** One transaction, one lock order: the agency's advisory quota lock
  (organization, hotel, agency) → the rooms `ORDER BY id FOR UPDATE` → lapsed pending bookings on those rooms become
  EXPIRED → facts re-read after the locks (calendar options included) and the option, quota and price checked again
  → the `BOOKING` sequence row (organization-wide, taken last, held only for the inserts) → the booking, claims
  (each booking its own rows, agency-owned for an agency GROUP, booking-owned otherwise), slots, stays, frozen price
  lines and the CREATED change. Agencies (and staff on their behalf) get HELD for `holdMinutes`, individuals
  REQUESTED for `requestHours`. A room taken meanwhile is 409 `OPTION_UNAVAILABLE`; a request that breaks the rules
  is 422 `INVALID_OPTION`; the exclusion constraints and `booking_quote_once` are the last line (409). A quote is
  usable while OFFERED and matching (hotel, dates, type, each side's count); it stays OFFERED until the booking is
  confirmed (step 12 marks it ACCEPTED). Booking numbers are `B-<hotel's year>-<n>`. The minute sweep
  (`booking.hold-expiry`, light) expires lapsed holds per organization, logging a failing organization and going on.
- **D-P2-36 (booking) Ticket 3: the allocator stays on the request path, measured.** On a 420-room hotel (Node 22,
  development Mac) one side takes 1.9 / 13 / 38 ms median for 30 / 150 / 300 pilgrims (v7 measured 3 / 90 / 240), a
  full GROUP search 3 / 31 / 101 ms for 50 / 270 / 580 pilgrims (p95 14 / 35 / 110). Bookings are capped at 600
  seated pilgrims and 200 rooms. `planStay` is pure and serializable: if the search p95 in production passes
  250 ms, it moves into a worker pool without other changes.
- **D-P2-37 (booking, step 11 reviews) Holding exactly what is needed, without lock cycles.** The hold re-check
  also enforces the planner's economy, so a hand-made option cannot claim more than it needs: with any new room on
  a side, every own room of that side is used and full (409 `OWN_ROOMS_FIRST`: the agency's rooms changed since the
  search); the new rooms leave fewer empty seats than the smallest of them (422 `IDLE_ROOMS`); extra beds only when
  the new rooms are full (422 `EXTRA_BEDS_UNNEEDED`) and slept in (422 `EXTRA_BEDS_UNUSED`). Children need an adult
  on their side (422 `CHILDREN_NEED_AN_ADULT`). The quote is re-read inside the transaction, and constraint errors
  raised at COMMIT are translated too. Database review: the sweep skips booking rows another transaction holds
  (`FOR UPDATE SKIP LOCKED`: the sweep never waits on a hold, so no lock cycle) and works in batches of 500; "lapsed"
  is judged at the later of the application's clock and the database's (`clock_timestamp()`), so whatever the seat
  count already treats as free is expired too — confirmation (step 12) must use the same rule and lock only the
  booking row; rooms are locked `FOR NO KEY UPDATE` (still exclusive against holds and the inventory changes'
  `FOR UPDATE`, without blocking unrelated inserts referencing a room); `booking_agency_live_idx` (0012) serves the
  quota count. Rule for later steps: anything that changes an agency's persons in a hotel (adding pilgrims, date
  changes) takes the same quota lock before its room locks. Accepted: the organization's `BOOKING` sequence row
  serializes the last few statements of concurrent holds (taken last, so no deadlock).
- **D-P2-38 (booking) The booking API.** Agency portal (`auth: 'agency'`, approved agencies): `POST
  /api/agency/stays/search`, `POST /api/agency/bookings` (hold, 201), `GET /api/agency/bookings[/:id]`, `POST
  …/:id/confirm`, `GET …/:id/receipt` — an agency sees only its own bookings (others 404); searches (600/h) and holds
  (120/h) are rate limited per agency. Staff: `POST /api/stays/search` and `POST /api/bookings` on an agency's behalf
  (`booking.create` on the hotel; the booking is the agency's, `created_by_user_id` the seller), `GET /api/bookings`
  (`booking.view`, only the caller's hotels), `GET /api/bookings/:id`, `POST …/:id/confirm` (`booking.create`: an
  agency's hold or an individual's request), `GET …/:id/receipt`. Confirmation locks only the booking row and uses
  the hold-lapse rule of D-P2-37 (409 `HOLD_EXPIRED`), stamps a random 24-byte receipt token (the QR content), marks
  a quote it used ACCEPTED and logs the change with its actor. Receipts exist once confirmed (409 `NOT_CONFIRMED`):
  hotel, stay, counts, rooms, nightly price lines summed per kind, room type and price (extra beds on their own
  line). Statuses are effective: a pending booking past its hold reads EXPIRED before the sweep. An individual may
  hold at most `individualMaxOpenRequests` open requests (a per-customer lock in the hold, before the room locks;
  409 `TOO_MANY_OPEN_REQUESTS`) — the public routes come in step 15. Review outcomes: confirmation is idempotent (a
  confirmed booking comes back unchanged; an expired one is `HOLD_EXPIRED` whether swept or not), needs an active
  hotel for agencies too, and marks the quote ACCEPTED only from OFFERED or EXPIRED (a quote staff declined meanwhile
  stays declined; the booking keeps its frozen price). Sellers confirm too (`booking.create`; no separate confirm
  permission). List filters use the effective status. The receipt token only finds a booking for authenticated
  staff (check-in, step 13); it admits no one by itself.
- **D-P2-39 (booking) Pilgrim details.** One form for agencies (`GET|PUT /api/agency/bookings/:id/guests[/:guestId]`,
  their own bookings only) and staff (`GET /api/bookings/:id/guests` with `pilgrim.view`, `PUT …` with
  `booking.edit` — reception enters details on arrival). Only the name is needed to save; a slot is READY once name,
  gender, nationality, date of birth, passport number and expiry are there. The age group comes from the date of
  birth on the check-in day; refused (422 `GUEST_DETAILS_REJECTED`): in a GROUP someone the child age or older on
  the other gender's side (a "child" who turns out to be 11 included), an infant slot for anyone older (infants have
  no seat); the same passport twice in one booking (422). Warned: a passport valid less than the minimum after
  check-in; staff only (v7 §13, §16): the same passport in another live booking on overlapping nights. Passport
  number and extras are encrypted with contexts bound to the slot (`booking_guest_detail.*:<booking_guest_id>`);
  `passport_lookup` = blind index of nationality|number. Agencies get their own copies in full; staff see numbers
  masked (`•••567`) unless `?reveal=passport` with `pilgrim.viewSensitive`; every full read is a
  `pii_access_log` row. Saves answer masked (no PII echo). Agencies cannot change a slot once checked in (409
  `GUEST_LOCKED`); details never change on a closed booking (409 `BOOKING_CLOSED`). `DETAILS_UPDATED` changes carry
  slot numbers and statuses only. Security review outcomes: details never cross the seat line (an infant slot for
  someone older, or a seated slot for an infant — the latter would leave the quota and the price; the hotel changes
  the slot instead, step 14) and implausible dates are refused (born after check-in or before 1900, a passport
  valid 20+ years); only staff link a slot to the staff master (an agency's typed passport proves nothing; its
  change of passport unlinks), and the master is created on first sight and never overwritten — linking to an
  existing master, and its `MASTER_DIFFERS` warning, only for staff with `pilgrim.viewSensitive` (for anyone else
  the answer must not reveal whether a master exists: no oracle); duplicate-passport warnings name only bookings in hotels the viewer can see; full views
  are rate limited (staff reveals 60/h, agency lists 300/h per user); saves lock the booking row first (duplicate
  checks cannot race, the status is current); one undecryptable row shows `DETAILS_UNREADABLE` instead of failing
  the list; passport numbers must be ASCII before case folding. Accepted: an agency may correct its READY details
  until check-in.
- **D-P2-40 (booking) Passport pipeline (v7 §13, ticket 1).** Agencies (own bookings) and staff (`booking.edit`)
  upload one passport photo per request (PNG/JPEG ≤ 10 MB; the portal sends many in parallel). The image is
  encrypted before storage (context bound to its storage key) and recorded as a QUEUED `passport_scan` whose reading
  job (`booking.passport-read`, heavy tier: worker process only) is enqueued in the same transaction; the image is
  deleted `passportImageRetentionMonths` after check-out (`delete_after`) or at once when the scan is discarded.
  Reading: on-server OCR (`PASSPORT_OCR=tesseract`, tesseract.js installed in the worker image only) → the TD3 MRZ,
  repaired by position (letters vs digits) and verified by its ICAO check digits; only when the MRZ is missing or
  fails a check, the external vision fallback (`PASSPORT_AI=anthropic`: Claude via the official SDK, structured JSON
  output, server-side refusal fallback; off by default per §23 Q24 — contract and data-region review first). With
  neither configured every scan is FAILED (`NO_READER`) and typed in by hand. Per-field confidence: verified MRZ
  fields 0.99, a cut-off MRZ name or a failed check 0.4, AI fields 0.6; below 0.9 is highlighted. The reading is
  encrypted on the scan and placed in an open slot (the passport's gender side in a GROUP, children and infants in
  their own slots). Review: the card lists what was read (logged in `pii_access_log`), the image is streamed
  decrypted (logged, `no-store`, sandboxed); confirming saves the details through the same rules as a hand entry and
  marks the scan CONFIRMED with the booker's copy it filled, in one transaction (ticket 1: never the staff master).
  Printed-page extras (place of birth, issue date, authority, address) come from the AI fallback or are typed in.
  Deferred: cropping the face photo for check-in comparison (needs face detection).
  Hardening (security review): uploads are rate limited per user (600/h) and a booking holds at most one unresolved
  scan per pilgrim + 5 re-takes (counted under the booking row lock); the image header is parsed and anything over
  60 MP refused before OCR can decode it (tesseract also times out after 60 s, one job at a time per worker). A
  reading that throws ends FAILED (`READ_ERROR`) instead of staying PROCESSING; a PROCESSING older than 10 min (a
  crashed worker) is taken over by the job's retry (retries start 11 min later). The external AI reader needs the
  organization's consent (`booking_setting.passport_ai_allowed`, off by default; PDPL cross-border transfer) and an
  hourly budget (300/organization); each sending is a `system` row in `pii_access_log`. AI answers are untrusted:
  real calendar dates and Latin-letter names only, every AI field below the review threshold. Staff reviewing what
  was read (cards, images) also need `pilgrim.viewSensitive` and are rate limited like `reveal=passport`; reception
  (`booking.edit` only) uploads and confirms. Images are deleted by the daily `booking.passport-retention` sweep
  (`delete_after`, or the day of a discard) — storage object first, then the asset is archived and the reading
  cleared, so an archived asset always means the object is gone and a failed deletion is retried. Accepted risk: a
  crash between the storage write and the upload transaction leaves an orphan encrypted object (no row, no key
  material exposed); an orphan reaper joins ticket 4's retention work.
- **D-P2-26 (deploy) RBAC sync.** New permissions (`agency.*`, `quote.manage`, `pilgrim.*`, `booking.checkIn`,
  `occupancy.view`, `booking.settings`) reach existing organizations through `pnpm rbac:sync` (additive,
  idempotent; run after migrations).

## Step 7 design (security prerequisites, v7 §21)

- **Principal kinds.** Session `user.kind: 'staff' | 'agency' | 'customer'` (missing = staff, for
  pre-Phase-2 sessions). `requireAuthContext` (staff routes) answers 401 `UNAUTHENTICATED` for any other
  kind; agency/customer resolvers arrive with their tables (step 10). One API, three domains: the API
  checks the kind on every route group, whatever domain the request came from.
- **CSRF origin check.** Nitro middleware on unsafe methods under `/api/`: a present `Origin` must be in
  `ALLOWED_ORIGINS` (comma list) or, when that is unset, match the request host; `Sec-Fetch-Site:
  cross-site` is refused. No `Origin` (non-browser clients) passes; SameSite=Lax stays the first line.
  403 `CSRF_ORIGIN_MISMATCH`.
- **Rate limiting.** Postgres fixed-window counters (`rate_limit_bucket`, one atomic UPSERT, platform
  repository); 429 `TOO_MANY_REQUESTS` + `Retry-After`. Policies and their order: D-P2-8. Old buckets are
  deleted by a light daily job.
- **PII crypto.** AES-256-GCM with a key ring (`PII_ENCRYPTION_KEYS="id:base64[,id:base64]"`, first =
  current) and an HMAC-SHA256 lookup key (`PII_LOOKUP_KEY`) for blind indexes (`passport_lookup`). Token
  format `pii1.<keyId>.<iv>.<ciphertext>.<tag>` (base64url parts); binary blobs (passport images) use a
  `PII1` header. Every value is bound to a context string (AAD), e.g. `app_user.totp_secret:<userId>`. A KMS-backed key provider can replace the env
  ring later without changing callers.
- **Staff 2FA (TOTP, RFC 6238).** `app_user.totp_secret` (encrypted), `totp_pending_secret`,
  `totp_enabled_at`, `totp_last_step` (replay guard); `role.requires_two_factor` (seeded true for
  SUPER_ADMIN and HOTEL_MANAGER). Login takes an optional `totpCode`; an enrolled user without it gets 401
  `TWO_FACTOR_REQUIRED`. Enrollment: `POST /api/auth/2fa/setup|enable|disable`. Enforcement
  `STAFF_2FA_ENFORCEMENT=off|required-roles` (production must be `required-roles`): a user holding a
  role that requires 2FA but not enrolled can only reach `auth/me`, `auth/logout` and the 2FA routes
  (403 `TWO_FACTOR_ENROLLMENT_REQUIRED`). Migration 0008 backfills `requires_two_factor` for existing Super
  Admin and Hotel Manager roles. Session version and admin reset: D-P2-11.
