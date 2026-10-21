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
| 8 | 2a: booking-platform schema (agency, customer, pricing, pilgrim, booking*, guest_stay, view, constraints) | |
| 9 | 2a: inventory ↔ booking conflict rules + Phase 1 lock gaps (floor deactivate, room reactivate, period delete) | |
| 10 | 2a: accounts (agency approval, agency users, customers + OTP), admin settings, pricing & quotes | |
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
