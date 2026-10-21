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
| 7 | 2a: security prerequisites (rate limit, CSRF origin check, principal kinds, staff 2FA, PII crypto) | |
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
