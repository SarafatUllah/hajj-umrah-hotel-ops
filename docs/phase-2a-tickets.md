# Phase 2a — tickets carried from the v7 design review

These came out of the review of design v7 (`docs/design/Hajj_Booking_Platform_Architecture_v7.pdf`)
and the module-boundary discussion. They move to GitHub issues when 2a work is assigned. Status is
updated as each lands on `dev` (see `docs/superpowers/plans/2026-10-21-phase-2-booking-platform.md`).

| # | Ticket | Status |
|---|---|---|
| 1 | **Passport pipeline targets the booker's copy.** An agency's scan links to its own `booking_guest_detail`, never to the master `pilgrim`; the review form saves there; only staff merge into the master. `passport_scan` references `booking_guest_detail` (not `pilgrim_id`). | done: schema (step 8) and pipeline (step 13b) — a confirmed scan points at the booker's copy it filled, never the master |
| 2 | **No silent seat release on a NULL hold expiry.** `CHECK (status NOT IN ('HELD','REQUESTED') OR hold_expires_at IS NOT NULL)`, and `room_night_occupancy` counts a seat as taken when the expiry is NULL (three-valued logic must never drop the row). | done (step 8): CHECK + `coalesce` in `room_night_occupancy(...)`, both tested |
| 3 | **Allocator off the request hot path.** Run the allocator off the event loop (worker_threads) or apply the back-pointer optimisation; measure p95 under concurrent searches in 2b. | done (step 11): in-place best-K states instead of the back-pointer (5–6× faster than v7's numbers), measured and capped; stays on the request path with a worker-pool trigger (D-P2-36) |
| 4 | **Retention covers every PII copy.** The retention job and the PII-in-logs test cover `booking_guest_detail` copies and the master `pilgrim`, not only passport images. | |
| 5 | **Module boundary rule.** Extend the existing `no-restricted-imports` + `layering.test.ts` so a module can import only another module's public service (`server/services/<module>/index.ts`), never its internals. No new tool. | done (step 9): `module-public-api` rule in `apps/api/tests/support/layering.ts` (`BUSINESS_MODULES`), with meta-tests; enforced by `test:unit` |
| 6 | **Postgres schema-per-module decision.** Recorded in `docs/decisions/0001-module-data-ownership.md` (decided in Phase 2-0; any table move would happen in 2a). | decided |
| 7 | **Domain events via pg-boss, for side effects only.** Written in the same transaction as the change; handlers idempotent (keyed by event id); payloads defined and versioned in `@hajj/contracts`. Rules that must hold immediately (e.g. "cannot cancel while a vehicle is assigned") use a direct public-service call in the same transaction. | |
| 8 | **Booking public read API.** The booking module exposes a public read API for slots (head counts, dates, gender/age group) and for the caller's own guest details, so future modules (transport) never read the master `pilgrim` from agency-facing code. | |

Explicitly **not** changed: the `price_quote` structure (quotes live 48 hours; restructure later if
multi-product quotes are ever needed).
