# Phase 2 — Booking platform (design v7) — build plan & progress log

Source design: `docs/design/Hajj_Booking_Platform_Architecture_v7.pdf` (Bengali, 45 pages).
Branch: `dev` (every step is reviewed, verified with `pnpm verify` and committed on `dev`; pushing is the owner's, D-P2-6).

## Working rules

- One step = one reviewed, green, committed unit. Review = the code-review skill/agents on the step's diff,
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
| 13 | 2d: guest details, passport pipeline (MRZ, OCR worker, AI fallback, review), check-in, extra-bed tasks, reminders, occupancy calendar | done (13a guest details, 13b passport pipeline, 13c check-in/tasks/reminders, 13d occupancy calendar) |
| 14 | 2e: changes & cancellation (add/remove guest, date change, room move, cancel, no-show, early checkout) | done: 14a cancellation, early checkout, no-show policy; 14b remove/add pilgrims; 14c room move; 14d date change |
| 15 | 2f: public booking API (REQUESTED flow, OTP, abuse limits) | done: 15a public request flow; 15b account closure |
| 16 | Frontends: `packages/ui`, `apps/ops-console`, `apps/agency-portal`, `apps/public-site` | 16a shared layer + public site done; 16b agency portal done; 16c ops console foundation done; 16d inventory pages and room calendar done; 16e front office: bookings done; 16f occupancy, front desk, housekeeping done; 16g quotes, agencies done; 16h booking settings, booking rules done |
| 17 | Final review (code, security, database, architecture) and docs | done: 17a data protection, database, security; 17c agency passwords; 17d shared layer, typed contracts; 17e bookings on the room calendar; 17f docs; 17g pull request review (D-P2-66) |
| 18 | Free MVP hosting: Vercel + Supabase (D-P2-67) | done: 18a S3-compatible storage driver; 18b 4 MB uploads, photos shrunk in the browser; 18c worker works every queue, polling interval; 18d `vercel.json`, worker image, deploy guide |

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
- **D-P2-24 (architecture) Ticket 5 module boundary.** `BUSINESS_MODULES = ['booking', 'accounts']` (`accounts` since 10a): only a module's own
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
  (agencies are not hotel-scoped). Delivered in step 17c (D-P2-62): the user's own change and a staff reset;
  invitations stay deferred (the platform sends no e-mail yet).
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
- **D-P2-41 (booking) Check-in, extra-bed tasks, details reminder (v7 §7, §11, §12, §15, §17).** The desk
  (`booking.checkIn` on the hotel) posts the receipt's QR token (`POST /api/check-in/lookup`, body not URL; any
  other token or hotel is 404) and moves one pilgrim at a time: `check-in` (READY only — 422 `DETAILS_INCOMPLETE`
  otherwise — on a hotel day of `[checkIn, checkOut)`), `check-out` (anyone checked in, any day), `no-show` (a slot
  not checked in, from the check-in day). Each move runs under the booking row lock then the slot lock; the
  booking's status follows from all slots (IN_HOUSE from the first arrival, COMPLETED when everyone still on the
  booking has left or never came — booking_room follows by trigger, so the remaining nights free up). Repeating a
  move answers the slot unchanged (a double scan); each move is a `booking_change` row. Seats of a no-show or an
  early departure are not released here (policy, step 14). Confirmation plans the extra beds' housekeeping in its
  transaction: per claim with extra beds an `EXTRA_BED_SETUP` due on its first night and an `EXTRA_BED_REMOVAL`
  due on its departure day (`GET /api/hotels/:id/tasks`, `booking.view`; `POST …/tasks/:taskId/done`,
  `booking.checkIn`, idempotent). The daily `booking.details-reminder` (06:00 UTC) texts the agency's or customer's
  phone once (`booking.details_reminded_at`, migration 0014) for confirmed bookings checking in within
  `detailsReminderDays` (0 = off) that still have slots without details — sent, then marked, so a failed message is
  retried the next day (the run pages past failures, at most 2,000 per organization); skipped entirely while SMS is
  disabled. The message carries no personal data. Marking a task done is a write: not on an inactive hotel.
  Follow-up (step 14): cancelling a booking or changing its rooms cancels its open tasks in the same transaction.
- **D-P2-42 (booking) Occupancy calendar (v7 §14).** Staff with `occupancy.view` on the hotel (agencies and
  customers never): `GET /api/hotels/:id/occupancy?from&to` (≤ 400 days, the calendar's range rule) answers per day
  the rooms in inventory by state — FULL, PARTIAL, HELD (only unconfirmed holds sit in it), EMPTY, BLOCKED (cannot be
  sold and nobody in it) — the sellable seats (pilgrims, held, free), the fill (taken of sellable, ≤ 100%), the
  confirmed arrivals and departures, and the capacity periods (Hajj/Ramadan marks). `GET …/occupancy/:date` answers
  floors → rooms (state, inventory status, capacity, seats) → live claims (booking, status, agency name or
  individual, occupancy, dates, extra beds) → pilgrims (slot, age group, status, details complete), with the day's
  summary per booker and the details still missing. Names show only with `pilgrim.view`; passport data never. Built
  from the calendar engine (versions, seasonal overrides, blocks: no new table) plus one hotel-scoped read
  repository whose seat count restates `room_night_occupancy`'s rule split confirmed/held (a test pins the two
  together). Measured without a cache: a 300-room hotel booked solid for a year (14,400 stays) — year view 0.47 s,
  day view 25 ms. Trigger for a cache or a summary table: a year view over 1 s. Deferred to the frontends: the day
  list's PDF/Excel export.
- **D-P2-43 (platform) Domain events (ticket 7).** Payloads live in `@hajj/contracts/events/domainEvents` as
  versioned envelopes (type, version, event id, time, organization, payload; a version never loses or changes a
  field). A service publishes with `publishEvent(tx, event)` inside the change's transaction; the jobs module wires
  the sink as soon as the runtime is started (API and worker; `enqueue` waits for the boot, so nothing is lost while
  it boots) and turns each event into one pg-boss job per handler (`event.<type>.<handler>`, light tier, 5 retries),
  so jobs commit or roll back with the change. A handler runs through `handleEventOnce`: it claims `event_receipt
  (organization, event, handler)` (migration 0015) in the transaction of its own database effects — the receipt,
  not a queue key, is the guarantee: a duplicate delivery changes nothing, a failure gives the claim back for the
  retry; an outside effect (a text message) is at least once. Without a running runtime (`JOBS_MODE=off`, a failed
  boot, a process stopping) an event is logged and dropped — a side effect never blocks the change. First event:
  `booking.confirmed` v1 → `notify-booker` texts the booker when staff confirmed for them (a customer's request,
  an agency booking made on its behalf). Receipts are pruned daily after 30 days (`events.receipt-prune`). Adding a
  second event type: type the handler table per event and check `version` in the handlers.
- **D-P2-44 (booking) Public read API (ticket 8).** `readBookingSlots(db, scope, bookingId, now)` — dates, head
  counts, effective status and per-slot gender, age group and status of the slots still on it, no personal data —
  and `readAgencyGuests(agencyCtx, bookingId)` — the agency's own copies (name, gender, nationality, date of birth;
  never the staff master, never passport data; another agency's booking is 404; rate limited like its guest list). Future modules (transport) use these
  through `server/services/booking/index.ts` only (the module-public-api rule).
- **D-P2-45 (booking) Retention of every PII copy (ticket 4, PDPL storage limitation).** The daily
  `booking.guest-data-retention` job (light tier) acts `guestDataRetentionMonths` (booking setting, default 24, 1–120;
  migration 0016) after a booking's check-out, on every booking that still holds personal data, in batches of 500
  (keyset, one transaction each, in a details save's lock order — booking rows, slots, copies — so it cannot deadlock
  with one): free text that may name people is cleared (booking notes and cancel reason, task notes), the slots let go
  of the staff master, every booker's copy is erased IN PLACE (name, gender, nationality, dates, passport number,
  lookup and extras cleared, `erased_at` set — the row stays for the slot's history and a confirmed scan's
  reference; guest lists show `DETAILS_ERASED`), and the booking's passport scans lose their readings and their
  images become due today (the image sweep deletes them, even when `passportImageRetentionMonths` is longer). Then
  every master no slot points at any more and untouched since the cutoff is deleted (one another booking still relies
  on stays). Re-runs find nothing; re-entering details on an erased slot clears the mark (and the next sweep erases it
  again if its booking is past the retention). Deliberately kept: slot gender, age group and check-in/out times, and
  who entered a copy (staff or agency user ids) — not identifying without a name or passport. The PII-in-logs test
  writes both kinds of copies and a master and checks `audit_log`, `booking_change`, `pii_access_log` and
  `event_receipt`. Customer accounts (phone, name) are account data, closed with the account, not by this sweep
  (account closure: D-P2-51).
- **D-P2-46 (booking) Cancellation, early departure, no-show policy (v7 §12, step 14a).** Staff with
  `booking.cancel` on the hotel cancel a HELD, REQUESTED or CONFIRMED booking with a reason (`POST
  /api/bookings/:id/cancel`, 3–500 characters): under the booking's row lock it becomes CANCELLED (its room claims
  follow by trigger: the seats are free at once), its open housekeeping tasks are CANCELLED, the quote it used is
  ACCEPTED (spent, never reusable — also when a pending booking is cancelled), the change is logged — the reason is kept on the booking (erased by the retention
  sweep), never in the append-only change log — and `booking.cancelled` v1 is published (the booker is texted when
  the hotel cancelled). Cancelling twice answers the booking unchanged; a booking with someone in the house is 409
  `BOOKING_IN_HOUSE` (check them out), a lapsed hold, a completed or expired booking 409 `BOOKING_NOT_CANCELLABLE`.
  An agency lets go of its own HELD booking (`POST /api/agency/bookings/:id/release`); a confirmed one is the hotel's
  to cancel (409 `CANCEL_BY_HOTEL`, v7 §12: changes other than adding pilgrims need the manager) — the statuses are
  judged under the booking's lock. Cancelling works on an inactive hotel (it only frees seats) and locks only the
  booking row (v7 §10's order is for changes that take seats). Checking out before the last night (the hotel's day)
  is `EARLY_CHECKOUT`: the pilgrim's stays end that day — a pilgrim who checked in that same day keeps that night
  (the room was used; who slept where stays on record) — and a claim nobody sleeps in any more ends there too
  (RELEASED if it had not begun), so the remaining nights are free — the frozen price is not changed (refunds are the client's policy). A no-show keeps its seats by
  default (it is usually paid); with `noShowReleasesSeats` (booking setting, migration 0017) it frees them from that
  day the same way. Follow-up: an early departure's extra-bed removal task keeps its original due date.
- **D-P2-47 (booking) Removing and adding pilgrims (v7 §12, step 14b).** Removing is a partial cancellation:
  staff with `booking.cancel` (`DELETE /api/bookings/:id/guests/:guestId`); under the booking's row lock the slot
  (PENDING_DETAILS or READY — someone in the house is checked out instead, 409 `GUEST_STATUS`) becomes REMOVED (its
  seat is free at once: removed slots never count), the head count is recounted from the slots as they are now (a
  passport may have made an "adult" slot a child: never decremented into a negative), a room the booking itself owns that
  nobody still on it sleeps in is RELEASED (an agency's group room stays the agency's — its free seat is for the
  agency's other bookings of the same dates, v7 §12), and `GUEST_REMOVED` is logged (slot number, age group: no
  personal data). Refused: the last seated pilgrim (409 `LAST_PILGRIM`: cancel the booking) and children or infants
  left without an adult on their side (422 `CHILDREN_NEED_AN_ADULT`). The price is not changed (refunds are the
  client's policy). Only the booking row and the slot are locked: a removal frees seats, never takes any. Adding is
  two steps, like a booking — agencies on their own bookings (v7 §12: they add pilgrims
  themselves) and staff with `booking.edit`, for bookings not started (HELD, REQUESTED, CONFIRMED; a companion
  arriving mid-stay gets a booking of their own): `POST …/guests/search` runs the allocation for the joining head
  count on the booking's dates with the booking's own rooms as "own" (an agency's GROUP: any of its rooms of the same
  dates; otherwise the booking's — for any booking type, `ownRoomsAnyType`), so its free seats come first, priced at
  the booking's quote or the rates (a room the booking already pays for is not charged again per room), within what is
  left of the per-booking limits (an individual's rooms, each type's extra beds count the booking's own); `POST …/guests` re-checks the chosen option under v7
  §10's locks (quota, rooms, then the booking) and against the booking-wide limits, appends the slots and their stays
  (the booking's own claim when it has the room — extra beds only in new rooms — else a new claim), merges the price (a night already priced keeps its frozen
  unit price, only the quantity grows; anything else is priced now), updates the head count and logs `GUEST_ADDED`.
  Infants alone need no rooms (they join the first room of their side) and may not send any (422 `ROOMS_NOT_ALLOWED`:
  every room taken goes through the plan check and the price — commit security review). The shared stay checks (quota, option
  errors, pricing) moved from the hold service to `stayChecks.ts`, so a hold and an addition apply the same ones.
- **D-P2-48 (booking) Room move (v7 §12, step 14c).** Staff with `booking.edit` move chosen pilgrims (one side at
  a time) into another room from a night on — `POST /api/bookings/:id/guests/move` `{ guestIds, roomId, from? }`; the
  hotel's day, by default today (or the check-in when the stay has not begun), within the stay and never in the past.
  In v7 §10's lock order (the rooms involved by id, then the booking) the target is checked for every night left with
  the same room descriptions planning uses (`loadStayRooms`, extracted from `loadStayFacts`): sellable, claimed by
  nobody but the booking's owner with the same occupancy (`ROOM_TAKEN`), a free seat for each mover who takes one
  (`NOT_ENOUGH_SEATS`; infants take none). Their stays split at that night — the earlier nights stay where they were
  (who slept where is history) — and move whole when they had not begun; the booking claims the room for the rest of
  its stay (its own claim of the same side that reaches that night, stretched — one of the other side that ends on it
  stays as it is and a new claim starts there — else a new one with its owner); a room nobody sleeps in any more from
  then on ends there (RELEASED if not begun); `ROOM_MOVED` is logged with room ids and slot numbers. Under the
  booking's lock the day and the stays are read again (409 `BOOKING_CHANGED` when another change moved them into a
  room not locked: try again); every chosen pilgrim must still have a night to move (409 `GUEST_STATUS`). The price
  does not change (the hotel's move); extra beds stay with their claim (a move fills regular seats). Pilgrims who
  left, were removed or never came cannot be moved.
- **D-P2-49 (booking) Date change (v7 §12, step 14d).** "The whole booking on new dates — in effect a new
  allocation; if the new dates have no rooms the booking stays as it was (all or nothing); the price per night anew."
  Staff with `booking.edit` (v7 §12: changes other than adding pilgrims are the manager's): `POST /api/bookings/:id/
  dates/search` `{ checkIn, checkOut, quoteId? }` gives the options, `POST /api/bookings/:id/dates` `{ …, rooms }`
  applies one. Only a booking not begun (HELD, REQUESTED or CONFIRMED and no slot CHECKED_IN, CHECKED_OUT or NO_SHOW:
  409 `STAY_BEGUN`), to other dates (422 `SAME_DATES`) from the hotel's today on (422 `DATES_IN_PAST`). Both plan as if
  the booking had already given up its own rooms, seats and quota: the seat count `room_night_occupancy` takes an
  optional booking it leaves out (migration 0018: drop and create, same rule otherwise), as do the agency's persons
  per night and the planner's live claims (`exceptBookingId` through `loadStayRooms`/`loadStayFacts`/`searchStay`).
  The change runs in v7 §10's lock order (quota lock, the chosen rooms by id, the booking) and re-checks the option
  exactly as a hold does — the hold's locked re-check is now one function, `recheckStay`, shared by both — then
  `rebook` replaces the booking's claims (released ones too), stays and price lines in the same transaction (the
  deferred containment triggers check the result at COMMIT): every live slot keeps its id and details and sleeps on
  its side in the new rooms by the same seating rules as a new booking (`reseatSlots` shares `guestSlots`' rules;
  the extra-bed flag follows the new seat). Giving up the old rooms takes no room lock (it frees seats, never takes
  any). The price is the rates' (agency default for an agency) or, with `quoteId`, the agency's OFFERED quote for
  exactly the new dates (v7 §8: "a date change needs a new quote"; it becomes ACCEPTED when the booking is confirmed,
  at once if it already is); the old quote is detached (an unconfirmed booking's stays OFFERED, usable again). A
  confirmed booking's open extra-bed tasks are cancelled and planned again; the details reminder may come again
  (`details_reminded_at` cleared); `DATES_CHANGED` records the old and new dates, rooms, quote and total. Known
  limit: age groups stay as judged for the old check-in (a child crossing an age limit between the two dates keeps
  its group). Review outcomes: dates were immutable before this step, so adding pilgrims (which plans on the stay and
  quote it read before its locks) now checks them again under the booking's lock (409 `BOOKING_CHANGED`: search
  again; a lock-wait test moves the dates while it waits); a re-seat that does not fit is 409 `SLOTS_DO_NOT_FIT`, not a
  500; no customer request lock (a date change opens no request). Deliberately kept simple: a DONE extra-bed set-up of
  the old dates gets no removal task (housekeeping sees the booking's new tasks), and claims released by a room move
  before the stay are replaced with the rest (`DATES_CHANGED` keeps the old rooms and dates).
- **D-P2-50 (booking) Public request flow (v7 §6, §10, step 15a).** The public site's customer (phone OTP session,
  D-P2-27) books at the public price, rooms of their own only (`b:` owner), at most `individualMaxRooms`, no quota:
  `POST /api/customer/stays/search` (the hold's search with an INDIVIDUAL booker; `quoteId` is not part of the public
  schema), `POST /api/customer/bookings` — the chosen option REQUESTED for `requestHours` (the hold's locks and
  re-check, the per-customer request lock and `individualMaxOpenRequests`, default 1: 409 `TOO_MANY_OPEN_REQUESTS`)
  together with the lead pilgrim's complete passport (v7: "at least the father's passport"): an adult on the check-in
  day (422 `LEAD_NOT_ADULT`, checked before any lock), put in the first adult slot of their side (422
  `LEAD_DOES_NOT_FIT`), saved by the same code as any booker's details (`saveSlot`, actor `customer`, no master) in
  the request's transaction — no request without it. Then `GET /api/customer/bookings[/:id]` (own only: anyone
  else's is 404), `…/:id/receipt` once the hotel confirmed (staff `booking.create`, D-P2-37), `…/:id/withdraw` (an
  open request only; a confirmed booking is the hotel's to cancel: 409 `CANCEL_BY_HOTEL`), `…/:id/guests` and
  `PUT …/:id/guests/:guestId`. D-P2-27b applied (security review): whoever holds the phone holds the session, so a
  customer session reads back names, nationality, completeness and a masked passport number only — never dates of
  birth, expiry dates, extras or a full number — and cannot change a slot once its details are complete (READY:
  409 `GUEST_LOCKED`; corrections go through the hotel), only fill the others. The receipt's QR token is shown (it
  admits no one by itself: only staff look it up, D-P2-37). `GET /api/public/hotels?organization=<slug>` (no
  session) lists the organization's active hotels (id, name, city, country, address; no internal code). Abuse
  limits (consume-first): hotel list 300 / 15 min per client address; searches 120 / hour per customer; request
  attempts 30 / day per customer, counted after the free checks (the lead's age and passport, before any lock), so
  retrying a busy hotel does not shut a family out; detail saves 120 / hour per customer — on top of the OTP limits
  (D-P2-27) and the one open request; a REQUESTED booking expires by itself after `requestHours` (the minute sweep).
  Accepted: the slug's existence shows (it is a sign-in input anyway); searches are bounded per customer, whose
  accounts cost an SMS each.
- **D-P2-51 (accounts) Customer account closure (step 15b).** `POST /api/customer/account/close` (customer session):
  irreversible, so it needs a code verified in the last 10 minutes (the session's `loggedInAt`, now carried as
  `CustomerContext.signedInAt`; 403 `STEP_UP_REQUIRED`: sign in again with a new code — D-P2-27b's step-up). One
  transaction, orchestrated outside both modules (`services/customerAccountService.ts`, each module's public API):
  the booking module takes the customer's request lock (the one a new request takes first) and refuses while a
  stay is not over — CONFIRMED with a check-out after today (UTC), or IN_HOUSE (409 `ACTIVE_BOOKINGS` with the
  booking numbers: the hotel cancels them; "today" in UTC like the retention sweep, conservative east of UTC; one the
  hotel confirmed meanwhile, judged again under its row lock, refuses the same way) — then withdraws every open
  request (CANCELLED, actor `customer`) and erases its personal data at once with the retention sweep's own step
  (`eraseBookingData`: the pilgrims' copies, free text, passport scans — security review: no stay will use them,
  so they do not wait out the retention months); the accounts module closes the row (migration 0019: `customer.phone` nullable, `closed_at`, check: closed ⇔ no phone,
  closed ⇒ inactive): phone, e-mail, verification and last sign-in times cleared (a sign-in racing the closure
  records nothing on a closed row), the name replaced by "Closed account", inactive,
  the session version bumped (every session ends; the route also clears its cookie). The row stays because past
  bookings name it; their pilgrims' details go with the retention sweep (D-P2-45). The number is free: signing in
  with it creates a new account without history. A request waiting behind the closure on the request lock checks
  the account under that lock (409 `ACCOUNT_CLOSED`), so none slips in; closing twice is 409 `ACCOUNT_CLOSED`.
  Left to their own expiry: the phone's sign-in challenges (purged daily) and rate-limit buckets (minutes to a day).
- **D-P2-52 (frontends) Shared layer and the public site (step 16a, UI-UX-MASTER-DIRECTION).** One Nuxt layer,
  `packages/ui` (`extends: ['@hajj/ui']`), carries what every frontend shares: Nuxt UI on Tailwind with the §8–§12
  tokens mapped onto Nuxt UI's variables (no library-default look; light/dark/system kept in a cookie, no flash),
  IBM Plex Sans + Arabic self-hosted (@fontsource), Lucide icons bundled locally; @nuxtjs/i18n with English and
  Arabic (RTL, six plural forms, `no_prefix`, the choice kept in a cookie — set explicitly, since `setLocale` alone
  does not persist it without a URL prefix); formatting with Gregorian dates and Western digits in both languages
  (`ar-SA-u-nu-latn-ca-gregory`), hotel dates as UTC calendar dates; TanStack Query for all server data
  (`useApiQuery` also fetches during server rendering) — deviation from D3: session presentation is Nuxt `useState`,
  not Pinia (no other client state yet; YAGNI); the API client (`useApi`: same-origin `/api`, cookies forwarded while
  rendering, every failure an `ApiError` with `status`, `code`, `details`); messages by error code, never server
  text — every code the API throws has an English and an Arabic message (a test scans the API's source, so a new
  code fails the build until translated); client validation with the API's own Zod schemas and localized messages
  (an empty value is "required"); the status registry (§19); EmptyState, ErrorState, PageHeader, MoneyText,
  StayDates, LocaleSwitch, ConfirmDialog (tiers 1–2). The response shapes the frontends read moved to
  `@hajj/contracts/types` (the API imports and re-exports them: one definition). Each app proxies `/api/**` to the
  API, so sessions are first-party cookies and the API's `ALLOWED_ORIGINS` lists the app — by a server handler of the
  layer (`server/api/[...path].ts`), not a route rule (review): only the prefixes the app uses (`apiProxy.allow`;
  everything else, staff and agency endpoints included, is 404 on its origin; `..`, encoded dots, backslashes and
  control characters refused), the visitor's address set in `X-Forwarded-For` by the app (the connection's, or the
  nearest hop behind one trusted proxy — never the visitor's own header) so the API's per-address limits see each
  visitor (the API runs with `TRUST_PROXY=true`), and the target a runtime setting (`NUXT_API_PROXY_TARGET`).
  The public site (`apps/public-site`, server-rendered hotels list; signed-in pages rendered in the browser and not
  indexed): phone sign-in (one component for sign-in and the closure step-up), the stay form → the options → the
  lead pilgrim's passport → the request, my bookings (status, stay, rooms, price, pilgrims with masked passports,
  completing a pilgrim's details, withdraw, receipt with the QR drawn in the browser), account (sign out everywhere,
  close with the step-up). Verified end to end in a browser against the built API and a seeded database: sign-up
  with a texted code (name asked once), search, request, details, withdraw, closure, in English and Arabic, light
  and dark; review fixes from that run: the main navigation's label, "required" for empty fields, the language
  cookie, numbers isolated (LRI/PDI) inside Arabic help text. Code review outcomes: a call answered "session over"
  (401 UNAUTHENTICATED / SESSION_INVALID — never OTP_INVALID) raises `hajj:session-ended`, and the app signs the
  visitor out, clears every cached answer and sends them to sign in (verified in the browser); errors of sign out
  everywhere and of a resent code are shown; on the server, no retries and no garbage-collection timers (one query
  client per request), and a disabled query is not prefetched; the hotels list's error is shown on the booking page
  and an unknown `?hotel=` is not pre-chosen; GuestFields writes a new value instead of changing its prop, and the
  nationality is upper-cased; focus moves to the code field; the step-up can be cancelled; a signed-in visitor
  skips the sign-in page; the cache is cleared on every sign-in; the redirect after sign-in also refuses control
  characters; the chosen option is marked for assistive technology; the QR falls back to the token as text.
- **D-P2-54 (frontends) The agency portal (step 16b, v7 §6–§15).** `apps/agency-portal` (dev port 3002) extends the
  shared layer like the public site; only sign-in and registration render on the server, every signed-in page in the
  browser (not indexed); its proxy forwards `/api/agency/` and `/api/public/` only. What both booking apps share moved
  into the layer instead of being copied: the stay form (`StayFormFields`; `fixed` when an offered quote sets the
  hotel, nights and type), the option card, the guest fields, the receipt QR, the hold countdown, the place label
  (number, age group and, in a group, the side), the search-and-choose state (`useStayOptions`: any change of what
  was asked forgets the options, and a 409 when acting on one — its rooms went meanwhile — does too), and the session
  plumbing (`usePrincipalSession`, `auth`/`guest` middleware, the session-ended plugin; each app names its
  endpoints in `runtimeConfig.public.session`). The upload limit and the passport photo types moved to
  `@hajj/contracts` (the API imports them: one definition). Pages: registration (then where the agency stands — waiting,
  suspended or refused, each in its own words — asked again on open and on demand; an agency suspended mid-visit is
  sent there by the `hajj:api-error` hook on `AGENCY_NOT_APPROVED`), bookings with a status filter, a new booking (the agency price or an offered quote, the
  agency's remaining quota on those nights, hold), a booking (countdown to the hold's end — Confirm goes when the
  browser sees it end, even before the server expires it — confirm, release, receipt, pilgrims with their full
  details, passport photos, adding pilgrims), quotes (list, ask for a price with the WhatsApp link, detail). Passport
  photos: type and size checked before sending; several at once, each failure listed and the rest still sent unless
  the booking takes no more (409); polled every 3 s while read, every 30 s once a reading has taken two minutes;
  reviewed beside the photo, saved to the first place still needing details. Pilgrims and photos change only while
  the booking holds its places (`SEAT_HOLDING_STATUSES`, the API's rule). Verified in a browser against the built API
  and the demo agency: sign-in, search at the agency price, hold, details, confirm, receipt, adding pilgrims, a photo
  upload by keyboard, its review and save, a quote request; after the review fixes: a staff-offered quote fixing the
  form and pricing the search (450 × 30 pilgrims × 10 nights), a hold refused because another tab took its rooms
  (options forgotten, the reason shown above the search), an expired hold (no confirm, no pilgrim or photo actions),
  the agency suspended mid-visit and approved again ("check again" returns to its bookings), a photo and a text file
  sent together ("1 of 2 added", the file named with its reason). Review outcomes (no CRITICAL/HIGH; every call matched its
  route and schema): the items above, plus a refused request from a shared schema now reads as 422
  `VALIDATION_FAILED` (it read as "couldn't reach the server", as did any unexpected error: only a fetch without an
  answer is a network error now, and only that is retried), paged lists keep their rows dimmed while the next page
  loads, and the review slideovers describe themselves. Not changed: the quote request keeps its own short form
  (men and women only, no children or infants, unlike `StayFormFields`); the offered quotes for a booking are one page
  of 100, the API's largest.
- **D-P2-55 (frontends) The ops console, foundation (step 16c, UI-UX-MASTER-DIRECTION §2–§7, §21–§26, §34–§35).**
  `apps/ops-console` (dev port 3003) on the shared layer; only `/login` renders on the server (D2), its proxy forwards
  the staff endpoints and the demo sign-in only. Shell: the sidebar at the reading start (collapsible, remembered),
  a drawer below 1024 px (language and theme move into it on phones), the hotel switcher in the header (one hotel: a
  label; several: a searchable menu; on a hotel's page it opens the same page for another hotel, on a portfolio page
  it sets `?hotel=`, elsewhere it remembers the last hotel per staff member), the user menu (roles, organization,
  two-factor, sign out). The URL is the hotel scope's only source (§6.1): hotels by code (D4); an unknown or
  inaccessible code shows the same state. Navigation lists only built modules the user may open (`utils/nav.ts`, one
  entry per module); hotel links resolve with the last hotel or the chooser. Permissions mirror `me` for display
  (`can`, `canInHotel`, `hasAllHotels`); the API decides, and a 403/hotel-404 asks `me` again (`hajj:api-error`).
  Sign-in: organization ID remembered, the code asked after `TWO_FACTOR_REQUIRED`, the demo personas only when the
  API's demo sign-in answers (nothing of them in the bundle); a role that requires two-factor and has not set it up is
  sent to the setup first (`TWO_FACTOR_ENROLLMENT_REQUIRED`), the setup draws the code in the browser. Pages: the
  overview (tonight's figures summed from each hotel's own daily summary, the 30/90-night outlook as one quiet series
  with its table, what needs attention, the seasons grouped across hotels, per hotel), hotels (filters in the URL,
  inventory columns only with `room.view`), a new hotel, the hotel profile (overview with the setup checklist, floors
  with the bulk preview and the existing levels named, settings in three panels, documents, activity with "load
  older"), room types (the defaults-apply-to-new-rooms rule stated three times), demo data (tier 3: a typed phrase).
  Shared with the other apps through the layer: `QrCode`, `useModelFields` (an object v-model's fields; writes made
  before the parent re-renders — autofill — build on each other instead of losing all but the last; found in the
  browser run, now used by every form), `uploadRefusal`/`formatBytes`, `formatNumber`, `common.actions`/`clearFilters`.
  Contracts: the staff, hotel and inventory response types (`types/staff|hotel|inventory.ts`), `staffLoginSchema`,
  `PERIOD_PHASES`, `DOCUMENT_MIME_TYPES`. API fixes found on the way: required names (hotel name and city, room type
  and season name) refused empty (`requiredText`; they took ""), a hotel's optional details cleared with `null`,
  check-in/out returned as HH:MM (they read HH:MM:SS, so a re-sent unchanged time was a change with an audit row),
  and 16 error codes that reach clients without a translation (`EMPTY_FILE`, the inventory rule codes) — the locale
  test now scans those error classes too. Verified in a browser against the built API and the demo: sign-in (wrong
  password, a persona, two-factor set up then signed in with a code, a wrong code refused), the overview, hotels,
  a new hotel (duplicate code on its field), floors (bulk with an existing level, deactivation refused while rooms
  remain), settings, documents (upload and download through the proxy), activity, room types, the demo reset, the
  Accountant and Reception personas' read-only views, an inaccessible hotel, Arabic RTL and dark mode, a phone.
  Review outcomes (no CRITICAL/HIGH; every call matched its route, every query key names its hotel): an empty
  optional detail means none in the API (left out on create, cleared on update — hotels and the room type's
  description: `optionalText`/`clearableText`), the hotel code `NEW` reserved (`/hotels/new` creates one), three more
  error codes translated that a helper threw by variable (the locale test now sees them), after any write to a hotel
  everything shown of it is asked again (`useHotelRefresh`: its detail, figures, seasons, documents, history and the
  lists across hotels), the overview and the hotels list say when a section failed instead of showing "none", the
  document file input labelled with its limits and problem announced, an untyped floor label left to the API (never
  stored in the language of whoever added it), row actions named for assistive technology, the last hotel used kept
  per staff member, country and currency upper-cased, numbers and identifiers isolated in Arabic, the switcher never
  showing another hotel on an inaccessible page, a refetch never replacing unsaved settings, the collapsed rail with
  tooltips (on the side away from its edge), focus on the code after starting two-factor setup, and the shared toasts
  (`useNotify`, in the shared layer since step 17d). The generic `ALREADY_EXISTS` message is generic again (it named floors).
- **D-P2-56 (frontends) The ops console, inventory (step 16d, UI-UX-MASTER-DIRECTION §27–§33).** A
  hotel's rooms as of a night (filters in the URL, search after a pause; capacity always as beds and Haji, a season
  named; status; next change), add rooms by range or pasted list (previewed as the API will store them — the range
  numbering is one function in `@hajj/contracts`, `roomNumbersOfRange`, used by the API and the preview; numbers
  already used are marked and nothing is created) or one room (the number set once, locked afterwards); a room's
  page (tonight's capacity and its source, the capacity timeline — normal, season, normal again "returns
  automatically", out of inventory hatched, reading order so right to left in Arabic, Earlier/Later by six months —
  its normal capacity history, seasons, blocks and history; change capacity from a date, retire listing what stands in
  the way first (tier 2), return to inventory; each date field starts at the earliest night the API accepts: after
  the current capacity started, after the last night in service); blocks (now and upcoming, or history with the
  cancelled; cancel or end early as the server's `cancelAction` says, a reason required; an early end shown to
  everyone); the block drawer (prefilled rooms, picked by number, or a whole floor; kind with its effect — maintenance
  that does not stop sales at this hotel says so; the nights; a reason with quick fills; a live impact line, "up to";
  a bulk conflict names the rooms and offers to save the rest); seasons (running and upcoming, or ended; a new season
  opens on its page; edit by phase; end a running one after tonight, tier 2; delete an empty upcoming one), the
  season's rooms (remove a selection while upcoming) and the apply builder (choose rooms with filters, "select all
  matching" over every page, exact numbers or more than normal, the impact only from the server's preview a moment
  after the last change, skipped rooms named with the reason and applied in skip mode). The rooms selection blocks
  several rooms at once and clears, with a toast, when the filters change. Contracts: the room, season, timeline,
  block, calendar and booking-misfit response types; `BLOCK_PHASES`; room and season notes like hotel details (empty
  is none). Layer: inventory and block statuses in the registry (available quiet, without an icon). Verified in a
  browser against the built API and the demo: rooms of a hotel and a new one, a bulk creation and its conflict, a room
  with a season on its timeline (also in Arabic), a capacity change, retire refused while a season remains and then a
  retire and return, single and bulk blocks with a conflict and "save the rest", cancel and end early, history, a new
  season, apply with the preview and a skip, removing a room.
  The room calendar (§31): every room, every night, from the API's runs of nights — one bar per run, never an element
  per night; available has no fill, its capacity at the bar's start; a season is a band on top; weekend, past and
  tonight shaded by one background; header rows (months, seasons, days, sellable rooms per night with the day's
  counts in a tooltip) and the room column stay in view. The view lives in the URL (first night, 7/14/31/90 nights,
  floor, type, number, statuses on any or every night, rooms out of inventory, the open cell) — a mistyped link falls
  back to the default. Rooms load a hundred at a time; more than the API serves at once asks for a narrower filter.
  One focusable grid (rows, row and column headers, a cell per run of nights) with an active cell — arrows in reading
  order, Page Up/Down, Home/End, T for tonight, Enter opens it; each move is a new cell for screen readers and is
  scrolled clear of the sticky headers; keys on a room's checkbox and modified keys are left alone. Each room's row is
  its own component, so a key renders again only the two rows involved (formatters are built once per language). A
  click opens the night under the pointer, whatever part of the bar took it; while another range loads, clicks wait.
  A failed "show more" keeps the rooms shown; a link to a room further down loads on until it is there. The cell
  drawer says why the night is as it is and blocks from that night; ticked rooms are blocked together (kept across
  ranges, cleared by a filter). The apply builder loads up to 2,000 rooms (and says so when a hotel has more), takes up
  to the API's 1,000 per application, and asks for both numbers before its preview.
  Review outcomes: the bulk preview counts a range before building it (a typo of 999 999 must not freeze the page);
  the season preview is only ever the preview of the choice on screen, and Apply sends the request that was previewed;
  the apply builder needs `capacity.manage` and an active hotel; the block drawer finds rooms by number on the server
  (any hotel size); rooms out of inventory cannot be selected; a scheduled retirement reads "leaves inventory from"
  and hides the capacity change; an early end shows the hotel's date; drawers and dialogs stay open while they save;
  URL state, search boxes that follow the URL, and the debounce are one composable each (`useUrlQuery`,
  `useDebounced`). Layer: after a language switch the names of labelled checkboxes, radios and switches are copied
  again (Reka copies a label's text once, at mount) — remounting the page instead would lose a half-filled form.
- **D-P2-57 (frontends) The ops console, front office: bookings (step 16e, v7 §6–§7, §12–§13, UI-UX §36).** Bookings
  (a portfolio page: the switcher's hotel or every visible one) newest first — number, hotel, who booked (by name),
  the stay, pilgrims, status, price; status, agency and number filters in the URL. One booking: who booked, stay,
  pilgrims (details and arrivals), price, booked at, notes; its rooms (released ones marked); confirm a hold or an
  individual's request (with the time left: minutes, hours or days, a warning within the last day), cancel with a
  reason (tier 2), change the dates (search, choose, all or nothing), add pilgrims, passport photos, the receipt.
  Pilgrim by pilgrim at the desk: check in (details first), check out (early leaves free the rest, asked first),
  did not come and remove (tier 2; never the last pilgrim), move to another room (same side, found by number, from a
  night of the stay); passport numbers shown in full only on request with `pilgrim.viewSensitive` (logged). What is
  offered follows the booking's and pilgrim's status, the hotel's date and the user's permissions in that hotel
  (`utils/booking.ts`, tested) — the API decides; an inactive hotel takes only a cancellation. A new booking on an
  agency's behalf: the agency (approved), its price or one of its offered quotes, the search, a hold, then confirm on
  its page. Shared with the agency portal through the layer: the pilgrims panel (now with room, warnings, column
  headers and per-pilgrim names on its buttons; staff add their actions in a slot and may correct arrived pilgrims),
  passport photos and adding pilgrims, all addressed by the booking's API path. API: `BookingDto.agencyName` (the
  accounts module's `findAgencyNames`, one lookup per page) so the desk reads who booked without the agency list;
  the front-desk and agency list/detail types moved to `@hajj/contracts`; the Accountant persona has screens now
  (bookings) and starts there. Verified in a browser against the built API and the demo: a booking held for
  Al-Noor and confirmed, details added, checked in, moved, checked out early, a no-show completing it; another moved
  to new dates, a pilgrim removed, cancelled with a reason; the list and its filters; Reception's view (no agency
  filter, no new booking, masked passports); Arabic RTL; the agency portal's booking page with the shared panels.
  Review outcomes: the passport photos (their fields are full passport data) only with `pilgrim.viewSensitive`, and
  read only by their own panel (no refetch on focus or after a desk action — each read is logged and counted); a
  pilgrim's details read with a masked number are not offered for correction (the mask would be sent or the number
  dropped; `isMaskedPassport` beside `maskPassport` in `@hajj/contracts`), show the numbers first; numbers shown in
  full are discarded once hidden (showing them again is a new, logged read) and hidden on another booking; the
  pilgrims panel kept while toggling; at an inactive hotel only the booking's cancellation is offered (not a
  pilgrim's removal), decided in the tested helper; a stay search answered after the form changed is dropped
  (`useStayOptions().question()`, all five searches); the date change waits for the pilgrims list; one desk move
  at a time; another hotel in the switcher starts a list on its first page; the new booking's hotel defaults to the
  switcher's only where the user may book; Arabic guest statuses read "arrived" and "left" (they read like the check-in
  button). Known limit: the agency filter and picker list the first 100 agencies (an organization works with fewer).
- **D-P2-58 (frontends) The ops console: occupancy, front desk, housekeeping (step 16f, v7 §11, §12, §14, §17).**
  Occupancy (`occupancy.view`), a hotel's page with its view in the URL: a year of small months, each day coloured by
  how full it is (under half, to nine tenths, beyond — said in words too, for assistive technology), Hajj and Ramadan
  marked and named; a month (weeks from Sunday) with each day's fill, free rooms and places, arrivals and
  departures; a day as floors of room tiles (places taken of the room's, who holds it and on which side; full, part
  full, on hold, empty, blocked), its summary (rooms by state, places, by booker, arrivals, departures, details
  missing), filters (agency or families, side, state, room type), each room's bookings and pilgrims in a drawer, and
  the day's list as a spreadsheet (a line per pilgrim; UTF-8 with a byte-order mark for Excel; nothing a spreadsheet
  would run as a formula; never a passport number). The front desk (`booking.checkIn`): a receipt's code opens its
  booking — typed by a handheld scanner, read by the camera where the browser can (`BarcodeDetector`; the camera
  stops when its dialog closes), or found by booking number — and today's arrivals and departures with the details
  still missing. Housekeeping: the extra beds to set up and take away, soonest first, overdue marked, done at the
  desk. Contracts: the occupancy response types (`types/occupancy.ts`) moved from the API. Verified in a browser
  against the built API and the demo: the month and year views (Arabic), a day with filters and a room's drawer, the
  desk opening a booking from its receipt code and refusing a malformed or unknown one, today's arrivals, an
  extra-bed booking's tasks and one marked done.
  Review outcomes: the camera scanner reads one frame at a time and hands a code over once (a run ends on close or
  on a find; a dialog closed while the camera starts stops it), says why when the camera cannot start (refused,
  unavailable, the picture never shown); the spreadsheet gives places taken and places as two numbers ("2/4" read as a
  date); switching views keeps the same moment (the views share one date in the URL); a day's filters stay named on
  a day without that agency or room type; marked seasons and days without rooms said in words; an unnamed agency is
  still an agency, never "individual"; a booking change asks the calendar, the desk lists and housekeeping again; the
  room drawer closes on another view or hotel; a calendar link outside 1900–2199 falls back to today; one day query
  shared by the calendar and the desk (`useOccupancyDay`).
- **D-P2-59 (frontends) The ops console: WhatsApp quotes and agencies (step 16g, v7 §8–§9, §15).** Quotes
  (`booking.view`), a portfolio page waiting on the team by default (requested), filtered by status, hotel (the
  switcher's) and agency; a quote opens in a drawer named in the URL (`?quote=`): what was asked (hotel, nights,
  pilgrims, room mix, the agency or the customer with their WhatsApp link), the offer (an amount in riyals sent in
  halalas, per pilgrim a night, per room a night or for the stay, with or without VAT, valid for so many hours) or a
  decline with its reason — both `quote.manage` on an active hotel, on a requested or offered quote; an offer above
  the hotel's highest public rate is allowed and said once, as a warning. A new quote on an agency's behalf (or a
  customer's phone) from the same page. `QuoteDto.agencyName` (one query per page of quotes) names the agency in the
  list. Agencies (`agency.view`): the list with the ones waiting for approval first-named in a banner, searched by
  name, filtered by status; an agency's page with its profile, its decisions (approve, suspend, reject — each with a
  reason; only the moves the API allows: `agencyDecisions` mirrors its transitions) and its users (add one; sign-in on
  or off). Creating an agency and deciding on one are `agency.manage` with every hotel (agencies are not a hotel's).
  Shared layer: the agency's profile and first user's fields (`AgencyProfileFields`, `AgencyUserFields`, their values
  and request in `utils/agency.ts`) — the portal's registration and the console's new agency use the same ones, and
  their strings moved from the portal's `register.*` to the layer's `agencyForm.*`. Verified in a browser against the
  built API and the demo (Arabic): a registration in the portal, the console's waiting banner, an approval with a
  reason, a user's sign-in turned off and on, a quote on an agency's behalf, an offer, a second offer above the
  highest public rate (the warning), a decline and the declined list; then (English) a new agency (approved at once
  with its first sign-in), a second sign-in, a suspension, an empty and a zero price refused, a link to an unknown
  quote. Review outcomes: an offer is a price — the shared schema refuses nothing (`amountHalalas` from 1 halala) and
  the drawer starts empty for a quote without one (no SAR 0 by default); a quote refreshed in the background keeps
  what is being typed (the forms start again only when a quote opens); a link to a quote that cannot be shown says
  why and leaves the URL; the drawer and the decision dialog keep their words while they close; the new quote starts
  at the switcher's hotel only where this user may quote, or the only such hotel; a list's page from the URL is a
  whole number from 1 (`pageOf`, every list page); the console does not offer to fill in the staff member's own name
  and email for someone else's sign-in (`AgencyUserFields` `own`, the portal's registration only); riyals and
  halalas convert in `@hajj/contracts/utils/money.ts` since step 16h (`toHalalas`, `toRiyals`). Known limit: the agency filter and picker
  list the first 100 agencies (as for bookings, D-P2-57).
- **D-P2-60 (frontends) The ops console: booking settings and a hotel's booking rules (step 16h, v7 §15).** Booking
  settings (`/admin/booking-settings`, `booking.view`): the organization's holds, requests and quotes (minutes,
  hours), what one customer may ask, the children's and infants' ages and the side a child stays with, the details
  reminder, passport validity, how long passport photos and pilgrims' details are kept, the external passport
  reader (a transfer abroad, off until agreed), the no-show rule and the WhatsApp number and message — changed with
  `booking.settings` over every hotel (D-P2-31), else shown read-only; only what changed is sent, an infant never
  older than a child is said before saving, a refetch never overwrites what is being typed; each hotel's rules are
  linked. A hotel's booking rules (a profile tab, `booking.view`): its rates (`rate.view`; by room type, public or
  the agencies' default, per person or per room a night, by season, VAT), agency quotas (an agency's own or the
  default for every agency, pilgrims a night by season), room-mix rules (a group size range, each gender apart: at
  most so many rooms of so many seats) and extra beds (per room type: a room's and a booking's most, the price,
  seasonally changed rooms) — added, edited and deleted with `rate.manage` or `booking.settings` on an active hotel;
  a rule overlapping another of its kind (409 `RANGE_OVERLAP`) or a second extra-bed policy (409 `ALREADY_EXISTS`)
  is said for that kind. Contracts: the rules' and settings' response types (`types/bookingRules.ts`), which the API
  now returns (a compile-time check holds each to its table's columns); riyals and halalas convert in
  `utils/money.ts` (the console's forms read a cleared number as nothing typed: `typedNumber`, `typedHalalas`). A
  range of dates names each year it spans (`formatDateRange`, every night range). One composable per kind of rule
  (`useBookingRules`: list, drawer, delete confirmation) and one frame for their panels and drawers; dialogs keep
  their words while closing (`useLastShown`). Verified in a browser against the built API and the demo: the settings
  saved (a changed hold and WhatsApp number), refused for an infant older than a child and a malformed number, and
  read-only for a one-hotel manager; a hotel's rules — a default quota and an agency's own, an overlapping default
  refused, a room-mix rule added and deleted, a rate edited — in English and Arabic, editable by the hotel's manager
  and read-only (no rates) for its reception.
  Review outcomes: an edited record's changes are measured against the version the form was built from, so a reload
  meanwhile (another admin's change) is never sent back (`useEditForm`; the hotel's details too); a cleared number is
  none and its field says "required"; a quota names its agency in the API (`AgencyQuotaDto.agencyName`, one query a
  list), so a reader without `agency.view` still sees whose quota it is, and quotas are edited only with it (the
  picker lists agencies); a confirmation cannot be closed while its action runs; extra beds offer "add" only once the
  policies are known; a rule deleted elsewhere leaves the list when its save fails.
- **D-P2-61 (review) Final review: data protection, database, security (step 17a).** Three read-only reviews
  (security, database, architecture) of the whole of Phase 2. Data protection: a passport photo's stored filename is
  "passport.<ext>", never the uploader's (it could name the pilgrim and outlived the image; migration 0020 scrubs
  existing rows); a cancelled or lapsed booking's pilgrims' details are erased `guestDataRetentionMonths` after it
  ended rather than after its stay; a date change moves the images' retention; the image sweep runs until a batch
  comes back short. Database: indexes for the staff booking list, the details reminder, the erasure job and a
  booking's tasks; redundant prefix indexes dropped; the passport retention index per organization; the day calendar
  and the movements read only the claims touching their dates; a unit price is at most 20,000 SAR (`MAX_UNIT_HALALAS`)
  so a night's price line (at most 600 pilgrims or 1,000 extra beds) fits its 32-bit column; an out-of-range number
  is 422 `VALUE_OUT_OF_RANGE`. Security: every response carries security headers (no framing, nosniff, HSTS, a short
  referrer, camera only for the desk); the frontends' proxy matches a slash-less prefix as a whole resource; the
  public site shows Cloudflare Turnstile and texting codes outside development refuses to start without it; code
  verifications are limited per phone and address (10 an hour: a stranger cannot lock the owner out) and per phone
  (30 an hour: guessing over many addresses stays bounded — a stranger filling it could already deny the owner codes
  through the request limits, a trade taken for the bound); a registration repeating a known agency's licence or
  e-mail is recorded on that agency (`AGENCY_REGISTRATION_REPEATED`) and approval asks staff to check the ministry's
  record; the development database listens on localhost only. Not done (recorded): a per-hotel cap on the seats
  customers' open requests may hold (Turnstile and the per-customer limits bound it); agency 2FA and "sign out
  everywhere" for agencies; receipt tokens and customers' phones stored as values (not hashes).
- **D-P2-62 (accounts) Agency passwords (step 17c, D-P2-25b).** `POST /api/agency/auth/password` (any agency
  status): the current password proves it (422 `CURRENT_PASSWORD_WRONG`, 5 tries per user in 15 minutes); every
  session of the user ends and the caller's is renewed with the new session version. `POST
  /api/agencies/:agencyId/users/:userId/password` (`agency.manage` with every hotel): a new password for a user who
  lost theirs, given to them off the system; every session of theirs ends. Both audited without the password; the
  portal's account page, the console's "New password" on an agency's user. Invitations stay deferred.
- **D-P2-63 (architecture) Shared layer and typed contracts (step 17d).** `useNotify` and `usePublicHotels` live in
  the shared layer (the portal, the public site and the layer's components no longer build their own toasts or copy
  the public hotels query); the contracts type every status they send (booking room, guest, scan, hold, the desk's
  lookup, booker and booking types, child side, event payloads), the API casting at its DTO mappings where a check
  constraint guarantees the value; one generic `Page<T>`; the console asks again everything a booking's change shows
  in from one list (`bookingChangeKeys`: a confirmation now refreshes the quotes, a new hold the occupancy and
  housekeeping, any change the room calendar and the daily summaries); `tsx` is a runtime dependency (the worker).
- **D-P2-64 (inventory) Bookings on the room calendar (step 17e, UI-UX-MASTER-DIRECTION §19, §31.2, §42-S13).**
  The room calendar shows a held or requested stay as held, a confirmed one as booked and one in the house as
  occupied (`BOOKING_INVENTORY_STATUSES`; a block still outranks a booking, which stays named), each run naming its
  bookings (`bookingIds`) and `refs.bookings` naming exactly the page's (number, agency, stay); the status filter
  finds them. The pure derivation takes the claims as an optional input (the availability and summary rules leave
  them out); the booking module answers for its claims (`roomCalendarClaims`: lapsed holds and released claims never
  show; two statements whatever the size). The console labels a booked bar with its booking's number ("+n" when more
  share the room), names the bookings in its description and lists the night's bookings in the drawer (each opening
  on its page with `booking.view`). Review outcomes: a cancellation or a lapse makes the booking's passport scans due
  at once (their reading cleared; the hold sweep does it in its one statement, a UTC day), so the image sweep stays
  on its date index — migration 0021 does it for bookings that had already ended; a blocked night keeps its block's
  label; `refs.bookings` carries no status (each run shows its own).
- **D-P2-65 (docs) Documentation and open items (step 17f).** README, ARCHITECTURE, DEPLOY_CHECKLIST, MIGRATIONS and
  `.env.example` describe Phase 2 as built (principal kinds, jobs and the worker, the frontends and their proxy,
  migrations 0008–0021, every environment variable). Open items carried past Phase 2: no automated end-to-end
  browser tests (each frontend step was checked in a browser by hand; CI lints, typechecks and unit-tests the
  frontends but does not build them); staff user management (no list endpoint: the HR phase); payments; agency
  invitations, 2FA and "sign out everywhere"; the cancellation charges policy (v7 §15: the client decides); Q28
  (Reception sees every occupancy view, D-P2-58) pending the client; transport after Phase 2.
- **D-P2-66 (review) Pull request review of Phase 2 (dev → main).** Nine read-only reviews of the whole pull request
  (booking logic, API plumbing, security, database, error handling, tests, types, the console, the layer and the two
  other apps), a clean-checkout install and build of every app, and the three apps driven end to end in a browser.
  Fixed: CI's unit job (the allocation property test's own timeout); sign-in codes and phones typed in Arabic digits
  (`toLatinDigits`, also room numbers); a job runtime that failed to start is tried again and an enqueue meanwhile is
  `JobRuntimeUnavailableError` (a side effect never blocks the change, D-P2-43), and the pool closes after the jobs
  stop; Turnstile's configuration errors and outages are logged and `remoteip` is only an address; the API answers
  401 before it reads or validates a body, bounds JSON bodies at 1 MiB (413 `BODY_TOO_LARGE`) and marks its answers
  `Cache-Control: no-store`; the frontends' proxy bounds bodies and times out; production refuses the example session
  password and a cookie without Secure; a new code's failed SMS leaves the previous code usable; unregistered
  constraints and 500s are logged with their route; erasure dates a cancellation in UTC; removing the last pilgrim
  still due completes an in-house booking, and a removed pilgrim no longer holds its room's claim; a GROUP's infants
  need an adult on the children's side at hold too; released claims give no extra-bed tasks; the room calendar keeps
  its ticked rooms on a cell click; the hotel switcher opens the section, not another hotel's room; a receipt shows
  only while the booking is confirmed (and its load error with a retry); a booked quote refreshes the quote lists;
  signing out of an expired session clears it. Open (recorded for the next steps, none blocks the merge): the
  integration tests' fixed 2027-05-01 clock meets the database clock on 2027-05-01 10:10 UTC (hold tests then see
  their holds lapse — move the test dates before then); booking edge cases (infants added after a room move, arrivals
  counted per stay rather than per pilgrim, a no-show-only booking completing frees its seats, a confirm racing a
  same-agency hold at the expiry instant, a quote re-offered while a hold uses it); database follow-ups for a 0022
  migration (the deferred containment trigger is O(n²) per booking, partial indexes for the image purge and the
  erasure sweep, purge indexes on `event_receipt` and `rate_limit_bucket`, a lock in the claim-status guard); type
  hardening (`bookableHotel` mints a `HotelScope` without an authorization, enum columns typed in Drizzle,
  discriminated DTOs); a plain "sign out" on the public site, hreflang and `Vary` for its two languages, passport
  reader errors told apart from unreadable photos, agency pickers past 100 agencies, staff "sign out everywhere".
- **D-P2-67 (deploy) Free MVP hosting on Vercel and Supabase.** For a demo at no cost (`docs/DEPLOY_VERCEL.md`):
  one Vercel project (`vercel.json`) runs the three frontends and the API as Services (functions; the API private,
  reached through service bindings that fill `NUXT_API_PROXY_TARGET`, each frontend chosen by the start of its host
  name) and the worker as a Daemon (`Dockerfile.worker`, `WORKER_JOBS=all`; the functions only enqueue,
  `JOBS_MODE=send`); PostgreSQL and the files are on Supabase (session pooler; Storage over its S3 API). What it
  needed: an S3-compatible `StorageDriver` (`STORAGE_DRIVER=s3`, brought forward from Phase 9: functions and daemons
  have no lasting disk), uploads capped at 4 MB (a function takes at most 4.5 MB per request; the frontends shrink a
  larger photo in the browser), `WORKER_JOBS` and `JOBS_POLL_SECONDS` (the free daemon quota counts CPU time), Node 22
  pinned for Vercel (`engines`), and the proxy joining a host-generated target URL. Checked: unit tests, the driver
  against a real S3-compatible server (SeaweedFS), the worker image run as the daemon will run it, `vercel.json`
  against Vercel's schema and a local `vercel build` of the four services (the daemon's image push needs Vercel's own
  token). Limits accepted for the demo: the free plan is non-commercial only; 5 active CPU hours a month for the
  daemon (holds stop expiring when they run out); daemons are beta and production-only; no backups on Supabase's free
  plan; customer SMS sign-in off. Not verifiable before a deployment: whether Vercel's calls between services keep the
  forwarded visitor address (the guide checks it; `ALLOWED_ORIGINS` covers the CSRF check either way).
- **D-P2-53 (demo) Booking demo data.** The demo seed adds the booking platform's data: rates for every hotel's room
  types over 540 days from the anchor date (public per person and per room; agency default 8 % lower; a price level
  per hotel) and one approved agency (Al-Noor Travels) with a portal user sharing the demo password — same ids on
  every seed, removed with the demo organization on a reset (cascade).
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
