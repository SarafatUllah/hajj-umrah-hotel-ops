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
| 1 | Phase 2-0: pnpm workspaces + Turborepo | |
| 2 | Phase 2-0: app → `apps/api` | |
| 3 | Phase 2-0: `shared/` → `packages/contracts` (`@hajj/contracts`) | |
| 4 | Phase 2-0: `db/` (schema, migrations, client, migrate, drift) → `packages/db` (`@hajj/db`); seed + test reset stay in `apps/api` | |
| 5 | Docs: v7 PDF, open client questions, Phase 2a tickets, schema-per-module decision | |
| 6 | pg-boss transaction spike (Drizzle/postgres.js `tx.unsafe` adapter) + jobs foundation | |
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
