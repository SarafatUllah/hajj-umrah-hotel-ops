# Spike — pg-boss jobs inside a Drizzle (postgres.js) transaction

- **Date:** 2026-10-21 · **Result: WORKS** — no outbox-table fallback needed.
- **Question (design v7 §10, Phase 2a ticket 7):** can a job (reminder, domain event) be written by
  the same database transaction as the booking change, so a committed change never misses its job and
  a rolled-back change never leaves one behind?
- **Versions:** pg-boss 12.38.0 (uses `pg` for its own pool), drizzle-orm 0.45.3 with the
  `postgres-js` driver (postgres 3.4.9), PostgreSQL 16.

## Approach

pg-boss accepts a per-call `db` option (`ConnectionOptions.db: { executeSql(text, values) }`). The
adapter `apps/api/server/jobs/pgBossTransaction.ts` takes the caller's Drizzle handle, reads the
postgres.js client Drizzle runs that handle on (`session.client` — the `TransactionSql`, or the
savepoint client for a nested `tx.transaction`) and implements `executeSql` with
`client.unsafe(text, values)`, returning `{ rows }`. pg-boss's SQL is `$n`-parameterised, which
postgres.js `unsafe` binds natively.

## Evidence

`apps/api/tests/integration/jobs/pgBossTransactionalSend.test.ts` (real PostgreSQL):

| Case | Result |
|---|---|
| Send inside a committed transaction | job exists; JSON payload and `startAfter` (a `Date`) round-trip exactly |
| Read the job from another connection before commit | not visible (`getJobById` → `null`) |
| Send, then throw (rollback) | no job |
| Send inside a savepoint that rolls back, outer transaction commits | no job |
| Adapter given something that is not a Drizzle postgres-js handle | throws immediately |

`apps/api/tests/integration/jobs/jobRuntime.test.ts` covers the runtime built on it: a job enqueued
in a committed transaction is delivered to its handler with its pg-boss id (the idempotency key);
unregistered jobs and a stopped runtime are refused.

## Risk and guard

`session.client` is not in Drizzle's public typings. The adapter reads it defensively and the spike
test fails loudly if a Drizzle upgrade moves it (rather than silently sending outside the
transaction). If that ever happens, the fallback is a small `outbox_event` table written in the
transaction and forwarded to pg-boss by a light job.

## Decision

Use the adapter. `enqueue(job, data, { tx })` (`server/jobs/runtime.ts`) is the one way application
code sends jobs; `JOBS_MODE` decides which tiers a process works (`light` in the API by default, `heavy`
— passport OCR — only in the worker process).
