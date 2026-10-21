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
| 10b | 2a: customers — phone OTP sign-up/sign-in (`CustomerScope`) | |
| 10c | 2a: booking settings, rates, quotas, room-mix rules, extra-bed policies (staff admin) | |
| 10d | 2a: WhatsApp quotes and price resolution (quote → agency default → public, per night) | |
| 11 | 2b: allocation engine (DP, property tests), locked holds, sweep, concurrency tests | |
| 12 | 2c: agency booking API (search, quote, hold, confirm, receipt/QR), staff on-behalf booking | |
| 13 | 2d: guest details, passport pipeline (MRZ, OCR worker, AI fallback, review), check-in, extra-bed tasks, reminders, occupancy calendar | |
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
