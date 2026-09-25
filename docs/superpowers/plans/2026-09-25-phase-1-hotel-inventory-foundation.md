# Phase 1 — Hotel Inventory Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Status (2026-09-25): Q1–Q6, the architectural foundations, the UI/UX master direction (`docs/UI-UX-MASTER-DIRECTION.md`) and the UI contract changes S1–S14 are APPROVED and integrated (see "Approval record" and "UI/UX reconciliation record" below). The demo sign-in endpoint is approved and the pre-execution re-verification PASSED (see "Pre-execution re-verification"). EXECUTION IS STILL ON HOLD** until the human partner gives an explicit go. Do not start Task 1 (or any task) before that.

**Goal:** Build the multi-hotel inventory foundation — organization-aware hotels, floors, room types, physical rooms, date-effective (seasonal) capacity, automatic hotel averages, operational blocks, and a derived date-wise room calendar — on top of a repository/authorization foundation that makes tenant and hotel isolation structural instead of a matter of discipline.

**Architecture:** API route → service → domain → repository, exactly as `docs/ARCHITECTURE.md` §3, but with the repository layer now real: services never import Drizzle; every query flows through branded `OrganizationScope`/`HotelScope` objects that only the authorization layer can mint; the database independently enforces org/hotel consistency with composite foreign keys and enforces temporal integrity with PostgreSQL exclusion constraints. Inventory is **derived, never materialized**: versioned base configuration + period overrides + operational blocks, resolved by pure, unit-tested domain functions (Phase 2 reservations plug into the same resolver).

**Tech Stack:** Nuxt 4 / Nitro, TypeScript (strict, `noUncheckedIndexedAccess`), PostgreSQL 16 + `btree_gist`, Drizzle ORM 0.45 + drizzle-kit 0.31, Zod 3, Vitest 5, a black-box HTTP harness against the built Nitro server (new), `nuxt-auth-utils` sessions, pnpm 9.4.0, Node 22.19.0.

**Spec:** `docs/ARCHITECTURE.md` (read §3, §6–§9, §14, §22, §23, §25–§27) and `docs/superpowers/plans/2026-09-22-phase-0-foundation.md`. Where this plan deliberately supersedes an architecture passage, the **Divergence Register (Part A2)** names the passage and the reason; Task 21 updates the architecture document so the two stop disagreeing.

## Global Constraints

- **Toolchain:** pnpm `9.4.0` (pinned in `package.json`), Node `22.19.0`. Project root is `/Users/ayon/Documents/GitHub/Hajj-Umrah hotel operations system` (no colon). In this harness the shell resets its working directory and defaults to Node 18 between calls, so **every shell command in every task must be run as** `cd "/Users/ayon/Documents/GitHub/Hajj-Umrah hotel operations system" && eval "$(fnm env)" && fnm use 22.19.0 && <command>`. Task commands below are written bare for readability; the prefix is mandatory. Never use yarn/npm; do not touch the `packageManager` field.
- **Dates:** every operational date is a `YYYY-MM-DD` string in the hotel's own timezone. Postgres columns are `date` (Drizzle `mode: 'string'`), never `timestamp`. Never build a date with `new Date('YYYY-MM-DD')` or local-time getters — use `shared/utils/dates.ts` (Task 9). "Today" for any rule is `todayInTimezone(hotel.timezone, now)`, with `now` injected.
- **No business dates in code (Q4):** Hajj/Ramadan/special dates exist only as configurable `capacity_period` rows. The literal dates `2027-05-01…2027-07-31` (and the other demo periods) may appear only in `db/seed/demo/**` and `tests/**`. No file under `server/`, `shared/`, `db/schema/` or `db/migrations/` may embed a season date, and `kind = HAJJ|RAMADAN|SPECIAL` is a label with **no behavioral difference** in any rule.
- **Room identity (Q2/D16):** `room.id` is the only room identity used by foreign keys, URLs, audit `entityId` and (Phase 2) reservations. `room_number` is a unique display/lookup attribute, immutable after creation in Phase 1, and is never a join key or foreign-key target.
- **Ranges are inclusive night ranges:** `{ from, to }` = first and last *night*. A stay `[checkIn, checkOut)` is converted with `rangeFromStay()`; same-day turnover is therefore never a conflict. Postgres uses `daterange(from, to, '[]')`.
- **Tenancy in the schema:** every tenant table has `organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE`. Hotel-owned tables also have `hotel_id`, and reference their parent with a **composite** FK that includes `organization_id` (and `hotel_id` where the parent is hotel-scoped), so the database itself rejects cross-org and cross-hotel links. Tables referenced by composite FKs get a matching `UNIQUE`.
- **FK delete actions between tenant tables are `NO ACTION` (Drizzle default) or `CASCADE` — never `RESTRICT`.** `DELETE FROM organization` (demo reset) must cascade through the whole tree in one statement; `NO ACTION` is verified to allow that, and history is protected by *not exposing delete operations* (D14), not by RESTRICT.
- **Every FK column set gets an index** (org-first). Cascading demo-reset deletes and range queries depend on them.
- **No hard deletes** of hotels, floors, room types, rooms, capacity periods that have started, or operational blocks. See D14 for the archive/soft-cancel rules.
- **Layering is enforced, not requested:** `server/services/**`, `server/api/**`, `server/domain/**`, `server/utils/**`, `shared/**` may not import `drizzle-orm*`, `db/schema*` or `db/client*` (ESLint `no-restricted-imports` + a fitness test, Task 4). `trustedOrganizationScope`/`trustedHotelScope` may only be imported from `server/security/**`, `db/seed/**`, `tests/**`.
- **Authorization:** decided per request from the database (Task 7); the session cookie carries identity only. Ids that do not belong to the caller's organization, **and hotels the caller has no access to**, return **404** (indistinguishable from a nonexistent id); an accessible resource the caller lacks the permission for returns **403**; ids inside a request *body* that are outside the caller's scope return **422 `INVALID_REFERENCE`**. Hotel creation and room-type writes require `allHotels`.
- **Transactions:** every write that touches more than one row — including its audit row — runs in one `db.transaction`. Constraint violations are translated by `translateDbError` (Task 5); services never leak raw Postgres errors.
- **Migrations:** forward-only; exactly one migration file per schema task; generated by `pnpm db:generate` and then hand-edited *before its first commit* only (backfills, ordering, raw-SQL constraints); immutable once committed. `pnpm db:check` and the drift check (Task 2) must pass. Extensions are created inside the migration that needs them.
- **Test hygiene:** no test lists table names for cleanup — use `truncateAllTables()` (Task 1). Integration tests only ever run against a database whose name ends in `_test`. Test output must be pristine.
- **Least privilege:** `organization.resetDemo` exists only in the demo organization's roles (Task 7). New permissions: `capacity.manage`, `room.block`, `audit.view` (Task 6).
- **Limits (DoS guards)** live in `shared/constants/inventory.ts`: `MAX_CALENDAR_DAYS=400`, `MAX_ROOMS_PER_PAGE=200`, `MAX_BEDS_PER_ROOM=30`, `MAX_CAPACITY_PERIOD_DAYS=366`, `MAX_BULK_ROOMS=200`.
- **Commits:** one commit per task (plus fix commits, never amend), message trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, hooks never skipped.

## Approval record (2026-09-25)

The human partner ruled on Q1–Q6 and approved the foundations. A final consistency self-review of this plan against the rulings found **no blocking contradiction**; one conflict (room number editable via `PATCH`) and several clarity gaps were fixed in this revision (listed under "Consistency review changes" at the end of Part B).

| Ruling | Decision | Where it is enforced |
|---|---|---|
| **Q1 Room types** | APPROVED: organization-level catalog, snapshot semantics. Editing a type's defaults never silently changes existing rooms or their history. Any later change to an existing room happens only through an explicit **date-effective base-configuration change** (`POST …/rooms/:roomId/base-config`). | D1, Tasks 13, 14 |
| **Q2 Room-number reuse** | APPROVED for Phase 1: a retired room's number is **never** reused in the same hotel; a room's number is **immutable after creation** in Phase 1 (no rename path). The model must let a future controlled, audited renumbering workflow be added without redesigning inventory history — that workflow is **not** implemented now. | D16, Task 14 |
| **Q3 Hotel documents** | APPROVED: Task 19 stays in Phase 1 and stays independently deferrable. | D15, Task 19 (deferral protocol) |
| **Q4 Demo Hajj period** | APPROVED: `2027-05-01…2027-07-31` for **deterministic demo/test data only**. It is not a business assumption; real Hajj/Ramadan/special periods are configurable date-effective `capacity_period` rows. | Global Constraints, Task 20 |
| **Q5 Session lifetime** | APPROVED: 8 hours; the session carries identity only; permissions and hotel access are resolved server-side on every request. | D8, Task 7 |
| **Q6 Overlapping periods** | APPROVED: hotel-level periods may overlap; a physical room may never have more than one effective override on the same night, protected by the PostgreSQL exclusion constraint. | D2, Task 15 |
| **Also approved** | Mandatory repository layer; branded `OrganizationScope`/`HotelScope`; Drizzle wrapped-error handling through `.cause`; versioned base room configuration; separate date-effective operational blocks; derived (not materialized) calendar/inventory; composite-FK tenant/hotel protection; transaction + audit requirements; deterministic isolated demo tenant. | D2–D12 |

**UI/UX hold.** Phase 1 builds no UI (Part C §2). Tasks 1–11 (foundation and pure domain) do not depend on UI decisions. The *response shapes* of Tasks 12–18 (hotel/room DTOs, calendar segments, pagination, summary rows) and the demo persona list in Task 20 are the places where a UI/UX direction could legitimately change the plan; That check is done: the UI/UX direction (`docs/UI-UX-MASTER-DIRECTION.md`) is approved and its contract changes S1–S14 are integrated into those tasks (see "UI/UX reconciliation record").

## UI/UX reconciliation record (2026-09-25)

The human partner approved the UI/UX master direction (`docs/UI-UX-MASTER-DIRECTION.md`), its decisions D1–D15, and the contract changes S1–S14 of its §42. Each S-item is integrated **into the task that owns it**; no parallel requirement list exists. The governing principle: **display truth comes from server/domain logic** — the UI never recomputes effective capacity, inventory status, averages, period or block phase, hotel-local today, or season impact.

| Item | What it adds | Owning task(s) |
|---|---|---|
| S1 | `/api/auth/me` gains `organization { id, name, slug, isDemo }` and `roles` (resolved only for `me`) | 7 (+ HTTP test in 8) |
| S2 | `HotelSummary` / `HotelDetail` with hotel-local `today`; counts `null` without `room.view` | 12 (counts wired in 13, 14) |
| S3 | Audit history: entity/action filters, keyset cursor, same-org actor names | 6 (repository), 12 (endpoint) |
| S4 | `FloorListItem.roomCount`, `RoomTypeListItem.usageCount` (`null` unless `allHotels`) | declared 13, wired 14 |
| S5 | `RoomListItem` / `RoomDetail`: lifecycle, base, effective + period ref, `status`, `nextChange`, history, seasons; new pure `nextCapacityChange` | 14 (+ 15 overrides, 16 blocks) |
| S6 | `POST …/overrides/preview` sharing one planning function with apply; writes nothing | 15 |
| S7 | Period DTO: `phase`, `nights`, `overrideCount`, `impact` | 15 |
| S8 | `POST …/overrides/remove` (atomic, FUTURE only, one audit row) | 15 |
| S9 | `MAX_OVERRIDE_SELECTOR_ROOMS = 1000` | 15 |
| S10 | `BlockListItem` with `phase` (new pure `blockPhase`) and `cancelAction` | 16 |
| S11 | `ended_early_at`, `ended_early_by`, `original_end_date` (+ 3 checks) on `room_operational_block`; audit row kept | 16 (migration `0006`) |
| S12 | Organization averages: per-hotel today when `date` omitted; `perHotel` items mirror top-level keys | 17 |
| S13 | Calendar `meta { today, maintenanceBlocksSales }` + page-scoped `refs`; timeline `refs.periods` | 18 (timeline: 15) |
| S14 | Persona display names; catalogue in `server/demo/personas.ts`; gated `GET /api/public/demo-sign-in` | 20 |

**D-rulings that constrain this plan:** D9 — demo sign-in shortcuts exist only behind the runtime gate of Task 20 and never with `APP_ENV=production`; D10 — Reception keeps no `room.block`; D11 — no atomic "adjust season from date" operation in Phase 1 (recorded as a later enhancement, Part C §2); D12 — S11 approved; D13 — Accountant and HR permissions unchanged, only labelled "available in later phases"; D14 — no bilingual entity names in Phase 1, recorded as a pre-production review item (Part C §2). D1–D8 are UI-implementation decisions and change no task here.

**Consistency finding resolved while integrating S14:** the draft wording ("a module the sign-in page imports in demo builds") would have required a demo-only build, contradicting ARCHITECTURE §17 (one image; environments differ only by env vars) and D9 (no demo credentials in production deployments). It is replaced by the runtime-gated endpoint in Task 20.

**Previously verified artifacts affected (re-verify before the owning task starts):**

| Artifact | Change | Re-verification |
|---|---|---|
| Task 16 `room_operational_block` schema and migration `0006` | +3 columns, +3 check constraints (S11) | Generate `0006` in a scratch PostgreSQL 16 database; re-run the verified exclusion behaviour (same-kind overlap rejected, different kinds allowed, cancelled rows free) plus: an early end frees the nights from today; the new checks reject partial / conflicting states; `db:check` + second `generate` report no drift |
| Task 16 `blockRules.ts` | `blockPhase` appended; verified functions untouched | Re-run the verified `blockRules` tests unchanged + the new `blockPhase` cases; strict `tsc` |
| Task 17/18 `loadRoomInputs` read path (A1#5 performance evidence) | override query joins `capacity_period`; block query selects `reason` (S13) | Re-run the 10,000-room prototype measurement or rely on Task 18's scale test (≤ 6 statements, < 300 ms page, no `Seq Scan`) — must pass unchanged |
| Task 14 room listing | now also loads overrides and blocks for the page (S5) | New fixed-statement-count test in Task 14 (test 18); no earlier measurement exists to preserve |
| `server/domain/inventory/nextChange.ts` | **new** logic, not prototyped | Written test-first in Task 14 (test 17) and extended in Task 15 (test 19); built only on the verified `capacitySegments` |

Unchanged verified artifacts: `shared/utils/dates.ts`, `capacity.ts`, `averages.ts`, `calendar.ts`, `baseVersions.ts`, `capacityPeriodRules.ts`, the migrations `0001`–`0005` and `0007`, the scope/repository base classes, `ids.ts`/`random.ts`.

**Dependency change:** Task 14 now depends on Task 11 (room `status` reuses `buildRoomSegments`). Task 11 is in the early parallel-safe group (9 → 10 → 11), so the execution order and the critical path are unchanged and no cycle is introduced.

**Pre-execution re-verification (2026-09-25) — PASSED.** Run in a throwaway PostgreSQL 16.14 database and a scratch directory; no project file was changed and the scratch database was dropped afterwards.

| Item | Result |
|---|---|
| Task 16 schema + migration `0006` | **PASS.** The plan's schema blocks (Tasks 6, 13–16) and migration SQL were extracted verbatim; a baseline migration (through `0005`, with `btree_gist` and the two earlier exclusion constraints) and the `room_blocks` migration (with the S11 columns and checks, plus the appended exclusion constraint) applied cleanly; `drizzle-kit check` reported no problems and a second `drizzle-kit generate` reported "No schema changes". 27/27 behaviour checks: same-kind overlap rejected (`23P01`), adjacent and different-kind ranges accepted, cancelled rows free their range, composite FKs reject cross-hotel and cross-org rooms (`23503`), all three S11 checks reject partial, conflicting and non-advancing states (`23514`, correct constraint names, row unchanged), the one-statement early end leaves a consistent row, releases the nights from "today" through the original end while the past nights still conflict, and an ended-early block cannot then be cancelled; `DELETE FROM organization` still cascades and leaves the other organization untouched. |
| Task 16 `blockRules.ts` | **PASS.** The verified functions are byte-identical to the plan's verified block; the 2 verified block-rule tests and the 26 verified `dates` tests pass unchanged; 8 new `blockPhase` cases (Task 16 test 13) pass; strict `tsc` (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, unused checks) reports 0 errors. |
| Tasks 17/18 read path with S13 | **PASS (reconstruction).** The original A1#5 prototype scripts no longer exist, so the dataset was rebuilt at SQL level: 10,000 rooms (5 × 2,000), 589,978 range rows, all inserted through the real constraints. With S13 the request still issues 5 statements (+ `hotel_setting` = 6); the override and block queries keep using the GiST exclusion indexes (`room_override_no_overlap`, `room_block_no_overlap`) with both `room_id = ANY(…)` and the range overlap as index conditions; no `Seq Scan` on `room_base_config`, `room_capacity_override` or `room_operational_block`; the period join is a hash join over the hotel's few `capacity_period` rows. Wall time of the whole 5-query sequence (client round trips through Docker on macOS included), median of 25: 100-room × 120-night page 10.6 ms → 12.6 ms with S13; 2,000-room × 400-night hotel 90.3 ms → 99.0 ms. These are not directly comparable to A1#5's single-query figures, whose method was not recorded. **The definitive check remains Task 18's scale test** (≤ 6 statements, < 300 ms page, no `Seq Scan` on the three range tables). |
| `nextCapacityChange` | Not part of the preflight by design; stays test-first work in Tasks 14 and 15. |

## Review Focus

The five failure modes the spec implies but a happy-path task list would miss. Each has a named test in the owning task.

1. **Foreign or mismatched ids in URLs and bodies (cross-tenant / cross-hotel IDOR).** A `floorId` from another hotel, a `roomTypeId` from another organization, a `roomId` of hotel A sent to hotel B's route, a `blockId`/`periodId` of another hotel. Expected: **404** for ids in the URL (**422 `INVALID_REFERENCE`** for ids inside a body — both indistinguishable from a nonexistent id), nothing written, nothing leaked. Owned by Tasks 4, 7, 12–18 (every task's test list contains "foreign id" cases).
2. **Boundary dates.** Last night of a period (Jul 31) vs the next night (Aug 1), leap day 2028-02-29, a one-night range, a stay whose checkout equals the next check-in, and the moment where the hotel's "today" differs from UTC's. Owned by Tasks 9, 10, 15, 16.
3. **Concurrent conflicting writes and double submits.** Two overlapping capacity applications, the same room number created twice, blocking a room while it is being retired, two simultaneous demo resets. Expected: exactly one succeeds, the other gets **409**, no partial rows. Owned by Tasks 14, 15, 16, 20.
4. **Empty and zero states.** A hotel with no rooms, all rooms out of service, no periods. Expected: averages are `null` (never `0`, `NaN`, `Infinity`), the calendar is empty, the summary is zeros — never a 500. Owned by Tasks 10, 11, 17, 18.
5. **Oversized and malformed input.** A 100-year range, `pageSize=100000`, `2027-2-30`, room numbers with spaces/unicode/emoji/300 characters, capacity `999` or `-1`, duplicate ids in an array, an empty selector that would match every room. Owned by Tasks 5, 13–18.

---

## How to read this plan

Phase 0's plan carried the full body of every file. Phase 1 is larger and has genuine design risk, so it is written differently, on purpose:

- **Code blocks in this plan are verified artifacts.** The pure domain modules (dates, capacity, averages, calendar), the scoping/repository base classes, the Drizzle schema and the migration SQL were prototyped and **executed** while planning (100 unit tests passing, strict `tsc` clean, migrations applied to a scratch PostgreSQL 16 database and exercised — see A1). They are embedded verbatim and are to be copied, not redesigned.
- **CRUD-shaped tasks (hotels, floors, types, rooms, periods, blocks) give exact interfaces, rules, endpoint tables and named test cases** and follow the reference pattern set by Task 12. Implementers write the bodies test-first inside those constraints. Where a design decision lives in code, the code is given.
- Every task lists: objective, dependencies, files, DB changes, domain rules, repository/service responsibilities, endpoints, authorization, tests first, verification commands, acceptance criteria, and commit boundary, as the review brief required.
- Parts: **A** findings from the pre-planning review · **B** design decisions (D1–D15) and open questions · **File structure** · **Tasks 1–21** · **C** the thirteen summary sections (scope, out-of-scope, domain model, DB changes, API plan, authorization model, inventory rules, capacity formulas, demo data, test matrix, risks, task list, acceptance gate).

---

# Part A — Findings from the pre-planning review

The brief said not to assume the documentation and the implementation are identical. I read the Phase 0 code, the architecture document and the Phase 0 plan, and I ran experiments for every design claim that carries risk.

## A1. What was verified (and how)

| # | Claim | Evidence (executed during planning) |
|---|---|---|
| 1 | One exclusion constraint per table can forbid overlapping effective ranges, with open-ended ranges, adjacent ranges allowed, and a partial (`WHERE cancelled_at IS NULL`) variant. | PostgreSQL 16 + `btree_gist`: overlapping base version rejected (`23P01`); close-then-reopen adjacent ranges accepted; same-kind block overlap rejected, different-kind accepted, cancelled block no longer conflicts. |
| 2 | An override row can carry the same dates as its period and stay in sync automatically with a composite FK `(period_id, valid_from, valid_to) → capacity_period(id, start_date, end_date) ON UPDATE CASCADE`. | Shrinking a period cascaded new dates into the override rows; **extending** it into a range where the same room already has another period's override was rejected by the exclusion constraint and rolled back; an override whose dates differ from its period was rejected by the FK. |
| 3 | Composite FKs make cross-org / cross-hotel links impossible. | Room→other-org hotel, room→other-org room type, audit row→other-org hotel, `user_hotel_access`→other-org hotel, and `user_role`→other-org role were all rejected by the database. |
| 4 | `NO ACTION` composite FKs do not block `DELETE FROM organization` (demo reset). | Deleting an org with hotel, floor, type, rooms, base versions, periods, overrides, blocks, audit rows and access rows removed everything in one statement; the other org was untouched. |
| 5 | Derive-don't-materialize is fast enough. | 10,000 rooms (≈28× the 360-room demo dataset) with ~590k range rows: a 100-room calendar page over 120 days = **≈1 ms**; an entire 2,000-room hotel over 400 days = **≈37 ms**. A room×day table for the same data = **47.5 million rows**. |
| 6 | `drizzle-kit` cannot express exclusion constraints or triggers, but tolerates hand-appended SQL. | `pg-core` exports no exclusion helper; `generate --custom` exists; after hand-appended raw SQL, a second `generate` reports "No schema changes" and `drizzle-kit check` passes → a CI drift check is viable. |
| 7 | `drizzle-kit generate` output cannot be applied blindly to populated tables. | It emitted `ADD COLUMN "organization_id" uuid NOT NULL` on `user_role`, which fails on existing rows → Task 3's hand-edited backfill (verified against a scratch DB containing a planted cross-org grant, which the migration purged). |
| 8 | Drizzle wraps database errors. | `DrizzleQueryError` has no `.code`; the Postgres error is on `.cause` (`code: '23505'`, `constraint_name: 'organization_slug_unique'`). A naive `err.code` check would silently never match → `translateDbError` must unwrap `.cause` (Task 5). |
| 9 | The scoping design compiles under strict TS and rejects misuse. | `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`: passing `organizationId` on a scoped insert, and querying the global `permission` table through a tenant query, are both compile errors (`@ts-expect-error` proven). |
| 10 | The pure inventory logic is correct. | 67 Vitest cases pass, including the requirement examples: Room 401 = 4/4 normally, 6/6 for 2027-05-01→07-31, back to 4/4 on 08-01; 310 capacity ÷ 80 rooms = 3.875 → `"3.88"`. |
| 11 | Session lifetime is unconfigured. | `nuxt-auth-utils` defaults only `name`, `password`, `cookie.sameSite`; there is no `maxAge` anywhere in `nuxt.config.ts`. |
| 12 | The business rules (base-version planning, capacity-period edit rules, block cancellation) behave as specified. | 16 cases pass, including the boundaries: a running period can end as of yesterday but not earlier; a running block is ended yesterday rather than rewritten; DELTA overrides are validated to 1–30 beds. |
| 13 | Upload hardening and deterministic demo ids work. | Upload validation (allow-list + file signature + size) and the local storage driver (traversal, overwrite, odd keys): 8 cases. UUID v5 matches the RFC reference vector `2ed6657d-e927-568b-95e1-2665a8aea6a2`; seeded PRNG determinism: 9 cases. **All prototypes together: 100 unit tests passing, strict `tsc` clean.** |

## A2. Divergence register (documentation/ledger vs. real code vs. Phase 1 decision)

| Item | Architecture / Phase 0 ledger says | Reality or Phase 1 decision | Fixed in |
|---|---|---|---|
| Capacity resolution | §9: `override ELSE room_type default ELSE room.physical_beds` | Room-type defaults are **copied into the room's first base version at creation** (D1) so editing a type never rewrites history. Base configuration is itself **versioned** (D2). | 14, 15 |
| Room state | §9: `room.operational_status` (ACTIVE/MAINTENANCE/OUT_OF_SERVICE), mutable | Forbidden by the Phase 1 brief. Replaced by date-effective `room_operational_block` rows; "room in inventory" is derived from base versions (D2, D3). | 14, 16 |
| `room_status_event` | §6 lists it | Replaced by `room_operational_block` (`room.status_event` would have been append-only history without a queryable date range). | 16 |
| Hotel access | §6/§8: `user_hotel_access(user_id, hotel_id \| ALL)` | `app_user.all_hotels boolean` + `user_hotel_access(user_id, hotel_id)` rows. "ALL" must include hotels created later, which a row cannot express. | 6 |
| Repository rule | §7.1: "every repository method takes `orgId` as first argument" | Replaced by branded `OrganizationScope`/`HotelScope` (D7): an id string can be mistyped or omitted; a scope object cannot be built from request input. | 4 |
| Sessions | §6 lists a `session` table; §8 says short-lived | No session table (cookie only). The cookie currently stores **permissions, allHotels and hotelIds** and never expires server-side. | 7 |
| **Ledger vs code** | Phase 0 final-review ruling: "a reasonable session `maxAge` is in-scope (bundled into fix #5)" | **Never implemented** — `grep maxAge nuxt.config.ts` finds nothing; the fix-wave brief omitted it. | 7 |
| Demo personas | §38: seven login personas | Phase 0 seeded **one** user (Super Admin). Roles exist; users do not. | 20 |
| Demo "second reset" quirk | Ledger: accepted (403 after first reset in same browser session) | Resolved by deterministic ids (D12) and per-request authorization (unknown session → clean 401). | 7, 20 |
| `hotel_settings` | §6 | Key/value `hotel_setting` with a code-side registry (D-settings) — new settings need no migration. | 12 |
| "Number of floors" | §4/brief lists it as a hotel field | Derived from `floor` rows. Storing it would create a second source of truth (§58). | 13 |
| HTTP authorization tests | §22: E2E from Phase 2; Phase 0 ledger deferred route-level auth tests | Human partner directive: server authorization tests are **not** deferred. `@nuxt/test-utils` harness pulled into Phase 1. | 8 |
| Optional `hotelId` | `hasPermission(ctx, p, hotelId?)` = org-level when omitted (documented, tested) | Ruled "not a defect" in Phase 0. With hotel data it becomes a footgun; services call explicit `orgCan` / `hotelCan` instead. | 7 |
| `resetDemo` privilege | Every org's SUPER_ADMIN holds it; guarded only by a demo-org check | Removed from the generic SUPER_ADMIN bundle; granted only to the demo org's role. | 7 |
| CI extension step | CI runs `CREATE EXTENSION btree_gist` itself | Migration `0001` creates it, so fresh databases (CI, staging, customers) need no side channel. | 3 |
| Test cleanup | Four files hard-code `TRUNCATE TABLE a, b, c…` | Every new table would silently survive between tests and can hide failures. | 1 |
| DB pool | `createDb` never exposes/ends its client; seed CLI uses `process.exit` | Leak in tests and on hot reload. | 2 |

## A3. Phase 0 technical debt that becomes dangerous once hotel/room data exists

The ten areas the brief asked me to review. Each is a **task**, not a workaround.

| # | Area | Finding in the real code | Why it becomes dangerous | Action → Task |
|---|---|---|---|---|
| 1 | Repository-layer enforcement | `server/repositories/` is empty. `auth.service.ts`, `demo.service.ts`, `db/seed/*` build Drizzle queries directly. The cross-tenant escalation found in Phase 0's final review was exactly an unscoped query in a seed. | Phase 1 adds ~10 tenant tables and dozens of queries; each is a chance to forget `organization_id`/`hotel_id`. | Scopes + repositories + lint + fitness + behavioral isolation suite → **4** |
| 2 | Tenant-aware authentication | Login is correctly scoped by org slug and timing-safe. `authenticate()` still returns `allHotels:false, hotelIds:[]` stubs and permissions that get frozen into the cookie. | Hotel access is now real; a frozen snapshot means revoked access keeps working, and a deactivated user keeps a valid session until the cookie dies (it never does — A1#11). | Identity-only session, `maxAge`, per-request resolution → **7** |
| 3 | RBAC + hotel-level authorization | `hasPermission` treats a missing `hotelId` as "org-level allowed". `requirePermission` reads the snapshot. Nothing loads the hotel or verifies it belongs to the caller's org. | A hotel-scoped route that forgets to pass `hotelId` silently becomes org-wide; a foreign hotel id is never checked against the org. | Explicit `orgCan`/`hotelCan`, `authorizeHotel` minting `HotelScope`, 404/403 rules → **7** |
| 4 | Demo reset after many FKs | Reset = one `DELETE FROM organization` cascade, then reseed inside one transaction. Correct today, untested against a wide graph. | `RESTRICT` FKs, missing FK indexes, or a slow 350-room seed inside one transaction would break or stall the reset; a second org holding the slug `demo` is already refused. | `NO ACTION`-only rule, FK indexes, reset regression with full data + second populated org, deterministic ids, hash reuse → **20** |
| 5 | Audit logging | Table exists; only demo reset writes to it. No `hotel_id`, no writer helper, no index, no immutability. | Config changes (capacity!) need per-hotel history that only authorised users can read; mutable audit rows are not audit. | `audit_log.hotel_id`, indexes, update-blocking trigger, `recordAudit`, `audit.view` → **6** |
| 6 | Transaction boundaries | Only `resetDemoData` uses a transaction. Repos accept `DbOrTx`, but services have no pattern. | `createRoom` = room + base version + audit. Partial success is corrupt inventory. | One-transaction-per-write rule, `runInTransaction`, rollback tests → **4, 12–16** |
| 7 | DB connection lifecycle | `createDb` builds a pool it never closes; `useDb()` is a process singleton; each test file also opens its own second pool; seeds `process.exit()`. | More test files and HTTP tests (Nuxt server + test process) multiply pools → "too many connections" flakiness. | `closeDb`, Nitro close hook, env-driven pool size, leak test → **2** |
| 8 | Migration strategy | One migration; no rules for raw SQL, no drift check, no way to test a data-preserving migration; extension created outside migrations. | Phase 1 needs exclusion constraints, triggers, a backfill, and 7 migrations. | Policy, `db:check`, drift CI check, migration test harness, extension-in-migration → **2, 3** |
| 9 | Test database isolation | Single shared `_test` DB, sequential files, four hard-coded `TRUNCATE` lists, no way to rebuild from scratch. | A forgotten table in a truncate list leaks rows between tests and creates order-dependent passes. | `truncateAllTables`, `db:test:reset`, `test:integration:fresh` → **1** |
| 10 | CI implications | CI runs lint/typecheck/unit/integration. No HTTP tests, no drift/migration checks, integration DB not rebuilt from scratch. | New guarantees are worthless if CI doesn't run them; `nuxt build` for HTTP tests adds minutes. | CI jobs split + new checks; decision gate on runtime → **8, 21** |

---

# Part B — Design decisions

Every decision states the recommended default. Items marked **Q** are the only things I would like the human partner to confirm; none blocks the plan, and each has a stated default that the tasks already assume.

**D1 — Room types are an organization-level catalog with *snapshot* semantics. (Q1)** `room_type(organization_id, code, name, default_physical_beds, default_sellable_capacity, …)` is shared by all hotels (a "Quad" means the same thing in Makkah and Madinah, and cross-hotel reports group by it). Creating a room copies the type's defaults into the room's first base version (`origin = 'ROOM_TYPE_DEFAULT'`, or `'MANUAL'` if the user overrides the numbers). **Editing a type's defaults never changes existing rooms** — otherwise one edit would silently rewrite historical capacity for every room of that type. The only way to change an existing room's capacity is an explicit, audited, date-effective base-configuration change on that room (`POST …/rooms/:roomId/base-config`, effective today or later). A bulk "apply new defaults from date X" convenience over that mechanism is **not built in Phase 1** (documented, deferred). **Approved (Q1).**

**D2 — Capacity is layered and versioned; a room's presence in inventory is derived.**
- `room_base_config`: date-effective **base** versions per room (`valid_from`, nullable `valid_to`, physical beds, sellable capacity). Exclusion constraint: no two base versions of a room overlap. A permanent change (renovation 4→5 beds) closes the current version and opens a new one; history is never overwritten.
- `capacity_period` + `room_capacity_override`: hotel-level named periods (Hajj 2027, Ramadan 2027, special) and per-room overrides whose dates equal the period's (kept in sync by the composite FK, A1#2). Exclusion constraint: a room has at most one override on any night. Periods may overlap each other; a *room* may not be overridden twice on one night.
- **Effective capacity(room, night)** = the override covering the night, else the base version covering the night, else *the room is not in inventory that night*. There is no `is_active` column on `room`: retiring a room closes its last base version; a temporary exclusion is a gap between versions; reactivation opens a new version. This keeps past denominators (occupancy, averages) correct — a room retired in 2027 still counts in 2026.
- **Physical beds and sellable capacity are separate numbers everywhere.** Sellable may exceed beds (extra beds) or be lower (staff hold); only range checks apply (`beds 1..30`, `sellable 0..30`).

**D3 — Operational state is a separate layer: `room_operational_block`.** Kinds: `OPERATIONAL_BLOCK`, `MAINTENANCE`, `OUT_OF_SERVICE` (display precedence OOS > maintenance > block). Each is a dated range with a required reason; overlapping ranges of *different* kinds are allowed, of the *same* kind are not (partial exclusion, active rows only). Blocks are soft-cancelled, never deleted; an in-progress block is "ended early" by moving its end to yesterday so past nights keep their history. Whether a `MAINTENANCE` block stops sales is the hotel setting `inventory.maintenanceBlocksSales` (default true). Housekeeping state (clean/dirty) is Phase 4 and does not exist here. Booking/hold occupancy is Phase 2 and enters through the same status enum and precedence list (`OCCUPIED`, `BOOKED`, `HELD` are already reserved in `INVENTORY_STATUSES`) — no schema rewrite.

**D4 — No materialization.** Availability is derived from D2+D3 by pure functions (Tasks 9–11); the calendar API returns run-length **segments per room**, not one cell per day. A read-optimized projection is added only if profiling proves it necessary (Phase 8). Evidence: A1#5.

**D5 — Range and time conventions.** Inclusive night ranges; `shared/utils/dates.ts` is the only place dates are parsed or added; ISO strings validated to real calendar dates 1900–2200; `todayInTimezone(hotel.timezone, clock)` for every "is it in the past" rule; timezone validated as an IANA name. Gregorian dates are authoritative; Hajj/Ramadan are *labels* on periods (`kind`), never the source of dates.

**D6 — Averages have four exact definitions** (formulas in Part C §8): Base Hotel Average, Date-Effective Hotel Average (both structural — operational blocks ignored), Range Average (weighted by room-nights), and Available-Stay Average (rooms sellable on every night of the stay, using each room's minimum capacity across the stay — reservations join in Phase 2). All return `{ numerator, denominator, value, display, basis }`; a zero denominator gives `null`, never 0/NaN. Multi-hotel results are weighted sums, never averages of averages. Display rounding is half-up to 2 decimals using integer arithmetic.

**D7 — Repository strategy (the Phase 1 foundation).**
- `OrganizationScope` / `HotelScope` are branded objects (`server/security/scope.ts`). Only `trustedOrganizationScope` / `trustedHotelScope` create them, and importing those is restricted to `server/security`, `db/seed`, `tests`. Requests obtain scopes from `requireAuthContext()` and `authorizeHotel()`.
- `OrgQuery` / `HotelQuery` (`server/repositories/base/scopedQuery.ts`) are the only way repositories touch tenant tables: every select/update/delete carries the org (and hotel) predicate; inserts take `Omit<Insert, 'organizationId'|'hotelId'>` so the caller *cannot* choose them, and at runtime the scope value is applied last so even a cast-away type cannot override it.
- **Two repository families:** `Tenant*Repository` (constructed from a scope) and `Platform*Repository` (deliberately cross-tenant: organization by slug, permission catalog, demo reset). A `Platform` repository is a review flag by name; an allow-list test pins which exist.
- Defense in depth: (1) types, (2) lint + a fitness test on imports, (3) a **registry-driven behavioral test** that calls every repository method as org B against org A's ids and asserts nothing is returned or changed — and fails if a repository exists that isn't registered, (4) composite FKs (writes), (5) PostgreSQL Row-Level Security is **deferred to Phase 9** (ruling: it needs a non-owner app role and per-request `SET LOCAL`, which is hardening work with its own risk; the schema is RLS-ready).
- Seeds go through the same tenant repositories (the Phase 0 escalation lived in a seed).

**D8 — Authorization model.** Session = identity. `requireAuthContext(event)` loads the user (must be active), their permission keys (roles restricted to the user's own org), `all_hotels` and hotel ids from the database once per request and memoizes it on the event. Services call `orgCan/hotelCan`, or `authorizeHotel(ctx, permission, hotelId)` which (a) loads the hotel *within the org* (404), (b) checks the permission for that hotel (403), (c) mints the `HotelScope`. New permissions `capacity.manage`, `room.block`, `audit.view`. Hotel-access assignment obeys escalation rules (Task 7).

**D9 — Audit.** `audit_log` gains nullable `hotel_id` (composite FK) and two indexes; an update-blocking trigger makes rows immutable (`DELETE` stays possible because org cascade must work). Every configuration write records `{action, entityType, entityId, before, after, reason?}` in the **same transaction**. Actions are constants (`shared/constants/audit.ts`). Secrets never enter `before/after`.

**D10 — Error model.** `DomainError` subclasses carry `code` + HTTP status; `translateDbError` maps Postgres codes (`23505` unique, `23P01` exclusion, `23503` FK, `23514` check, `55000` immutable audit) — unwrapping Drizzle's `.cause` — into `ConflictError`/`ValidationError` using a constraint-name → friendly-message registry. `defineApiHandler` validates params/query/body with Zod, builds the auth context, and renders errors as Nitro `createError({ statusCode, statusMessage, data: { code, details } })`.

**D11 — Transactions.** One transaction per write service including audit. Repositories accept `DbOrTx`. Check-then-insert races are backstopped by the constraints and surface as `409` through `translateDbError`.

**D12 — Demo data.** Deterministic ids (UUID v5 from a fixed namespace + a stable key, e.g. `hotel:MKK-GRAND`, `room:MKK-GRAND:401`) and a seeded PRNG (mulberry32) so two seeds produce identical rows; sessions and bookmarks survive a reset. Time-relative rows (current maintenance, blocks) hang off a fixed `DEMO_ANCHOR_DATE` (default `2026-09-01`, overridable at reset). One Argon2 hash is computed once and reused for all personas. The seed **refuses to run when `APP_ENV=production`** unless `ALLOW_DEMO_SEED=true`.

**D13 — Migration policy.** Documented in `docs/MIGRATIONS.md` (Task 2): forward-only; one file per schema task; hand-edit only before first commit; raw SQL (exclusion constraints, triggers, extensions) appended to the generated file; `db:check` + drift check in CI; data-preserving migrations covered by the migration harness (Task 3).

**D14 — Deletion/archive policy.** Hotels/floors/room types: deactivate only (`INACTIVE`/`is_active=false`), never deleted. Rooms: retired by closing their base version. Capacity periods: deletable **only before they start and only with no overrides**; started periods are shortened, not deleted. Overrides: deletable only while their period has not started. Blocks: soft-cancelled/ended early, never deleted. Documents: archived (`archived_at`). Audit rows: append-only. These rules live in services and are tested; the database keeps `NO ACTION` FKs as a second line.

**D15 — Documents.** Generic `document_asset` (file metadata + storage key) plus a typed `hotel_document` link table, so later phases add `employee_document` etc. without polymorphic FKs. `StorageDriver` interface with a local-disk driver; S3-compatible driver is Phase 9. **Task 19 is deferrable** without blocking anything else.

**D16 — Room identity and renumbering-readiness (Q2).** A physical room is identified by `room.id` (uuid), permanently. Every relationship — composite FKs (base versions, overrides, blocks), URLs (`/rooms/:roomId`), audit `entityId`, repository lookups, and Phase 2 reservations/assignments — uses `room.id`, **never** `room_number`. The number is a hotel-unique display/lookup attribute (`UNIQUE(hotel_id, room_number)`), immutable after creation in Phase 1; retiring a room only closes its base version, so its row and number stay and remain reserved forever (no reuse). This keeps a future controlled renumbering workflow additive: a `room_number_history(room_id, room_number, valid_from, valid_to)` table (exclusion constraint per hotel so a number is never held by two rooms on one night, plus an audited, permission-gated endpoint) can be introduced, with `room.room_number` remaining the *current* number — no change to inventory history, calendar segments, capacity tables or reservations is needed. Consequences already built into Phase 1: DTOs return `roomId` and `roomNumber` as separate fields; stored snapshots that embed a number (audit `before/after`, `details.conflicts`) are point-in-time by nature; deterministic demo ids derive from the *initial* number at seed time only, never at runtime. **Not implemented in Phase 1:** renumbering, number reuse, number history.

### Resolved questions (rulings recorded in the Approval record above)

- **Q1** Room types organization-level with snapshot semantics — **approved** (D1).
- **Q2** No reuse of a retired room's number within a hotel in Phase 1; number immutable after creation; renumbering-ready model, workflow deferred — **approved** (D16).
- **Q3** Hotel documents (Task 19) stay in Phase 1, independently deferrable — **approved** (D15, Task 19).
- **Q4** Demo Hajj period `2027-05-01…2027-07-31`, demo/test data only, never a hard-coded business assumption — **approved** (Global Constraints, Task 20).
- **Q5** Session lifetime 8 hours, identity-only session, per-request authorization — **approved** (D8, Task 7).
- **Q6** Hotel-level periods may overlap; a room has at most one override per night (exclusion constraint) — **approved** (D2, Task 15).

### Consistency review changes (2026-09-25, against the rulings)

| # | Finding | Change |
|---|---|---|
| 1 | **Conflict with Q2:** Task 14 rule 5 let `PATCH` change a room's number, and the old Q2 text said "rename the old room first" — a renumbering path the ruling defers and that would rewrite how history reads. | `PATCH` no longer accepts `roomNumber` (strict schema → 422 `ROOM_NUMBER_IMMUTABLE`); Task 14 rules and tests updated; D16 added; Global Constraint "Room identity" added. |
| 2 | Q1 wording implied a bulk "apply defaults" action might ship. | D1 states it is deferred; the per-room date-effective base change is the only mechanism. |
| 3 | Q4 was stated as a default, not a constraint; season dates could leak into code. | Global Constraint "No business dates in code"; Task 20 acceptance gains an inspection/grep step. |
| 4 | Task 19 independence was asserted but the acceptance gate, migration table and Task 21 doc list assumed `0007`. | Task 19 deferral protocol; gate item 1, §4 table and Task 21 made conditional. |
| 5 | Q3/Q5/Q6 and all "also approved" items | Verified consistent; no change beyond recording the approval. |

---

## File structure (Phase 1 additions and changes)

```text
db/
  client.ts                          # MODIFY  Task 2 (createDbWithClient, closeDb-ready)
  schema/
    tenancy.ts                       # MODIFY  Tasks 3, 6 (unique(org,id), user_role.org, app_user.all_hotels)
    audit.ts                         # MODIFY  Task 6 (hotel_id, indexes)
    hotel.ts                         # CREATE  Task 6 (hotel, hotel_setting, user_hotel_access)
    inventory.ts                     # CREATE  Tasks 13-16 (floor, room_type, room, room_base_config,
                                     #         capacity_period, room_capacity_override, room_operational_block)
    documents.ts                     # CREATE  Task 19
    index.ts                         # MODIFY  re-exports
  migrations/0001..0007_*.sql        # CREATE  one per schema task (3, 6, 13, 14, 15, 16, 19)
  scripts/resetTestDb.ts             # CREATE  Task 1
  seed/
    demo-org.ts                      # MODIFY  Tasks 4, 20
    rbac.ts                          # MODIFY  Tasks 4, 7
    demo/{ids,random,inventory,index}.ts   # CREATE Task 20
server/
  demo/{catalog,personas}.ts        # CREATE  Task 20 (static demo catalogues shared by seed and demo sign-in, S14)
  security/{scope,authContext,authorize,hotelAccess}.ts       # CREATE Tasks 4, 7
  repositories/
    base/scopedQuery.ts              # CREATE  Task 4
    platform/*.ts                    # CREATE  Task 4 (organization, permission catalog, demo reset)
    tenant/*.ts                      # CREATE  Tasks 4-19 (user, role, audit, hotel, hotelSetting, userHotelAccess, organization (S1),
                                     #         floor, roomType, room, baseConfig, capacityPeriod, override, block,
                                     #         inventoryRead, document)
    index.ts                         # CREATE  Task 4 (platformRepos, tenantRepos, hotelRepos factories)
  domain/
    rbac/{hasPermission,authorize}.ts          # MODIFY/CREATE Task 7
    inventory/{capacity,averages,calendar}.ts  # CREATE Tasks 10-11
    inventory/{baseVersions,nextChange,capacityPeriodRules,blockRules}.ts  # CREATE Tasks 14-16 (nextChange: S5; blockRules gains blockPhase: S10)
  errors/{domainError,dbErrors}.ts   # CREATE  Task 5
  services/                          # auth, demo (MODIFY 4, 7); hotel, hotelAccess, floor, roomType, room,
                                     # capacityPeriod, capacityAverage, operationalBlock, roomCalendar,
                                     # document, audit (CREATE 6-19); sessionContext (7, S1); hotelDto, roomDto, blockDto (12, 14, 16); demoSignIn (20, S14)
  api/                               # routes per Part C §5
  utils/{apiHandler,requireAuth,serviceContext,db}.ts  # CREATE/MODIFY Tasks 2, 5, 7
  plugins/db.ts                      # CREATE  Task 2
shared/
  constants/{inventory,audit,permissions,roles}.ts
  schemas/{common,hotel,inventory,...}.ts
  business-rules/hotelSettings.ts
  utils/dates.ts                     # CREATE  Task 9
tests/
  unit/{architecture,domain/inventory,shared,security}/...
  integration/{support,security,services,db,demo}/...
  http/                              # CREATE  Task 8
  types/scope.types.ts               # CREATE  Task 4
  support/fixtures.ts                # CREATE  Task 4 (extended by later tasks)
docs/{MIGRATIONS.md,ARCHITECTURE.md} # Tasks 2, 21
```

---

# Tasks

**Order and dependencies at a glance** (details per task; the full table is Part C §12):

```text
Foundation (sequential):  1 → 2 → 3 → 4 → 5 → 6 → 7 → 8
Pure domain (parallel-safe with 1–8, disjoint files):  9 → 10 → 11
Inventory (sequential, migrations are linear):  12 → 13 → 14 → 15 → 16 → 17 → 18
(Task 14 also needs Task 11 merged: room `status` reuses `buildRoomSegments`. 9 → 10 → 11 run early and in parallel with 1–8, so this adds no wait.)
Deferrable / parallel-safe after 16:  19
Closing:  20 → 21
```

Standard step skeleton used by every task (only the task-specific parts are repeated below): **(1)** write the listed tests first; **(2)** run them and confirm they fail *for the stated reason*; **(3)** implement the smallest change; **(4)** run the covering tests, then the full verification commands; **(5)** commit at the stated boundary. Every task ends with `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration` green and pristine.

---

### Task 1: Test infrastructure hardening

**Objective:** Make integration tests safe to grow: no hard-coded table lists, one shared connection per test file, and the ability to rebuild the test database from nothing.

**Depends on:** none (Phase 0 code only). **Parallelization:** sequential (touches every integration test file).

**Files:**
- Create: `tests/integration/support/testDb.ts`, `db/scripts/resetTestDb.ts`
- Create (tests): `tests/unit/support/testDatabase.test.ts`, `tests/integration/support/testDb.test.ts`
- Modify: `tests/integration/db/seed.test.ts`, `tests/integration/db/tenancy-schema.test.ts`, `tests/integration/services/auth-service.test.ts`, `tests/integration/services/demo-service.test.ts` (replace per-file `postgres()` + hard-coded `TRUNCATE` with the helper)
- Modify: `package.json` (scripts `db:test:reset`, `test:integration:fresh`)

**Interfaces:**
- Produces (`tests/integration/support/testDb.ts`):
  ```ts
  export function getTestClient(): postgres.Sql
  export function getTestDb(): PostgresJsDatabase<typeof schema>
  export function truncateAllTables(): Promise<void>   // every table in schema "public", discovered from pg_tables
  export function closeTestDb(): Promise<void>
  ```
- Produces (`db/scripts/resetTestDb.ts`): a script that refuses any `DATABASE_URL` whose database name does not end in `_test`, then `DROP SCHEMA public CASCADE; DROP SCHEMA drizzle CASCADE; CREATE SCHEMA public;` and runs all migrations. (Drizzle keeps its bookkeeping in schema `drizzle`; verified: `drizzle.__drizzle_migrations`.)

**Reference implementation of the helper (verified shape):**
```ts
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../../db/schema'
import { requireTestDatabaseUrl } from './testDatabase'

let client: ReturnType<typeof postgres> | null = null

export function getTestClient() {
  client ??= postgres(requireTestDatabaseUrl(), { max: 4, onnotice: () => {} })
  return client
}
export function getTestDb() {
  return drizzle(getTestClient(), { schema })
}
/** Truncates every table in "public", discovered from the catalog, so a table added later can never be forgotten. */
export async function truncateAllTables(): Promise<void> {
  const c = getTestClient()
  const rows = await c<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  if (rows.length === 0) return
  const list = rows.map(r => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(', ')
  await c.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
}
export async function closeTestDb(): Promise<void> {
  if (client) { await client.end(); client = null }
}
```

**API / authorization:** none.

**Database changes:** none.

**Tests to write first:**
1. (unit) `requireTestDatabaseUrl()` — accepts `postgres://…/hajj_umrah_test`; throws for `…/hajj_umrah_dev`; throws for a missing `DATABASE_URL`; throws for an unparseable URL; accepts a percent-encoded name that decodes to `*_test`. *(This guard exists but has no test today.)*
2. (integration) `truncateAllTables()` empties **every** table: the test creates `zz_truncate_probe(id int)` with a row, calls the helper, asserts zero rows, drops the probe. Also asserts `drizzle.__drizzle_migrations` is untouched.
3. (integration) `resetTestDb` refuses a non-`_test` database (import the guard function it uses and assert it throws for `hajj_umrah_dev`).
4. The four existing integration files still pass after migration to the helper and contain **no** `TRUNCATE` and **no** table names in cleanup (a unit test greps `tests/integration/**/*.test.ts` for `TRUNCATE` and fails if found — this stops the pattern coming back).

**Verification commands:**
```bash
pnpm test:unit
pnpm test:integration
pnpm test:integration:fresh      # drops schemas, re-migrates, runs the whole suite
pnpm lint && pnpm typecheck
```

**Acceptance criteria:** existing 24 integration + 29 unit tests still pass; `test:integration:fresh` passes from an empty database; no test file names a table for cleanup; the `_test` guard has direct tests.

**Commit boundary:** one commit — `test: shared test-db helper, catalog-driven truncate, fresh-db script`.

---

### Task 2: DB connection lifecycle & migration tooling

**Objective:** Close the connection-leak risk before more pools appear, and put migration rules under automated control.

**Depends on:** 1. **Parallelization:** sequential.

**Files:**
- Modify: `db/client.ts`, `server/utils/db.ts`, `server/utils/env.ts`, `db/seed/index.ts`, `.github/workflows/ci.yml`, `package.json`, `.env.example`
- Create: `server/plugins/db.ts`, `db/scripts/checkDrift.ts`, `docs/MIGRATIONS.md`
- Test: `tests/unit/server/env.test.ts` (extend), `tests/integration/support/dbLifecycle.test.ts`

**Interfaces:**
- Produces (`db/client.ts`):
  ```ts
  export interface DbHandle { db: Database, close: () => Promise<void> }
  export function createDbWithClient(connectionString: string, options?: { max?: number }): DbHandle
  export function createDb(connectionString: string, options?: { max?: number }): Database   // unchanged signature, kept for scripts
  ```
  `createDbWithClient` builds `postgres(url, { max: options.max ?? 10, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} })` and returns `{ db, close: () => client.end({ timeout: 5 }) }`.
- Produces (`server/utils/db.ts`): `useDb(): Database` (lazy singleton, pool size from `DATABASE_POOL_MAX`) and `closeDb(): Promise<void>` (idempotent; a later `useDb()` creates a fresh handle).
- Produces (`server/plugins/db.ts`): `export default defineNitroPlugin(nitro => { nitro.hooks.hook('close', closeDb) })`.
- Produces (`env`): `DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10)`.
- Produces (scripts): `"db:check": "drizzle-kit check"`, `"db:drift": "tsx db/scripts/checkDrift.ts"`.

**API / authorization:** none (no routes are added or changed).

**Drift check (`db/scripts/checkDrift.ts`):** runs `drizzle-kit generate --name drift_check`, then `git status --porcelain db/migrations`; if anything changed or appeared it deletes the newly generated files and exits 1 with "the Drizzle schema no longer matches the migrations — run `pnpm db:generate`". Verified during planning: after hand-appended raw SQL, a second `generate` reports "No schema changes", so exclusion constraints and triggers do not cause false drift.

**`docs/MIGRATIONS.md` (content):** forward-only; one migration per schema task; generate with `pnpm db:generate --name <task-slug>`; hand-editing is allowed **only before the first commit** and only to (a) reorder statements, (b) add backfills, (c) append raw SQL Drizzle cannot express (extensions, exclusion constraints, triggers); never edit a committed migration; extensions are created in the migration that needs them; every migration must apply cleanly to an empty database (`pnpm test:integration:fresh`) and, when it touches existing rows, has a data-preserving test using the migration harness (Task 3).

**CI changes:** add steps `pnpm db:check` and `pnpm db:drift` after install (they need no database). Leave the existing `btree_gist` step for now — Task 3 removes it.

**Tests to write first:**
1. (unit) `DATABASE_POOL_MAX` defaults to 10; `'0'`, `'51'`, `'abc'` are rejected.
2. (integration) `closeDb()` twice does not throw; after `closeDb()`, `useDb()` returns a working handle (`select 1`).
3. (integration) leak test: create-query-close a `DbHandle` 15 times; `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()` after equals the count before.
4. `pnpm db:seed` run twice in a row exits 0 without `process.exit` (verified manually in the task report).

**Verification commands:** `pnpm test:unit && pnpm test:integration && pnpm db:check && pnpm db:drift && pnpm db:seed && pnpm db:seed`.

**Acceptance criteria:** no code path calls `process.exit(0)` to end a DB script; pool size is configurable; drift and check scripts pass locally and in CI; migration policy is written down.

**Commit boundary:** one commit — `chore: db handle lifecycle, pool config, migration drift/check tooling`.

---

### Task 3: Tenancy composite-key hardening (migration `0001`)

**Objective:** Close, **in the database**, the class of cross-tenant link that produced the Phase 0 privilege-escalation finding (`user_role` could join a user of one org to a role of another), and make the schema ready for composite-FK children.

**Depends on:** 1, 2. **Parallelization:** sequential (first schema migration).

**Files:**
- Modify: `db/schema/tenancy.ts`, `db/seed/rbac.ts`, `db/seed/demo-org.ts`, `.github/workflows/ci.yml`, `tests/integration/services/auth-service.test.ts`, `tests/integration/services/demo-service.test.ts` (their `userRole` inserts now need `organizationId`)
- Create: `db/migrations/0001_tenancy_hardening.sql` (+ generated `meta/`), `tests/integration/support/migrationHarness.ts`, `tests/integration/db/tenancyHardening.migration.test.ts`

**Schema changes (`db/schema/tenancy.ts`)** — additions only:
- `appUser`: `unique('app_user_org_id_unique').on(organizationId, id)`
- `role`: `unique('role_org_id_unique').on(organizationId, id)`
- `userRole`: new `organizationId` column (FK → organization, cascade); the two single-column FKs are replaced by composite FKs `user_role_org_user_fk (organization_id, user_id) → app_user(organization_id, id) ON DELETE CASCADE` and `user_role_org_role_fk (organization_id, role_id) → role(organization_id, id) ON DELETE CASCADE`; index `user_role_role_idx (organization_id, role_id)`.

The verified Drizzle definition:
```ts
export const userRole = pgTable('user_role', {
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.roleId] }),
  foreignKey({ columns: [table.organizationId, table.userId], foreignColumns: [appUser.organizationId, appUser.id], name: 'user_role_org_user_fk' }).onDelete('cascade'),
  foreignKey({ columns: [table.organizationId, table.roleId], foreignColumns: [role.organizationId, role.id], name: 'user_role_org_role_fk' }).onDelete('cascade'),
  index('user_role_role_idx').on(table.organizationId, table.roleId),
])
```

**Migration `0001` — the required hand edits to what `pnpm db:generate --name tenancy_hardening` emits** (generated `ADD COLUMN … NOT NULL` fails on populated tables — A1#7). Final statement order (executed against a scratch database holding Phase 0 data including a planted cross-org grant; the grant was purged):
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "user_role" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
UPDATE "user_role" ur SET "organization_id" = u."organization_id" FROM "app_user" u WHERE u."id" = ur."user_id";--> statement-breakpoint
DELETE FROM "user_role" ur USING "role" r WHERE r."id" = ur."role_id" AND r."organization_id" <> ur."organization_id";--> statement-breakpoint
ALTER TABLE "user_role" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_org_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_org_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
-- …then the generated DROP CONSTRAINT of the two old single-column FKs, and the generated ADD CONSTRAINT / CREATE INDEX statements for user_role
```
(The `UNIQUE` constraints must precede the composite FKs that reference them. The `DELETE` removes exactly the rows this migration exists to forbid: a user linked to a role of a different organization.)

**Migration harness (`tests/integration/support/migrationHarness.ts`) — reused by every later schema task:**
```ts
withScratchDatabase(name: string, fn: (url: string) => Promise<T>): Promise<T>   // creates/drops "<name>" (must end in _test) on the same server
migrateThrough(url: string, lastIdx: number): Promise<void>  // copies db/migrations to a temp dir, truncates meta/_journal.json to idx <= lastIdx, runs drizzle migrate
migrateAll(url: string): Promise<void>                        // applies whatever is still pending (drizzle compares created_at, so partial → full works)
```

**Domain/service rules:** none (structural). `seedOrganizationRoles`/`seedDemoOrganization` and the two test files add `organizationId` to their `userRole` inserts.

**API / authorization:** none.

**Tests to write first** (`tenancyHardening.migration.test.ts`, each in a scratch DB named `hajj_umrah_migrate_test`):
1. Fresh DB → `migrateAll` → `pg_extension` contains `btree_gist` (the migration creates it; no `init.sql` needed).
2. `migrateThrough(0)`, insert two orgs with users/roles and `user_role` rows including one **cross-org** grant (raw SQL, old schema), then `migrateAll`: the legitimate row survives with `organization_id` equal to its user's org; the cross-org row is gone; row count is exactly 1.
3. After migration, inserting a `user_role` whose role belongs to another org fails with SQLSTATE `23503` and constraint `user_role_org_role_fk`; the same for the user side (`user_role_org_user_fk`).
4. `information_schema` shows `app_user_org_id_unique` and `role_org_id_unique`.
5. (integration, main test DB) the existing seed/auth/demo suites pass unchanged in behavior.

**Verification commands:** `pnpm db:generate --name tenancy_hardening` (then hand-edit), `pnpm db:check && pnpm db:drift && pnpm test:integration:fresh`.

**Acceptance criteria:** the database itself rejects any `user_role` row that crosses organizations; legacy cross-org rows are purged, not silently kept; a fresh database migrates without `init.sql`; CI no longer runs a separate `CREATE EXTENSION` step (remove it in this task).

**Commit boundary:** one commit — `feat(db): composite-key tenancy hardening (user_role org column, btree_gist in migration)`.

---

### Task 4: Scope types & repository foundation (the deferred Phase 0 requirement)

**Objective:** Make tenant and hotel isolation structural. After this task no service, route, domain module or util can build a Drizzle query, and no tenant query can be written without an organization predicate.

**Depends on:** 3. **Parallelization:** sequential — it refactors `auth.service.ts`, `demo.service.ts` and all seed code; nothing else may touch them meanwhile.

**Files:**
- Create: `server/security/scope.ts`, `server/security/tenantResolver.ts`, `server/repositories/base/scopedQuery.ts`, `server/repositories/platform/{organizationRepository,permissionCatalogRepository}.ts`, `server/repositories/tenant/{userRepository,roleRepository,auditRepository}.ts`, `server/repositories/tenant/index.ts` (barrel), `server/repositories/index.ts`, `tests/support/fixtures.ts`, `tests/support/layering.ts`, `tsconfig.typetests.json`
- Create (tests): `tests/types/scope.types.ts`, `tests/unit/architecture/layering.test.ts`, `tests/integration/security/repositoryRegistry.ts`, `tests/integration/security/tenantIsolation.test.ts`, `tests/integration/security/scopedQuery.test.ts`
- Modify: `server/services/auth.service.ts`, `server/services/demo.service.ts`, `db/seed/rbac.ts`, `db/seed/demo-org.ts`, `db/seed/index.ts`, `eslint.config.mjs`, `package.json` (script `typecheck:types`), `.github/workflows/ci.yml` (run it)

**API / authorization:** no endpoints. Authorization is *structural* here: this task creates the scope types that every later authorization decision returns (Task 7).

**Row types:** repositories export their row types (`export type UserRow = typeof appUser.$inferSelect`, `OrganizationRow`, …) because services and domain code may not import `db/schema`, not even for types.

**Interfaces — produced (verified code, embedded verbatim):**

`server/security/scope.ts`
```ts
declare const orgBrand: unique symbol
declare const hotelBrand: unique symbol

/** Proof that a tenant has been established server-side. Cannot be built from request input without going through this module. */
export interface OrganizationScope { readonly [orgBrand]: true, readonly organizationId: string }
/** Proof that the caller was authorised for this hotel inside this organization. */
export interface HotelScope extends OrganizationScope { readonly [hotelBrand]: true, readonly hotelId: string }

/**
 * The only functions that mint scopes. Importing them is restricted (ESLint + a fitness test) to
 * server/security/**, db/seed/** and tests/** — request handlers and services obtain scopes from
 * requireAuthContext() / authorizeHotel(), never by constructing them.
 */
export function trustedOrganizationScope(organizationId: string): OrganizationScope {
  return { organizationId } as unknown as OrganizationScope
}
export function trustedHotelScope(org: OrganizationScope, hotelId: string): HotelScope {
  return { organizationId: org.organizationId, hotelId } as unknown as HotelScope
}
```

`server/repositories/base/scopedQuery.ts`
```ts
import { and, eq, type SQL } from 'drizzle-orm'
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core'
import type { DbOrTx } from '../../../db/client'
import type { HotelScope, OrganizationScope } from '../../security/scope'

type OrgTable = PgTable & { organizationId: AnyPgColumn }
type HotelTable = OrgTable & { hotelId: AnyPgColumn }

type InsertOf<T extends PgTable> = T['$inferInsert']

export interface SelectOptions { orderBy?: SQL[], limit?: number, offset?: number }

async function run<T extends PgTable>(db: DbOrTx, table: T, where: SQL, o: SelectOptions = {}): Promise<Array<T['$inferSelect']>> {
  // Drizzle's conditional `from()` typing cannot be satisfied by a generic table, so the row type is restated here.
  let q = db.select().from(table as PgTable).where(where).$dynamic()
  if (o.orderBy?.length) q = q.orderBy(...o.orderBy)
  if (o.limit !== undefined) q = q.limit(o.limit)
  if (o.offset !== undefined) q = q.offset(o.offset)
  return (await q) as Array<T['$inferSelect']>
}


/** Every statement it builds carries the organization predicate; inserts cannot choose their own organization. */
export class OrgQuery {
  constructor(protected readonly db: DbOrTx, readonly scope: OrganizationScope) {}

  protected orgCond(table: OrgTable): SQL {
    return eq(table.organizationId, this.scope.organizationId)
  }

  cond<T extends OrgTable>(table: T, ...extra: Array<SQL | undefined>): SQL {
    return and(this.orgCond(table), ...extra)!
  }

  select<T extends OrgTable>(table: T, where?: SQL, options?: SelectOptions) {
    return run(this.db, table, this.cond(table, where), options)
  }

  insert<T extends OrgTable>(table: T, values: Omit<InsertOf<T>, 'organizationId'>) {
    return this.db.insert(table).values({ ...values, organizationId: this.scope.organizationId } as InsertOf<T>)
  }

  update<T extends OrgTable>(table: T, set: Partial<Omit<InsertOf<T>, 'organizationId' | 'id'>>, ...extra: Array<SQL | undefined>) {
    return this.db.update(table).set(set as never).where(this.cond(table, ...extra))
  }

  delete<T extends OrgTable>(table: T, ...extra: Array<SQL | undefined>) {
    return this.db.delete(table).where(this.cond(table, ...extra))
  }
}

/** Adds the hotel predicate on top of the organization predicate; inserts cannot choose organization or hotel. */
export class HotelQuery {
  constructor(protected readonly db: DbOrTx, readonly scope: HotelScope) {}

  cond<T extends HotelTable>(table: T, ...extra: Array<SQL | undefined>): SQL {
    return and(eq(table.organizationId, this.scope.organizationId), eq(table.hotelId, this.scope.hotelId), ...extra)!
  }

  select<T extends HotelTable>(table: T, where?: SQL, options?: SelectOptions) {
    return run(this.db, table, this.cond(table, where), options)
  }

  insert<T extends HotelTable>(table: T, values: Omit<InsertOf<T>, 'organizationId' | 'hotelId'>) {
    return this.db.insert(table).values({ ...values, organizationId: this.scope.organizationId, hotelId: this.scope.hotelId } as InsertOf<T>)
  }

  update<T extends HotelTable>(table: T, set: Partial<Omit<InsertOf<T>, 'organizationId' | 'hotelId' | 'id'>>, ...extra: Array<SQL | undefined>) {
    return this.db.update(table).set(set as never).where(this.cond(table, ...extra))
  }

  delete<T extends HotelTable>(table: T, ...extra: Array<SQL | undefined>) {
    return this.db.delete(table).where(this.cond(table, ...extra))
  }
}
```

`tests/types/scope.types.ts` (compile-only proof; `pnpm typecheck:types` must pass, which proves both `@ts-expect-error` lines are genuine errors)
```ts
import { eq } from 'drizzle-orm'
import { appUser, role } from '../../db/schema'
import type { DbOrTx } from '../../db/client'
import { OrgQuery } from '../../server/repositories/base/scopedQuery'
import { trustedOrganizationScope } from '../../server/security/scope'

/** Compile-only: `pnpm typecheck:types` must pass, which proves the two @ts-expect-error lines really are errors. */
export async function demo(db: DbOrTx) {
  const q = new OrgQuery(db, trustedOrganizationScope('00000000-0000-0000-0000-000000000000'))
  const rows = await q.select(appUser, eq(appUser.isActive, true))
  const first: string | undefined = rows[0]?.email
  await q.insert(appUser, { email: 'a@b.c', passwordHash: 'x', fullName: 'A' })
  await q.update(appUser, { isActive: false }, eq(appUser.email, 'a@b.c'))
  await q.delete(role, eq(role.key, 'X'))
  // @ts-expect-error organizationId must not be caller-supplied on insert
  await q.insert(appUser, { organizationId: 'other', email: 'a@b.c', passwordHash: 'x', fullName: 'A' })
  // @ts-expect-error a table without organization_id (the global permission catalog) cannot be queried through a tenant query
  await q.select((await import('../../db/schema')).permission)
  return first
}
```

`tsconfig.typetests.json`
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true,
    "noUncheckedIndexedAccess": true, "skipLibCheck": true, "noEmit": true,
    "verbatimModuleSyntax": true, "types": [], "lib": ["ES2023"]
  },
  "include": ["server/repositories/base/**/*.ts", "server/security/scope.ts", "tests/types/**/*.ts"]
}
```
Script: `"typecheck:types": "tsc -p tsconfig.typetests.json"`.

**Repository catalogue (constructors take `DbOrTx` + scope; methods listed are the Phase 0 surface only — later tasks add theirs):**

| Class | Family | Constructor | Methods |
|---|---|---|---|
| `PlatformOrganizationRepository` | Platform | `(db)` | `findBySlug(slug)`, `findById(id)`, `insert(values)`, `deleteCascade(id)` *(demo reset only)* |
| `PermissionCatalogRepository` | Platform | `(db)` | `upsertAll(entries)`, `listKeys()` |
| `UserRepository` | Tenant | `(db, OrganizationScope)` | `findActiveByEmail(email)`, `findById(id)`, `insert(values)` |
| `RoleRepository` | Tenant | `(db, OrganizationScope)` | `findByKey(key)`, `insert(values)`, `grantPermissions(roleId, keys)`, `assignToUser(userId, roleId)`, `permissionKeysForUser(userId)` |
| `AuditRepository` | Tenant | `(db, OrganizationScope)` | `record(entry)` |

`server/repositories/index.ts`: `platformRepos(db)` → `{ organizations, permissionCatalog }`; `tenantRepos(db, scope)` → `{ users, roles, audit, … }` (lazily constructed; later tasks extend it, plus `hotelRepos(db, hotelScope)`).

`server/security/tenantResolver.ts`: `resolveTenantBySlug(db, slug): Promise<{ organization: OrganizationRow, scope: OrganizationScope } | null>` and `scopeFromIdentity(identity: { organizationId: string }): OrganizationScope` — the only production code besides the seeds that calls `trustedOrganizationScope`.

**Rules for repositories (enforced by review + the registry test):**
- Constructed only with a scope; every tenant-table statement goes through `OrgQuery`/`HotelQuery` (or, for joins, uses `query.cond(table)` for **every** table involved).
- Repositories never open transactions; they accept `DbOrTx`.
- Methods return plain rows / DTO-shaped objects, never Drizzle builders.
- `RoleRepository.permissionKeysForUser` keeps the Phase 0 query-level guard (`role.organization_id = scope.organizationId`) even though the FK now forbids cross-org links — two independent layers.

**Guard rails:**
1. `eslint.config.mjs` — add (flat config):
   ```js
   {
     files: ['server/services/**/*.ts', 'server/api/**/*.ts', 'server/domain/**/*.ts', 'server/utils/**/*.ts', 'shared/**/*.ts'],
     ignores: ['server/utils/db.ts'],
     rules: {
       'no-restricted-imports': ['error', { patterns: [
         { group: ['drizzle-orm', 'drizzle-orm/*'], message: 'Only repositories may build queries.' },
         { group: ['**/db/schema', '**/db/schema/*', '**/db/client'], message: 'Go through a repository.' },
         { group: ['**/security/scope'], importNamePattern: '^trusted', message: 'Scopes are minted only by server/security, db/seed and tests.' },
       ] }],
     },
   }
   ```
2. Fitness test `tests/unit/architecture/layering.test.ts` uses the pure function `findViolations(sources: Record<string,string>, rules)` from `tests/support/layering.ts` and asserts (a) no forbidden imports in the same directories as the lint rule (so removing the lint rule cannot silently disable the check), (b) `trusted*` imports only from `server/security/**`, `db/seed/**`, `tests/**`, (c) `db/seed/**` does not import table objects from `db/schema` (seeds use repositories), (d) the set of `Platform*Repository` classes equals an explicit allow-list, (e) meta-tests: `findViolations({ 'server/services/x.ts': "import { eq } from 'drizzle-orm'" }, rules)` returns one violation — the checker itself is tested.
3. Behavioral registry `tests/integration/security/repositoryRegistry.ts` maps `ClassName.method` → an isolation case `{ arrange(orgA), act(scopeForOrgB, idsFromOrgA), expect: 'empty' | 'null' | 'zero-affected' | 'rejects' }` and `tenantIsolation.test.ts` runs them all. A **coverage test** imports the tenant barrel, walks every exported `*Repository` class and every prototype method, and fails if any lacks a registry entry — so a new repository cannot ship untested.

**Refactor (behavior identical; all existing tests keep passing):**
- `auth.service.ts` → `resolveTenantBySlug` → `tenantRepos(db, scope).users.findActiveByEmail(normalizeEmail(email))` → timing-safe verify → `roles.permissionKeysForUser`.
- `demo.service.ts` → `platformRepos(tx).organizations` / `deleteCascade`, `tenantRepos(tx, scope).audit.record`.
- `db/seed/rbac.ts`, `demo-org.ts` → repositories under `trustedOrganizationScope(org.id)`; no table imports.

**Tests to write first:**
1. (types) `pnpm typecheck:types` passes and contains the two negative cases above.
2. (unit) layering fitness test incl. the meta-tests.
3. (integration, `scopedQuery.test.ts`) `OrgQuery.insert` ignores an `organizationId` smuggled in with a cast (`{ organizationId: 'other' } as never`) and stores the scope's org; `OrgQuery.select/update/delete` never touch another org's rows (two orgs, identical shapes); `HotelQuery` requires both predicates.
4. (integration) registry-driven **tenant isolation** for every Phase 0 repository method (`findActiveByEmail` with the same email in orgs A and B returns only the scoped org's user; `findById` with org A's id under org B's scope → `null`; `permissionKeysForUser`; `assignToUser`; `record`).
5. (integration, **Phase 0 regression class**) inside a transaction run `SET LOCAL session_replication_role = replica` to bypass FK checks, insert a `user_role` row linking an org-A user to an org-B role, and assert `permissionKeysForUser` under org A still returns **none** of org B's permissions (query-level guard, independent of the FK). Roll back.
6. (integration) `seedDemoOrganization` with a foreign org that already owns a user `admin@demo.alsafahotels.test`: the foreign user is neither adopted nor linked to the demo SUPER_ADMIN role (existing test, must survive the refactor).
7. (integration) the registry coverage test fails when a new repository class is added without registry entries (demonstrated with a throwaway class inside the test).

**Verification commands:** `pnpm lint && pnpm typecheck && pnpm typecheck:types && pnpm test:unit && pnpm test:integration`.

**Acceptance criteria:** `git grep -l "drizzle-orm" server/services server/api server/domain server/utils shared` returns nothing (except `server/utils/db.ts`'s client import, allowed); every Phase 0 repository method has an isolation case; the architecture test and the lint rule both fail on a deliberate violation; existing suites unchanged in behavior.

**Commit boundary:** two commits — (1) `feat(security): branded org/hotel scopes and scoped query helpers` (files under `server/security`, `server/repositories/base`, types test, layering tooling); (2) `refactor: route all Phase 0 data access through tenant/platform repositories`.

---

### Task 5: API conventions — error model, DB error translation, handler wrapper, shared Zod schemas

**Objective:** One consistent way to validate input, fail, and report errors, before dozens of routes exist.

**Depends on:** 4, and **9** (`isValidIsoDate` — Task 9 must be merged first). **Parallelization:** sequential.

**Files:**
- Create: `server/errors/domainError.ts`, `server/errors/dbErrors.ts`, `server/utils/apiHandler.ts`, `shared/schemas/common.ts`
- Modify: `server/api/auth/login.post.ts` (uses the wrapper with `auth: 'none'`)
- Test: `tests/unit/server/domainError.test.ts`, `tests/unit/server/dbErrors.test.ts`, `tests/unit/shared/commonSchemas.test.ts`, `tests/integration/support/dbErrors.integration.test.ts`

**Interfaces — produced:**
```ts
// server/errors/domainError.ts
export class DomainError extends Error { constructor(readonly code: string, message: string, readonly httpStatus: number, readonly details?: unknown) }
export class ValidationError extends DomainError {}      // 422
export class NotFoundError extends DomainError {}        // 404
export class ForbiddenError extends DomainError {}       // 403
export class UnauthenticatedError extends DomainError {} // 401
export class ConflictError extends DomainError {}        // 409

// server/errors/dbErrors.ts
export interface PgErrorInfo { code: string, constraint?: string, table?: string, detail?: string }
export function extractPgError(err: unknown): PgErrorInfo | null      // unwraps Drizzle's `.cause` chain (max depth 4)
export const CONSTRAINT_MESSAGES: Record<string, { kind: 'conflict' | 'validation', code: string, message: string }>
export function translateDbError(err: unknown): DomainError | null    // null = not a known database error; caller rethrows

// server/utils/apiHandler.ts
export function defineApiHandler<P = unknown, Q = unknown, B = unknown, R = unknown>(opts: {
  params?: z.ZodType<P>, query?: z.ZodType<Q>, body?: z.ZodType<B>,
  auth?: 'none',                       // Task 7 adds 'required' → handler receives ctx: AuthContext
  handler: (args: { event: H3Event, params: P, query: Q, body: B }) => Promise<R>,
})
```
**Authorization:** none of its own — `defineApiHandler` gains `auth: 'required'` in Task 7.

**Error rendering:** every failure becomes `createError({ statusCode: e.httpStatus, statusMessage: e.message, data: { code: e.code, details: e.details } })`. Zod failures become `ValidationError('VALIDATION_FAILED', …, { issues })` (issues carry path + message only — never echo secrets). `translateDbError` is tried on every non-`DomainError`; unknown errors propagate as 500 with a generic message and the original logged.

**Generic mapping by SQLSTATE (before the per-constraint registry):** `23505` → `ConflictError('ALREADY_EXISTS')`; `23P01` → `ConflictError('RANGE_OVERLAP')`; `23503` → `ValidationError('INVALID_REFERENCE')`; `23514` → `ValidationError('CONSTRAINT_VIOLATION')`; `55000` (immutable audit) → treated as an internal error. **Each later schema task adds its own `CONSTRAINT_MESSAGES` entries** (e.g. `hotel_org_code_unique` → "A hotel with this code already exists") and a test proving the real database error translates.

**`shared/schemas/common.ts`:** `uuid`; `isoDate` (uses `isValidIsoDate`, so `2027-2-30`, `2027-02-30` and `2027-05-01T00:00` are rejected); `dateRange` (from ≤ to, length ≤ `MAX_CALENDAR_DAYS`); `pagination({ maxPageSize })` (coerces query strings, `page ≥ 1`, `1 ≤ pageSize ≤ max`); `safeText(max)` (NFC-normalizes, trims, rejects C0 control characters, enforces `max`); `uniqueIds(max)` (array of uuids, deduplicated, length ≤ `max`, non-empty when required).

**Tests to write first:**
1. (unit) each `DomainError` subclass carries the right status/code; `ValidationError` from Zod exposes `issues[].path` and `message` only.
2. (unit) `extractPgError` finds the code on a synthetic `DrizzleQueryError { cause: PostgresError-like }` **and** on a bare Postgres-like error; returns `null` for a plain `Error`; stops after depth 4 (no infinite loop on a cyclic `cause`).
3. (unit) `translateDbError` mapping for `23505`, `23P01`, `23503`, `23514`; unknown code → `null`.
4. (unit) `commonSchemas`: `isoDate` rejects `2027-2-30`, `2027-02-30`, `''`, `2027-05-01T00:00`, `0099-01-01`, accepts `2028-02-29`; `pagination` caps `pageSize` and rejects `0`/`-1`/`NaN`; `safeText` rejects a 300-character string when `max=200`, strips surrounding whitespace, rejects a NUL byte, accepts Arabic text (`فندق`) and emoji; `uniqueIds` dedupes and rejects an empty array when required and >max.
5. (integration) provoke **real** violations on Phase 0 tables and assert `translateDbError` result: duplicate org slug (`23505`, constraint `organization_slug_unique` → `ConflictError`), `app_user` with a non-existent org (`23503` → `ValidationError`). This is the test that pins "Drizzle wraps errors and the code is on `.cause`" (A1#8).
6. (unit/HTTP-less) `defineApiHandler` maps `ZodError` → 422, `NotFoundError` → 404, a raw `Error` → 500 without leaking its message. (Full HTTP proof arrives in Task 8.)

**Verification commands:** `pnpm test:unit && pnpm test:integration && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** login still works and its validation errors use the new shape; a database unique violation surfaces as a 409 with a stable `code`; no route hand-rolls `try/catch` for known domain/db errors.

**Commit boundary:** one commit — `feat: domain error model, db error translation, api handler wrapper, shared zod schemas`.

---

### Task 6: Hotel core schema, audit foundation, permission catalog (migration `0002`)

**Objective:** Create the `hotel` aggregate, per-hotel settings, hotel-scoped user access, the audit foundation (per-hotel history, immutable rows, a single writer), and the new permissions — everything the authorization layer in Task 7 needs to be real.

**Depends on:** 3, 4, 5. **Parallelization:** sequential (schema migration).

**Files:**
- Create: `db/schema/hotel.ts`, `db/migrations/0002_hotel_core.sql`, `shared/constants/audit.ts`, `server/repositories/tenant/{hotelRepository,userHotelAccessRepository}.ts`, `server/repositories/hotel/hotelSettingRepository.ts`, `server/services/audit.ts`
- Modify: `db/schema/tenancy.ts` (`app_user.all_hotels`), `db/schema/audit.ts`, `db/schema/index.ts`, `shared/constants/{permissions,roles}.ts`, `server/repositories/tenant/{userRepository,auditRepository}.ts`, `server/repositories/index.ts` (add `hotels`, `userHotelAccess`, `hotelRepos(db, hotelScope)`), `server/errors/dbErrors.ts` (registry entries), `db/seed/demo-org.ts` (demo admin `all_hotels = true`), `tests/integration/security/repositoryRegistry.ts`, `tests/support/fixtures.ts` (`makeHotel`, `makeUser({ allHotels, hotelIds })`)
- Test: `tests/integration/db/hotelCore.test.ts`, `tests/unit/shared/{permissions,roles}.test.ts` (update), `tests/unit/server/audit.test.ts`

**Schema (verified; applied and exercised on PostgreSQL 16):**

`db/schema/tenancy.ts` — `appUser` gains `allHotels: boolean('all_hotels').notNull().default(false),` next to `isActive`.

`db/schema/hotel.ts`
```ts
import { sql } from 'drizzle-orm'
import { check, foreignKey, index, jsonb, pgTable, primaryKey, text, time, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { appUser, organization } from './tenancy'

export const hotel = pgTable('hotel', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  city: text('city').notNull(),
  country: text('country').notNull().default('SA'),
  address: text('address'),
  phone: text('phone'),
  email: text('email'),
  timezone: text('timezone').notNull().default('Asia/Riyadh'),
  currency: text('currency').notNull().default('SAR'),
  checkInTime: time('check_in_time').notNull().default('15:00'),
  checkOutTime: time('check_out_time').notNull().default('12:00'),
  licenseReference: text('license_reference'),
  ownershipType: text('ownership_type').notNull().default('OWNED'),
  status: text('status').notNull().default('ACTIVE'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique('hotel_org_id_unique').on(t.organizationId, t.id),
  unique('hotel_org_code_unique').on(t.organizationId, t.code),
  check('hotel_status_check', sql`${t.status} in ('ACTIVE', 'INACTIVE')`),
  check('hotel_ownership_check', sql`${t.ownershipType} in ('OWNED', 'LEASED', 'CONTRACTED')`),
  check('hotel_currency_check', sql`char_length(${t.currency}) = 3`),
])

export const hotelSetting = pgTable('hotel_setting', {
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  hotelId: uuid('hotel_id').notNull(),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.hotelId, t.key] }),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'hotel_setting_hotel_fk' }),
])

export const userHotelAccess = pgTable('user_hotel_access', {
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  hotelId: uuid('hotel_id').notNull(),
  grantedBy: uuid('granted_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.userId, t.hotelId] }),
  foreignKey({ columns: [t.organizationId, t.userId], foreignColumns: [appUser.organizationId, appUser.id], name: 'user_hotel_access_user_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'user_hotel_access_hotel_fk' }),
  index('user_hotel_access_hotel_idx').on(t.organizationId, t.hotelId),
])
```

`db/schema/audit.ts` (full file after the change)
```ts
import { foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { hotel } from './hotel'
import { organization } from './tenancy'

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  hotelId: uuid('hotel_id'),
  actorUserId: uuid('actor_user_id'),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  action: text('action').notNull(),
  beforeData: jsonb('before_data'),
  afterData: jsonb('after_data'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'audit_log_hotel_fk' }),
  index('audit_log_org_hotel_time_idx').on(t.organizationId, t.hotelId, t.createdAt),
  index('audit_log_entity_idx').on(t.organizationId, t.entityType, t.entityId, t.createdAt),
])
```

**Migration `0002_hotel_core.sql`:** `pnpm db:generate --name hotel_core`, then **append** the raw SQL Drizzle cannot express (audit rows become immutable; `DELETE` stays allowed because organization cascade and `TRUNCATE` in tests must work):
```sql
CREATE FUNCTION audit_log_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log rows are immutable' USING ERRCODE = '55000';
END $$;--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_update();
```
Existing `audit_log` rows get `hotel_id = NULL` (organization-level entries); no backfill needed.

**Permission catalog:**
- `PERMISSIONS` gains `capacity.manage` ("Change base capacity and manage seasonal capacity periods and overrides"), `room.block` ("Create and cancel operational blocks, maintenance and out-of-service periods"), `audit.view` ("View the audit log for hotels the user can access"). Update `PERMISSION_DESCRIPTIONS`.
- New `DEMO_ONLY_PERMISSIONS = ['organization.resetDemo'] as const` (exported from `permissions.ts`).
- Roles: `SUPER_ADMIN` = every permission **except** the demo-only ones; `HOTEL_MANAGER` gains `capacity.manage`, `room.block`, `audit.view`; no other role changes.

Repositories export their row types (`HotelRow`, `UserHotelAccessRow`, `HotelSettingRow`) for services to use.

**Repositories (isolation-registry entries required for every method):**

| Class | Scope | Methods |
|---|---|---|
| `HotelRepository` | Org | `insert(values)`, `findById(id)`, `findByCode(code)`, `listByIds(ids)`, `listAll()`, `update(id, patch)` (patch type excludes `id`, `organizationId`, `code`), `setStatus(id, status)` |
| `UserHotelAccessRepository` | Org | `hotelIdsForUser(userId)`, `replaceForUser(userId, hotelIds, grantedBy)`, `userIdsForHotel(hotelId)` |
| `HotelSettingRepository` | Hotel | `getAll()`, `upsert(key, value)` |
| `UserRepository` (extend) | Org | `setAllHotels(userId, value)` |
| `AuditRepository` (extend) | Org | `record(entry)` now accepts `hotelId?: string \| null`; `listForHotel(hotelId, { entityType?, entityId?, action?, cursor?: { createdAt, id }, limit })` — keyset cursor ordered `created_at DESC, id DESC`, served by `audit_log_org_hotel_time_idx` / `audit_log_entity_idx`, returning each row with `actor: { id, fullName } \| null` from a left join to `app_user` **constrained to the same organization** (S3); `listOrganizationLevel({ … })` |

**Audit writer (`server/services/audit.ts`):**
```ts
export interface AuditEntry { hotelId?: string | null, entityType: string, entityId: string, action: AuditAction, before?: unknown, after?: unknown, reason?: string }
export async function recordAudit(audit: AuditRepository, actorUserId: string, entry: AuditEntry): Promise<void>
```
Redacts keys named `password`, `passwordHash`, `password_hash`, `token`, `secret` at any depth, converts `undefined` to `null`, JSON-round-trips values so Dates/BigInts cannot break the insert. `shared/constants/audit.ts` exports `AUDIT_ACTIONS` (`HOTEL_CREATED`, `HOTEL_UPDATED`, `HOTEL_DEACTIVATED`, `HOTEL_ACTIVATED`, `HOTEL_SETTINGS_CHANGED`, `USER_HOTEL_ACCESS_CHANGED`, `FLOOR_CREATED`, `FLOOR_UPDATED`, `ROOM_TYPE_CREATED`, `ROOM_TYPE_UPDATED`, `ROOM_CREATED`, `ROOM_UPDATED`, `ROOM_BASE_CHANGED`, `ROOM_RETIRED`, `ROOM_REACTIVATED`, `CAPACITY_PERIOD_CREATED`, `CAPACITY_PERIOD_UPDATED`, `CAPACITY_PERIOD_DELETED`, `CAPACITY_OVERRIDES_APPLIED`, `CAPACITY_OVERRIDE_DELETED`, `BLOCK_CREATED`, `BLOCK_CANCELLED`, `BLOCK_ENDED_EARLY`, `DOCUMENT_ADDED`, `DOCUMENT_ARCHIVED`, `DEMO_RESET`) as a `const` tuple with its union type.

**Domain rules:** hotel `code` is unique per organization and immutable after creation; `timezone` must be an IANA name (validated in Task 12's service, not the DB); `currency` is 3 letters; status is `ACTIVE`/`INACTIVE`; ownership `OWNED`/`LEASED`/`CONTRACTED`.

**API / authorization:** none in this task (repositories and schema only).

**Tests to write first:**
1. (integration) hotel `code` unique within an org, the same code allowed in another org; `status`, `ownership_type` and `currency` check constraints reject bad values (`23514`); real-error `translateDbError` mapping for `hotel_org_code_unique` → "A hotel with this code already exists".
2. (integration) composite-FK isolation: `hotel_setting`, `user_hotel_access` and `audit_log` rows pointing at another org's hotel are rejected (`23503`); `user_hotel_access` for another org's user is rejected.
3. (integration) audit immutability: `UPDATE audit_log` fails with SQLSTATE `55000`; `INSERT` works; `DELETE FROM organization` cascades the audit rows away; `truncateAllTables()` still works.
4. (integration) every FK column set added here has an index (query `pg_indexes`/`pg_constraint` and assert coverage — this is the guard that keeps demo-reset cascades fast).
5. (integration) **demo-reset cascade with hotel data:** an org with hotel + setting + access row + audit row is deleted with one `DELETE FROM organization`; everything is gone, another populated org is untouched.
6. (unit) `recordAudit` redaction (nested `passwordHash` removed, arrays handled, `undefined`→`null`, a `Date` survives).
7. (unit) permission/role catalogs: three new permissions exist with descriptions; `SUPER_ADMIN` equals the catalog minus `DEMO_ONLY_PERMISSIONS`; **no** role definition contains a demo-only permission; `HOTEL_MANAGER` has the three additions; the read-only role still has no mutating permission.
8. (integration) registry cases for `HotelRepository`, `UserHotelAccessRepository`, `HotelSettingRepository`, extended `UserRepository`/`AuditRepository` (org B cannot read/modify org A's hotels, access rows, settings or audit entries).

**Verification commands:** `pnpm db:generate --name hotel_core` (then append SQL), `pnpm db:check && pnpm db:drift && pnpm test:integration:fresh && pnpm test:unit && pnpm lint && pnpm typecheck && pnpm typecheck:types`.

**Acceptance criteria:** the database rejects every cross-org/cross-hotel link on the new tables; audit rows cannot be edited; `SUPER_ADMIN` no longer carries `organization.resetDemo`; all new repositories are covered by the isolation registry.

**Commit boundary:** one commit — `feat(db): hotel, hotel settings, user hotel access, per-hotel immutable audit, new permissions`.

---

### Task 7: Authorization foundation — per-request authz, hotel authorization, identity-only session, hotel access assignment

**Objective:** Authorization that is decided from the database on every request, hotel access that can only be exercised through a minted `HotelScope`, a session that carries identity and expires, and the first hotel-scoped admin operation (assigning a user's hotel access) with escalation rules.

**Depends on:** 4, 5, 6. **Parallelization:** sequential.

**Files:**
- Create: `server/security/{authContext,authorize}.ts`, `server/domain/rbac/authorize.ts`, `server/utils/requireAuth.ts`, `server/services/hotelAccessService.ts`, `server/services/sessionContextService.ts` (S1), `server/repositories/tenant/organizationRepository.ts` (S1, `TenantOrganizationRepository`), `server/api/users/[userId]/hotel-access.get.ts`, `server/api/users/[userId]/hotel-access.put.ts`, `shared/schemas/hotelAccess.ts`
- Modify: `server/services/auth.service.ts` (`authenticate` returns `{ user }` only), `server/api/auth/login.post.ts`, `server/api/auth/me.get.ts`, `server/api/admin/demo/reset.post.ts`, `server/types/auth.d.ts`, `server/utils/apiHandler.ts` (`auth: 'required'`), `server/utils/requirePermission.ts` (delete), `nuxt.config.ts`, `db/seed/rbac.ts`, `db/seed/demo-org.ts`, `.env.example`, `.env.test`
- Test: `tests/unit/domain/authorize.test.ts`, `tests/integration/security/{authContext,authorizeHotel,hotelAccessService,demoPrivilege}.test.ts`

**Interfaces — produced:**
```ts
// server/security/authContext.ts
export interface AuthIdentity { userId: string, organizationId: string, email: string, fullName: string }
export interface AuthContext { identity: AuthIdentity, authz: AuthorizationContext, scope: OrganizationScope, db: Database, now: () => Date }
/** null when the user does not exist in that organization, or is inactive. Never trusts a permission snapshot. */
export function resolveAuthContext(db: Database, identity: { userId: string, organizationId: string }, now?: () => Date): Promise<AuthContext | null>

// server/domain/rbac/authorize.ts   (pure; hasPermission stays for its existing tests)
export function orgCan(authz: AuthorizationContext, permission: Permission): boolean
export function hotelCan(authz: AuthorizationContext, permission: Permission, hotelId: string): boolean   // permission AND (allHotels OR hotelIds ∋ hotelId)
export function hasHotelAccess(authz: AuthorizationContext, hotelId: string): boolean

// server/security/authorize.ts
export function requireOrgPermission(ctx: AuthContext, permission: Permission): void      // ForbiddenError
export function requireAllHotels(ctx: AuthContext): void                                  // ForbiddenError
export interface AuthorizedHotel { scope: HotelScope, hotel: HotelRow }
export function authorizeHotel(ctx: AuthContext, permission: Permission, hotelId: string, opts?: { allowInactive?: boolean }): Promise<AuthorizedHotel>

// server/utils/requireAuth.ts  (Nitro auto-import)
export function requireAuthContext(event: H3Event): Promise<AuthContext>      // memoized on event.context.authContext
```

**`authorizeHotel` semantics (the rule that replaces the ambiguous optional `hotelId`):**
1. Load the hotel through `tenantRepos(ctx.db, ctx.scope).hotels.findById(hotelId)`. Not found in the caller's organization → `NotFoundError('HOTEL_NOT_FOUND')`.
2. No access to that hotel (`!hasHotelAccess`) → **the same** `NotFoundError('HOTEL_NOT_FOUND')` — a hotel-scoped user cannot enumerate hotels they do not work at.
3. Access but missing the permission → `ForbiddenError('FORBIDDEN')`.
4. `hotel.status === 'INACTIVE'` and `opts.allowInactive !== true` → `ConflictError('HOTEL_INACTIVE')`. Services pass `allowInactive: true` for reads and for the activate/edit-hotel operations.
5. Mint `trustedHotelScope(ctx.scope, hotel.id)` and return it with the hotel row.

**`resolveAuthContext`:** one query for the user by `(organization_id, id)` and `is_active = true` (`UserRepository.findById`), one for permission keys (`RoleRepository.permissionKeysForUser`, org-guarded), one for hotel ids (`UserHotelAccessRepository.hotelIdsForUser`). `authz = { permissions: Set, allHotels: user.allHotels, hotelIds: Set }`. Per request, not per process: nothing about authorization is cached across requests.

**Session:**
- `login.post.ts` stores `{ user: { id, organizationId, email, fullName }, loggedInAt }` only; `server/types/auth.d.ts` drops `permissions`, `allHotels`, `hotelIds`.
- `me.get.ts` returns `{ user, organization: { id, name, slug, isDemo }, roles: [{ key, name }], permissions, allHotels, hotelIds }` resolved fresh (S1). `organization` and `roles` come from `sessionContextService.getSessionContext(ctx)`, which uses two new org-scoped repository methods — `TenantOrganizationRepository.getOwn()` (reads only the scope's own organization row) and `RoleRepository.rolesForUser(userId)` (same org guard as `permissionKeysForUser`) — both added to the isolation registry. They run **only** for `me`, not in `resolveAuthContext`, so the per-request authorization cost stays at three queries.
- `nuxt.config.ts`: `runtimeConfig.session = { maxAge: 60 * 60 * 8, cookie: { httpOnly: true, sameSite: 'lax', secure: true } }`; `.env.example` and `.env.test` set `NUXT_SESSION_COOKIE_SECURE=false` for local/test (Node test clients cannot send `Secure` cookies over http). *(Ledger vs code: this lifetime was ruled in scope during Phase 0 but never implemented — A2.)*
- `requireAuthContext`: unsealed session → `resolveAuthContext` → on `null`, `clearUserSession(event)` and throw `UnauthenticatedError('SESSION_INVALID')`.
- `defineApiHandler({ auth: 'required', handler({ ctx, … }) })` passes the context.

**Least privilege for the demo reset:** `seedOrganizationRoles(db, orgId, options?: { extraPermissions?: Partial<Record<RoleKey, Permission[]>> })`; `seedDemoOrganization` passes `{ SUPER_ADMIN: ['organization.resetDemo'] }`. `reset.post.ts` uses `auth: 'required'` and `requireOrgPermission(ctx, 'organization.resetDemo')`; the service's demo-org membership check stays (second layer).

**Hotel access assignment — `hotelAccessService`:**
`getUserHotelAccess(ctx, userId): { allHotels, hotelIds }` and `setUserHotelAccess(ctx, userId, { allHotels, hotelIds })`, endpoints `GET|PUT /api/users/:userId/hotel-access`, permission `user.manage`. Rules, each with a test:
1. Caller lacks `user.manage` → 403.
2. Target user not in the caller's organization → 404 (indistinguishable from nonexistent).
3. `allHotels = true` with a non-empty `hotelIds` → 422 (ambiguous).
4. Any `hotelId` not in the caller's organization → 422 `INVALID_REFERENCE` (indistinguishable from nonexistent; never 404-vs-403 leakage through bodies).
5. Caller **without** `allHotels`: may grant only hotels in their own `hotelIds`; may not set `allHotels = true`; may not change their own access; may not modify a target who has `allHotels`. Violations → 403 `ESCALATION_DENIED`.
6. Caller **with** `allHotels`: unrestricted.
7. Replace is atomic (delete + insert in one transaction) and writes one `USER_HOTEL_ACCESS_CHANGED` audit row (`hotel_id` null) with before/after `{ allHotels, hotelIds }`; a failure rolls back both.
8. Response is the new `{ allHotels, hotelIds }`.

**Tests to write first:**
1. (unit) `orgCan`/`hotelCan`/`hasHotelAccess` truth table; `hotelCan` **requires** a hotel id (there is no optional parameter to forget).
2. (integration, `authContext`) resolves permissions from the user's own org roles, `allHotels`, hotel ids; inactive user → `null`; identity `{ userId: <org A user>, organizationId: <org B> }` → `null`; **revoking a role or a hotel-access row is visible on the very next resolve** (no snapshot); a deleted user → `null`; a cross-org `user_role` forced in via `session_replication_role = replica` grants nothing (Phase 0 regression class).
3. (integration, `authorizeHotel`) foreign-org hotel → `NotFoundError`; same-org hotel the user has no access to → the **same** `NotFoundError`; access but lacking permission → `ForbiddenError`; `allHotels` → any org hotel; inactive hotel: write → `ConflictError('HOTEL_INACTIVE')`, read (`allowInactive`) → ok; the returned scope's `hotelId` equals the hotel's.
4. (integration, `hotelAccessService`) one test per rule 1–8 above, including the escalation attempts (a hotel-scoped manager granting themselves `allHotels`, granting an unrelated hotel, editing their own row, downgrading an `allHotels` admin) and audit before/after content and rollback.
5. (integration, `demoPrivilege`) a fresh non-demo org's SUPER_ADMIN **lacks** `organization.resetDemo`; the demo org's SUPER_ADMIN has it; `resetDemoData` still works and still rejects a non-member.
6. (unit) `requireAuthContext` memoizes: two calls on one event resolve once (spy on the resolver).
7. HTTP proof of everything session/cookie-related is Task 8.
8. (integration, S1) `getSessionContext` returns the caller's own organization (`isDemo` true only for the demo organization) and role keys/names; a forced cross-org `user_role` row (as in test 2) never appears in `roles`; `TenantOrganizationRepository.getOwn` and `RoleRepository.rolesForUser` pass the isolation registry.

**Verification commands:** `pnpm test:unit && pnpm test:integration && pnpm lint && pnpm typecheck && pnpm typecheck:types && pnpm build`.

**Acceptance criteria:** no code reads permissions from the session; removing a user's hotel access takes effect on their next request; a hotel-scoped user cannot distinguish an inaccessible hotel from a missing one; the session expires after 8 hours; `git grep -n "hasPermission(" server/services server/api` returns nothing (services use `orgCan`/`hotelCan`/`authorizeHotel`).

**Commit boundary:** two commits — (1) `feat(security): per-request auth context, authorizeHotel, explicit orgCan/hotelCan`; (2) `feat: identity-only session with lifetime, hotel access assignment, demo-only resetDemo`.

---

### Task 8: HTTP test harness and authorization tests over real HTTP

**Objective:** Prove cookie, session and error-shape behavior end to end — the layer the service-level tests cannot see — so server authorization is never "verified by the UI".

**Depends on:** 5, 7. **Parallelization:** sequential (touches `package.json`, CI, `.env.test`).

**Design decision:** a *black-box* harness, not `@nuxt/test-utils`. A Vitest `globalSetup` runs `nuxt build` once (skippable with `HTTP_TEST_SKIP_BUILD=1`), starts `node .output/server/index.mjs` as a child process on a free port with the `.env.test` environment, waits for `GET /api/health`, and provides the base URL; teardown kills the process. This removes a dependency and version-coupling risk, tests the production artifact, and works because Task 7 made the server stateless with respect to authorization (tests can mutate the database directly and the next request sees it).

**Files:**
- Create: `vitest.http.config.ts`, `tests/http/support/{globalSetup,client,fixtures}.ts`, `tests/http/{auth,session,demoReset,errors}.http.test.ts`, `server/api/health.get.ts`
- Modify: `package.json` (`test:http`), `.github/workflows/ci.yml` (separate job `http`), `.env.test`, `README.md`

**API / authorization:** the only new endpoint is `GET /api/health`; every other test exercises Task 7's authorization rules over real HTTP.

**Interfaces — produced:**
```ts
// tests/http/support/client.ts
export function apiClient(baseUrl: string): {
  request(path: string, init?: { method?: string, body?: unknown, cookie?: string }): Promise<{ status: number, json: any, setCookie: string[] }>
  login(orgSlug: string, email: string, password: string): Promise<{ cookie: string, status: number, json: any }>
}
// server/api/health.get.ts
// → { status: 'ok', db: 'ok' } after `select 1`; 503 { status: 'degraded', db: 'down' } if the query fails (ARCHITECTURE §20)
```

**Tests to write first (each is an HTTP request against the built server; fixtures created through repositories in the test process):**
1. **Cookie hardening:** login response `Set-Cookie` contains `HttpOnly` and `SameSite=Lax`; has `Max-Age`/`Expires` within 60 s of 28,800; no `Secure` in the test environment (asserted explicitly, with the production requirement recorded in the deploy checklist, Task 21).
2. Login body contains the user and **no** `permissions`, `allHotels`, `hotelIds`.
3. `GET /api/auth/me` returns fresh authorization plus `organization { id, name, slug, isDemo }` and `roles` (S1); after the test deletes the user's `user_hotel_access` row (and separately flips `all_hotels`), the **next** `me` reflects it with the same cookie.
4. **Deactivating a user** (`is_active = false`) makes the next authenticated call return 401 and clears the cookie (session cannot outlive the account).
5. Protected route without a cookie → 401 with `data.code`; with a tampered cookie → 401.
6. **Login indistinguishability:** unknown organization, unknown email, wrong password → identical status, `statusMessage` and `data.code`.
7. Malformed login body → 422 `VALIDATION_FAILED` with `issues[].path`, and **no** echo of the submitted password.
8. **Demo reset:** another organization's Super Admin → 403 (they no longer hold the permission); a demo member without the permission → 403; the demo admin → 200 and an audit row exists.
9. `GET /api/health` → 200 `{ status: 'ok' }`; unknown route → 404 in the standard error shape.
10. Error shape: every non-2xx response in this suite has `statusCode`, `statusMessage` and `data.code`.

**Decision gate (recorded, not silent):** if `pnpm test:http` takes longer than **4 minutes** in CI (build included) or is flaky across three consecutive runs, stop and report — options are caching the build, running HTTP tests only on `main`/nightly, or reducing scope. Do not weaken the assertions to make it pass.

**Verification commands:** `pnpm test:http` (local), then push a branch and confirm the CI `http` job.

**Acceptance criteria:** the ten HTTP tests pass locally and in CI; the harness leaves no orphan server process (`lsof -i` clean after a run); all later tasks' endpoint tests add cases to `tests/http/`.

**Commit boundary:** one commit — `test: black-box HTTP harness and session/authorization tests`.

---

### Task 9: Domain — night ranges, ISO dates, hotel-local time, inventory constants (pure)

**Objective:** The single place where dates are parsed, validated, added and compared, and where "today" is computed in a hotel's own timezone. Everything temporal in Phase 1 (and Phase 2 stays, checkouts, holds) is built on it.

**Depends on:** none. **Parallelization:** **safe to run in parallel** with Tasks 1–8 (creates new files only; no shared files). It **must be merged before Task 5** (the `isoDate` Zod schema uses `isValidIsoDate`).

**Files:**
- Create: `shared/utils/dates.ts`, `shared/constants/inventory.ts`, `tests/unit/shared/dates.test.ts`

**Database / API / authorization:** none.

**Domain rules (encoded and tested):**
- ISO dates are valid only if they are real calendar dates between 1900 and 2200 (`2027-02-29`, `2027-13-01`, `2027-5-1`, `0099-01-01`, `2027-05-01T00:00` are invalid).
- A **night range** `{ from, to }` is inclusive at both ends; `from ≤ to`; a single night is valid.
- Adjacent ranges (`…-10`, `…-11`) do not overlap; ranges sharing one night do.
- A stay `[checkIn, checkOut)` occupies nights `checkIn … checkOut-1`; `checkOut ≤ checkIn` is invalid; same-day turnover is not a conflict.
- Day arithmetic is done on epoch days (UTC, no local-time getters), correct across month, year and leap boundaries (`2028-02-29`).
- `todayInTimezone(tz, now)` returns the calendar date in that IANA timezone: at `2027-05-01T22:30:00Z` it is `2027-05-02` in `Asia/Riyadh` but `2027-05-01` in `UTC`.
- `eachDate` refuses ranges longer than its cap (default 1000) — a 100-year range cannot become a 36,500-element array.

**Verified implementation** (26 tests passing, strict `tsc` clean):

`shared/utils/dates.ts`
```ts
export type IsoDate = string

export class InvalidDateError extends Error {
  constructor(value: string) {
    super(`Invalid ISO date: ${value}`)
    this.name = 'InvalidDateError'
  }
}
export class InvalidRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRangeError'
  }
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const MIN_YEAR = 1900
const MAX_YEAR = 2200
const MS_PER_DAY = 86_400_000

export function isValidIsoDate(value: string): boolean {
  const m = ISO.exec(value)
  if (!m) return false
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (y < MIN_YEAR || y > MAX_YEAR) return false
  const t = new Date(0)
  t.setUTCFullYear(y, mo - 1, d)
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

export function toEpochDay(date: IsoDate): number {
  if (!isValidIsoDate(date)) throw new InvalidDateError(date)
  const m = ISO.exec(date)!
  const t = new Date(0)
  t.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Math.round(t.getTime() / MS_PER_DAY)
}

export function fromEpochDay(day: number): IsoDate {
  const t = new Date(day * MS_PER_DAY)
  const y = String(t.getUTCFullYear()).padStart(4, '0')
  const mo = String(t.getUTCMonth() + 1).padStart(2, '0')
  const d = String(t.getUTCDate()).padStart(2, '0')
  return `${y}-${mo}-${d}`
}

export function addDays(date: IsoDate, n: number): IsoDate {
  return fromEpochDay(toEpochDay(date) + n)
}

/** Inclusive first and last NIGHT of a range (a night is identified by the date it starts). */
export interface NightRange { from: IsoDate, to: IsoDate }

export function makeRange(from: IsoDate, to: IsoDate): NightRange {
  if (toEpochDay(to) < toEpochDay(from)) throw new InvalidRangeError(`Range end ${to} is before start ${from}`)
  return { from, to }
}

export function rangeLength(r: NightRange): number {
  return toEpochDay(r.to) - toEpochDay(r.from) + 1
}

export function containsDate(r: NightRange, d: IsoDate): boolean {
  const e = toEpochDay(d)
  return e >= toEpochDay(r.from) && e <= toEpochDay(r.to)
}

export function rangesOverlap(a: NightRange, b: NightRange): boolean {
  return toEpochDay(a.from) <= toEpochDay(b.to) && toEpochDay(b.from) <= toEpochDay(a.to)
}

export function intersect(a: NightRange, b: NightRange): NightRange | null {
  if (!rangesOverlap(a, b)) return null
  const from = toEpochDay(a.from) >= toEpochDay(b.from) ? a.from : b.from
  const to = toEpochDay(a.to) <= toEpochDay(b.to) ? a.to : b.to
  return { from, to }
}

/** A stay [checkIn, checkOut) occupies the nights checkIn .. checkOut-1. */
export function rangeFromStay(checkIn: IsoDate, checkOut: IsoDate): NightRange {
  if (toEpochDay(checkOut) <= toEpochDay(checkIn)) throw new InvalidRangeError('checkOut must be after checkIn')
  return { from: checkIn, to: addDays(checkOut, -1) }
}

export function eachDate(r: NightRange, maxDays = 1000): IsoDate[] {
  const len = rangeLength(r)
  if (len > maxDays) throw new InvalidRangeError(`Range of ${len} days exceeds the maximum of ${maxDays}`)
  const start = toEpochDay(r.from)
  return Array.from({ length: len }, (_, i) => fromEpochDay(start + i))
}

/** Today's calendar date in a hotel's IANA timezone (never the server's or browser's). */
export function todayInTimezone(timezone: string, now: Date): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
    return true
  }
  catch {
    return false
  }
}
```

`shared/constants/inventory.ts`
```ts
/** Lower index = higher display precedence. Phase 2 slots OCCUPIED/BOOKED/HELD in without a schema change. */
export const INVENTORY_STATUSES = ['NOT_IN_INVENTORY', 'OUT_OF_SERVICE', 'MAINTENANCE', 'OPERATIONAL_BLOCK', 'OCCUPIED', 'BOOKED', 'HELD', 'AVAILABLE'] as const
export type InventoryStatus = typeof INVENTORY_STATUSES[number]

/** Operational block kinds, highest display precedence first. */
export const BLOCK_KINDS = ['OUT_OF_SERVICE', 'MAINTENANCE', 'OPERATIONAL_BLOCK'] as const
export type BlockKind = typeof BLOCK_KINDS[number]

export const CAPACITY_PERIOD_KINDS = ['HAJJ', 'RAMADAN', 'SPECIAL'] as const
export type CapacityPeriodKind = typeof CAPACITY_PERIOD_KINDS[number]

export const HOTEL_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type HotelStatus = typeof HOTEL_STATUSES[number]
export const OWNERSHIP_TYPES = ['OWNED', 'LEASED', 'CONTRACTED'] as const
export const BASE_CONFIG_ORIGINS = ['ROOM_TYPE_DEFAULT', 'MANUAL', 'BULK', 'SEED'] as const

/** Hard limits that bound every list/range endpoint (DoS guards). */
export const MAX_CALENDAR_DAYS = 400
export const MAX_ROOMS_PER_PAGE = 200
export const MAX_BEDS_PER_ROOM = 30
export const MAX_CAPACITY_PERIOD_DAYS = 366
export const MAX_BULK_ROOMS = 200
```

**Tests (write first — these are the verified tests; expected RED before the module exists):**

`tests/unit/shared/dates.test.ts`
```ts
import { describe, expect, it } from 'vitest'
import { addDays, containsDate, eachDate, intersect, isValidIsoDate, isValidTimezone, makeRange, rangeFromStay, rangeLength, rangesOverlap, todayInTimezone, toEpochDay, fromEpochDay, InvalidRangeError } from '../../../shared/utils/dates'

describe('isValidIsoDate', () => {
  it.each(['2027-05-01', '2028-02-29', '1900-01-01'])('accepts %s', d => expect(isValidIsoDate(d)).toBe(true))
  it.each(['2027-02-29', '2027-13-01', '2027-00-10', '2027-5-1', '27-05-01', '2027-05-01T00:00', '', '0099-01-01', '2027-04-31'])('rejects %s', d => expect(isValidIsoDate(d)).toBe(false))
})
describe('epoch day arithmetic', () => {
  it('round-trips', () => { expect(fromEpochDay(toEpochDay('2028-02-29'))).toBe('2028-02-29') })
  it('adds across month/year/leap boundaries', () => {
    expect(addDays('2027-07-31', 1)).toBe('2027-08-01')
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28')
  })
})
describe('ranges are inclusive on both ends', () => {
  const hajj = makeRange('2027-05-01', '2027-07-31')
  it('length counts both endpoints', () => { expect(rangeLength(hajj)).toBe(92) })
  it('contains first and last night but not the neighbours', () => {
    expect(containsDate(hajj, '2027-05-01')).toBe(true)
    expect(containsDate(hajj, '2027-07-31')).toBe(true)
    expect(containsDate(hajj, '2027-04-30')).toBe(false)
    expect(containsDate(hajj, '2027-08-01')).toBe(false)
  })
  it('adjacent ranges do not overlap; sharing one night does', () => {
    expect(rangesOverlap(makeRange('2027-05-01', '2027-05-10'), makeRange('2027-05-11', '2027-05-20'))).toBe(false)
    expect(rangesOverlap(makeRange('2027-05-01', '2027-05-10'), makeRange('2027-05-10', '2027-05-20'))).toBe(true)
  })
  it('intersects', () => {
    expect(intersect(makeRange('2027-05-01', '2027-05-10'), makeRange('2027-05-05', '2027-05-20'))).toEqual({ from: '2027-05-05', to: '2027-05-10' })
    expect(intersect(makeRange('2027-05-01', '2027-05-04'), makeRange('2027-05-05', '2027-05-20'))).toBeNull()
  })
  it('rejects reversed ranges and invalid dates', () => {
    expect(() => makeRange('2027-05-02', '2027-05-01')).toThrow(InvalidRangeError)
    expect(() => makeRange('2027-02-30', '2027-03-01')).toThrow()
  })
  it('a single-night range is valid', () => { expect(rangeLength(makeRange('2027-05-01', '2027-05-01'))).toBe(1) })
})
describe('stays', () => {
  it('a stay [checkIn, checkOut) occupies checkOut-1 as last night (same-day turnover is not a conflict)', () => {
    const s = rangeFromStay('2027-05-01', '2027-05-04')
    expect(s).toEqual({ from: '2027-05-01', to: '2027-05-03' })
    expect(rangesOverlap(s, rangeFromStay('2027-05-04', '2027-05-06'))).toBe(false)
  })
  it('rejects zero/negative length stays', () => {
    expect(() => rangeFromStay('2027-05-01', '2027-05-01')).toThrow(InvalidRangeError)
  })
})
describe('eachDate', () => {
  it('lists dates', () => { expect(eachDate(makeRange('2028-02-28', '2028-03-01'))).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']) })
  it('refuses oversized ranges (DoS guard)', () => { expect(() => eachDate(makeRange('2000-01-01', '2100-01-01'))).toThrow(InvalidRangeError) })
})
describe('hotel-local today', () => {
  it('uses the hotel timezone, not UTC', () => {
    const t = new Date('2027-05-01T22:30:00Z') // 01:30 on 2 May in Riyadh (UTC+3), still 1 May in UTC
    expect(todayInTimezone('Asia/Riyadh', t)).toBe('2027-05-02')
    expect(todayInTimezone('UTC', t)).toBe('2027-05-01')
    expect(todayInTimezone('America/Los_Angeles', t)).toBe('2027-05-01')
  })
  it('validates timezone names', () => {
    expect(isValidTimezone('Asia/Riyadh')).toBe(true)
    expect(isValidTimezone('Mars/Olympus')).toBe(false)
  })
})
```

**Verification commands:** `pnpm test:unit && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** 26 date tests pass; no other file in the repo parses a date string with `new Date(string)` (a fitness test in `tests/unit/architecture/` — added here — fails if `new Date('…')`, ``new Date(`…`)`` or `Date.parse(` appears in `server/` or `shared/` outside `shared/utils/dates.ts`; `new Date()` and `new Date(<number>)` remain allowed).

**Commit boundary:** one commit — `feat(domain): iso dates, night ranges, hotel-local time, inventory constants`.

---

### Task 10: Domain — effective capacity and hotel averages (pure)

**Objective:** The exact, tested definition of "what is this room's capacity on this night" and of the hotel averages users must never maintain by hand.

**Depends on:** 9. **Parallelization:** safe to run in parallel with Tasks 1–8 and with Task 11 (disjoint files), after Task 9 is merged.

**Files:**
- Create: `server/domain/inventory/capacity.ts`, `server/domain/inventory/averages.ts`, `tests/unit/domain/inventory/capacity.test.ts`

**Database / API / authorization:** none.

**Domain rules:**
1. **Effective capacity(room, night)** = the period override covering the night, else the base version covering the night, else **`null` — the room is not in inventory that night**, even if an override row exists.
2. Physical beds and sellable capacity are independent numbers everywhere; sellable may differ from beds.
3. A permanent base change never rewrites history: a room's 2025 nights still resolve against the 2025 version after a 2026 version starts.
4. Gaps between base versions (temporary exclusion) and nights after the last closed version are "not in inventory".
5. Hotel averages return `{ numerator, denominator, value, display, basis }`; **a zero denominator yields `value: null, display: null`** — never `0`, `NaN`, `Infinity`.
6. Display rounding is half-up to two decimals using integer arithmetic (`310/80 = 3.875 → "3.88"`, `1/8 → "0.13"`, `3/8 → "0.38"`).
7. **Base Hotel Average** ignores seasonal overrides; **Date-Effective Hotel Average** includes them; both ignore operational blocks. **Range average** is weighted by room-nights. All-hotel results are weighted sums (`combineAverages`), never an average of averages; mixing bases throws.
8. `minSellableOverStay` returns the lowest sellable capacity across a stay, or `null` if any night is outside inventory (ARCHITECTURE §2.8: a stay spanning a capacity boundary uses the minimum).

**Verified implementation:**

`server/domain/inventory/capacity.ts`
```ts
import { type IsoDate, type NightRange, containsDate, fromEpochDay, rangeLength, toEpochDay } from '../../../shared/utils/dates'

export interface BaseVersion { validFrom: IsoDate, validTo: IsoDate | null, physicalBeds: number, sellableCapacity: number }
export interface CapacityOverride { periodId: string, validFrom: IsoDate, validTo: IsoDate, physicalBeds: number, sellableCapacity: number }
export type CapacitySource = 'BASE' | 'PERIOD_OVERRIDE'
export interface EffectiveCapacity { physicalBeds: number, sellableCapacity: number, source: CapacitySource, periodId: string | null }
export interface CapacitySegment extends NightRange, EffectiveCapacity {}

function baseCovers(v: BaseVersion, date: IsoDate): boolean {
  const e = toEpochDay(date)
  return toEpochDay(v.validFrom) <= e && (v.validTo === null || e <= toEpochDay(v.validTo))
}

export function baseAt(versions: BaseVersion[], date: IsoDate): BaseVersion | null {
  return versions.find(v => baseCovers(v, date)) ?? null
}

export function overrideAt(overrides: CapacityOverride[], date: IsoDate): CapacityOverride | null {
  return overrides.find(o => containsDate({ from: o.validFrom, to: o.validTo }, date)) ?? null
}

/** Base configuration only (ignores seasonal overrides). null = room is not in inventory that night. */
export function baseCapacityAt(versions: BaseVersion[], date: IsoDate): { physicalBeds: number, sellableCapacity: number } | null {
  const b = baseAt(versions, date)
  return b ? { physicalBeds: b.physicalBeds, sellableCapacity: b.sellableCapacity } : null
}

/**
 * Effective capacity on a night: a period override wins over the base version;
 * with no base version covering the night the room is not in inventory (null),
 * even if an override row exists.
 */
export function effectiveCapacityAt(versions: BaseVersion[], overrides: CapacityOverride[], date: IsoDate): EffectiveCapacity | null {
  const base = baseAt(versions, date)
  if (!base) return null
  const o = overrideAt(overrides, date)
  if (o) return { physicalBeds: o.physicalBeds, sellableCapacity: o.sellableCapacity, source: 'PERIOD_OVERRIDE', periodId: o.periodId }
  return { physicalBeds: base.physicalBeds, sellableCapacity: base.sellableCapacity, source: 'BASE', periodId: null }
}

export interface Interval { from: IsoDate, to: IsoDate | null }

/** Epoch-day boundaries inside `range` at which any interval starts or (the day after it) ends. */
export function cutPoints(range: NightRange, intervals: Interval[]): number[] {
  const start = toEpochDay(range.from)
  const end = toEpochDay(range.to)
  const cuts = new Set<number>([start])
  for (const i of intervals) {
    const s = toEpochDay(i.from)
    if (s > start && s <= end) cuts.add(s)
    if (i.to !== null) {
      const after = toEpochDay(i.to) + 1
      if (after > start && after <= end) cuts.add(after)
    }
  }
  return [...cuts].sort((a, b) => a - b)
}

const sameCapacity = (a: EffectiveCapacity, b: EffectiveCapacity) =>
  a.physicalBeds === b.physicalBeds && a.sellableCapacity === b.sellableCapacity && a.source === b.source && a.periodId === b.periodId

/** Run-length-encoded effective capacity over `range`; nights where the room is not in inventory produce no segment. */
export function capacitySegments(versions: BaseVersion[], overrides: CapacityOverride[], range: NightRange): CapacitySegment[] {
  const points = cutPoints(range, [
    ...versions.map(v => ({ from: v.validFrom, to: v.validTo })),
    ...overrides.map(o => ({ from: o.validFrom, to: o.validTo })),
  ])
  const end = toEpochDay(range.to)
  const out: CapacitySegment[] = []
  points.forEach((s, i) => {
    const e = (points[i + 1] ?? end + 1) - 1
    const cap = effectiveCapacityAt(versions, overrides, fromEpochDay(s))
    if (!cap) return
    const last = out[out.length - 1]
    if (last && toEpochDay(last.to) + 1 === s && sameCapacity(last, cap)) last.to = fromEpochDay(e)
    else out.push({ from: fromEpochDay(s), to: fromEpochDay(e), ...cap })
  })
  return out
}

/** Lowest sellable capacity over every night of a stay; null if the room is not in inventory for the whole stay. */
export function minSellableOverStay(versions: BaseVersion[], overrides: CapacityOverride[], stay: NightRange): number | null {
  const segs = capacitySegments(versions, overrides, stay)
  if (segs.reduce((n, s) => n + rangeLength(s), 0) !== rangeLength(stay)) return null
  return Math.min(...segs.map(s => s.sellableCapacity))
}

/** Pairs of ranges that overlap — used by services to give a friendly error before the DB exclusion constraint fires. */
export function findOverlaps<T extends NightRange>(ranges: T[]): Array<[T, T]> {
  const sorted = [...ranges].sort((a, b) => toEpochDay(a.from) - toEpochDay(b.from))
  const out: Array<[T, T]> = []
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (toEpochDay(sorted[j]!.from) > toEpochDay(sorted[i]!.to)) break
      out.push([sorted[i]!, sorted[j]!])
    }
  }
  return out
}
```

`server/domain/inventory/averages.ts`
```ts
import { type IsoDate, type NightRange, rangeLength } from '../../../shared/utils/dates'
import { type BaseVersion, type CapacityOverride, baseCapacityAt, capacitySegments, effectiveCapacityAt } from './capacity'

export interface RoomCapacityInput { roomId: string, versions: BaseVersion[], overrides: CapacityOverride[] }

export interface AverageResult {
  numerator: number
  denominator: number
  /** null when the denominator is 0 — never 0, NaN or Infinity. */
  value: number | null
  /** Half-up rounded to 2 decimals for display only; null when undefined. */
  display: string | null
  basis: 'ROOMS' | 'ROOM_NIGHTS'
}

/** Half-up decimal formatting of n/d with integer arithmetic only (no float rounding surprises). */
export function formatRatio(n: number, d: number, decimals = 2): string | null {
  if (d === 0) return null
  const scale = 10 ** decimals
  const a = n * scale * 2 + d
  const b = 2 * d
  const scaled = (a - (a % b)) / b
  const whole = Math.floor(scaled / scale)
  const frac = String(scaled % scale).padStart(decimals, '0')
  return `${whole}.${frac}`
}

export function makeAverage(numerator: number, denominator: number, basis: AverageResult['basis']): AverageResult {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator, display: formatRatio(numerator, denominator), basis }
}

/** Base Hotel Average on a date: sum of BASE sellable capacity / rooms in inventory (seasonal overrides ignored). */
export function baseHotelAverage(rooms: RoomCapacityInput[], date: IsoDate): AverageResult {
  let cap = 0
  let n = 0
  for (const r of rooms) {
    const b = baseCapacityAt(r.versions, date)
    if (b) { cap += b.sellableCapacity; n += 1 }
  }
  return makeAverage(cap, n, 'ROOMS')
}

/** Date-Effective Hotel Average: sum of EFFECTIVE sellable capacity / rooms in inventory on that date (operational blocks ignored). */
export function dateEffectiveHotelAverage(rooms: RoomCapacityInput[], date: IsoDate): AverageResult {
  let cap = 0
  let n = 0
  for (const r of rooms) {
    const e = effectiveCapacityAt(r.versions, r.overrides, date)
    if (e) { cap += e.sellableCapacity; n += 1 }
  }
  return makeAverage(cap, n, 'ROOMS')
}

/** Range average, weighted by room-nights: sum(capacity x nights) / sum(nights in inventory). */
export function rangeEffectiveAverage(rooms: RoomCapacityInput[], range: NightRange): AverageResult {
  let capNights = 0
  let roomNights = 0
  for (const r of rooms) {
    for (const s of capacitySegments(r.versions, r.overrides, range)) {
      const len = rangeLength(s)
      capNights += s.sellableCapacity * len
      roomNights += len
    }
  }
  return makeAverage(capNights, roomNights, 'ROOM_NIGHTS')
}

/** Weighted combination (e.g. all hotels): sums numerators and denominators; never averages averages. */
export function combineAverages(results: AverageResult[]): AverageResult {
  if (results.length === 0) return makeAverage(0, 0, 'ROOMS')
  const basis = results[0]!.basis
  if (results.some(r => r.basis !== basis)) throw new Error('Cannot combine averages with different bases')
  return makeAverage(results.reduce((s, r) => s + r.numerator, 0), results.reduce((s, r) => s + r.denominator, 0), basis)
}
```

**Tests (write first; verified — 26 cases here; Tasks 9–11 together have 67):**

`tests/unit/domain/inventory/capacity.test.ts`
```ts
import { describe, expect, it } from 'vitest'
import { capacitySegments, effectiveCapacityAt, findOverlaps, minSellableOverStay, type BaseVersion, type CapacityOverride } from '../../../../server/domain/inventory/capacity'
import { baseHotelAverage, combineAverages, dateEffectiveHotelAverage, formatRatio, makeAverage, rangeEffectiveAverage, type RoomCapacityInput } from '../../../../server/domain/inventory/averages'
import { makeRange } from '../../../../shared/utils/dates'

const base44: BaseVersion[] = [{ validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }]
const hajj2027 = (beds = 6, sellable = 6): CapacityOverride => ({ periodId: 'hajj-2027', validFrom: '2027-05-01', validTo: '2027-07-31', physicalBeds: beds, sellableCapacity: sellable })

describe('Room 401 example from the requirements', () => {
  it('is 4/4 normally, 6/6 during Hajj 2027, and returns to 4/4 automatically afterwards', () => {
    const o = [hajj2027()]
    expect(effectiveCapacityAt(base44, o, '2027-04-30')).toMatchObject({ physicalBeds: 4, sellableCapacity: 4, source: 'BASE' })
    expect(effectiveCapacityAt(base44, o, '2027-05-01')).toMatchObject({ physicalBeds: 6, sellableCapacity: 6, source: 'PERIOD_OVERRIDE', periodId: 'hajj-2027' })
    expect(effectiveCapacityAt(base44, o, '2027-07-31')).toMatchObject({ sellableCapacity: 6 })
    expect(effectiveCapacityAt(base44, o, '2027-08-01')).toMatchObject({ physicalBeds: 4, sellableCapacity: 4, source: 'BASE' })
  })
  it('does not conflate physical beds with sellable capacity', () => {
    expect(effectiveCapacityAt(base44, [hajj2027(6, 5)], '2027-06-01')).toMatchObject({ physicalBeds: 6, sellableCapacity: 5 })
  })
  it('run-length segments show the three regimes', () => {
    const segs = capacitySegments(base44, [hajj2027()], makeRange('2027-04-01', '2027-08-31'))
    expect(segs.map(s => [s.from, s.to, s.sellableCapacity, s.source])).toEqual([
      ['2027-04-01', '2027-04-30', 4, 'BASE'],
      ['2027-05-01', '2027-07-31', 6, 'PERIOD_OVERRIDE'],
      ['2027-08-01', '2027-08-31', 4, 'BASE'],
    ])
  })
  it('historical periods stay queryable after they end', () => {
    const past = { ...hajj2027(), periodId: 'hajj-2026', validFrom: '2026-05-01', validTo: '2026-07-31' }
    expect(effectiveCapacityAt(base44, [past, hajj2027()], '2026-06-15')).toMatchObject({ sellableCapacity: 6, periodId: 'hajj-2026' })
    expect(effectiveCapacityAt(base44, [past, hajj2027()], '2026-09-15')).toMatchObject({ sellableCapacity: 4, source: 'BASE' })
  })
})

describe('versioned base configuration', () => {
  const versions: BaseVersion[] = [
    { validFrom: '2025-01-01', validTo: '2026-05-31', physicalBeds: 4, sellableCapacity: 4 },
    { validFrom: '2026-06-01', validTo: null, physicalBeds: 5, sellableCapacity: 5 },
  ]
  it('a permanent base change does not rewrite history', () => {
    expect(effectiveCapacityAt(versions, [], '2026-05-31')!.sellableCapacity).toBe(4)
    expect(effectiveCapacityAt(versions, [], '2026-06-01')!.sellableCapacity).toBe(5)
  })
  it('a room is not in inventory before its first version, in a gap, or after retirement', () => {
    const gappy: BaseVersion[] = [
      { validFrom: '2025-01-01', validTo: '2026-01-31', physicalBeds: 4, sellableCapacity: 4 },
      { validFrom: '2026-03-01', validTo: '2026-12-31', physicalBeds: 4, sellableCapacity: 4 },
    ]
    expect(effectiveCapacityAt(gappy, [], '2024-12-31')).toBeNull()
    expect(effectiveCapacityAt(gappy, [], '2026-02-15')).toBeNull()
    expect(effectiveCapacityAt(gappy, [], '2027-01-01')).toBeNull()
  })
  it('an override on a night without a base version is ignored (room not in inventory)', () => {
    expect(effectiveCapacityAt([], [hajj2027()], '2027-06-01')).toBeNull()
  })
  it('segments skip nights not in inventory', () => {
    const gappy: BaseVersion[] = [{ validFrom: '2027-05-10', validTo: '2027-05-20', physicalBeds: 3, sellableCapacity: 3 }]
    expect(capacitySegments(gappy, [], makeRange('2027-05-01', '2027-05-31'))).toEqual([
      { from: '2027-05-10', to: '2027-05-20', physicalBeds: 3, sellableCapacity: 3, source: 'BASE', periodId: null },
    ])
  })
})

describe('minSellableOverStay (a stay spanning a capacity boundary)', () => {
  it('uses the minimum across all nights', () => {
    expect(minSellableOverStay(base44, [hajj2027()], makeRange('2027-04-29', '2027-05-03'))).toBe(4)
    expect(minSellableOverStay(base44, [hajj2027()], makeRange('2027-05-02', '2027-05-05'))).toBe(6)
  })
  it('is null when any night is outside inventory', () => {
    expect(minSellableOverStay([{ ...base44[0]!, validFrom: '2027-05-03' }], [], makeRange('2027-05-01', '2027-05-05'))).toBeNull()
  })
})

describe('findOverlaps', () => {
  it('finds overlapping ranges and treats adjacent ranges as fine', () => {
    expect(findOverlaps([makeRange('2027-01-01', '2027-01-10'), makeRange('2027-01-11', '2027-01-20')])).toEqual([])
    expect(findOverlaps([makeRange('2027-01-01', '2027-01-10'), makeRange('2027-01-10', '2027-01-20')])).toHaveLength(1)
  })
})

function hotel(spec: Array<[count: number, beds: number]>, overridden: number, upliftTo?: number): RoomCapacityInput[] {
  const rooms: RoomCapacityInput[] = []
  let idx = 0
  for (const [count, beds] of spec) {
    for (let i = 0; i < count; i++) {
      const versions: BaseVersion[] = [{ validFrom: '2025-01-01', validTo: null, physicalBeds: beds, sellableCapacity: beds }]
      const overrides: CapacityOverride[] = idx < overridden && upliftTo ? [hajj2027(upliftTo, upliftTo)] : []
      rooms.push({ roomId: `r${idx++}`, versions, overrides })
    }
  }
  return rooms
}

describe('automatic hotel averages', () => {
  // 25 triples + 40 quads + 15 quints = 80 rooms, capacity 75 + 160 + 75 = 310
  const ajyad = hotel([[25, 3], [40, 4], [15, 5]], 0)
  it('310 capacity over 80 rooms is 3.875 and displays as 3.88 (half-up)', () => {
    const r = baseHotelAverage(ajyad, '2026-10-01')
    expect(r).toMatchObject({ numerator: 310, denominator: 80, value: 3.875, display: '3.88', basis: 'ROOMS' })
  })
  it('the date-effective average follows seasonal overrides and reverts after the period', () => {
    const rooms = hotel([[25, 3], [40, 4], [15, 5]], 30, 6) // 30 rooms go to 6 during Hajj
    // first 25 rooms are triples (3->6 = +3 each), next 5 are quads (4->6 = +2 each): +75 +10
    expect(dateEffectiveHotelAverage(rooms, '2027-06-01')).toMatchObject({ numerator: 310 + 75 + 10, denominator: 80 })
    expect(baseHotelAverage(rooms, '2027-06-01').numerator).toBe(310)
    expect(dateEffectiveHotelAverage(rooms, '2027-08-01').numerator).toBe(310)
  })
  it('a hotel with no rooms in inventory has an undefined average, not 0 or NaN', () => {
    expect(baseHotelAverage([], '2026-10-01')).toMatchObject({ value: null, display: null, denominator: 0 })
    expect(dateEffectiveHotelAverage(ajyad, '2020-01-01')).toMatchObject({ value: null, display: null })
  })
  it('range average is weighted by room-nights (straddling the period boundary)', () => {
    const rooms = hotel([[2, 4]], 2, 6)
    // nights Jul 30, 31 at 6, Aug 1, 2 at 4, for both rooms: (6+6+4+4)*2 / (4*2)
    const r = rangeEffectiveAverage(rooms, makeRange('2027-07-30', '2027-08-02'))
    expect(r).toMatchObject({ numerator: 40, denominator: 8, value: 5, basis: 'ROOM_NIGHTS' })
  })
  it('rooms that join mid-range only count for their own nights', () => {
    const rooms: RoomCapacityInput[] = [
      { roomId: 'a', versions: [{ validFrom: '2027-05-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }], overrides: [] },
      { roomId: 'b', versions: [{ validFrom: '2027-05-03', validTo: null, physicalBeds: 6, sellableCapacity: 6 }], overrides: [] },
    ]
    expect(rangeEffectiveAverage(rooms, makeRange('2027-05-01', '2027-05-04'))).toMatchObject({ numerator: 4 * 4 + 6 * 2, denominator: 6 })
  })
  it('all-hotel average is weighted, never an average of averages', () => {
    const small = makeAverage(3, 1, 'ROOMS') // 1 room of 3
    const big = makeAverage(400, 100, 'ROOMS') // 100 rooms of 4
    expect(combineAverages([small, big])).toMatchObject({ numerator: 403, denominator: 101 })
    expect(combineAverages([small, big]).value).not.toBeCloseTo((3 + 4) / 2)
    expect(combineAverages([])).toMatchObject({ value: null })
  })
  it('refuses to mix room and room-night bases', () => {
    expect(() => combineAverages([makeAverage(1, 1, 'ROOMS'), makeAverage(1, 1, 'ROOM_NIGHTS')])).toThrow()
  })
})

describe('formatRatio', () => {
  it.each([[310, 80, '3.88'], [1, 3, '0.33'], [2, 3, '0.67'], [5, 2, '2.50'], [0, 5, '0.00'], [1, 8, '0.13'], [3, 8, '0.38']])('%i/%i -> %s', (n, d, s) => expect(formatRatio(n, d)).toBe(s))
  it('returns null for a zero denominator', () => expect(formatRatio(5, 0)).toBeNull())
})
```

**Verification commands:** `pnpm test:unit && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** the requirement examples pass literally (Room 401 = 4/4 → 6/6 (2027-05-01…07-31) → 4/4; 310 ÷ 80 → `"3.88"`); an empty hotel gives `null`; the module imports nothing from `db/` or `server/repositories/`.

**Commit boundary:** one commit — `feat(domain): effective capacity resolution and hotel averages`.

---

### Task 11: Domain — room calendar segments, daily summary, filters, available-stay average (pure)

**Objective:** Turn base versions + overrides + blocks into the run-length segments the calendar API returns, plus the daily totals and the filter semantics — with no database and no HTTP.

**Depends on:** 9, 10. **Parallelization:** safe to run in parallel with Tasks 1–8 (disjoint files) after 9 and 10 are merged.

**Files:**
- Create: `server/domain/inventory/calendar.ts`, `tests/unit/domain/inventory/calendar.test.ts`

**Database / API / authorization:** none.

**Domain rules:**
1. Every night of the requested range belongs to **exactly one** segment (no gaps, no overlaps); adjacent identical states merge.
2. Status precedence: `NOT_IN_INVENTORY` › `OUT_OF_SERVICE` › `MAINTENANCE` › `OPERATIONAL_BLOCK` › (Phase 2: `OCCUPIED`, `BOOKED`, `HELD`) › `AVAILABLE`. Blocks over nights where the room is not in inventory are ignored.
3. `sellable` is true only when the room is in inventory and no *sale-blocking* block covers the night. `OUT_OF_SERVICE` and `OPERATIONAL_BLOCK` always block; `MAINTENANCE` blocks unless `maintenanceBlocksSales` is false (then it is displayed as maintenance but stays sellable). A maintenance block that does not block sales cannot hide an operational block on the same night.
4. Capacity regime (base vs. period override) and operational state are independent layers: a segment boundary appears whenever either changes.
5. Filters: `matchesStatusFilter(segments, statuses, 'any' | 'all')` (an empty status list matches everything); `matchesCapacityFilter(segments, min?, max?)` matches if **any** night's sellable capacity is within the bounds.
6. `summarizeDaily` returns one row per date with `roomsInInventory`, `sellableRooms`, per-status counts (`outOfService`, `maintenance`, `operationalBlock`), `effectiveSellableCapacity` and `sellableRoomCapacity`; an empty hotel yields zero rows of data, not errors. (Counts by *status* and `sellableRooms` can overlap only in the `maintenanceBlocksSales = false` case — by design.)
7. `availableStayAverage`: rooms sellable on **every** night of the stay; each contributes its minimum sellable capacity over the stay; result carries `eligibleRoomIds`. Reservations join the same `sellable` predicate in Phase 2.

**Verified implementation:**

`server/domain/inventory/calendar.ts`
```ts
import { type IsoDate, type NightRange, eachDate, fromEpochDay, toEpochDay } from '../../../shared/utils/dates'
import { type CapacitySource, capacitySegments, cutPoints, effectiveCapacityAt } from './capacity'
import { type AverageResult, type RoomCapacityInput, makeAverage } from './averages'
import { type BlockKind, type InventoryStatus, INVENTORY_STATUSES } from '../../../shared/constants/inventory'


export interface BlockInput { id: string, kind: BlockKind, from: IsoDate, to: IsoDate }
export interface RoomCalendarInput extends RoomCapacityInput { blocks: BlockInput[] }
export interface CalendarOptions {
  /** hotel_setting inventory.maintenanceBlocksSales: when false a MAINTENANCE block is shown but the room stays sellable. */
  maintenanceBlocksSales: boolean
}

export interface CalendarSegment {
  from: IsoDate
  to: IsoDate
  status: InventoryStatus
  /** Can the room be sold on these nights (in inventory and not covered by a sale-blocking block)? */
  sellable: boolean
  physicalBeds: number | null
  sellableCapacity: number | null
  capacitySource: CapacitySource | null
  periodId: string | null
  blockIds: string[]
}

const rank = (s: InventoryStatus) => INVENTORY_STATUSES.indexOf(s)

function blockCovers(b: BlockInput, day: number): boolean {
  return toEpochDay(b.from) <= day && day <= toEpochDay(b.to)
}

function stateAt(input: RoomCalendarInput, date: IsoDate, options: CalendarOptions): Omit<CalendarSegment, 'from' | 'to'> {
  const cap = effectiveCapacityAt(input.versions, input.overrides, date)
  if (!cap) {
    return { status: 'NOT_IN_INVENTORY', sellable: false, physicalBeds: null, sellableCapacity: null, capacitySource: null, periodId: null, blockIds: [] }
  }
  const day = toEpochDay(date)
  const covering = input.blocks.filter(b => blockCovers(b, day))
  let status: InventoryStatus = 'AVAILABLE'
  for (const b of covering) if (rank(b.kind) < rank(status)) status = b.kind
  const sellable = !covering.some(b => b.kind !== 'MAINTENANCE' || options.maintenanceBlocksSales)
  return {
    status,
    sellable,
    physicalBeds: cap.physicalBeds,
    sellableCapacity: cap.sellableCapacity,
    capacitySource: cap.source,
    periodId: cap.periodId,
    blockIds: covering.map(b => b.id).sort(),
  }
}

const sameState = (a: Omit<CalendarSegment, 'from' | 'to'>, b: Omit<CalendarSegment, 'from' | 'to'>) =>
  a.status === b.status && a.sellable === b.sellable && a.physicalBeds === b.physicalBeds && a.sellableCapacity === b.sellableCapacity
  && a.capacitySource === b.capacitySource && a.periodId === b.periodId && a.blockIds.join() === b.blockIds.join()

/** Run-length-encoded calendar row for one room. Every night of `range` is covered by exactly one segment. */
export function buildRoomSegments(input: RoomCalendarInput, range: NightRange, options: CalendarOptions): CalendarSegment[] {
  const points = cutPoints(range, [
    ...input.versions.map(v => ({ from: v.validFrom, to: v.validTo })),
    ...input.overrides.map(o => ({ from: o.validFrom, to: o.validTo })),
    ...input.blocks.map(b => ({ from: b.from, to: b.to })),
  ])
  const end = toEpochDay(range.to)
  const out: CalendarSegment[] = []
  points.forEach((s, i) => {
    const e = (points[i + 1] ?? end + 1) - 1
    const state = stateAt(input, fromEpochDay(s), options)
    const last = out[out.length - 1]
    if (last && sameState(last, state)) last.to = fromEpochDay(e)
    else out.push({ from: fromEpochDay(s), to: fromEpochDay(e), ...state })
  })
  return out
}

export interface DailySummary {
  date: IsoDate
  roomsInInventory: number
  sellableRooms: number
  outOfService: number
  maintenance: number
  operationalBlock: number
  effectiveSellableCapacity: number
  sellableRoomCapacity: number
}

export function summarizeDaily(rooms: RoomCalendarInput[], range: NightRange, options: CalendarOptions): DailySummary[] {
  const dates = eachDate(range, 1000)
  const start = toEpochDay(range.from)
  const rows: DailySummary[] = dates.map(date => ({
    date, roomsInInventory: 0, sellableRooms: 0, outOfService: 0, maintenance: 0, operationalBlock: 0, effectiveSellableCapacity: 0, sellableRoomCapacity: 0,
  }))
  for (const room of rooms) {
    for (const seg of buildRoomSegments(room, range, options)) {
      if (seg.status === 'NOT_IN_INVENTORY') continue
      const from = toEpochDay(seg.from) - start
      const to = toEpochDay(seg.to) - start
      for (let i = from; i <= to; i++) {
        const row = rows[i]!
        row.roomsInInventory += 1
        row.effectiveSellableCapacity += seg.sellableCapacity ?? 0
        if (seg.sellable) { row.sellableRooms += 1; row.sellableRoomCapacity += seg.sellableCapacity ?? 0 }
        if (seg.status === 'OUT_OF_SERVICE') row.outOfService += 1
        else if (seg.status === 'MAINTENANCE') row.maintenance += 1
        else if (seg.status === 'OPERATIONAL_BLOCK') row.operationalBlock += 1
      }
    }
  }
  return rows
}

export function matchesStatusFilter(segments: CalendarSegment[], statuses: InventoryStatus[], match: 'any' | 'all'): boolean {
  if (statuses.length === 0) return true
  return match === 'any' ? segments.some(s => statuses.includes(s.status)) : segments.every(s => statuses.includes(s.status))
}

/** True if on any night in the segments the effective sellable capacity is within [min, max]. */
export function matchesCapacityFilter(segments: CalendarSegment[], min?: number, max?: number): boolean {
  if (min === undefined && max === undefined) return true
  return segments.some(s => s.sellableCapacity !== null && (min === undefined || s.sellableCapacity >= min) && (max === undefined || s.sellableCapacity <= max))
}

export interface AvailableStayAverage extends AverageResult { eligibleRoomIds: string[] }

/**
 * Available-Stay Average: over rooms sellable on EVERY night of the stay, the average of each room's
 * minimum sellable capacity across the stay. Reservations join this predicate in Phase 2.
 */
export function availableStayAverage(rooms: RoomCalendarInput[], stay: NightRange, options: CalendarOptions): AvailableStayAverage {
  let total = 0
  const eligible: string[] = []
  for (const room of rooms) {
    const segs = buildRoomSegments(room, stay, options)
    if (!segs.every(s => s.sellable)) continue
    total += Math.min(...segs.map(s => s.sellableCapacity!))
    eligible.push(room.roomId)
  }
  return { ...makeAverage(total, eligible.length, 'ROOMS'), eligibleRoomIds: eligible }
}
```

**Tests (write first; verified):**

`tests/unit/domain/inventory/calendar.test.ts`
```ts
import { describe, expect, it } from 'vitest'
import { availableStayAverage, buildRoomSegments, matchesCapacityFilter, matchesStatusFilter, summarizeDaily, type RoomCalendarInput } from '../../../../server/domain/inventory/calendar'
import { makeRange } from '../../../../shared/utils/dates'

const opts = { maintenanceBlocksSales: true }
const room = (over: Partial<RoomCalendarInput> = {}): RoomCalendarInput => ({
  roomId: 'r401',
  versions: [{ validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }],
  overrides: [],
  blocks: [],
  ...over,
})
const brief = (segs: ReturnType<typeof buildRoomSegments>) => segs.map(s => `${s.from}..${s.to} ${s.status}${s.sellable ? '' : '!'} ${s.sellableCapacity}`)

describe('buildRoomSegments', () => {
  it('a plain room is one AVAILABLE segment', () => {
    expect(brief(buildRoomSegments(room(), makeRange('2027-06-01', '2027-06-10'), opts))).toEqual(['2027-06-01..2027-06-10 AVAILABLE 4'])
  })
  it('separates capacity regime and operational states as independent layers', () => {
    const r = room({
      overrides: [{ periodId: 'h', validFrom: '2027-05-01', validTo: '2027-07-31', physicalBeds: 6, sellableCapacity: 6 }],
      blocks: [{ id: 'b1', kind: 'MAINTENANCE', from: '2027-05-10', to: '2027-05-12' }],
    })
    expect(brief(buildRoomSegments(r, makeRange('2027-04-29', '2027-05-14'), opts))).toEqual([
      '2027-04-29..2027-04-30 AVAILABLE 4',
      '2027-05-01..2027-05-09 AVAILABLE 6',
      '2027-05-10..2027-05-12 MAINTENANCE! 6',
      '2027-05-13..2027-05-14 AVAILABLE 6',
    ])
  })
  it('out of service outranks maintenance outranks operational block on overlapping nights', () => {
    const r = room({ blocks: [
      { id: 'a', kind: 'OPERATIONAL_BLOCK', from: '2027-06-01', to: '2027-06-10' },
      { id: 'b', kind: 'MAINTENANCE', from: '2027-06-03', to: '2027-06-06' },
      { id: 'c', kind: 'OUT_OF_SERVICE', from: '2027-06-05', to: '2027-06-05' },
    ] })
    expect(brief(buildRoomSegments(r, makeRange('2027-06-01', '2027-06-10'), opts))).toEqual([
      '2027-06-01..2027-06-02 OPERATIONAL_BLOCK! 4',
      '2027-06-03..2027-06-04 MAINTENANCE! 4',
      '2027-06-05..2027-06-05 OUT_OF_SERVICE! 4',
      '2027-06-06..2027-06-06 MAINTENANCE! 4',
      '2027-06-07..2027-06-10 OPERATIONAL_BLOCK! 4',
    ])
  })
  it('nights outside inventory are NOT_IN_INVENTORY and ignore blocks', () => {
    const r = room({ versions: [{ validFrom: '2027-06-05', validTo: '2027-06-08', physicalBeds: 4, sellableCapacity: 4 }], blocks: [{ id: 'x', kind: 'OUT_OF_SERVICE', from: '2027-06-01', to: '2027-06-30' }] })
    expect(brief(buildRoomSegments(r, makeRange('2027-06-03', '2027-06-10'), opts))).toEqual([
      '2027-06-03..2027-06-04 NOT_IN_INVENTORY! null',
      '2027-06-05..2027-06-08 OUT_OF_SERVICE! 4',
      '2027-06-09..2027-06-10 NOT_IN_INVENTORY! null',
    ])
  })
  it('honours the maintenanceBlocksSales hotel setting (shown as maintenance, still sellable)', () => {
    const r = room({ blocks: [{ id: 'm', kind: 'MAINTENANCE', from: '2027-06-01', to: '2027-06-02' }] })
    const segs = buildRoomSegments(r, makeRange('2027-06-01', '2027-06-03'), { maintenanceBlocksSales: false })
    expect(segs[0]).toMatchObject({ status: 'MAINTENANCE', sellable: true })
  })
  it('a maintenance block that does not block sales still cannot hide an operational block', () => {
    const r = room({ blocks: [
      { id: 'm', kind: 'MAINTENANCE', from: '2027-06-01', to: '2027-06-02' },
      { id: 'o', kind: 'OPERATIONAL_BLOCK', from: '2027-06-01', to: '2027-06-02' },
    ] })
    expect(buildRoomSegments(r, makeRange('2027-06-01', '2027-06-02'), { maintenanceBlocksSales: false })[0]).toMatchObject({ status: 'MAINTENANCE', sellable: false })
  })
  it('segments always cover the requested range exactly, without gaps or overlaps', () => {
    const r = room({ blocks: [{ id: 'b', kind: 'MAINTENANCE', from: '2027-06-03', to: '2027-06-04' }] })
    const segs = buildRoomSegments(r, makeRange('2027-06-01', '2027-06-07'), opts)
    expect(segs[0]!.from).toBe('2027-06-01')
    expect(segs.at(-1)!.to).toBe('2027-06-07')
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.from > segs[i - 1]!.to).toBe(true)
  })
  it('a single-night range works and leap day is respected', () => {
    expect(buildRoomSegments(room(), makeRange('2028-02-29', '2028-02-29'), opts)).toHaveLength(1)
  })
})

describe('summarizeDaily', () => {
  it('counts rooms per status and capacity per day', () => {
    const rooms = [
      room({ roomId: 'a' }),
      room({ roomId: 'b', blocks: [{ id: 'k', kind: 'OUT_OF_SERVICE', from: '2027-06-02', to: '2027-06-02' }] }),
      room({ roomId: 'c', versions: [{ validFrom: '2027-06-02', validTo: null, physicalBeds: 6, sellableCapacity: 6 }] }),
    ]
    const rows = summarizeDaily(rooms, makeRange('2027-06-01', '2027-06-02'), opts)
    expect(rows[0]).toMatchObject({ date: '2027-06-01', roomsInInventory: 2, sellableRooms: 2, outOfService: 0, effectiveSellableCapacity: 8, sellableRoomCapacity: 8 })
    expect(rows[1]).toMatchObject({ date: '2027-06-02', roomsInInventory: 3, sellableRooms: 2, outOfService: 1, effectiveSellableCapacity: 14, sellableRoomCapacity: 10 })
  })
  it('an empty hotel yields zero rows of data, not errors', () => {
    expect(summarizeDaily([], makeRange('2027-06-01', '2027-06-02'), opts).every(r => r.roomsInInventory === 0)).toBe(true)
  })
})

describe('filters', () => {
  const segs = buildRoomSegments(room({ blocks: [{ id: 'm', kind: 'MAINTENANCE', from: '2027-06-03', to: '2027-06-04' }] }), makeRange('2027-06-01', '2027-06-07'), opts)
  it('any vs all semantics', () => {
    expect(matchesStatusFilter(segs, ['MAINTENANCE'], 'any')).toBe(true)
    expect(matchesStatusFilter(segs, ['MAINTENANCE'], 'all')).toBe(false)
    expect(matchesStatusFilter(segs, ['MAINTENANCE', 'AVAILABLE'], 'all')).toBe(true)
    expect(matchesStatusFilter(segs, [], 'all')).toBe(true)
  })
  it('capacity filter', () => {
    expect(matchesCapacityFilter(segs, 4, 4)).toBe(true)
    expect(matchesCapacityFilter(segs, 5)).toBe(false)
    expect(matchesCapacityFilter(segs)).toBe(true)
  })
})

describe('availableStayAverage', () => {
  const rooms = [
    room({ roomId: 'a' }),
    room({ roomId: 'b', overrides: [{ periodId: 'h', validFrom: '2027-05-01', validTo: '2027-07-31', physicalBeds: 6, sellableCapacity: 6 }] }),
    room({ roomId: 'c', blocks: [{ id: 'k', kind: 'OUT_OF_SERVICE', from: '2027-05-03', to: '2027-05-03' }] }),
  ]
  it('excludes rooms blocked on any night and uses the minimum capacity across the stay', () => {
    const r = availableStayAverage(rooms, makeRange('2027-04-29', '2027-05-04'), opts) // b: min(4,4,6,6,..)=4 ; c blocked
    expect(r.eligibleRoomIds).toEqual(['a', 'b'])
    expect(r).toMatchObject({ numerator: 8, denominator: 2, value: 4, display: '4.00' })
  })
  it('a stay wholly inside Hajj sees the seasonal capacity', () => {
    const r = availableStayAverage(rooms, makeRange('2027-06-01', '2027-06-03'), opts)
    expect(r).toMatchObject({ numerator: 4 + 6 + 4, denominator: 3 })
  })
  it('no eligible rooms gives an undefined average', () => {
    expect(availableStayAverage(rooms, makeRange('2027-05-03', '2027-05-03'), { maintenanceBlocksSales: true }).eligibleRoomIds).toEqual(['a', 'b'])
    expect(availableStayAverage([], makeRange('2027-05-03', '2027-05-03'), opts)).toMatchObject({ value: null, display: null })
  })
})
```

**Verification commands:** `pnpm test:unit && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** the segment tests for the two-layer example (capacity regime + maintenance), the three-way block precedence, out-of-inventory nights, the `maintenanceBlocksSales` setting and the range-coverage invariant all pass; the module has no imports outside `shared/` and `server/domain/inventory/`.

**Commit boundary:** one commit — `feat(domain): room calendar segments, daily summary, filters, available-stay average`.

---

### Task 12: Hotel management service and API (the reference pattern for every CRUD task)

**Objective:** Organization-aware hotel create/read/update/activate/deactivate, per-hotel settings, and the per-hotel audit read — built exactly the way every later aggregate will be built.

**Depends on:** 5, 6, 7, 8 (for HTTP tests), 9 (`isValidTimezone`). **Parallelization:** sequential.

**Reference pattern (all later CRUD tasks copy this shape):** route (`defineApiHandler`, Zod for params/query/body) → service function `(ctx: AuthContext, …)` → `authorizeHotel` first (or `requireOrgPermission`) → **one transaction** containing repository writes and `recordAudit` → DTO mapper. Services never see `event`; routes never see repositories.
```ts
// server/services/hotelService.ts  (reference)
export async function updateHotel(ctx: AuthContext, hotelId: string, patch: UpdateHotelInput): Promise<HotelDetail> {
  const { hotel } = await authorizeHotel(ctx, 'hotel.manage', hotelId, { allowInactive: true })
  return ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    const { before, after } = diffFields(hotel, patch)              // only fields that actually change
    if (Object.keys(after).length === 0) return toHotelDetail(hotel)
    const updated = await repos.hotels.update(hotel.id, patch)
    await recordAudit(repos.audit, ctx.identity.userId, {
      hotelId: hotel.id, entityType: 'hotel', entityId: hotel.id, action: 'HOTEL_UPDATED', before, after,
    })
    return toHotelDetail(updated)
  })
}
// server/api/hotels/[hotelId]/index.patch.ts
export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: updateHotelSchema,
  handler: ({ ctx, params, body }) => updateHotel(ctx, params.hotelId, body),
})
```

**Files:**
- Create: `shared/schemas/hotel.ts`, `shared/business-rules/hotelSettings.ts`, `server/services/hotelService.ts`, `server/services/hotelDto.ts`
- Create routes: `server/api/hotels/index.get.ts`, `index.post.ts`, `[hotelId]/index.get.ts`, `[hotelId]/index.patch.ts`, `[hotelId]/activate.post.ts`, `[hotelId]/deactivate.post.ts`, `[hotelId]/settings.get.ts`, `[hotelId]/settings.put.ts`, `[hotelId]/audit-log.get.ts`
- Modify: `server/errors/dbErrors.ts` (`hotel_org_code_unique`)
- Test: `tests/unit/shared/{hotelSchemas,hotelSettings}.test.ts`, `tests/integration/services/hotelService.test.ts`, `tests/http/hotels.http.test.ts`

**Schemas (`shared/schemas/hotel.ts`):**
- `createHotelSchema`: `code` `/^[A-Z0-9][A-Z0-9-]{1,19}$/`; `name` `safeText(120)`; `city` `safeText(80)`; `country` `/^[A-Z]{2}$/` (default `SA`); `address` `safeText(300)?`; `phone` `safeText(40)?`; `email` valid address ≤ 254 chars `?`; `timezone` valid IANA name (`isValidTimezone`); `currency` `/^[A-Z]{3}$/` (default `SAR`); `checkInTime`, `checkOutTime` `/^([01]\d|2[0-3]):[0-5]\d$/` (defaults `15:00`, `12:00`); `licenseReference` `safeText(100)?`; `ownershipType` one of `OWNERSHIP_TYPES` (default `OWNED`); `notes` `safeText(2000)?`.
- `updateHotelSchema = createHotelSchema.omit({ code: true }).partial().strict()` — unknown keys (`status`, `organizationId`, `code`, `id`) are a 422, not silently ignored (no mass assignment).

**Settings registry (`shared/business-rules/hotelSettings.ts`):**
```ts
export const HOTEL_SETTINGS = {
  'inventory.maintenanceBlocksSales': { schema: z.boolean(), default: true },
  'calendar.defaultRangeDays': { schema: z.number().int().min(7).max(MAX_CALENDAR_DAYS), default: 31 },
} as const
export function resolveSettings(stored: Record<string, unknown>): ResolvedSettings   // defaults filled; unknown stored keys ignored
export const updateSettingsSchema   // built from the registry: every key optional, .strict()
```
New settings later = one registry line, no migration.

**Service functions** (signatures): `listHotels(ctx)`, `getHotel(ctx, hotelId)`, `createHotel(ctx, input)`, `updateHotel(ctx, hotelId, patch)`, `activateHotel(ctx, hotelId)`, `deactivateHotel(ctx, hotelId)`, `getSettings(ctx, hotelId)`, `updateSettings(ctx, hotelId, patch)`, `listHotelAudit(ctx, hotelId, filter)`.

**DTOs (`server/services/hotelDto.ts`, S2) — the UI's only source for a hotel's identity and its local "today":**
```ts
export interface HotelSummary {           // GET /api/hotels items; also the hotel switcher's data
  id: string, code: string, name: string, city: string, country: string,
  status: HotelStatus, timezone: string,
  today: IsoDate,                         // todayInTimezone(timezone, ctx.now()) — never the browser's date
  floorCount: number | null,              // active floors (added by Task 13); null when the caller lacks room.view
  roomCount: number | null,               // rooms in inventory on `today` (added by Task 14); null without room.view
}
export interface HotelDetail extends HotelSummary {
  address: string | null, phone: string | null, email: string | null, currency: string,
  checkInTime: string, checkOutTime: string, ownershipType: OwnershipType,
  licenseReference: string | null, notes: string | null, createdAt: string, updatedAt: string,
}
```
`listHotels` returns `HotelSummary[]` ordered by `name`; every other hotel endpoint returns `HotelDetail`. The counts are computed with one grouped query per list call (not one per hotel).

**Audit history (S3):** `GET …/audit-log?entityType=&entityId=&action=&cursor=&limit=` → `{ items: AuditItem[], nextCursor: string | null }` where `AuditItem = { id, action, entityType, entityId, actor: { id, fullName } | null, before, after, reason, createdAt }`; `cursor` is the opaque `nextCursor` from the previous page (`base64url(createdAt|id)`, validated by Zod — a malformed cursor → 422); `limit ≤ 100` (default 50); `entityType` from a fixed list (`hotel`, `floor`, `room`, `capacity_period`, `room_block`, `document`), `action` from `AUDIT_ACTIONS`. Rows are hotel rows only (`hotel_id = :hotelId`), so room, season and block histories are the same endpoint filtered by entity.

**Domain rules:**
1. Hotels are never deleted; `code` is immutable; timezone must be IANA; inactive hotels reject inventory writes (`HOTEL_INACTIVE`) but allow reads, hotel edits, settings edits and reactivation.
2. Creating a hotel needs `hotel.manage` **and** `allHotels`. A newly created hotel needs no access rows (only `allHotels` users can create, and they already see it).
3. Deactivate/activate on a hotel already in that state → `409 ALREADY_INACTIVE` / `ALREADY_ACTIVE`. *(Phase 2 adds "no future confirmed bookings" to deactivation — recorded here as an integration seam, not implemented.)*
4. The number of floors is **derived** (Task 13 fills `floorCount` in `HotelSummary` and `HotelDetail`); it is not a column.
5. Audit: `HOTEL_CREATED` (before `null`, after = the created fields), `HOTEL_UPDATED`/`HOTEL_SETTINGS_CHANGED` (before/after of changed fields only), `HOTEL_DEACTIVATED`/`HOTEL_ACTIVATED` — all with `hotel_id` set, written in the same transaction.

**Endpoints and authorization:**

| Method & path | Permission | Scope rule | Success | Notable errors |
|---|---|---|---|---|
| `GET /api/hotels` | `hotel.view` | org-level; returns **only accessible hotels** | 200 | 403 without permission; empty list (200) with no access |
| `POST /api/hotels` | `hotel.manage` + `allHotels` | org-level | 201 | 403; 409 `ALREADY_EXISTS`; 422 |
| `GET /api/hotels/:hotelId` | `hotel.view` | `authorizeHotel` (allow inactive) | 200 | 404 foreign/inaccessible; 403 |
| `PATCH /api/hotels/:hotelId` | `hotel.manage` | `authorizeHotel` (allow inactive) | 200 | 404; 403; 422 unknown field |
| `POST …/activate`, `…/deactivate` | `hotel.manage` | `authorizeHotel` (allow inactive) | 200 | 404; 409 |
| `GET/PUT …/settings` | `hotel.view` / `hotel.manage` | `authorizeHotel` (allow inactive) | 200 | 422 unknown key / wrong type |
| `GET …/audit-log?entityType&entityId&action&cursor&limit` | `audit.view` | `authorizeHotel`; hotel rows only; keyset cursor; `limit ≤ 100` (S3) | 200 | 404; 403; 422 bad cursor/filter |

**Tests to write first:**
1. (unit) schemas: code pattern boundaries (1 char, 21 chars, lowercase, space), timezone `Mars/Olympus` rejected, `25:00` rejected, `sar` rejected, unknown key rejected in update (`status`, `code`, `organizationId`), a 121-character name rejected, Arabic name accepted; settings registry defaults, unknown stored key ignored, wrong type rejected.
2. (integration) create as `allHotels` + `hotel.manage` → hotel + `HOTEL_CREATED` audit row with `hotel_id` = the new hotel; as a hotel-scoped manager (has `hotel.manage`, not `allHotels`) → 403; as a role without `hotel.manage` → 403.
3. (integration) duplicate `code` in the same org → `409 ALREADY_EXISTS` (real DB error translated, message from `CONSTRAINT_MESSAGES`); same code in another org succeeds.
4. (integration) **list isolation:** a user with access to 2 of 5 hotels sees exactly those 2; an `allHotels` user sees all of their org's hotels and **none** of another org's; a user with no access gets `[]`.
5. (integration) **get/patch/activate/deactivate with a foreign-org hotel id → 404; with an in-org hotel the user has no access to → the same 404; with access but a role lacking the permission → 403** (Review Focus #1).
6. (integration) update writes before/after of changed fields only; a no-op patch writes no audit row and no `updated_at` change; `code` cannot be changed.
7. (integration) deactivate → `INACTIVE`, audit, second deactivate → 409; an inactive hotel still returns from `GET`, accepts `PATCH`, and (verified again in Tasks 13–16) rejects inventory writes.
8. (integration) settings: defaults when nothing stored; valid update stored and audited (`HOTEL_SETTINGS_CHANGED`); unknown key → 422; wrong type → 422; second identical update is a no-op.
9. (integration) **atomicity:** with `AuditRepository.record` spied to throw, `createHotel` leaves no hotel behind.
10. (integration) **concurrency:** two simultaneous `createHotel` with the same code → exactly one 201 and one 409, one hotel row.
11. (integration) audit read: `audit.view` hotel A cannot read hotel B's log (404); org-level rows (`hotel_id` null) never appear in a hotel log; `limit=101` → 422.
12. (integration, S3) filters by `entityType`+`entityId` and by `action`; cursor pages are stable (no row repeated or skipped when a new row is written between page requests; rows sharing one `created_at` are ordered by `id`); a malformed cursor → 422; `actor.fullName` resolves for users of the same organization and is `null` for a deleted user; an `actor_user_id` that belongs to another organization (forced insert) resolves to `null`, never another org's name.
13. (integration, S2) `HotelSummary`/`HotelDetail` shapes; `today` with an injected clock at `2027-05-01T21:30:00Z` is `2027-05-02` for `Asia/Riyadh` and `2027-05-01` for a `UTC` hotel; list counts come from one grouped query (statement count asserted); a caller without `room.view` (e.g. Accountant) receives `floorCount: null` and `roomCount: null`.
14. (HTTP, real cookies) 401 without a session; 403 for a reservation manager on `POST /api/hotels`; 404 for a foreign-org `hotelId` on every hotel route; 422 shape with `issues[]`; `PATCH` with `{ "status": "INACTIVE" }` → 422.

**Verification commands:** `pnpm test:unit && pnpm test:integration && pnpm test:http && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** no hotel route can be reached for an id outside the caller's access; every write has an audit row with before/after and rolls back with it; the pattern above is the only shape later tasks need.

**Commit boundary:** one commit — `feat: hotel management service and API with settings and audit read`.

---

### Task 13: Floors and room types (migration `0003`)

**Objective:** The two structural catalogs rooms depend on: per-hotel floors, and the organization-wide room-type catalog whose defaults seed new rooms (D1).

**Depends on:** 12. **Parallelization:** sequential (schema migration).

**Files:**
- Create: `db/schema/inventory.ts` (floor, room_type — the header below is the file's final form; unused imports are trimmed until later tasks add their tables), `db/migrations/0003_floors_room_types.sql`, `server/repositories/hotel/floorRepository.ts`, `server/repositories/tenant/roomTypeRepository.ts`, `server/services/{floorService,roomTypeService}.ts`, `shared/schemas/{floor,roomType}.ts`
- Create routes: `server/api/hotels/[hotelId]/floors/{index.get,index.post,bulk.post}.ts`, `floors/[floorId]/{index.patch,activate.post,deactivate.post}.ts`, `server/api/room-types/{index.get,index.post}.ts`, `room-types/[roomTypeId]/{index.patch,activate.post,deactivate.post}.ts`
- Modify: `db/schema/index.ts`, `server/errors/dbErrors.ts` (`floor_hotel_level_unique`, `room_type_org_code_unique`), `server/services/hotelDto.ts` (`floorCount`), `tests/integration/security/repositoryRegistry.ts`, `tests/support/fixtures.ts`
- Test: `tests/integration/services/{floorService,roomTypeService}.test.ts`, `tests/integration/db/floorsRoomTypes.test.ts`, `tests/http/floorsRoomTypes.http.test.ts`, `tests/unit/shared/floorRoomTypeSchemas.test.ts`

**Schema (verified; applied to PostgreSQL 16):**
```ts
import { sql } from 'drizzle-orm'
import { boolean, check, date, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { hotel } from './hotel'
import { organization } from './tenancy'

const orgCol = () => uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' })
const stamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const floor = pgTable('floor', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  hotelId: uuid('hotel_id').notNull(),
  level: integer('level').notNull(),
  label: text('label').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...stamps(),
}, t => [
  unique('floor_org_hotel_id_unique').on(t.organizationId, t.hotelId, t.id),
  unique('floor_hotel_level_unique').on(t.hotelId, t.level),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'floor_hotel_fk' }),
  check('floor_level_check', sql`${t.level} between -5 and 200`),
])

export const roomType = pgTable('room_type', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  defaultPhysicalBeds: integer('default_physical_beds').notNull(),
  defaultSellableCapacity: integer('default_sellable_capacity').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...stamps(),
}, t => [
  unique('room_type_org_id_unique').on(t.organizationId, t.id),
  unique('room_type_org_code_unique').on(t.organizationId, t.code),
  check('room_type_beds_check', sql`${t.defaultPhysicalBeds} between 1 and 30`),
  check('room_type_sellable_check', sql`${t.defaultSellableCapacity} between 0 and 30`),
])
```

**Migration `0003`:** `pnpm db:generate --name floors_room_types`; no raw SQL needed (checks and uniques are expressible).

**Domain rules:**
- **Floors:** `level` integer `-5…200` unique per hotel (`0` = ground); default label `Floor N` (`Ground` for 0); deactivation is soft (`is_active = false`); a floor with rooms **in inventory today or later** cannot be deactivated (**that guard is added in Task 14**, where rooms exist; its test lives there). Bulk creation `POST …/floors/bulk { fromLevel, toLevel }` creates all levels in one transaction, `≤ 60` floors, and is all-or-nothing: any existing level → `409` with `details.existing: number[]`.
- **Room types:** `code` `/^[A-Z0-9][A-Z0-9_-]{1,19}$/` unique per org; `defaultPhysicalBeds` `1…30`, `defaultSellableCapacity` `0…30` (sellable may exceed beds — extra beds — or be lower); `sortOrder` `0…1000`. Editing defaults or deactivating a type **never changes existing rooms** (D1; test in Task 14).
- Writing room types is org-wide configuration: `room.manage` **and** `allHotels`. Reading needs `room.view` (org-level).
- **List DTOs (S4):** `FloorListItem { id, level, label, isActive, roomCount }` and `RoomTypeListItem { id, code, name, defaultPhysicalBeds, defaultSellableCapacity, description, sortOrder, isActive, usageCount: number | null }`. Both counts are *declared* here and return `0` / `null` until rooms exist; **Task 14 wires them** (rooms in inventory on the hotel's today; `usageCount` across the organization and only for `allHotels` callers, otherwise `null`, so hotel-scoped users never learn room counts of hotels they cannot see).
- Audit: `FLOOR_CREATED/UPDATED` (hotel set), `ROOM_TYPE_CREATED/UPDATED` (`hotel_id` null).

**Repositories (isolation-registry entries required):** `FloorRepository` (Hotel scope: `insert`, `insertMany`, `findById`, `findByLevel`, `list({ includeInactive })`, `update`, `setActive`, `countByHotel`); `RoomTypeRepository` (Org scope: `insert`, `findById`, `findByCode`, `list({ includeInactive })`, `update`, `setActive`).

**Endpoints and authorization:**

| Method & path | Permission | Scope rule |
|---|---|---|
| `GET /api/hotels/:hotelId/floors?includeInactive=` | `room.view` | `authorizeHotel` (allow inactive) |
| `POST /api/hotels/:hotelId/floors`, `…/floors/bulk` | `room.manage` | `authorizeHotel` (writes reject inactive hotels) |
| `PATCH …/floors/:floorId`, `POST …/activate`, `…/deactivate` | `room.manage` | `authorizeHotel`; `floorId` must belong to **this** hotel → else 404 |
| `GET /api/room-types?includeInactive=` | `room.view` | org-level |
| `POST /api/room-types`, `PATCH /api/room-types/:id`, `POST …/activate\|deactivate` | `room.manage` + `allHotels` | org-level; id must belong to the org → else 404 |

**Tests to write first:**
1. (integration/DB) unique `(hotel_id, level)`; same level in another hotel fine; unique `(organization_id, code)` for types, same code in another org fine; check constraints (`level 201`, `beds 0/31`, `sellable 31`) rejected (`23514`); a floor row pointing at another org's hotel rejected (`23503`); index coverage for the new FK column sets; real-error `translateDbError` messages for the two unique constraints.
2. (integration) create floor + audit; duplicate level → 409; bulk `0…12` creates 13 floors atomically; bulk with one existing level → 409 with `existing` and **nothing** created; bulk `fromLevel > toLevel`, `> 60` floors → 422; `level` `-6` / `201` → 422.
3. (integration) **foreign ids:** `PATCH/deactivate` of a floor that belongs to another hotel of the same org → 404; of another org → 404; in every case nothing changes.
4. (integration) room types: create with defaults `beds 4, sellable 4`; `beds 0`, `31`, `sellable -1`, `31` → 422; sellable > beds accepted; a hotel-scoped manager (no `allHotels`) creating/editing a type → 403; a hotel-scoped user can still `GET` types; type id from another org → 404.
5. (integration) writes to floors of an **inactive** hotel → 409 `HOTEL_INACTIVE`; reads succeed.
6. (integration) `floorCount` in `GET /api/hotels` and `GET /api/hotels/:id` counts active floors only (S2).
7. (integration) audit rows: floor events carry `hotel_id`; room-type events have `hotel_id` null and are invisible in a hotel audit log.
8. (HTTP) 401/403/404/422 for each route with real cookies; a Reception user can list floors and types but not create.
9. (unit) schema boundaries (labels 81 chars, control characters, Arabic labels accepted, code patterns).

**Verification commands:** `pnpm db:generate --name floors_room_types && pnpm db:check && pnpm db:drift && pnpm test:integration:fresh && pnpm test:http && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** floors and types manageable through the API under the exact permission/scope rules above; all foreign-id cases are 404 with no write; the migration applies from an empty database.

**Commit boundary:** one commit — `feat: floors and organization-level room types`.

---

### Task 14: Rooms and versioned base configuration (migration `0004`)

**Objective:** Physical rooms whose base capacity is a dated, versioned history; room lifecycle (retire/reactivate) derived from that history; no mutable `room.status`.

**Depends on:** 9, 10, 11 (room `status` reuses `buildRoomSegments`, S5), 13. **Parallelization:** sequential.

**Files:**
- Modify: `db/schema/inventory.ts` (room, room_base_config)
- Create: `db/migrations/0004_rooms_base_config.sql`, `server/domain/inventory/{rules,baseVersions,nextChange}.ts` (nextChange: S5), `server/repositories/hotel/{roomRepository,roomBaseConfigRepository}.ts`, `server/services/roomService.ts`, `server/services/roomDto.ts` (S5), `shared/schemas/room.ts`, `shared/utils/roomNumber.ts`
- Create routes under `server/api/hotels/[hotelId]/rooms/`: `index.get.ts`, `index.post.ts`, `bulk.post.ts`, `[roomId]/index.get.ts`, `[roomId]/index.patch.ts`, `[roomId]/base-config.post.ts`, `[roomId]/retire.post.ts`, `[roomId]/reactivate.post.ts`
- Modify: `server/services/floorService.ts` (floor-deactivation guard; `roomCount` in `FloorListItem`, S4), `server/services/roomTypeService.ts` + `server/repositories/tenant/roomTypeRepository.ts` (`usageCount`, S4), `server/services/hotelDto.ts` (`roomCount` in `HotelSummary`/`HotelDetail`, S2), `server/errors/dbErrors.ts`, `shared/constants/inventory.ts` (add `ROOM_FEATURES = ['ACCESSIBLE', 'CONNECTING', 'CITY_VIEW', 'HARAM_VIEW'] as const`), registry + fixtures
- Test: `tests/unit/domain/inventory/baseVersions.test.ts`, `tests/unit/domain/inventory/nextChange.test.ts`, `tests/unit/shared/roomNumber.test.ts`, `tests/integration/services/roomService.test.ts`, `tests/integration/db/roomsBaseConfig.test.ts`, `tests/http/rooms.http.test.ts`

**Schema (verified):**
```ts
export const room = pgTable('room', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  hotelId: uuid('hotel_id').notNull(),
  floorId: uuid('floor_id').notNull(),
  roomTypeId: uuid('room_type_id').notNull(),
  roomNumber: text('room_number').notNull(),
  features: text('features').array().notNull().default(sql`'{}'::text[]`),
  notes: text('notes'),
  ...stamps(),
}, t => [
  unique('room_org_hotel_id_unique').on(t.organizationId, t.hotelId, t.id),
  unique('room_hotel_number_unique').on(t.hotelId, t.roomNumber),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'room_hotel_fk' }),
  foreignKey({ columns: [t.organizationId, t.hotelId, t.floorId], foreignColumns: [floor.organizationId, floor.hotelId, floor.id], name: 'room_floor_fk' }),
  foreignKey({ columns: [t.organizationId, t.roomTypeId], foreignColumns: [roomType.organizationId, roomType.id], name: 'room_type_fk' }),
  index('room_hotel_floor_idx').on(t.organizationId, t.hotelId, t.floorId),
  index('room_type_idx').on(t.organizationId, t.roomTypeId),
  check('room_number_check', sql`char_length(btrim(${t.roomNumber})) between 1 and 20`),
])

export const roomBaseConfig = pgTable('room_base_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  hotelId: uuid('hotel_id').notNull(),
  roomId: uuid('room_id').notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }),
  physicalBeds: integer('physical_beds').notNull(),
  sellableCapacity: integer('sellable_capacity').notNull(),
  origin: text('origin').notNull().default('MANUAL'),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.hotelId, t.roomId], foreignColumns: [room.organizationId, room.hotelId, room.id], name: 'room_base_config_room_fk' }),
  index('room_base_config_org_hotel_idx').on(t.organizationId, t.hotelId),
  check('room_base_config_range_check', sql`${t.validTo} is null or ${t.validFrom} <= ${t.validTo}`),
  check('room_base_config_beds_check', sql`${t.physicalBeds} between 1 and 30`),
  check('room_base_config_sellable_check', sql`${t.sellableCapacity} between 0 and 30`),
  check('room_base_config_origin_check', sql`${t.origin} in ('ROOM_TYPE_DEFAULT', 'MANUAL', 'BULK', 'SEED')`),
])
```

**Migration `0004`:** `pnpm db:generate --name rooms_base_config`, then **append** the temporal-integrity constraint (verified: overlapping base versions rejected `23P01`; adjacent close-then-reopen accepted; open-ended `valid_to` is `NULL`):
```sql
ALTER TABLE "room_base_config" ADD CONSTRAINT "room_base_config_no_overlap"
  EXCLUDE USING gist ("room_id" WITH =, daterange("valid_from", "valid_to", '[]') WITH &&);
```

**Verified pure rules (`server/domain/inventory/baseVersions.ts`, plus `rules.ts` for the shared error type):**
```ts
/**
 * Raised by the pure inventory rule modules. Services translate it: kind 'conflict' -> HTTP 409,
 * kind 'validation' -> HTTP 422. (The domain layer must not import server/errors.)
 */
export class InventoryRuleError extends Error {
  constructor(readonly code: string, message: string, readonly kind: 'conflict' | 'validation' = 'conflict') {
    super(message)
    this.name = 'InventoryRuleError'
  }
}
```
```ts
import { type IsoDate, addDays, toEpochDay } from '../../../shared/utils/dates'
import type { BaseVersion } from './capacity'
import { InventoryRuleError } from './rules'

export interface BaseVersionRow extends BaseVersion { id: string }
export interface CapacityValues { physicalBeds: number, sellableCapacity: number }
export interface Closing { id: string, validTo: IsoDate }

function last(versions: BaseVersionRow[]): BaseVersionRow | null {
  return [...versions].sort((a, b) => toEpochDay(a.validFrom) - toEpochDay(b.validFrom)).at(-1) ?? null
}

function assertNotInPast(effectiveFrom: IsoDate, today: IsoDate, code: string) {
  if (toEpochDay(effectiveFrom) < toEpochDay(today)) {
    throw new InventoryRuleError(code, 'Changes take effect from today (hotel time) onwards; past nights are history and cannot be rewritten')
  }
}

/** A permanent base change: close the open version the day before, open a new one. History is never rewritten. */
export function planBaseChange(versions: BaseVersionRow[], effectiveFrom: IsoDate, today: IsoDate, next: CapacityValues): { close: Closing, insert: BaseVersion } {
  const current = last(versions)
  if (!current || current.validTo !== null) {
    throw new InventoryRuleError('ROOM_NOT_IN_INVENTORY', 'The room is retired (or scheduled to retire); reactivate it instead of changing its base capacity')
  }
  assertNotInPast(effectiveFrom, today, 'BASE_CHANGE_IN_PAST')
  if (toEpochDay(effectiveFrom) <= toEpochDay(current.validFrom)) {
    throw new InventoryRuleError('BASE_CHANGE_BEFORE_CURRENT', `The change must take effect after the current version starts (${current.validFrom})`)
  }
  return {
    close: { id: current.id, validTo: addDays(effectiveFrom, -1) },
    insert: { validFrom: effectiveFrom, validTo: null, physicalBeds: next.physicalBeds, sellableCapacity: next.sellableCapacity },
  }
}

/** Retiring a room = closing its open version; nights from `effectiveFrom` on are no longer in inventory. */
export function planRetire(versions: BaseVersionRow[], effectiveFrom: IsoDate, today: IsoDate): { close: Closing } {
  const current = last(versions)
  if (!current || current.validTo !== null) throw new InventoryRuleError('ROOM_ALREADY_RETIRED', 'The room is already retired')
  assertNotInPast(effectiveFrom, today, 'RETIRE_IN_PAST')
  if (toEpochDay(effectiveFrom) <= toEpochDay(current.validFrom)) {
    throw new InventoryRuleError('RETIRE_BEFORE_CURRENT', `Retirement must be after the current version starts (${current.validFrom})`)
  }
  return { close: { id: current.id, validTo: addDays(effectiveFrom, -1) } }
}

/** Reactivation opens a new open-ended version after the last closed one (a gap in between is legitimate). */
export function planReactivate(versions: BaseVersionRow[], effectiveFrom: IsoDate, today: IsoDate, next: CapacityValues): { insert: BaseVersion } {
  const current = last(versions)
  if (!current || current.validTo === null) throw new InventoryRuleError('ROOM_NOT_RETIRED', 'The room is not retired')
  assertNotInPast(effectiveFrom, today, 'REACTIVATE_IN_PAST')
  if (toEpochDay(effectiveFrom) <= toEpochDay(current.validTo)) {
    throw new InventoryRuleError('REACTIVATE_BEFORE_RETIREMENT_END', `Reactivation must be after the last in-service night (${current.validTo})`)
  }
  return { insert: { validFrom: effectiveFrom, validTo: null, physicalBeds: next.physicalBeds, sellableCapacity: next.sellableCapacity } }
}
```

**Domain / service rules:**
1. **Creating a room** requires an active hotel, an **active floor of this hotel**, an **active room type of this org**, and `inServiceFrom` (a valid date; may be in the past to onboard an existing hotel). The service inserts the `room` and its first base version in one transaction: numbers default to the type's defaults (`origin = 'ROOM_TYPE_DEFAULT'`) or to explicit `physicalBeds`/`sellableCapacity` (`origin = 'MANUAL'`).
2. **Room numbers** are normalized by `normalizeRoomNumber` (`shared/utils/roomNumber.ts`): trim, upper-case, map Arabic-Indic digits (`٠-٩`) to ASCII, then must match `^[A-Z0-9][A-Z0-9./-]{0,19}$` (no inner whitespace, no emoji). Unique per hotel **for its lifetime** (Q2): a retired room's number stays reserved and is never reused; the number is **immutable after creation** (D16).
3. **Base changes** (`POST …/base-config`, permission `capacity.manage`): `planBaseChange` — effective today or later, strictly after the current version starts; closes the open version the day before and opens a new one; history is never rewritten.
4. **Retire / reactivate** (`room.manage`): `planRetire` / `planReactivate`. *Guards for overrides (Task 15) and blocks (Task 16) that extend past the retirement date are added by those tasks to `retireRoom`, each with its own test.*
5. **Editing a room** (`PATCH`, `room.manage`): floor (must be a floor of this hotel), room type, features (subset of `ROOM_FEATURES`: `ACCESSIBLE`, `CONNECTING`, `CITY_VIEW`, `HARAM_VIEW`), notes. **The room number is not editable** (Q2/D16): `updateRoomSchema` is `.strict()` and a body containing `roomNumber` (or `id`, `organizationId`, `hotelId`, capacity fields) is rejected with 422 (`ROOM_NUMBER_IMMUTABLE` for the number, a generic unknown-key error for the rest). Changing a room type **never** changes its capacity — capacity changes only through rule 3. A future audited renumbering workflow is out of scope (D16).
6. **Floor deactivation guard:** a floor with any room whose last base version is open-ended or ends on/after today → `409 FLOOR_HAS_ROOMS`.
7. **Room type defaults are a snapshot** (D1): editing a type's defaults later does not touch existing rooms' base versions.
8. **Bulk create** `POST …/rooms/bulk { floorId, roomTypeId, inServiceFrom, numbers?: string[] | range?: { prefix?, from, to, pad? }, physicalBeds?, sellableCapacity? }`: exactly one of `numbers`/`range`; ≤ `MAX_BULK_ROOMS` (200); duplicates inside the request → 422; conflicts with existing numbers → `409` with `details.conflicts: string[]`; all-or-nothing in one transaction.
9. **Listing** `GET …/rooms?asOf=&floorId=&roomTypeId=&q=&inventory=IN|OUT|ALL&page=&pageSize=`: default `asOf` = hotel-local today; `q` is a case-insensitive prefix match with `%`, `_`, `\` escaped (so `q=%` matches nothing rather than everything); `pageSize ≤ MAX_ROOMS_PER_PAGE`; ordering `floor.level, length(room_number), room_number, id`. Items are `RoomListItem` (S5, below), evaluated for `asOf`.
10. Inactive hotels reject all writes here (`HOTEL_INACTIVE`).

**Room DTOs (`server/services/roomDto.ts`, S5) — every capacity, status and "next change" value is computed on the server by the verified domain functions; the UI only displays them:**
```ts
export interface PeriodRef { id: string, name: string, kind: CapacityPeriodKind, startDate: IsoDate, endDate: IsoDate }
export interface CapacityValues { physicalBeds: number, sellableCapacity: number }
export interface EffectiveCapacityDto extends CapacityValues { source: CapacitySource, period: PeriodRef | null }
export type NextChangeDto =
  | { kind: 'CAPACITY' | 'ENTERS_INVENTORY', date: IsoDate, capacity: EffectiveCapacityDto }
  | { kind: 'LEAVES_INVENTORY', date: IsoDate }

export interface RoomListItem {
  id: string, roomNumber: string,
  floor: { id: string, level: number, label: string },
  roomType: { id: string, code: string, name: string },
  features: RoomFeature[],
  asOf: IsoDate,
  inInventory: boolean,
  lifecycle: { inServiceFrom: IsoDate, lastNight: IsoDate | null },   // first version's start; latest version's valid_to (null = open-ended)
  base: CapacityValues | null,                                        // baseCapacityAt(versions, asOf)
  effective: EffectiveCapacityDto | null,                             // effectiveCapacityAt(versions, overrides, asOf)
  status: InventoryStatus,                                            // buildRoomSegments(input, [asOf, asOf], settings)[0].status
  nextChange: NextChangeDto | null,                                   // nextCapacityChange(versions, overrides, asOf)
}
export interface RoomDetail extends RoomListItem {
  notes: string | null, createdAt: string, updatedAt: string,
  baseVersions: Array<{ id: string, validFrom: IsoDate, validTo: IsoDate | null, physicalBeds: number, sellableCapacity: number, origin: BaseConfigOrigin, reason: string | null, createdAt: string }>,  // full history, oldest first
  seasons: Array<{ overrideId: string, period: PeriodRef & { phase: PeriodPhase }, physicalBeds: number, sellableCapacity: number }>,  // all of the room's overrides; Task 15 fills it, [] before
}
```
Staged delivery, one shape: Task 14 computes `status` with no blocks (so only `AVAILABLE` / `NOT_IN_INVENTORY`) and `nextChange` / `effective` with no overrides; **Task 15** passes overrides and fills `period` names and `seasons`; **Task 16** passes blocks and the `inventory.maintenanceBlocksSales` setting. A list page costs a fixed number of queries (rooms page, their base versions, then overrides and blocks for those room ids once Tasks 15/16 exist), never one per room.

**`nextCapacityChange` (new pure function, `server/domain/inventory/nextChange.ts`, S5) — built only on the verified `capacitySegments`:**
```ts
/** The first change after `asOf` within `horizonNights` (default MAX_CALENDAR_DAYS), or null. */
export function nextCapacityChange(versions: BaseVersion[], overrides: CapacityOverride[], asOf: IsoDate, horizonNights?: number): NextChange | null
```
Rules: let `segs = capacitySegments(versions, overrides, [asOf, asOf + horizon − 1])` (which already merges identical adjacent nights and omits nights not in inventory). If the room is in inventory on `asOf` (`segs[0].from === asOf`): no further boundary inside the horizon → `null`; the next segment starts the night after `segs[0].to` → `CAPACITY` (a change of numbers, source **or** period counts); otherwise → `LEAVES_INVENTORY` on `segs[0].to + 1`. If the room is not in inventory on `asOf`: first segment → `ENTERS_INVENTORY` on its `from`; none → `null`. `capacitySegments` itself is **not** modified.

**Repositories (registry entries required):** `RoomRepository` (Hotel scope: `insert`, `insertMany`, `findById`, `findByNumber`, `findByNumbers`, `listPage`, `update`, `countInInventory(asOf)`, `countInInventoryOnFloor(floorId, asOf)`, `countInInventoryByFloor(asOf)` (one grouped query, S4)); `RoomTypeRepository` (extend, Org scope: `usageCounts(asOf)` — rooms in inventory per type across the organization, one grouped query, S4); `RoomBaseConfigRepository` (Hotel scope: `insert`, `insertMany`, `versionsForRoom`, `versionsForRooms`, `closeVersion(id, validTo)`).

**Endpoints and authorization:**

| Method & path | Permission | Notes |
|---|---|---|
| `GET …/rooms`, `GET …/rooms/:roomId` | `room.view` | `roomId` must belong to **this** hotel → else 404 |
| `POST …/rooms`, `POST …/rooms/bulk`, `PATCH …/rooms/:roomId` | `room.manage` | body ids (`floorId`, `roomTypeId`) not in scope → 422 `INVALID_REFERENCE` (indistinguishable from nonexistent) |
| `POST …/rooms/:roomId/base-config` | `capacity.manage` | 409 with rule code from `InventoryRuleError` |
| `POST …/rooms/:roomId/retire`, `…/reactivate` | `room.manage` | |

**Tests to write first:**
1. (unit) `baseVersions.test.ts` (the verified cases below) and `roomNumber.test.ts` (`' 401 '`→`401`, `'a-12'`→`A-12`, `'٤٠١'`→`401`, `''`, 21 chars, `'4 01'`, `'🏨1'`, `'-4'` rejected).
2. (integration) create copies type defaults → base version with `origin ROOM_TYPE_DEFAULT`, `valid_from = inServiceFrom`, `valid_to null`; explicit numbers → `MANUAL`; a `ROOM_CREATED` audit row with `hotel_id`; room + version + audit are one transaction (spy makes the version insert fail → **no room row remains**).
3. (integration) duplicate number → 409; same number in another hotel OK; `' 401 '`/`'٤٠١'` collide with `401`; a retired room's number still collides (Q2).
4. (integration) **foreign ids:** `floorId` of another hotel (same org) or another org, `roomTypeId` of another org → 422 `INVALID_REFERENCE`; `GET/PATCH/retire` with a `roomId` of hotel A under hotel B's route → 404; nothing written.
5. (integration) inactive floor → 409 `FLOOR_INACTIVE`; inactive room type → 409; inactive hotel → 409 `HOTEL_INACTIVE`.
6. (integration) **snapshot rule:** create a Quad room, then edit the Quad type's defaults to 5/5 → the room's base version is still 4/4; a room created afterwards gets 5/5.
7. (integration) **base change:** new version, old one closed the day before, history queryable; effective-capacity DTO for `asOf` before/after; backdating → 409 `BASE_CHANGE_IN_PAST`; a `room.manage`-only user → 403; `capacity.manage` user → 200.
8. (integration) retire then reactivate (adjacent and with a gap); `inventory=IN` lists exclude a retired room after its last night and include it before (`asOf`); retire twice → 409.
9. (integration) **bulk:** 10 rooms via `range { prefix: '4', from: 1, to: 10, pad: 2 }` → `401…410`; one conflicting number → 409, `details.conflicts`, **zero** rooms created; 201 numbers → 422; duplicates within the request → 422; `numbers` and `range` together → 422.
10. (integration) **concurrency:** two simultaneous creates of room `401` → one 201, one 409; two simultaneous base changes on one room → one succeeds, the other 409 (no overlapping versions in the table).
11. (integration/DB) direct insert of an overlapping base version → `23P01` translated to `409 RANGE_OVERLAP` with the registry message; a base version for a room of another hotel/org rejected by the composite FK.
12. (integration) floor deactivation: a floor with any room in inventory today or later → 409 `FLOOR_HAS_ROOMS`; once every room on it has been retired effective today (their last night is yesterday) the floor can be deactivated.
13. (integration) list filters/pagination: `pageSize=201` → 422, `asOf=2027-02-30` → 422, `q=%` matches nothing, ordering `2,10,101` by `length` then value, empty hotel → 200 empty page.
14. (integration) `roomCount` in `HotelSummary` and `HotelDetail` counts rooms in inventory on the hotel's today (S2).
15. (integration/HTTP) **number immutability and no reuse (Q2/D16):** `PATCH` with `roomNumber` → 422 `ROOM_NUMBER_IMMUTABLE` and the row is unchanged; `PATCH` with `capacity`/`physicalBeds`/`id`/`hotelId` → 422; retiring a room then creating a new room with the same number → 409 (the old row still holds it); no code path other than `insert` writes `room_number` (`git grep -n "roomNumber" server/repositories` shows no update assignment); every FK/URL/audit `entityId` in Tasks 14–19 uses `room.id`.
16. (HTTP) 401/403/404/422/409 mapping for the endpoints; Arabic room number accepted end to end.
17. (unit, `nextChange.test.ts`, S5) open-ended single version → `null`; a base change 30 nights ahead → `CAPACITY` with the new numbers; a scheduled retirement → `LEAVES_INVENTORY` on `valid_to + 1`; not yet commissioned → `ENTERS_INVENTORY`; a closed-then-reopened room (gap) → `LEAVES_INVENTORY`, and from inside the gap → `ENTERS_INVENTORY`; a change beyond the horizon → `null`; `asOf` on the last night of the horizon. *(Task 15 adds the season cases.)*
18. (integration, S5) `RoomListItem` and `RoomDetail` shapes; `status` is `AVAILABLE` / `NOT_IN_INVENTORY` for `asOf` inside / outside the room's versions; `lifecycle` for an open-ended, a retired and a gapped room; `baseVersions` is the complete history, oldest first; a past `asOf` returns the historical base; a 50-room page runs a fixed number of statements (asserted), independent of page size.
19. (integration, S4) `FloorListItem.roomCount` and `RoomTypeListItem.usageCount` count rooms in inventory on the hotel's today and exclude retired rooms; `usageCount` spans all hotels for an `allHotels` caller and is `null` for a hotel-scoped caller; both are single grouped queries.

**Verified base-version tests (from Task 14's own file):**
```ts
import { describe, expect, it } from 'vitest'
import { planBaseChange, planReactivate, planRetire, type BaseVersionRow } from '../../../../server/domain/inventory/baseVersions'
import type { InventoryRuleError } from '../../../../server/domain/inventory/rules'

const TODAY = '2026-09-25'
const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as InventoryRuleError).code } return 'NO_ERROR' }
const open = (over: Partial<BaseVersionRow> = {}): BaseVersionRow => ({ id: 'v1', validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4, ...over })

describe('base version planning', () => {
  it('a permanent change closes the open version the day before and opens a new one', () => {
    const p = planBaseChange([open()], '2026-10-01', TODAY, { physicalBeds: 5, sellableCapacity: 5 })
    expect(p.close).toEqual({ id: 'v1', validTo: '2026-09-30' })
    expect(p.insert).toEqual({ validFrom: '2026-10-01', validTo: null, physicalBeds: 5, sellableCapacity: 5 })
  })
  it('a change effective today is allowed, one in the past is not (history is not rewritten)', () => {
    expect(code(() => planBaseChange([open()], TODAY, TODAY, { physicalBeds: 5, sellableCapacity: 5 }))).toBe('NO_ERROR')
    expect(code(() => planBaseChange([open()], '2026-09-24', TODAY, { physicalBeds: 5, sellableCapacity: 5 }))).toBe('BASE_CHANGE_IN_PAST')
  })
  it('the change must fall after the current version starts', () => {
    expect(code(() => planBaseChange([open({ validFrom: '2026-12-01' })], '2026-12-01', TODAY, { physicalBeds: 5, sellableCapacity: 5 }))).toBe('BASE_CHANGE_BEFORE_CURRENT')
  })
  it('a retired room cannot get a base change', () => {
    expect(code(() => planBaseChange([open({ validTo: '2026-12-31' })], '2027-01-01', TODAY, { physicalBeds: 5, sellableCapacity: 5 }))).toBe('ROOM_NOT_IN_INVENTORY')
    expect(code(() => planBaseChange([], '2027-01-01', TODAY, { physicalBeds: 5, sellableCapacity: 5 }))).toBe('ROOM_NOT_IN_INVENTORY')
  })
  it('retire closes the open version; retiring twice is rejected; past retirement is rejected', () => {
    expect(planRetire([open()], '2027-01-01', TODAY).close).toEqual({ id: 'v1', validTo: '2026-12-31' })
    expect(code(() => planRetire([open({ validTo: '2026-12-31' })], '2027-02-01', TODAY))).toBe('ROOM_ALREADY_RETIRED')
    expect(code(() => planRetire([open()], '2026-09-01', TODAY))).toBe('RETIRE_IN_PAST')
  })
  it('reactivate opens a new version after the last one, adjacent or after a gap', () => {
    const closed = open({ validTo: '2026-12-31' })
    expect(planReactivate([closed], '2027-01-01', TODAY, { physicalBeds: 4, sellableCapacity: 4 }).insert.validFrom).toBe('2027-01-01')
    expect(planReactivate([closed], '2027-06-01', TODAY, { physicalBeds: 4, sellableCapacity: 4 }).insert.validFrom).toBe('2027-06-01')
    expect(code(() => planReactivate([closed], '2026-12-31', TODAY, { physicalBeds: 4, sellableCapacity: 4 }))).toBe('REACTIVATE_BEFORE_RETIREMENT_END')
    expect(code(() => planReactivate([open()], '2027-01-01', TODAY, { physicalBeds: 4, sellableCapacity: 4 }))).toBe('ROOM_NOT_RETIRED')
  })
  it('uses the latest version even when versions are given out of order', () => {
    const versions = [open({ id: 'v2', validFrom: '2026-01-01', validTo: null }), open({ id: 'v1', validFrom: '2025-01-01', validTo: '2025-12-31' })]
    expect(planBaseChange(versions, '2026-10-01', TODAY, { physicalBeds: 5, sellableCapacity: 5 }).close.id).toBe('v2')
  })
})
```

**Verification commands:** `pnpm db:generate --name rooms_base_config && pnpm db:check && pnpm db:drift && pnpm test:integration:fresh && pnpm test:http && pnpm test:unit && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** a room's whole capacity history is queryable; there is no code path that mutates a past night; the database rejects overlapping versions and cross-hotel links; the Room 401 example (4/4 normal) is creatable through the API. Room DTOs carry server-computed `status`, `effective` capacity and `nextChange` (S5); floor and room-type lists carry their counts (S4).

**Commit boundary:** two commits — (1) `feat(domain): base-version planning rules and nextCapacityChange`; (2) `feat: rooms with versioned base configuration, retire/reactivate, bulk create`.

---

### Task 15: Capacity periods and room overrides (migration `0005`)

**Objective:** Seasonal capacity — Hajj, Ramadan, special periods — as date-effective overrides that never overwrite base configuration, preserve history, and cannot overlap.

**Depends on:** 10, 14. **Parallelization:** sequential.

**Files:**
- Modify: `db/schema/inventory.ts` (capacity_period, room_capacity_override), `server/services/roomService.ts` + `roomDto.ts` (retire guard; overrides, `period` refs and `seasons` in room DTOs, S5), `server/repositories/hotel/roomRepository.ts` (`idsInInventoryOn(date)`, S6), `shared/constants/inventory.ts` (`MAX_OVERRIDE_SELECTOR_ROOMS = 1000`, S9), `shared/constants/audit.ts` (`CAPACITY_OVERRIDES_REMOVED`, S8), `server/errors/dbErrors.ts`, registry + fixtures
- Create: `db/migrations/0005_capacity_periods.sql`, `server/domain/inventory/capacityPeriodRules.ts`, `server/repositories/hotel/{capacityPeriodRepository,roomCapacityOverrideRepository}.ts`, `server/services/capacityPeriodService.ts`, `shared/schemas/capacityPeriod.ts`
- Create routes under `server/api/hotels/[hotelId]/`: `capacity-periods/{index.get,index.post}.ts`, `capacity-periods/[periodId]/{index.get,index.patch,index.delete}.ts`, `capacity-periods/[periodId]/overrides/{index.get,index.post,preview.post,remove.post}.ts` (preview: S6, remove: S8), `capacity-periods/[periodId]/overrides/[overrideId].delete.ts`, `rooms/[roomId]/capacity-timeline.get.ts`
- Test: `tests/unit/domain/inventory/capacityPeriodRules.test.ts`, `tests/integration/services/capacityPeriodService.test.ts`, `tests/integration/db/capacityOverrides.test.ts`, `tests/http/capacityPeriods.http.test.ts`

**Schema (verified):**
```ts
export const capacityPeriod = pgTable('capacity_period', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  hotelId: uuid('hotel_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  notes: text('notes'),
  ...stamps(),
}, t => [
  unique('capacity_period_org_hotel_id_unique').on(t.organizationId, t.hotelId, t.id),
  unique('capacity_period_dates_unique').on(t.id, t.startDate, t.endDate),
  unique('capacity_period_hotel_name_unique').on(t.hotelId, t.name),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'capacity_period_hotel_fk' }),
  check('capacity_period_range_check', sql`${t.startDate} <= ${t.endDate}`),
  check('capacity_period_kind_check', sql`${t.kind} in ('HAJJ', 'RAMADAN', 'SPECIAL')`),
])

export const roomCapacityOverride = pgTable('room_capacity_override', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  hotelId: uuid('hotel_id').notNull(),
  roomId: uuid('room_id').notNull(),
  periodId: uuid('period_id').notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  physicalBeds: integer('physical_beds').notNull(),
  sellableCapacity: integer('sellable_capacity').notNull(),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique('room_override_period_room_unique').on(t.periodId, t.roomId),
  foreignKey({ columns: [t.organizationId, t.hotelId, t.roomId], foreignColumns: [room.organizationId, room.hotelId, room.id], name: 'room_override_room_fk' }),
  foreignKey({ columns: [t.organizationId, t.hotelId, t.periodId], foreignColumns: [capacityPeriod.organizationId, capacityPeriod.hotelId, capacityPeriod.id], name: 'room_override_period_fk' }),
  foreignKey({ columns: [t.periodId, t.validFrom, t.validTo], foreignColumns: [capacityPeriod.id, capacityPeriod.startDate, capacityPeriod.endDate], name: 'room_override_period_dates_fk' }).onUpdate('cascade'),
  index('room_override_org_hotel_idx').on(t.organizationId, t.hotelId),
  check('room_override_beds_check', sql`${t.physicalBeds} between 1 and 30`),
  check('room_override_sellable_check', sql`${t.sellableCapacity} between 0 and 30`),
])
```

**Migration `0005`:** `pnpm db:generate --name capacity_periods`, then **append**:
```sql
ALTER TABLE "room_capacity_override" ADD CONSTRAINT "room_override_no_overlap"
  EXCLUDE USING gist ("room_id" WITH =, daterange("valid_from", "valid_to", '[]') WITH &&);
```
Verified behavior (PostgreSQL 16): an override's dates are kept equal to its period's by the composite FK `(period_id, valid_from, valid_to) → capacity_period(id, start_date, end_date) ON UPDATE CASCADE`; shrinking a period cascades to its overrides; **extending** it into another period's override range for the same room is rejected by the exclusion constraint and rolled back; an override with dates different from its period is rejected.

**Verified pure rules (`capacityPeriodRules.ts`):**
```ts
import { MAX_BEDS_PER_ROOM, MAX_CAPACITY_PERIOD_DAYS } from '../../../shared/constants/inventory'
import { type IsoDate, addDays, makeRange, rangeLength, toEpochDay } from '../../../shared/utils/dates'
import type { CapacityValues } from './baseVersions'
import { InventoryRuleError } from './rules'

export interface PeriodDates { startDate: IsoDate, endDate: IsoDate }
export type PeriodPhase = 'FUTURE' | 'ACTIVE' | 'ENDED'

export function periodPhase(p: PeriodDates, today: IsoDate): PeriodPhase {
  if (toEpochDay(p.endDate) < toEpochDay(today)) return 'ENDED'
  if (toEpochDay(p.startDate) > toEpochDay(today)) return 'FUTURE'
  return 'ACTIVE'
}

export function assertPeriodRange(p: PeriodDates): void {
  const range = makeRange(p.startDate, p.endDate)
  if (rangeLength(range) > MAX_CAPACITY_PERIOD_DAYS) {
    throw new InventoryRuleError('PERIOD_TOO_LONG', `A capacity period cannot exceed ${MAX_CAPACITY_PERIOD_DAYS} days`, 'validation')
  }
}

export interface PeriodPatch { name?: string, notes?: string | null, kind?: string, startDate?: IsoDate, endDate?: IsoDate }

/**
 * Editing rules that keep history intact:
 * - ENDED: only name and notes.
 * - ACTIVE: start and kind are frozen; the end may be extended, or shortened down to yesterday
 *   ("end it as of today"), which only removes future nights.
 * - FUTURE: everything editable, but the start may not move into the past.
 */
export function assertPeriodPatchAllowed(period: PeriodDates & { kind: string }, patch: PeriodPatch, today: IsoDate): void {
  const phase = periodPhase(period, today)
  const touchesDates = patch.startDate !== undefined || patch.endDate !== undefined
  if (phase === 'ENDED') {
    if (touchesDates || patch.kind !== undefined) throw new InventoryRuleError('PERIOD_ENDED', 'An ended period is history: only its name and notes can change')
    return
  }
  const next = { startDate: patch.startDate ?? period.startDate, endDate: patch.endDate ?? period.endDate }
  assertPeriodRange(next)
  if (phase === 'ACTIVE') {
    if (patch.startDate !== undefined && patch.startDate !== period.startDate) throw new InventoryRuleError('PERIOD_STARTED', 'The start of a running period cannot change')
    if (patch.kind !== undefined && patch.kind !== period.kind) throw new InventoryRuleError('PERIOD_STARTED', 'The kind of a running period cannot change')
    if (toEpochDay(next.endDate) < toEpochDay(addDays(today, -1))) {
      throw new InventoryRuleError('PERIOD_END_IN_PAST', 'A running period can end at the earliest yesterday; past nights keep their configuration')
    }
    return
  }
  if (toEpochDay(next.startDate) < toEpochDay(today)) throw new InventoryRuleError('PERIOD_START_IN_PAST', 'A future period cannot be moved to start in the past')
}

export function assertOverridesChangeable(period: PeriodDates, today: IsoDate): void {
  if (periodPhase(period, today) !== 'FUTURE') {
    throw new InventoryRuleError('PERIOD_STARTED', 'Overrides can only be added or removed before a period starts; to change a running season, end it as of today and create a new period')
  }
}

export function assertPeriodDeletable(period: PeriodDates, overrideCount: number, today: IsoDate): void {
  if (periodPhase(period, today) !== 'FUTURE') throw new InventoryRuleError('PERIOD_STARTED', 'Only a period that has not started can be deleted')
  if (overrideCount > 0) throw new InventoryRuleError('PERIOD_HAS_OVERRIDES', 'Remove the period\'s room overrides first')
}

export type OverrideSpec =
  | { mode: 'ABSOLUTE', physicalBeds: number, sellableCapacity: number }
  | { mode: 'DELTA', deltaBeds: number, deltaSellable: number }

/** DELTA is applied to the room's BASE capacity on the period's first night. */
export function computeOverrideValues(spec: OverrideSpec, baseAtPeriodStart: CapacityValues): CapacityValues {
  const v = spec.mode === 'ABSOLUTE'
    ? { physicalBeds: spec.physicalBeds, sellableCapacity: spec.sellableCapacity }
    : { physicalBeds: baseAtPeriodStart.physicalBeds + spec.deltaBeds, sellableCapacity: baseAtPeriodStart.sellableCapacity + spec.deltaSellable }
  if (v.physicalBeds < 1 || v.physicalBeds > MAX_BEDS_PER_ROOM || v.sellableCapacity < 0 || v.sellableCapacity > MAX_BEDS_PER_ROOM) {
    throw new InventoryRuleError('OVERRIDE_OUT_OF_RANGE', `Resulting capacity must be 1-${MAX_BEDS_PER_ROOM} beds and 0-${MAX_BEDS_PER_ROOM} sellable`, 'validation')
  }
  return v
}
```

**Service rules:**
1. **Create period** (`capacity.manage`): `name` unique per hotel, `kind ∈ HAJJ|RAMADAN|SPECIAL`, dates valid and ≤ 366 days (`assertPeriodRange`), start may be in the past only for onboarding history (**future-or-past creation is allowed; editing is what is restricted**).
2. **Edit period** — `assertPeriodPatchAllowed` (ended = name/notes only; running = end may extend or be cut to yesterday, start/kind frozen; future = editable, start not into the past). Date edits cascade to override rows through the FK; an exclusion conflict surfaces as `409 RANGE_OVERLAP` ("Changing these dates would give some rooms two overrides on the same night") with the transaction rolled back.
3. **Apply overrides** `POST …/overrides` `{ selector, spec, onConflict?: 'FAIL' | 'SKIP', reason }`:
   - `selector` is exactly one of `{ all: true }`, `{ floorIds }`, `{ roomTypeIds }`, `{ roomIds }` (arrays non-empty, deduplicated, ids must belong to **this** hotel → else 422 `INVALID_REFERENCE`; `roomIds` holds at most `MAX_OVERRIDE_SELECTOR_ROOMS` = 1,000 ids after de-duplication, else 422 — S9). An empty selector never means "everything".
   - `spec` is `ABSOLUTE { physicalBeds, sellableCapacity }` or `DELTA { deltaBeds, deltaSellable }` (DELTA uses each room's **base at the period's first night**; results validated `1…30` beds, `0…30` sellable, else 422).
   - Only while the period is **FUTURE** (`assertOverridesChangeable`). To change a running season: end it as of today and create a new period.
   - A room is *skipped* (reason `NOT_IN_INVENTORY_FOR_PERIOD`) if it is not in inventory for every night of the period, or (reason `ALREADY_OVERRIDDEN`) if it already has an override overlapping the period. `onConflict: 'FAIL'` (default) → `409` with `details.skipped[]` and **no rows written**; `'SKIP'` → applies the rest and returns `{ applied, skipped: [{ roomId, roomNumber, reason }] }`.
   - One transaction, one `CAPACITY_OVERRIDES_APPLIED` audit row (selector, spec, `applied`, skipped count).
4. **Delete override** — only while its period is FUTURE; **delete period** — only FUTURE with zero overrides (`assertPeriodDeletable`). Audit rows for both.
5. **Historical preservation:** `GET …/capacity-periods?includePast=true` lists ended periods; `GET …/rooms/:roomId/capacity-timeline?from&to` (`≤ MAX_CALENDAR_DAYS`) returns `{ range, meta: { today }, segments: capacitySegments(…), refs: { periods: { [id]: PeriodRef } } }` — past ranges resolve against the overrides that were in force; `refs.periods` holds exactly the periods referenced by the returned segments (S13 pattern).
6. **Retire guard:** `retireRoom` rejects with `409 ROOM_HAS_FUTURE_OVERRIDES` if the room has an override ending on or after the retirement date (the room must have them removed first).
7. Inactive hotels reject writes.
8. **Period DTO (S7)** for list and detail: `{ id, name, kind, startDate, endDate, notes, phase, nights, overrideCount, impact: { sellableDelta, bedsDelta } }`. `phase` = `periodPhase(period, hotel today)` (verified rule, unchanged); `nights` = `rangeLength`; `overrideCount` from one grouped query; `impact` = Σ over the period's overrides of (override − `baseCapacityAt(versions, startDate)`), measured on the period's **first night**, from two queries (overrides, then their rooms' base versions) — never per period in a loop. The UI never recomputes phase or impact.
9. **One planning path for apply and preview (S6).** `planOverrideApplication(repos, period, input, today)` resolves the selector, applies `assertOverridesChangeable`, `computeOverrideValues` and the skip rules (`NOT_IN_INVENTORY_FOR_PERIOD`, `ALREADY_OVERRIDDEN`), and returns `{ applied: [{ roomId, roomNumber, before, after }], skipped: [{ roomId, roomNumber, reason }] }`, where `before` is the room's effective capacity on the first night **without** this period. `applyOverrides` calls it inside its transaction and writes; `previewOverrides` calls it read-only and adds:
   `totals: { rooms, bedsBefore, bedsAfter, sellableBefore, sellableAfter }` over `applied`, and
   `hotelTotals: { roomsInInventory, sellableBefore, sellableDuring }` for the whole hotel on the first night (`RoomRepository.idsInInventoryOn(startDate)`, their versions and the overrides covering that night; `sellableDuring` = `sellableBefore` + the selection's delta).
   `POST …/overrides/preview` takes the same body as apply, returns `{ applied, skipped, totals, hotelTotals }`, writes **nothing** and records **no** audit row. Because both share one function, a preview followed by an apply of the same body (with nothing changed in between) produces exactly the previewed rows.
10. **Bulk removal (S8).** `POST …/overrides/remove { overrideIds }` (1…1,000 unique ids): all ids must belong to **this** period (else 422 `INVALID_REFERENCE`, nothing removed); `assertOverridesChangeable` (FUTURE only, else 409 `PERIOD_STARTED`); one transaction deletes them and writes one `CAPACITY_OVERRIDES_REMOVED` audit row (`hotel_id` set, `before` = the removed rows); returns `{ removed: number }`. The single-override `DELETE` stays for the one-room case.
11. **Room DTOs gain seasons (S5).** `roomService` passes each room's overrides to `effectiveCapacityAt`, `nextCapacityChange` and (Task 16) `buildRoomSegments`; `effective.period` and `nextChange.capacity.period` are filled from `CapacityPeriodRepository.findByIds`; `RoomDetail.seasons` lists all of the room's overrides (`findAllForRoom`) with their period ref and `phase`.

**Repositories (registry entries required):** `CapacityPeriodRepository` (Hotel scope: `insert`, `findById`, `list({ includePast, today })`, `findByIds(ids)` (period refs for DTOs, S5/S13), `update`, `delete`, `countOverrides(periodId)`, `overrideCountsByPeriod()` (one grouped query, S7)); `RoomCapacityOverrideRepository` (Hotel scope: `insertMany`, `findByPeriod`, `findByRoomIds(roomIds, range)`, `findAllForRoom(roomId)` (S5), `findOverlapping(roomIds, range)`, `findByIdsInPeriod(periodId, ids)` (S8), `deleteById`, `deleteByIds(ids)` (S8), `existsEndingOnOrAfter(roomId, date)`); `RoomRepository` (extend: `idsInInventoryOn(date)`, S6).

**Endpoints and authorization:** reads (`GET …/capacity-periods`, `…/overrides`, `…/capacity-timeline`) need `room.view`; every write needs `capacity.manage`; `POST …/overrides/preview` also needs `capacity.manage` (it is a step of the write flow, S6); all through `authorizeHotel`; `periodId`/`overrideId`/`roomId` belonging to another hotel or org → 404.

**Tests to write first:**
1. (unit) `capacityPeriodRules.test.ts` (verified cases below).
2. (integration) **the requirement example:** Room 401 (Quad 4/4, in service 2025-01-01); a Hajj 2027 period `2027-05-01…2027-07-31`; apply `ABSOLUTE 6/6` to `roomIds: [401]` → the timeline shows `…-04-30 → 4/4 BASE`, `05-01…07-31 → 6/6 PERIOD_OVERRIDE`, `08-01 → 4/4 BASE`; the base version rows are **unchanged**.
3. (integration) **boundaries (Review Focus #2):** effective capacity on `04-30`, `05-01`, `07-31`, `08-01`; adjacent periods `…-07-31` and `08-01…` both overriding the same room succeed; an overlapping period (`07-15…`) for a room that already has the earlier override → `409` (friendly, via pre-check) **and** at the DB (direct insert → `23P01`); leap-day period `2028-02-01…2028-03-01` includes `02-29`; a 366-day period succeeds, 367 → 422.
4. (integration) **history:** an ended period stays queryable (`includePast=true`, timeline over past dates); editing its dates → 409 `PERIOD_ENDED`; renaming and notes → 200.
5. (integration) running-period rules with an injected clock: shorten to yesterday OK, earlier → 409; start/kind edits → 409; adding overrides → 409 `PERIOD_STARTED`; delete → 409.
6. (integration) **selectors:** `{ floorIds: [] }`, `{}`, two selector kinds together → 422; `{ all: true }` applies to every room in inventory; a `floorId` of another hotel/org → 422; duplicate ids deduplicated; `roomTypeIds` selects by type.
7. (integration) `DELTA` uses base at period start (a room whose base changes mid-period still gets the start-based result); out-of-range results → 422.
8. (integration) `FAIL` vs `SKIP`: a room commissioned mid-period and a room retired mid-period → `NOT_IN_INVENTORY_FOR_PERIOD`; a room already overridden by an overlapping period → `ALREADY_OVERRIDDEN`; `FAIL` writes nothing, `SKIP` writes the rest and reports skips.
9. (integration) **date cascade:** shrinking a period updates its override rows; extending into another period's overridden range → 409 and **both** the period and its overrides unchanged.
10. (integration) **concurrency:** two simultaneous applications of overlapping periods to the same rooms → each room ends up with exactly one override; the loser gets 409 and wrote nothing (whole-transaction atomicity).
11. (integration) authorization: `room.view`-only user can `GET` but gets 403 on `POST`; hotel-scoped user of hotel A gets 404 on hotel B; a `periodId`/`overrideId`/`roomId` from another hotel of the same org → 404; from another org → 404.
12. (integration) retire guard: retiring a room with a future override → 409; after deleting the override → 200.
13. (integration) audit rows for create/update/delete/apply with `hotel_id`; an audit failure rolls the change back; real-error translation for `room_override_no_overlap`, `capacity_period_hotel_name_unique`, `room_override_period_dates_fk`.
14. (integration/DB) with **fresh fixtures per case** (so unique-key errors cannot mask FK errors): an override whose `(org, hotel, period)` mismatches, or whose room belongs to another hotel, is rejected `23503`.
15. (integration, S6) preview: for the Room 401 example it returns `before 4/4`, `after 6/6`, correct `totals` and `hotelTotals`; skipped rooms carry their reasons; **no** override and **no** audit row is written (row counts asserted); preview then apply of the same body yields identical rows; the same 404/422/409 cases as apply (foreign ids, empty selector, running period); `room.view`-only caller → 403.
16. (integration, S7) period DTO at the phase boundaries (`04-30` FUTURE, `05-01` and `07-31` ACTIVE, `08-01` ENDED, injected clock); `overrideCount` and `impact` for a period with ABSOLUTE and DELTA rows; the list runs a fixed number of statements regardless of how many periods exist.
17. (integration, S8) remove 3 of 5 overrides atomically with one audit row; an id from another period or hotel → 422 and nothing removed; after the period starts → 409 `PERIOD_STARTED`; 1,001 ids → 422.
18. (integration, S9) a `roomIds` selector of 1,000 unique ids is accepted (validation level), 1,001 → 422; duplicates are removed before counting.
19. (unit, `nextChange.test.ts`, S5 season cases) the night before a season → `CAPACITY` on the season's first night with its `periodId`; inside a season → `CAPACITY` back to `BASE` on the night after it ends; two adjacent seasons with equal numbers but different periods → `CAPACITY`; (integration) room list/detail show `effective.period` names and `seasons` for Room 401 (Hajj 2027); the capacity-timeline `refs.periods` contains exactly the referenced periods.

**Verified rule tests:**
```ts
import { describe, expect, it } from 'vitest'
import { assertOverridesChangeable, assertPeriodDeletable, assertPeriodPatchAllowed, assertPeriodRange, computeOverrideValues, periodPhase } from '../../../../server/domain/inventory/capacityPeriodRules'
import type { InventoryRuleError } from '../../../../server/domain/inventory/rules'

const TODAY = '2026-09-25'
const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as InventoryRuleError).code } return 'NO_ERROR' }

describe('capacity period rules', () => {
  const hajj = { startDate: '2027-05-01', endDate: '2027-07-31', kind: 'HAJJ' }
  it('phases follow hotel-local today with inclusive boundaries', () => {
    expect(periodPhase(hajj, '2027-04-30')).toBe('FUTURE')
    expect(periodPhase(hajj, '2027-05-01')).toBe('ACTIVE')
    expect(periodPhase(hajj, '2027-07-31')).toBe('ACTIVE')
    expect(periodPhase(hajj, '2027-08-01')).toBe('ENDED')
  })
  it('range and length: 366 days is the cap (a leap year fits, 367 does not)', () => {
    expect(code(() => assertPeriodRange({ startDate: '2028-01-01', endDate: '2028-12-31' }))).toBe('NO_ERROR')
    expect(code(() => assertPeriodRange({ startDate: '2028-01-01', endDate: '2029-01-01' }))).toBe('PERIOD_TOO_LONG')
    expect(() => assertPeriodRange({ startDate: '2027-02-01', endDate: '2027-01-01' })).toThrow()
  })
  it('an ENDED period only accepts name/notes', () => {
    expect(code(() => assertPeriodPatchAllowed(hajj, { name: 'Hajj 1448' }, '2027-09-01'))).toBe('NO_ERROR')
    expect(code(() => assertPeriodPatchAllowed(hajj, { endDate: '2027-08-15' }, '2027-09-01'))).toBe('PERIOD_ENDED')
    expect(code(() => assertPeriodPatchAllowed(hajj, { kind: 'SPECIAL' }, '2027-09-01'))).toBe('PERIOD_ENDED')
  })
  it('an ACTIVE period keeps its start/kind; its end can be extended or cut to yesterday, not into the past', () => {
    expect(code(() => assertPeriodPatchAllowed(hajj, { endDate: '2027-08-10' }, '2027-06-15'))).toBe('NO_ERROR')
    expect(code(() => assertPeriodPatchAllowed(hajj, { endDate: '2027-06-14' }, '2027-06-15'))).toBe('NO_ERROR')
    expect(code(() => assertPeriodPatchAllowed(hajj, { endDate: '2027-06-13' }, '2027-06-15'))).toBe('PERIOD_END_IN_PAST')
    expect(code(() => assertPeriodPatchAllowed(hajj, { startDate: '2027-05-02' }, '2027-06-15'))).toBe('PERIOD_STARTED')
    expect(code(() => assertPeriodPatchAllowed(hajj, { kind: 'SPECIAL' }, '2027-06-15'))).toBe('PERIOD_STARTED')
  })
  it('a FUTURE period is fully editable but cannot move into the past', () => {
    expect(code(() => assertPeriodPatchAllowed(hajj, { startDate: '2027-04-20', endDate: '2027-08-20', kind: 'SPECIAL' }, '2027-03-01'))).toBe('NO_ERROR')
    expect(code(() => assertPeriodPatchAllowed(hajj, { startDate: '2027-02-01' }, '2027-03-01'))).toBe('PERIOD_START_IN_PAST')
  })
  it('overrides may only change, and periods only be deleted, before they start (and empty)', () => {
    expect(code(() => assertOverridesChangeable(hajj, '2027-04-30'))).toBe('NO_ERROR')
    expect(code(() => assertOverridesChangeable(hajj, '2027-05-01'))).toBe('PERIOD_STARTED')
    expect(code(() => assertPeriodDeletable(hajj, 0, '2027-04-30'))).toBe('NO_ERROR')
    expect(code(() => assertPeriodDeletable(hajj, 3, '2027-04-30'))).toBe('PERIOD_HAS_OVERRIDES')
    expect(code(() => assertPeriodDeletable(hajj, 0, '2027-05-01'))).toBe('PERIOD_STARTED')
  })
  it('ABSOLUTE and DELTA override values, with range validation', () => {
    const base = { physicalBeds: 4, sellableCapacity: 4 }
    expect(computeOverrideValues({ mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, base)).toEqual({ physicalBeds: 6, sellableCapacity: 6 })
    expect(computeOverrideValues({ mode: 'DELTA', deltaBeds: 2, deltaSellable: 2 }, base)).toEqual({ physicalBeds: 6, sellableCapacity: 6 })
    expect(computeOverrideValues({ mode: 'DELTA', deltaBeds: 2, deltaSellable: 1 }, base)).toEqual({ physicalBeds: 6, sellableCapacity: 5 })
    expect(code(() => computeOverrideValues({ mode: 'DELTA', deltaBeds: -4, deltaSellable: 0 }, base))).toBe('OVERRIDE_OUT_OF_RANGE')
    expect(code(() => computeOverrideValues({ mode: 'ABSOLUTE', physicalBeds: 31, sellableCapacity: 5 }, base))).toBe('OVERRIDE_OUT_OF_RANGE')
    expect(code(() => computeOverrideValues({ mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: -1 }, base))).toBe('OVERRIDE_OUT_OF_RANGE')
  })
})
```

**Verification commands:** `pnpm db:generate --name capacity_periods && pnpm db:check && pnpm db:drift && pnpm test:integration:fresh && pnpm test:http && pnpm test:unit && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** the Hajj example works through the API; no request can rewrite a past night; overlapping overrides are impossible at the database level and reported clearly at the service level; the room DTOs expose `effective` capacity with its source and period name, `nextChange` including season boundaries, and `seasons` (S5); period DTOs carry server-computed `phase`, `nights`, `overrideCount` and `impact` (S7); the preview returns exactly what apply would write and writes nothing (S6); bulk removal is atomic (S8); the 1,000-room selector cap holds (S9).

**Commit boundary:** two commits — (1) `feat(domain): capacity period edit rules and override computation`; (2) `feat: seasonal capacity periods and room overrides with history preservation, impact preview and bulk removal`.

---

### Task 16: Operational blocks — operational block, maintenance, out of service (migration `0006`)

**Objective:** The date-effective operational layer (D3): rooms unavailable for a dated reason, with history, precedence and overlap protection — never a mutable room status.

**Depends on:** 11, 14. **Parallelization:** sequential (schema migration).

**Files:**
- Modify: `db/schema/inventory.ts` (room_operational_block, incl. the ended-early columns, S11), `server/services/roomService.ts` + `roomDto.ts` (retire guard; blocks and the `maintenanceBlocksSales` setting feed room `status`, S5), `server/errors/dbErrors.ts`, registry + fixtures
- Create: `db/migrations/0006_room_blocks.sql`, `server/domain/inventory/blockRules.ts`, `server/repositories/hotel/operationalBlockRepository.ts`, `server/services/operationalBlockService.ts`, `server/services/blockDto.ts` (S10), `shared/schemas/roomBlock.ts`
- Create routes under `server/api/hotels/[hotelId]/`: `room-blocks/{index.get,bulk.post}.ts`, `room-blocks/[blockId]/cancel.post.ts`, `rooms/[roomId]/blocks.post.ts`
- Test: `tests/unit/domain/inventory/blockRules.test.ts`, `tests/integration/services/operationalBlockService.test.ts`, `tests/integration/db/roomBlocks.test.ts`, `tests/http/roomBlocks.http.test.ts`

**Schema (verified; the three `ended_early` columns and three S11 checks were added after verification and must be re-verified — see "UI/UX reconciliation record"):**
```ts
export const roomOperationalBlock = pgTable('room_operational_block', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  hotelId: uuid('hotel_id').notNull(),
  roomId: uuid('room_id').notNull(),
  kind: text('kind').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  reason: text('reason').notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: uuid('cancelled_by'),
  cancelReason: text('cancel_reason'),         // reason for a cancellation OR an early end (S11)
  endedEarlyAt: timestamp('ended_early_at', { withTimezone: true }),   // S11
  endedEarlyBy: uuid('ended_early_by'),                                 // S11
  originalEndDate: date('original_end_date', { mode: 'string' }),   // S11: the planned last night before the early end
}, t => [
  foreignKey({ columns: [t.organizationId, t.hotelId, t.roomId], foreignColumns: [room.organizationId, room.hotelId, room.id], name: 'room_block_room_fk' }),
  index('room_block_org_hotel_idx').on(t.organizationId, t.hotelId),
  check('room_block_kind_check', sql`${t.kind} in ('OPERATIONAL_BLOCK', 'MAINTENANCE', 'OUT_OF_SERVICE')`),
  check('room_block_range_check', sql`${t.startDate} <= ${t.endDate}`),
  check('room_block_reason_check', sql`char_length(btrim(${t.reason})) > 0`),
  check('room_block_ended_early_check', sql`(${t.endedEarlyAt} is null) = (${t.originalEndDate} is null) and (${t.endedEarlyAt} is null) = (${t.endedEarlyBy} is null)`),     // S11: all or none
  check('room_block_end_state_check', sql`${t.endedEarlyAt} is null or ${t.cancelledAt} is null`),                                                        // S11: cancelled xor ended early
  check('room_block_original_end_check', sql`${t.originalEndDate} is null or ${t.originalEndDate} > ${t.endDate}`),                                       // S11
])
```

**Migration `0006`:** `pnpm db:generate --name room_blocks`, then **append** (verified: same-kind overlap rejected, different kinds may overlap, a cancelled block no longer conflicts). The generated part now also contains the S11 columns and checks; the appended exclusion constraint is unchanged and still keys on `end_date`, so an ended-early block frees the nights after its new end:
```sql
ALTER TABLE "room_operational_block" ADD CONSTRAINT "room_block_no_overlap"
  EXCLUDE USING gist ("room_id" WITH =, "kind" WITH =, daterange("start_date", "end_date", '[]') WITH &&)
  WHERE ("cancelled_at" IS NULL);
```

**Verified pure rules (`server/domain/inventory/blockRules.ts`):**
```ts
import { type IsoDate, addDays, makeRange, rangeLength, toEpochDay } from '../../../shared/utils/dates'
import { InventoryRuleError } from './rules'

export const MAX_BLOCK_DAYS = 731

/** New blocks start today (hotel time) or later: history is recorded by acting on it in time, not by editing the past. */
export function assertBlockCreatable(from: IsoDate, to: IsoDate, today: IsoDate): void {
  const range = makeRange(from, to)
  if (toEpochDay(from) < toEpochDay(today)) throw new InventoryRuleError('BLOCK_IN_PAST', 'A block cannot start in the past', 'validation')
  if (rangeLength(range) > MAX_BLOCK_DAYS) throw new InventoryRuleError('BLOCK_TOO_LONG', `A block cannot exceed ${MAX_BLOCK_DAYS} days`, 'validation')
}

export type CancelAction = { kind: 'CANCEL' } | { kind: 'END_EARLY', newEndDate: IsoDate }

/**
 * - not started: soft-cancel the whole block
 * - running: end it yesterday, so nights already blocked stay blocked in the history
 * - finished or already cancelled: conflict
 */
export function planBlockCancellation(block: { startDate: IsoDate, endDate: IsoDate, cancelledAt: Date | null }, today: IsoDate): CancelAction {
  if (block.cancelledAt) throw new InventoryRuleError('BLOCK_ALREADY_CANCELLED', 'This block is already cancelled')
  if (toEpochDay(block.endDate) < toEpochDay(today)) throw new InventoryRuleError('BLOCK_ALREADY_ENDED', 'This block has already ended')
  if (toEpochDay(block.startDate) >= toEpochDay(today)) return { kind: 'CANCEL' }
  return { kind: 'END_EARLY', newEndDate: addDays(today, -1) }
}
```

**Service rules:**
1. **Create** (`room.block`): `kind ∈ OPERATIONAL_BLOCK|MAINTENANCE|OUT_OF_SERVICE`, `reason` required (non-blank after trim, ≤ 500 chars), `assertBlockCreatable` (starts today or later in hotel time, ≤ 731 days). The room must be **in inventory for every night** of the block (else 422 `ROOM_NOT_IN_INVENTORY_FOR_BLOCK`) — a block on a retired or not-yet-commissioned room is meaningless.
2. **Overlap:** the same room may not have two active blocks of the **same kind** on one night (friendly pre-check `BLOCK_OVERLAP` + the exclusion constraint as backstop); different kinds may overlap (display precedence resolves them).
3. **Cancel** (`POST …/cancel`, `reason` required): `planBlockCancellation` — a block that has not started is soft-cancelled (`cancelled_at`, `cancelled_by`, `cancel_reason`; `BLOCK_CANCELLED`); a running block is **ended yesterday** so nights already blocked stay in the history (`BLOCK_ENDED_EARLY`) — in the same UPDATE the row records `original_end_date` (the planned last night), `ended_early_at`, `ended_early_by` and the reason in `cancel_reason` (S11), so users without `audit.view` can see what happened; the immutable audit row is still written; a finished or already-cancelled block → 409. Blocks are never deleted.
4. **Bulk** `POST …/room-blocks/bulk { kind, startDate, endDate, reason, roomIds | floorId }`: ≤ `MAX_BULK_ROOMS` rooms, all-or-nothing in one transaction, one audit row per block created plus one summary; a conflict returns `409` with `details.conflicts: [{ roomId, roomNumber, reason }]` and writes nothing.
5. **Retire guard:** `retireRoom` rejects with `409 ROOM_HAS_ACTIVE_BLOCKS` if the room has an active block ending on or after the retirement date.
6. Whether a `MAINTENANCE` block stops sales is the hotel setting `inventory.maintenanceBlocksSales`; it does not change what is stored, only how the calendar and available-stay average interpret it (Task 18/17).
7. **Phase 2 seam (documented, not built):** creating a block over nights that hold a booking/hold will be rejected in this same service; the block tables need no change.
8. Inactive hotels reject writes.
9. **Block DTO (S10)** for the list, create and cancel responses:
   ```ts
   export interface BlockListItem {
     id: string, room: { id: string, roomNumber: string }, kind: BlockKind,
     startDate: IsoDate, endDate: IsoDate, nights: number, reason: string,
     phase: 'UPCOMING' | 'RUNNING' | 'ENDED' | 'CANCELLED' | 'ENDED_EARLY',   // blockPhase(block, hotel today)
     cancelAction: 'CANCEL' | 'END_EARLY' | null,                             // planBlockCancellation(block, hotel today), null when it would throw
     createdBy: { id: string, fullName: string } | null, createdAt: string,
     cancelledAt: string | null, cancelledBy: { id: string, fullName: string } | null, cancelReason: string | null,
     endedEarly: { at: string, by: { id: string, fullName: string } | null, originalEndDate: IsoDate, reason: string } | null,   // S11
   }
   ```
   `phase` is for display; the confirmation dialog follows `cancelAction`, because a block starting tonight displays as `RUNNING` yet is fully cancellable (verified rule: start ≥ today → `CANCEL`). Actor names come from a same-organization join (as in S3). The UI never compares dates to decide either value.
10. **Room status (S5).** `roomService` now passes each room's active blocks covering `asOf` (`findActiveForRoomsOn`) and the hotel's `inventory.maintenanceBlocksSales` setting to `buildRoomSegments`, so `RoomListItem.status` shows `OUT_OF_SERVICE` / `MAINTENANCE` / `OPERATIONAL_BLOCK` with the verified precedence.

**New pure function (S10, appended to `blockRules.ts`; the verified functions above are unchanged):**
```ts
export type BlockPhase = 'UPCOMING' | 'RUNNING' | 'ENDED' | 'CANCELLED' | 'ENDED_EARLY'
export function blockPhase(block: { startDate: IsoDate, endDate: IsoDate, cancelledAt: Date | null, endedEarlyAt: Date | null }, today: IsoDate): BlockPhase {
  if (block.cancelledAt) return 'CANCELLED'
  if (block.endedEarlyAt) return 'ENDED_EARLY'
  if (toEpochDay(block.endDate) < toEpochDay(today)) return 'ENDED'
  if (toEpochDay(block.startDate) > toEpochDay(today)) return 'UPCOMING'
  return 'RUNNING'
}
```

**Repository (registry entries required):** `OperationalBlockRepository` (Hotel scope: `insert`, `insertMany`, `findById`, `list({ from, to, roomId, kind, includeCancelled })`, `findActiveOverlapping(roomIds, range, kinds?)`, `markCancelled(id, at, by, reason)`, `endEarly(id, { newEndDate, at, by, reason })` (sets `end_date`, `original_end_date`, `ended_early_at`, `ended_early_by`, `cancel_reason` in one statement; replaces `setEndDate`, S11), `findActiveForRoomsOn(roomIds, date)` (room status, S5), `existsActiveEndingOnOrAfter(roomId, date)`).

**Endpoints and authorization:**

| Method & path | Permission | Notes |
|---|---|---|
| `GET …/room-blocks?from&to&roomId&kind&includeCancelled` | `room.view` | range ≤ `MAX_CALENDAR_DAYS`; `pageSize ≤ 200` |
| `POST …/rooms/:roomId/blocks` | `room.block` | `roomId` of another hotel/org → 404 |
| `POST …/room-blocks/bulk` | `room.block` | body ids outside scope → 422 `INVALID_REFERENCE` |
| `POST …/room-blocks/:blockId/cancel` | `room.block` | `blockId` of another hotel/org → 404 |

**Tests to write first:**
1. (unit) `blockRules.test.ts` (verified below).
2. (integration) create one block of each kind; blank/whitespace `reason` → 422; start in the past (injected clock) → 422; `2028-12-31` length → 422; `to < from` → 422; nights outside the room's inventory → 422.
3. (integration) **overlap:** same kind overlapping → 409 (friendly) and a direct insert → `23P01` translated to `RANGE_OVERLAP`; different kind overlapping OK; adjacent same kind OK; after cancelling the first, the range is free again.
4. (integration) **cancel/end-early:** unstarted → `cancelled_at` set, audit `BLOCK_CANCELLED`; running (clock inside the range) → `end_date = yesterday`, audit `BLOCK_ENDED_EARLY`, nights before today still resolve as blocked; finished → 409; cancelled → 409; the row count never decreases (no deletes).
5. (integration) **foreign ids:** `roomId` of hotel A under hotel B's route → 404; `blockId` of another hotel/org → 404; bulk `roomIds`/`floorId` outside scope → 422; nothing written.
6. (integration) **bulk:** floor selector creates one block per room in inventory; > 200 rooms → 422; one room with a same-kind overlap → 409 with `details.conflicts` and **zero** blocks created; audit summary row.
7. (integration) authorization: Reception (no `room.block`) → 403; Hotel Manager → 200; hotel-scoped user on another hotel → 404; inactive hotel → 409 `HOTEL_INACTIVE`.
8. (integration) **concurrency:** two simultaneous same-kind overlapping creates on one room → one 201, one 409.
9. (integration) retire guard: an active block past the retirement date → 409; after cancelling → 200.
10. (integration/DB) cross-hotel room rejected (`23503`); `kind` and blank-reason check constraints (`23514`); real-error translations for `room_block_no_overlap`.
11. (integration) audit rows have `hotel_id`; a forced audit failure rolls the block back.
12. (HTTP) 401/403/404/409/422 mapping with real cookies.
13. (unit, S10) `blockPhase`: starts tomorrow → `UPCOMING`; starts today → `RUNNING`; ends today → `RUNNING`; ended yesterday → `ENDED`; cancelled → `CANCELLED`; ended early → `ENDED_EARLY` (even though its end is in the past); the verified `planBlockCancellation` tests stay unchanged and pass.
14. (integration, S10) `BlockListItem` shape; `cancelAction` is `CANCEL` for a block starting today (while `phase` is `RUNNING`), `END_EARLY` for one that started yesterday, `null` for ended or cancelled blocks; `createdBy.fullName` resolves within the organization only.
15. (integration/DB, S11) ending a running block early sets `end_date = yesterday`, `original_end_date`, `ended_early_at`, `ended_early_by`, `cancel_reason` in one statement and still writes `BLOCK_ENDED_EARLY` to the audit log; cancelling sets none of the ended-early columns; the three S11 check constraints reject a row with only some ended-early columns, with both `cancelled_at` and `ended_early_at`, and with `original_end_date <= end_date` (`23514`); after an early end, the nights from today are free for a new same-kind block (exclusion constraint on the new `end_date`).
16. (integration, S5) room `status` on `asOf`: `OUT_OF_SERVICE` over `MAINTENANCE` over `OPERATIONAL_BLOCK` on a night where several apply; `MAINTENANCE` with `maintenanceBlocksSales = false` still shows `MAINTENANCE`; a cancelled block does not affect status.

**Verified rule tests:**
```ts
import { describe, expect, it } from 'vitest'
import { assertBlockCreatable, planBlockCancellation } from '../../../../server/domain/inventory/blockRules'
import type { InventoryRuleError } from '../../../../server/domain/inventory/rules'

const TODAY = '2026-09-25'
const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as InventoryRuleError).code } return 'NO_ERROR' }

describe('operational block rules', () => {
  it('new blocks start today or later and are bounded', () => {
    expect(code(() => assertBlockCreatable(TODAY, '2026-09-30', TODAY))).toBe('NO_ERROR')
    expect(code(() => assertBlockCreatable('2026-09-24', '2026-09-30', TODAY))).toBe('BLOCK_IN_PAST')
    expect(code(() => assertBlockCreatable(TODAY, '2028-12-31', TODAY))).toBe('BLOCK_TOO_LONG')
    expect(() => assertBlockCreatable('2026-10-02', '2026-10-01', TODAY)).toThrow()
  })
  it('cancelling: unstarted -> cancel; running -> end yesterday; finished/cancelled -> conflict', () => {
    const b = (startDate: string, endDate: string, cancelledAt: Date | null = null) => ({ startDate, endDate, cancelledAt })
    expect(planBlockCancellation(b('2026-10-01', '2026-10-10'), TODAY)).toEqual({ kind: 'CANCEL' })
    expect(planBlockCancellation(b(TODAY, '2026-10-10'), TODAY)).toEqual({ kind: 'CANCEL' })
    expect(planBlockCancellation(b('2026-09-20', '2026-10-10'), TODAY)).toEqual({ kind: 'END_EARLY', newEndDate: '2026-09-24' })
    expect(planBlockCancellation(b('2026-09-20', TODAY), TODAY)).toEqual({ kind: 'END_EARLY', newEndDate: '2026-09-24' })
    expect(code(() => planBlockCancellation(b('2026-09-01', '2026-09-24'), TODAY))).toBe('BLOCK_ALREADY_ENDED')
    expect(code(() => planBlockCancellation(b('2026-10-01', '2026-10-10', new Date()), TODAY))).toBe('BLOCK_ALREADY_CANCELLED')
  })
})
```

**Verification commands:** `pnpm db:generate --name room_blocks && pnpm db:check && pnpm db:drift && pnpm test:integration:fresh && pnpm test:http && pnpm test:unit && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** blocks are dated, reasoned, auditable and never deleted; same-kind overlap is impossible in the database; running blocks keep their history when ended. An early end is visible on the block row itself to every user who can see the block (S11); block DTOs carry server-computed `phase` and `cancelAction` (S10); room DTOs show block-aware `status` (S5).

**Commit boundary:** two commits — (1) `feat(domain): block creation, cancellation and phase rules`; (2) `feat: operational blocks (block, maintenance, out of service)`.

---

### Task 17: Capacity averages — service and API

**Objective:** Serve the four exact averages (Part C §8) for one hotel or weighted across the hotels the caller may see — automatically, from effective capacity, never from a maintained number.

**Depends on:** 10, 11, 15, 16. **Parallelization:** sequential *(Tasks 17 and 18 share `inventoryReadRepository`; run them one after the other)*.

**Files:**
- Create: `server/repositories/hotel/inventoryReadRepository.ts`, `server/services/capacityAverageService.ts`, `shared/schemas/capacityAverages.ts`
- Create routes: `server/api/hotels/[hotelId]/capacity/averages.get.ts`, `server/api/capacity/averages.get.ts`
- Modify: registry
- Test: `tests/integration/services/capacityAverageService.test.ts`, `tests/integration/performance/averagesScale.test.ts`, `tests/http/capacityAverages.http.test.ts`

**Repository `InventoryReadRepository` (Hotel scope) — the single read path shared with Task 18:**
```ts
loadRoomInputs(range: NightRange, opts?: { roomIds?: string[], includeBlocks: boolean }): Promise<RoomCalendarInput[]>
```
Four indexed queries — rooms (id, number, floor, type) that have any base version overlapping `range`, their base versions overlapping `range`, overrides overlapping `range`, and (when requested) **non-cancelled** blocks overlapping `range` — assembled into `RoomCalendarInput[]` in memory. Every table is queried with `HotelQuery.cond` (org + hotel). The measured cost of these queries on 10,000 rooms is in A1#5.

**Service:** `getHotelAverages(ctx, hotelId, q)` and `getOrganizationAverages(ctx, q)`.
- Hotel: `authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })`; parameters `date` (default hotel-local today) → `base` and `dateEffective`; optional `from`/`to` → `range`; optional `stayCheckIn`/`stayCheckOut` → `availableStay` via `rangeFromStay`.
- Organization: `room.view` org-level; hotel set = accessible **active** hotels (or the explicit `hotelIds`, each of which must be accessible → otherwise 404); one `authorizeHotel` per hotel; combined with `combineAverages` (weighted sums). **When `date` is omitted, each hotel is evaluated on its own hotel-local today** (hotels in different timezones may be on different dates); an explicit `date` applies to every hotel (S12).

**Response shape (all averages):** `{ numerator, denominator, value, display, basis }` where a zero denominator gives `value: null, display: null`; `availableStay` adds `eligibleRoomCount` (and `eligibleRoomIds` only when `includeRoomIds=true`, ≤ 2000); the organization response adds `perHotel: [{ hotelId, code, name, date, base, dateEffective }]` — **each item carries the same average keys as the top level** plus the `date` it was evaluated on; the top-level `date` is the explicit one, or `null` when hotels were evaluated on their own todays (S12).

**Endpoints and authorization:**

| Method & path | Permission | Notes |
|---|---|---|
| `GET /api/hotels/:hotelId/capacity/averages?date&from&to&stayCheckIn&stayCheckOut&includeRoomIds` | `room.view` | `from`/`to` ≤ `MAX_CALENDAR_DAYS`; stay ≤ 90 nights |
| `GET /api/capacity/averages?date&hotelIds` | `room.view` | only accessible hotels; an inaccessible/foreign id in `hotelIds` → 404 |

**Tests to write first:**
1. (integration) **the requirement example end to end:** a hotel of 80 rooms (25 triples, 40 quads, 15 quints, each 3/4/5) → `base.numerator 310`, `denominator 80`, `value 3.875`, `display "3.88"`; nothing typed by a user.
2. (integration) Hajj: 30 rooms overridden to 6 for `2027-05-01…07-31` → `dateEffective` on `2027-06-01` = `(310 + 75 + 10)/80 = 4.9375 → "4.94"`; `base` on the same date is still `3.875`; on `2027-08-01` `dateEffective` is back to `3.875`. *(The 30 rooms are 25 triples + 5 quads: +3 each and +2 each.)*
3. (integration) range average across the period boundary (`2027-07-30…2027-08-02`) is weighted by room-nights and equals the hand-computed value.
4. (integration) **history stays correct:** a room retired effective `2027-01-01` counts in the average on `2026-06-01` and not on `2027-01-01`; a room commissioned on `2027-03-01` is absent before that date.
5. (integration) structural averages **ignore** operational blocks; `availableStay` **excludes** rooms blocked on any night of the stay, uses each room's minimum capacity over the stay, and honors `inventory.maintenanceBlocksSales = false`.
6. (integration) **empty/zero states (Review Focus #4):** a hotel with no rooms; a date before any room exists; all rooms out of service for the stay → `value: null`, `display: null`, HTTP 200, never `0`/`NaN`.
7. (integration) organization endpoint: two hotels of different sizes → weighted result, **not** the mean of the two averages; with `date` omitted and one hotel in `Asia/Riyadh` and one in `UTC` at `2027-05-01T21:30:00Z`, `perHotel[].date` is `2027-05-02` and `2027-05-01` respectively and the top-level `date` is `null`; every `perHotel` item has `base` and `dateEffective` (S12); a user with access to one of two hotels sees only theirs in `perHotel`; `hotelIds` including a hotel of another org or one they cannot access → 404; inactive hotels are excluded by default.
8. (integration) limits: `from > to`, range > 400 days, stay > 90 nights, `2027-02-30` → 422.
9. (integration) rounding: `1/3 → "0.33"`, `2/3 → "0.67"`, `5/2 → "2.50"`.
10. (integration, performance) a 2,000-room hotel (test-only generator through repositories) answers `averages` for a 120-day range in < 1 s, with ≤ 6 SQL statements.
11. (HTTP) 401/403/404/422 mapping; response has no `NaN`/`Infinity` anywhere (JSON round-trip check).

**Verification commands:** `pnpm test:integration && pnpm test:http && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** the 310 ÷ 80 = 3.875 → 3.88 example passes through the real database and API; hotel averages are always computed from effective room capacity; all-hotel figures are weighted sums.

**Commit boundary:** one commit — `feat: capacity averages service and API (base, date-effective, range, available-stay)`.

---

### Task 18: Room calendar and inventory summary — service, API and scale test

**Objective:** The backend of the date-wise room calendar: rows = rooms, columns = dates, served as compressed per-room segments with the required filters, plus daily totals — with proof it scales.

**Depends on:** 11, 15, 16, 17. **Parallelization:** sequential.

**Files:**
- Modify: `server/repositories/hotel/inventoryReadRepository.ts` (add `listRoomCandidates(filters)`; `loadRoomInputs(range, { …, withRefs: true })` also returns `refs` — S13), `server/repositories/hotel/roomRepository.ts` if needed
- Create: `server/services/roomCalendarService.ts`, `shared/schemas/roomCalendar.ts`
- Create routes: `server/api/hotels/[hotelId]/room-calendar.get.ts`, `server/api/hotels/[hotelId]/inventory/daily-summary.get.ts`
- Test: `tests/integration/services/roomCalendarService.test.ts`, `tests/integration/performance/calendarScale.test.ts`, `tests/http/roomCalendar.http.test.ts`

**Query parameters (`GET …/room-calendar`):** `from`, `to` (inclusive, ≤ 400 days), `floorId`, `roomTypeId`, `q` (room-number prefix, escaped), `minCapacity`, `maxCapacity` (sellable capacity on **any** night in the range), `status` (comma list from `AVAILABLE, OPERATIONAL_BLOCK, MAINTENANCE, OUT_OF_SERVICE, NOT_IN_INVENTORY`), `statusMatch=any|all` (default `any`), `includeOutOfInventory` (default `false`: rooms with no in-inventory night in the range are omitted), `page`, `pageSize` (default 50, ≤ 200). The "single date" case is `from = to`.

**Algorithm (no materialization, D4):** (1) structural filters in SQL (floor, type, number prefix, "has a base version overlapping the range" unless `includeOutOfInventory`) → candidate room ids (**> 5,000 candidates → 422 `TOO_MANY_ROOMS`**, unrealistic for one hotel); (2) `loadRoomInputs(range, { roomIds, includeBlocks: true })`; (3) derive segments per room with `buildRoomSegments(input, range, { maintenanceBlocksSales })` (setting read from `hotel_setting`); (4) apply `matchesStatusFilter` and `matchesCapacityFilter`; (5) order `floor.level, length(room_number), room_number`; (6) paginate in memory → exact `total`. `daily-summary` runs (1)–(3) over all matching rooms and returns `summarizeDaily` rows (`from`/`to` ≤ 400 days, optional `floorId`/`roomTypeId`).

**Response:** `{ range, page, pageSize, total, meta: { today, maintenanceBlocksSales }, refs: { periods: { [id]: { name, kind, startDate, endDate } }, blocks: { [id]: { kind, startDate, endDate, reason } } }, rooms: [{ roomId, roomNumber, floor: { id, level, label }, roomType: { id, code, name }, features, segments: CalendarSegment[] }] }` (S13: `meta.today` is the hotel-local today; `refs` contains **exactly** the periods and blocks referenced by the segments of the rooms on this page. They are assembled from rows `loadRoomInputs` already reads — the override query joins `capacity_period` for name, kind and dates, and the block query also selects `reason` — so no statement is added and the ≤ 6-statement bound below still holds. `daily-summary` adds the same `meta`.) — segments are run-length (`from`, `to`, `status`, `sellable`, `physicalBeds`, `sellableCapacity`, `capacitySource`, `periodId`, `blockIds`); the client expands them and virtualizes the grid (Phase 1 builds no UI).

**Endpoints and authorization:** both `GET`, permission `room.view`, `authorizeHotel(…, { allowInactive: true })`; foreign/inaccessible hotel → 404.

**Tests to write first:**
1. (integration) **the requirements' three-room calendar example, expressed with Phase 1 states** (`BOOKED`/`HELD` arrive in Phase 2): `401` (6-bed in Hajj) free, `402` (5) with an `OPERATIONAL_BLOCK` on two nights, `403` (6) with `OUT_OF_SERVICE` on two other nights — segments and run-length merging match the hand-built expectation.
2. (integration) every filter: hotel (foreign → 404), floor, room type, room-number prefix (`q=4` vs `q=40`, `q=%` matches nothing), single date (`from = to`), date range, month and year ranges, capacity (`minCapacity`, `maxCapacity`), status = available / blocked (operational) / maintenance / out of service, `statusMatch` any vs all.
3. (integration) **Hajj visible in the calendar:** Room 401 shows `4` before `2027-05-01`, `6` (`PERIOD_OVERRIDE`) through `07-31`, `4` from `08-01`; a room retired mid-range shows a `NOT_IN_INVENTORY` tail; a room retired before the range is omitted unless `includeOutOfInventory=true`.
4. (integration) `inventory.maintenanceBlocksSales = false`: maintenance nights remain `MAINTENANCE` but `sellable: true`; the daily summary counts them in `maintenance` and in `sellableRooms`.
5. (integration) invariants over a generated hotel: for every returned room the segments cover the range **exactly** (contiguous, no gap/overlap); `summarizeDaily` totals equal the aggregation of the calendar segments for the same filters.
6. (integration) limits and malformed input (Review Focus #5): 401 days → 422; `from > to`; `2027-02-30`; `pageSize=201`; `page=0`; `status=BOGUS`; `minCapacity=-1`; `statusMatch=some`; a page past the end → 200 empty `rooms`, correct `total`.
7. (integration) empty hotel → `total 0`, `rooms []`; daily summary rows all zero.
8. (integration) authorization: no `room.view` → 403; hotel-scoped user without access → 404; inactive hotel readable.
9. (performance, `calendarScale.test.ts`) a 2,000-room hotel (~1,200 base overrides ×3 periods, ~40k blocks, generated through bulk repository inserts): a 100-room × 120-day page **< 300 ms**; the full 400-day daily summary **< 2 s**; **≤ 6 SQL statements per request** (counted by wrapping the test client's `debug` hook); and `EXPLAIN (FORMAT JSON)` of the range queries shows **no `Seq Scan`** on `room_capacity_override`, `room_base_config` or `room_operational_block`. (Measured on the design prototype: ≈1 ms / ≈37 ms — the thresholds have two orders of magnitude of headroom so CI variance cannot flake them.)
10. (HTTP) 401/403/404/422 mapping; a 2,000-room response stays under 2 MB.
11. (integration, S13) every `periodId` and `blockId` in the page's segments has an entry in `refs`, and `refs` has no other entry (a block of a room on another page, or of another hotel, never appears); `meta.today` follows the hotel's timezone with an injected clock; `meta.maintenanceBlocksSales` mirrors the setting; the statement count of test 9 is unchanged (≤ 6) with `refs` on.

**Verification commands:** `pnpm test:integration && pnpm test:http && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** all listed filters work and are tested; the response carries `meta` and page-scoped `refs` (S13); the calendar is served derived (no room×day rows exist anywhere); the scale test passes with the stated bounds; the response format is stable for Phase 2 to add `HELD`/`BOOKED`/`OCCUPIED` segments.

**Commit boundary:** one commit — `feat: room calendar and inventory daily summary (derived, segment-based) with scale test`.

---

### Task 19: Hotel documents and storage abstraction (migration `0007`) — *deferrable (Q3)*

**Objective:** The metadata + storage foundation for hotel documents (license, contract, insurance), with hardened uploads. Nothing else in Phase 1 depends on this task; it may be moved to a later phase without affecting the acceptance gate for inventory. **Approved to stay in Phase 1 (Q3).**

**Deferral protocol (independently deferrable):** if this task is deferred, skip it entirely and adjust exactly these things, nothing else: migration `0007` is not created (the chain ends at `0006`; a later phase claims the next number); `db/schema/documents.ts`, `server/storage/**`, the document repositories/registry entries, routes and `STORAGE_*` env vars are not created; Task 20 seeds no documents (it never does); Task 21 omits the document tables from the `ARCHITECTURE.md` list and the storage line from `DEPLOY_CHECKLIST.md`; acceptance-gate item 1 requires migrations `0001…0006`. No other task may import from `server/storage/**` or `hotel_document`.

**Depends on:** 12. **Parallelization:** its files are disjoint from Tasks 17–18, but its migration number (`0007`) is fixed and it edits the shared registry file — **safe to run in a separate worktree in parallel with 17/18 if merged sequentially**.

**Files:**
- Create: `db/schema/documents.ts`, `db/migrations/0007_documents.sql`, `server/storage/{localStorageDriver,uploadValidation}.ts`, `server/storage/index.ts` (driver factory from env `STORAGE_DRIVER=local`, `STORAGE_LOCAL_DIR=.data/uploads`), `server/repositories/tenant/documentAssetRepository.ts`, `server/repositories/hotel/hotelDocumentRepository.ts`, `server/services/documentService.ts`, `shared/schemas/document.ts`
- Create routes under `server/api/hotels/[hotelId]/documents/`: `index.get.ts`, `index.post.ts` (multipart), `[documentId]/download.get.ts`, `[documentId]/archive.post.ts`
- Modify: `.gitignore` (`.data/`), `.env.example`, registry
- Test: `tests/unit/server/uploads.test.ts`, `tests/integration/services/documentService.test.ts`, `tests/integration/db/documents.test.ts`, `tests/http/documents.http.test.ts`

**Schema (verified — generates cleanly):**
```ts
import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { hotel } from './hotel'
import { organization } from './tenancy'

export const documentAsset = pgTable('document_asset', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(),
  originalFilename: text('original_filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, t => [
  unique('document_asset_org_id_unique').on(t.organizationId, t.id),
  unique('document_asset_storage_key_unique').on(t.storageKey),
  check('document_asset_size_check', sql`${t.sizeBytes} between 1 and 10485760`),
  check('document_asset_mime_check', sql`${t.mimeType} in ('application/pdf', 'image/png', 'image/jpeg')`),
])

export const hotelDocument = pgTable('hotel_document', {
  documentId: uuid('document_id').notNull(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  hotelId: uuid('hotel_id').notNull(),
  docType: text('doc_type').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.documentId] }),
  foreignKey({ columns: [t.organizationId, t.documentId], foreignColumns: [documentAsset.organizationId, documentAsset.id], name: 'hotel_document_asset_fk' }),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'hotel_document_hotel_fk' }),
  index('hotel_document_hotel_idx').on(t.organizationId, t.hotelId),
  check('hotel_document_type_check', sql`${t.docType} in ('LICENSE', 'CONTRACT', 'INSURANCE', 'PERMIT', 'OTHER')`),
])
```

**Verified upload validation and storage driver:**
```ts
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Allow-list: declared MIME type -> file signature the bytes must start with, and the extension we store. */
const ALLOWED = {
  'application/pdf': { signature: [0x25, 0x50, 0x44, 0x46, 0x2d], ext: '.pdf' },
  'image/png': { signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ext: '.png' },
  'image/jpeg': { signature: [0xff, 0xd8, 0xff], ext: '.jpg' },
} as const

export type AllowedMime = keyof typeof ALLOWED

export class UploadRejectedError extends Error {
  constructor(readonly code: 'EMPTY_FILE' | 'FILE_TOO_LARGE' | 'TYPE_NOT_ALLOWED' | 'CONTENT_MISMATCH', message: string) {
    super(message)
    this.name = 'UploadRejectedError'
  }
}

export interface ValidatedUpload { mimeType: AllowedMime, extension: string, safeFilename: string }

/** Display-only filename: no paths, no control characters, bounded length. It is never used to build a storage path. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').replace(/^\.+/, '').trim()
  const limited = cleaned.length > 120 ? cleaned.slice(-120) : cleaned
  return limited.length > 0 ? limited : 'document'
}

/** The declared type must be on the allow-list AND the bytes must carry that type's signature (a renamed .exe is not a PDF). */
export function validateUpload(bytes: Uint8Array, declaredMime: string, filename: string): ValidatedUpload {
  if (bytes.byteLength === 0) throw new UploadRejectedError('EMPTY_FILE', 'The file is empty')
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadRejectedError('FILE_TOO_LARGE', `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  const entry = (ALLOWED as Record<string, { signature: readonly number[], ext: string }>)[declaredMime.toLowerCase()]
  if (!entry) throw new UploadRejectedError('TYPE_NOT_ALLOWED', 'Only PDF, PNG and JPEG files are accepted')
  if (!entry.signature.every((b, i) => bytes[i] === b)) throw new UploadRejectedError('CONTENT_MISMATCH', 'The file content does not match its declared type')
  return { mimeType: declaredMime.toLowerCase() as AllowedMime, extension: entry.ext, safeFilename: sanitizeFilename(filename) }
}
```
```ts
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'

/** Storage abstraction (ARCHITECTURE §15). The database holds metadata and the key; never the bytes. */
export interface StorageDriver {
  put(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Readable>
  exists(key: string): Promise<boolean>
  delete(key: string): Promise<void>
}

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${key}`)
    this.name = 'InvalidStorageKeyError'
  }
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9/_-]*\.[a-z0-9]{2,5}$/

export class LocalStorageDriver implements StorageDriver {
  private readonly root: string
  constructor(rootDir: string) {
    this.root = resolve(rootDir)
  }

  /** Keys are generated by the server (`<orgId>/<yyyy>/<uuid>.<ext>`); this still refuses traversal and absolute paths. */
  private pathFor(key: string): string {
    if (!KEY.test(key) || key.includes('..') || key.includes('//')) throw new InvalidStorageKeyError(key)
    const full = resolve(this.root, key)
    if (!full.startsWith(this.root + sep)) throw new InvalidStorageKeyError(key)
    return full
  }

  async put(key: string, bytes: Uint8Array) {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { flag: 'wx' })
  }

  async get(key: string) {
    return createReadStream(this.pathFor(key))
  }

  async exists(key: string) {
    try {
      await stat(this.pathFor(key))
      return true
    }
    catch (e) {
      if (e instanceof InvalidStorageKeyError) throw e
      return false
    }
  }

  async delete(key: string) {
    await rm(this.pathFor(key), { force: true })
  }
}
```

**Rules:**
- Metadata rows live in Postgres; bytes live behind `StorageDriver` (local disk in dev/test; S3-compatible is Phase 9). Storage keys are **server-generated** (`<orgId>/<yyyy>/<uuid><ext>`), never derived from the filename; the original filename is display metadata only.
- Upload validation = allow-listed MIME **and** matching file signature **and** ≤ 10 MB (`validateUpload`); `sha256` recorded.
- The upload writes the file, then the metadata rows and the `DOCUMENT_ADDED` audit row in one transaction; if the transaction fails the stored object is deleted (compensating action, tested).
- Documents are archived (`archived_at`), never deleted; archived documents are hidden by default and not downloadable except with `includeArchived` by `hotel.manage`.
- Download streams through the API after `authorizeHotel(…, 'hotel.view')` with `Content-Disposition: attachment`, the stored `Content-Type`, and `X-Content-Type-Options: nosniff`. No public URLs.
- Permissions: read `hotel.view`, write `hotel.manage`.

**Tests to write first:** (1) the verified unit suite below; (2) (integration) a document row whose `hotel_id` belongs to another org, or whose asset belongs to another org, is rejected (`23503`); size and MIME check constraints; (3) (integration) upload → metadata + audit + object exist; a failure after the object write deletes the object; duplicate content gets a distinct key; (4) (integration/HTTP) a renamed `.exe` declared as PDF → 422 `CONTENT_MISMATCH`; 10 MB + 1 byte → 422; empty file → 422; SVG → 422; (5) **foreign ids:** `documentId` of another hotel/org → 404 for download and archive; (6) download headers (attachment, nosniff) and an archived document → 404 for viewers; (7) authorization: Reception (`hotel.view`) can download but not upload (403); hotel-scoped user of another hotel → 404; (8) filename `../../etc/passwd` stores under a generated key and displays as `passwd`.

**Verified unit tests:**
```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvalidStorageKeyError, LocalStorageDriver } from '../../../server/storage/localStorageDriver'
import { MAX_UPLOAD_BYTES, UploadRejectedError, sanitizeFilename, validateUpload } from '../../../server/storage/uploadValidation'

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0])
const reason = (fn: () => unknown) => { try { fn() } catch (e) { return (e as UploadRejectedError).code } return 'OK' }

describe('validateUpload', () => {
  it('accepts real PDF, PNG and JPEG content with a matching declared type', () => {
    expect(validateUpload(pdf, 'application/pdf', 'licence.pdf')).toMatchObject({ extension: '.pdf' })
    expect(validateUpload(png, 'image/png', 'a.png')).toMatchObject({ extension: '.png' })
    expect(validateUpload(jpg, 'IMAGE/JPEG', 'a.jpeg')).toMatchObject({ mimeType: 'image/jpeg', extension: '.jpg' })
  })
  it('rejects a declared type that is not on the allow-list', () => {
    expect(reason(() => validateUpload(pdf, 'application/x-msdownload', 'a.exe'))).toBe('TYPE_NOT_ALLOWED')
    expect(reason(() => validateUpload(pdf, 'text/html', 'a.html'))).toBe('TYPE_NOT_ALLOWED')
    expect(reason(() => validateUpload(pdf, 'image/svg+xml', 'a.svg'))).toBe('TYPE_NOT_ALLOWED')
  })
  it('rejects content that does not match the declared type (renamed file)', () => {
    expect(reason(() => validateUpload(new TextEncoder().encode('MZ...'), 'application/pdf', 'invoice.pdf'))).toBe('CONTENT_MISMATCH')
    expect(reason(() => validateUpload(png, 'application/pdf', 'x.pdf'))).toBe('CONTENT_MISMATCH')
  })
  it('rejects empty and oversized files at the boundary', () => {
    expect(reason(() => validateUpload(new Uint8Array(), 'application/pdf', 'a.pdf'))).toBe('EMPTY_FILE')
    const exactly = new Uint8Array(MAX_UPLOAD_BYTES); exactly.set(pdf)
    expect(reason(() => validateUpload(exactly, 'application/pdf', 'a.pdf'))).toBe('OK')
    expect(reason(() => validateUpload(new Uint8Array(MAX_UPLOAD_BYTES + 1), 'application/pdf', 'a.pdf'))).toBe('FILE_TOO_LARGE')
  })
})

describe('sanitizeFilename (display only)', () => {
  it('strips paths, control characters and leading dots; bounds length; falls back', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Users\\x\\licence.pdf')).toBe('licence.pdf')
    expect(sanitizeFilename('a\u0000b\u001F.pdf')).toBe('ab.pdf')
    expect(sanitizeFilename('.hidden')).toBe('hidden')
    expect(sanitizeFilename('ترخيص الفندق.pdf')).toBe('ترخيص الفندق.pdf')
    expect(sanitizeFilename('x'.repeat(500) + '.pdf').length).toBeLessThanOrEqual(120)
    expect(sanitizeFilename('   ')).toBe('document')
    expect(sanitizeFilename('')).toBe('document')
  })
})

describe('LocalStorageDriver', () => {
  let dir: string
  let driver: LocalStorageDriver
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'hotel-uploads-')); driver = new LocalStorageDriver(dir) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('stores, reads, checks existence and deletes by server-generated key', async () => {
    const key = '11111111-1111-1111-1111-111111111111/2026/abc-123.pdf'
    await driver.put(key, pdf)
    expect(await driver.exists(key)).toBe(true)
    const chunks: Buffer[] = []
    for await (const c of await driver.get(key)) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(pdf))
    await driver.delete(key)
    expect(await driver.exists(key)).toBe(false)
  })
  it('never overwrites an existing object', async () => {
    const key = 'org/2026/once.pdf'
    await driver.put(key, pdf)
    await expect(driver.put(key, pdf)).rejects.toThrow()
  })
  it('refuses traversal, absolute paths, double slashes and odd characters', async () => {
    for (const bad of ['../evil.pdf', 'a/../../evil.pdf', '/etc/passwd.pdf', 'a//b.pdf', 'a/b.pdf/', 'a b.pdf', 'a\\b.pdf', 'noext', '']) {
      await expect(driver.put(bad, pdf)).rejects.toBeInstanceOf(InvalidStorageKeyError)
      await expect(driver.exists(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError)
    }
  })
})
```

**Verification commands:** `pnpm db:generate --name documents && pnpm db:check && pnpm db:drift && pnpm test:integration:fresh && pnpm test:http && pnpm test:unit && pnpm lint && pnpm typecheck`.

**Acceptance criteria:** hotel documents can be uploaded, listed, downloaded and archived under the stated permissions; no path derived from user input ever reaches the filesystem; the driver interface is the only storage dependency.

**Commit boundary:** one commit — `feat: hotel documents with storage abstraction and hardened uploads`.

---

### Task 20: Demo dataset — personas, hotel assignments, realistic inventory, reset regression

**Objective:** Grow the isolated Demo Organization from "one admin" into a presentation-quality, deterministic, internally consistent dataset (5 hotels, 360 rooms, seasonal history and future seasons, blocks, retired rooms, 9 personas with hotel-scoped access), and prove the reset is still safe with a wide FK graph.

**Depends on:** 12–18 (19 optional). **Parallelization:** sequential (rewrites `db/seed/*`).

**Files:**
- Create: `db/seed/demo/{ids,random,inventory,index}.ts`, `tests/support/fingerprint.ts`, `server/demo/{catalog,personas}.ts` (hotel catalogue and persona catalogue shared by the seed and the demo sign-in endpoint; pure data, no database imports — S14), `server/services/demoSignInService.ts`, `server/api/public/demo-sign-in.get.ts` (S14 / D9)
- Modify: `db/seed/demo-org.ts`, `db/seed/rbac.ts`, `db/seed/index.ts`, `tests/integration/db/seed.test.ts` and `tests/integration/services/demo-service.test.ts` (import `DEMO_ADMIN_EMAIL`/`DEMO_PASSWORD` from `server/demo/personas.ts` instead of `db/seed/demo-org.ts`; import path only, S14), `tests/unit/server/env.test.ts` (`DEMO_SIGN_IN_ENABLED` cases), `server/services/demo.service.ts`, `server/api/admin/demo/reset.post.ts`, `server/utils/env.ts` (`ALLOW_DEMO_SEED`, `DEMO_ANCHOR_DATE`, `DEMO_SIGN_IN_ENABLED`), `.env.example`, `README.md`
- Test: `tests/unit/seed/demoDeterminism.test.ts`, `tests/integration/demo/{demoInventory,demoPersonas,demoReset,demoGuard,demoSignIn}.test.ts`, `tests/http/{demo,demoSignIn}.http.test.ts`

**API / authorization:** one new **unauthenticated, runtime-gated** endpoint for the demo sign-in experience (S14, D9; below); `POST /api/admin/demo/reset` keeps Task 7's rules (`organization.resetDemo` — held only by the demo organization's Super Admin — plus demo-organization membership) and additionally accepts an optional `anchorDate`. The `admin` persona keeps the Phase 0 login `admin@demo.alsafahotels.test`.

**Verified building blocks (Task 20 copies these):**

`db/seed/demo/ids.ts`
```ts
import { createHash } from 'node:crypto'

/** Fixed namespace for every demo id. Random-looking but constant: the same key always yields the same UUID. */
export const DEMO_NAMESPACE = '5b1c2f0e-8f0a-4c67-9d6a-3e1f4a7c9b21'

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

/** RFC 4122 version-5 (SHA-1, name-based) UUID. */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash('sha1').update(uuidToBytes(namespace)).update(name, 'utf8').digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6]! & 0x0f) | 0x50
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** deterministicId('room', 'MKK-GRAND', '401') is identical on every seed, in every environment. */
export function deterministicId(kind: string, ...parts: string[]): string {
  return uuidV5([kind, ...parts].join('|'), DEMO_NAMESPACE)
}
```

`db/seed/demo/random.ts`
```ts
/** mulberry32: a tiny seeded PRNG. Same seed, same sequence, on every machine. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Stable string -> 32-bit seed (FNV-1a), so each hotel/period gets its own independent, reproducible stream. */
export function seedFromString(s: string): number {
  let h = 0x811C9DC5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Deterministic Fisher-Yates; returns a new array. */
export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}
```

`tests/unit/seed/demoDeterminism.test.ts` (includes the RFC 4122 reference vector `uuidV5('www.example.com', DNS namespace) = 2ed6657d-e927-568b-95e1-2665a8aea6a2`)
```ts
import { describe, expect, it } from 'vitest'
import { DEMO_NAMESPACE, deterministicId, uuidV5 } from '../../../db/seed/demo/ids'
import { mulberry32, seedFromString, shuffled } from '../../../db/seed/demo/random'

describe('uuidV5', () => {
  it('matches the RFC 4122 / Python reference vector (DNS namespace, "www.example.com")', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })
  it('is a valid version-5 uuid', () => {
    expect(deterministicId('room', 'MKK-GRAND', '401')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
describe('deterministicId', () => {
  it('is stable across calls and distinct across keys', () => {
    expect(deterministicId('hotel', 'MKK-GRAND')).toBe(deterministicId('hotel', 'MKK-GRAND'))
    expect(deterministicId('hotel', 'MKK-GRAND')).not.toBe(deterministicId('hotel', 'MKK-AJYAD'))
    expect(deterministicId('room', 'A', '401')).not.toBe(deterministicId('room', 'B', '401'))
  })
  it('does not confuse part boundaries', () => {
    expect(deterministicId('a', 'bc')).not.toBe(deterministicId('ab', 'c'))
  })
  it('the namespace is a fixed valid uuid', () => {
    expect(DEMO_NAMESPACE).toMatch(/^[0-9a-f-]{36}$/)
  })
})
describe('mulberry32', () => {
  it('produces the same sequence for the same seed and a different one for another seed', () => {
    const a = mulberry32(42); const b = mulberry32(42); const c = mulberry32(43)
    const sa = [a(), a(), a(), a()]
    expect(sa).toEqual([b(), b(), b(), b()])
    expect(sa).not.toEqual([c(), c(), c(), c()])
  })
  it('stays within [0, 1)', () => {
    const r = mulberry32(seedFromString('MKK-GRAND'))
    for (let i = 0; i < 10_000; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
  })
  it('pins the first value for seed 42 so an accidental algorithm change is caught', () => {
    expect(mulberry32(42)()).toBeCloseTo(0.6011037519201636, 12)
  })
})
describe('shuffled', () => {
  it('is deterministic, a permutation, and does not mutate its input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const one = shuffled(input, mulberry32(7)); const two = shuffled(input, mulberry32(7))
    expect(one).toEqual(two)
    expect([...one].sort((x, y) => x - y)).toEqual(input)
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})
```

**Design (decisions D12; details in Part C §9):**
1. **Deterministic ids:** organization, roles, users, hotels, floors, room types, rooms, periods, overrides, blocks and base versions all get `deterministicId(kind, …stable key)`. A reset recreates rows with the **same ids**, so sessions, bookmarks and cached client state survive it (this also removes the Phase 0 "second reset returns 403" quirk).
2. **Anchor date:** every time-relative row hangs off `DEMO_ANCHOR_DATE` (default `2026-09-01`, overridable through env or a reset parameter); the seed writes rows directly through repositories (so historical rows are allowed) but must satisfy every constraint the API enforces — the DB exclusion constraints are the referee.
3. **Reproducible randomness:** each hotel/period draws from `mulberry32(seedFromString('<hotel code>|<purpose>'))`; no `Math.random`, no `Date.now()` inside the generator.
4. **One Argon2 hash** is computed once and reused for all personas (the demo password is public by design and documented in the README; the seed **refuses to run** when `APP_ENV=production` unless `ALLOW_DEMO_SEED=true`).
5. **Bulk writes:** repositories' `insertMany` in chunks of ≤ 500 rows; the whole seed is one transaction so a failure leaves the previous demo data intact; target < 15 s including the cascade delete.
6. **Seeds go through tenant repositories** under `trustedOrganizationScope(demoOrgId)` (D7); `db/seed/**` may not import tables (fitness test).

**Catalogue (`server/demo/catalog.ts`):**

| Code | Name | City | Ownership | In service | Floors (levels) | Rooms | Triple / Quad / Quint / Six-bed | Capacity (initial) |
|---|---|---|---|---|---|---|---|---|
| `MKK-GRAND` | Al Safa Grand Makkah | Makkah | OWNED | 2025-01-01 | 10 (2–11) | 100 | 10 / 40 / 30 / 20 | 460 → 4.60 |
| `MKK-AJYAD` | Al Safa Ajyad Towers | Makkah | CONTRACTED | 2025-01-01 | 8 (1–8) | 80 | 25 / 40 / 15 / 0 | **310 → 3.875 → "3.88"** |
| `MKK-AZIZ` | Al Safa Aziziyah Residence | Makkah | LEASED | 2025-01-01 | 6 (1–6) | 60 | 0 / 18 / 24 / 18 | 300 → 5.00 |
| `MED-CENT` | Al Safa Madinah Central | Madinah | OWNED | 2025-01-01 | 7 (1–7) | 70 | 18 / 26 / 18 / 8 | 296 → 4.23 |
| `MED-QUBA` | Al Safa Quba Suites | Madinah | OWNED | 2025-06-01 | 5 (1–5) | 50 | 8 / 22 / 20 / 0 | 212 → 4.24 |

Total **360 rooms** (organization base average on `2025-07-01`: 1578 ÷ 360 = 4.3833 → `"4.38"`). Ten rooms per floor; room numbers `<level><nn>` (`201…210`, `301…`). Room types are the four organization-level types `TRIPLE 3/3`, `QUAD 4/4`, `QUINT 5/5`, `SIX_BED 6/6`. **Room `401` of `MKK-GRAND` is forced to be a Quad on level 4** (the requirements' example): normal 4/4, Hajj 2027 6/6. About 5 % of rooms have `sellable < beds` at the base level (connecting/staff-hold rooms) so the two numbers visibly differ. Hotel timezone `Asia/Riyadh`, currency `SAR`, check-in `15:00`, check-out `12:00`.

**History and configuration generated on top (all rules deterministic):**
- **Renovations:** ~8 % of rooms per hotel get +1 bed (max 6) from `2026-03-01` (two base versions) — dated **after** `2025-07-01`, so the catalogue averages above hold on that reference date.
- **Retired / inactive:** 2 rooms per hotel retired effective `2026-04-01`; 1 room per hotel closed `2026-05-01…2026-06-30` and reactivated from `2026-07-01` (a gap); all of `MKK-AZIZ` level 6 retired effective `2026-06-01` and that floor set inactive; 2 `MKK-GRAND` rooms scheduled to retire effective `2027-09-01`.
- **Capacity periods** (per hotel, `notes` explain the operational reason): `Ramadan 2026` (`2026-02-18…03-19`, past), `Hajj 2026` (`2026-05-01…07-31`, past), `Umrah Peak Dec 2026` (`SPECIAL`, `2026-12-15…2027-01-15`, `MKK-AJYAD` and `MKK-AZIZ` only), `Ramadan 2027` (`2027-02-08…03-09`), **`Hajj 2027` (`2027-05-01…07-31`)**, `Hajj 2028` (`2028-04-19…07-19`, `MKK-GRAND` and `MKK-AJYAD` only). Makkah hotels override ~70–80 % of rooms in Hajj (+2 beds, capped at 6, sellable = beds), Madinah ~50–60 % (+1); Ramadan ~40–50 % (+1). Rooms not in inventory for a whole period are skipped by the same rule the API uses.
- **Blocks** (~25 per hotel, ~125 total): running maintenance at the anchor (4 per hotel), future pre-Hajj maintenance (`2027-02-01…03-01`, Makkah), operational blocks ("Reserved for management", "Staff accommodation"), out-of-service (AC failure, water leak; one 90-day), historical maintenance, 2 **cancelled** and 2 **ended early** per hotel. No same-kind overlaps per room (the exclusion constraint enforces it at seed time).
- Volume: ≈ 360 rooms, ≈ 450 base versions, ≈ 1,100 overrides, ≈ 30 periods, ≈ 125 blocks, 9 users, ≈ 14 access rows.

**Personas (`server/demo/personas.ts`; every password is the documented demo password; emails `<key>@demo.alsafahotels.test`; display names are realistic but fictional — S14):**

| Key | Display name | Role | Hotel access | Phase 1 availability (D13) |
|---|---|---|---|---|
| `admin` | Faisal Al-Otaibi | Super Admin (+ `organization.resetDemo`) | all hotels | available |
| `manager.grand` | Nora Al-Qahtani | Hotel Manager | `MKK-GRAND` | available |
| `manager.madinah` | Omar Siddiqui | Hotel Manager | `MED-CENT`, `MED-QUBA` | available |
| `reservations` | Aisha Rahman | Reservation Manager | `MKK-GRAND`, `MKK-AJYAD`, `MKK-AZIZ` | available (read-only inventory) |
| `accountant` | Khalid Al-Harbi | Accountant | all hotels | **available in later phases** |
| `hr` | Maryam Yusuf | HR Manager | `MKK-GRAND`, `MKK-AJYAD`, `MED-CENT` | **available in later phases** |
| `reception.grand` | Ahmed Hassan | Reception | `MKK-GRAND` | available (read-only inventory) |
| `reception.ajyad` | Imran Chowdhury | Reception | `MKK-AJYAD` | available (read-only inventory) |
| `management` | Sarah Al-Mutairi | Read-only Management | all hotels | available (read-only) |

No persona's permissions or hotel access change: the "later phases" label is presentation only (D13), and Reception stays without `room.block` (D10). The catalogue exports `{ key, email, fullName, roleKey, hotelCodes, phase1Available }` — **never** a password or hash.

**Demo sign-in endpoint (S14, D9) — the only way the sign-in page learns demo shortcuts:** `GET /api/public/demo-sign-in` (no session). It answers **404, indistinguishable from an unknown route**, unless `DEMO_SIGN_IN_ENABLED=true` **and** `APP_ENV` is `development` or `demo`; with `APP_ENV=production` or `staging` it is always 404, whatever the flag says (checked in `getEnv()` as well: `DEMO_SIGN_IN_ENABLED=true` with `APP_ENV=production` fails validation at startup). The service reads only the static catalogues (`server/demo/{catalog,personas}.ts`) and checks, through the existing `PlatformOrganizationRepository.findBySlug('demo')`, that an organization with `is_demo = true` exists; it mints no tenant scope and runs no tenant query (only `server/security`, seeds and tests may mint scopes). When enabled and the demo organization exists, it returns `{ organizationSlug: 'demo', password: <the documented demo password>, personas: [{ email, fullName, roleName, hotels: [{ code, name }], phase1Available }] }`; when the demo organization does not exist, 404. This is a runtime switch, not a build variant, so the same image runs everywhere (ARCHITECTURE §17) and a production deployment cannot serve demo credentials even by accident. The demo credential constants (`DEMO_ADMIN_EMAIL`, and `DEMO_ADMIN_PASSWORD` renamed `DEMO_PASSWORD` since all nine personas share it) move from `db/seed/demo-org.ts` to `server/demo/personas.ts`, the single place the seed, this endpoint and the Phase 0 tests read them.

**Reset:** `resetDemoData(actor, { anchorDate? })` — same transaction, membership and `isDemo` checks as Phase 0; deletes the demo organization (one cascade, verified to work across the whole Phase 1 graph, A1#4) and reseeds under the same ids; writes the `DEMO_RESET` audit row.

**Tests to write first:**
1. (unit) `demoDeterminism.test.ts` (verified above) + catalogue arithmetic: totals 360 rooms, per-hotel type counts sum to room counts, capacities as tabulated.
2. (integration, `demoInventory`) **determinism:** seed twice (truncate between) → `fingerprint()` (SHA-256 over every inventory table's rows sorted by id, excluding `created_at`/`updated_at`) is identical.
3. (integration) **catalogue invariants:** 5 hotels in Makkah/Madinah, exactly 360 rooms; per hotel and per room type counts match the table; floors and rooms-per-floor as specified; unique numbers per hotel; `MKK-GRAND` room `401` is a Quad on level 4.
4. (integration) **the requirement examples through the real services:** `MKK-AJYAD` base average on `2025-07-01` = `310/80 → "3.88"`; organization average `"4.38"`; Room 401 effective capacity `4/4` on `2027-04-30`, `6/6` on `2027-05-01` and `2027-07-31`, `4/4` on `2027-08-01`; `Hajj 2026` (past) is queryable and shows the historical override; sellable ≠ beds for the flagged rooms.
5. (integration) **consistency:** every override's dates equal its period's; every room has ≥ 1 base version and no overlaps; retired/inactive rooms and the inactive floor are consistent (no in-inventory room on an inactive floor at the anchor); blocks include every kind, cancelled and ended-early rows; the calendar segments of a generated hotel cover their range exactly and match `summarizeDaily`.
6. (integration, `demoPersonas`) 9 personas exist; each persona's resolved hotel set equals the table; each can log in; **hotel-scoped isolation:** `reception.grand` gets 404 for `MKK-AJYAD` and Madinah hotels; `manager.madinah` gets 404 for Makkah; `reservations` sees exactly the three Makkah hotels; `management`/`accountant` see all; `management` gets 403 on every write; `reception.*` gets 403 on `room.block`; a Hotel Manager can block but cannot create hotels (403).
7. (integration, `demoReset`) after arbitrary changes (a new room, a base change, a block, audit rows) `resetDemoData` returns the demo organization to **exactly the fresh-seed fingerprint**; the admin's user id and the organization id are unchanged; a **second reset with the same identity** succeeds.
8. (integration) **cross-tenant safety with a wide graph:** a second, fully populated non-demo organization (hotels, floors, rooms, versions, periods, overrides, blocks, users, access rows, audit rows) has an identical fingerprint before and after a demo reset; a real organization holding the slug `demo` (not `is_demo`) is refused and untouched.
9. (integration) **atomicity:** with a repository spied to throw during the blocks step, the reset fails and the previous demo fingerprint is intact; two concurrent resets both settle (each succeeds or is refused for a stale actor), leaving one demo organization equal to the fresh fingerprint.
10. (integration) **performance:** a full reset completes in < 15 s (CI-generous; expected ≈ 1–3 s) and runs a bounded number of statements (chunked inserts), proving FK indexes make the cascade cheap.
11. (integration, `demoGuard`) seeding with `APP_ENV=production` and no `ALLOW_DEMO_SEED` throws; with the flag it runs; a cross-org same-email user is still never adopted (Phase 0 regression retained).
12. (HTTP) two consecutive `POST /api/admin/demo/reset` with the same cookie both return 200; persona logins work over HTTP; `reservations` lists three hotels and gets 404 on `MED-CENT`.
13. (integration, `demoPersonas`, S14) every persona has its display name, and `GET /api/auth/me` returns it as `user.fullName`; `accountant` and `hr` keep exactly their role permissions (no `room.view`) and are marked `phase1Available: false`; `reception.*` still lack `room.block`.
14. (integration + HTTP, `demoSignIn`, S14/D9) the endpoint returns 404 with the flag off; 404 with the flag on and `APP_ENV=production` (and `getEnv()` rejects that combination at startup); 404 when no `is_demo` organization exists; with `APP_ENV=demo` and the flag on it returns the slug, the password and nine personas, and the payload contains no hash, no user id and no data of any other organization; the 404 body is byte-identical to an unknown route's.

**Verification commands:** `pnpm test:unit && pnpm test:integration && pnpm test:http && pnpm db:seed && pnpm db:seed && pnpm lint && pnpm typecheck` (the second `db:seed` proves idempotency).

**Acceptance criteria:** the demo tells the Hajj story on first login (room 401, the 3.88 average, seasonal history, blocks, personas with different views); personas carry realistic display names and unchanged least-privilege access; demo sign-in shortcuts are served only by the gated endpoint and never in production (S14, D9, D13); reset restores it exactly and touches nothing else; every generated row passes the same constraints the API enforces. **Demo dates are data, not rules (Q4):** the demo period dates live only in `db/seed/demo/**` (anchored on `DEMO_ANCHOR_DATE`) and are created through the same period/override services a real user would call; verify by inspection plus `git grep -nE "20[0-9]{2}-[0-9]{2}-[0-9]{2}" server shared db/schema db/migrations` finding no season/period date literals (validity bounds such as the 1900/2200 year limits are not season dates), and by a test that a period with different dates and `kind` behaves identically.

**Commit boundary:** two commits — (1) `feat(seed): deterministic ids/random and demo catalogue with personas`; (2) `feat(seed): demo inventory, seasonal capacity, blocks, and reset regression suite`.

---

### Task 21: Documentation, CI and the Phase 1 acceptance gate

**Objective:** Make the new guarantees permanent: documentation that matches the code, a CI pipeline that runs every check, and one acceptance scenario that fails if the phase regresses.

**Depends on:** all. **Parallelization:** sequential (final).

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `README.md`, `docs/MIGRATIONS.md`, `.env.example`, `.github/workflows/ci.yml`, `package.json`
- Create: `docs/DEPLOY_CHECKLIST.md`, `tests/integration/acceptance/phase1.test.ts`

**API / authorization:** none. **Tests to write first:** the acceptance scenario `phase1.test.ts` (below) is written first against the seeded demo; the CI job definitions are exercised by pushing a branch.

**Documentation updates:**
- `docs/UI-UX-MASTER-DIRECTION.md` §42: confirm every S1–S14 contract matches the shipped DTOs and endpoints (field names, `null` rules, gating); record any deliberate difference.
- `ARCHITECTURE.md`: replace §9 with the Phase 1 inventory architecture (D2–D5, formulas of Part C §8); update §6 table lists (add `room_base_config`, `room_operational_block`, `hotel_setting`, and (only if Task 19 shipped) `document_asset`, `hotel_document`; remove `room_status_event`, `session`); update §7/§8 (branded scopes, per-request authorization, `all_hotels`, 404/403 rules); §14 (deterministic ids, personas, anchor date, seed guard); §22 (HTTP harness in Phase 1; browser E2E tests arrive with the Phase 1 UI plan per `docs/UI-UX-MASTER-DIRECTION.md` §45 instead of "from Phase 2"); append the Divergence Register (A2) as a changelog.
- `README.md`: workflow (`db:generate`, `db:check`, `db:drift`, `test:integration:fresh`, `test:http`, `verify`), demo personas table, the demo password disclaimer, environment variables.
- `DEPLOY_CHECKLIST.md`: `NUXT_SESSION_COOKIE_SECURE=true` in production; strong `NUXT_SESSION_PASSWORD`; `ALLOW_DEMO_SEED` unset in production; `DEMO_SIGN_IN_ENABLED` unset (or false) in production and staging (startup validation also refuses it); the database role can `CREATE EXTENSION btree_gist` (it is a trusted extension on PostgreSQL 13+) or the extension is pre-created; migrations run before the new app version takes traffic; storage directory/driver configured; session lifetime reviewed (Q5).
- `.env.example`: every new variable with a comment.

**CI (`.github/workflows/ci.yml`):** jobs `static` (lint, typecheck, `typecheck:types`, `db:check`, `db:drift`), `unit`, `integration` (Postgres 16 service; `pnpm test:integration` — the database is fresh in CI), `http` (build + `pnpm test:http`); `concurrency` group cancelling superseded runs; pnpm store cached. **Decision gate:** total CI wall time above 12 minutes, or the `http` job flaking three runs in a row, is reported, not papered over.

**Scripts:** `"verify": "pnpm lint && pnpm typecheck && pnpm typecheck:types && pnpm db:check && pnpm db:drift && pnpm test:unit && pnpm test:integration && pnpm test:http"`.

**Acceptance scenario (`tests/integration/acceptance/phase1.test.ts`) — one test file that walks the requirements over the seeded demo:**
1. Log in as `reception.grand` → hotels list is exactly `[MKK-GRAND]`; `MKK-AJYAD` → 404.
2. Log in as `manager.grand` → Room 401 timeline is 4/4 → 6/6 (2027-05-01…07-31) → 4/4; create a maintenance block for room 405 → visible in the calendar as `MAINTENANCE`; the hotel's date-effective average during Hajj is higher than its base average and equals base again after 2027-07-31.
3. `admin` → `MKK-AJYAD` base average `"3.88"`; organization average `"4.38"`; all-hotel list has 5; audit log contains the block creation with before/after.
4. A second organization's Super Admin cannot read, list, or reset anything of the demo organization (404/403 matrix).
5. `admin` resets the demo; the fingerprint equals the fresh seed; the second organization's fingerprint is unchanged.

**Verification commands:** `pnpm verify && pnpm test:integration:fresh` and a green CI run on a pushed branch.

**Acceptance criteria:** documents match the code (a reviewer can follow the README from zero to a running demo); CI runs every gate in Part C §13; the acceptance scenario passes.

**Commit boundary:** two commits — (1) `docs: architecture, migrations policy, README and deploy checklist for Phase 1`; (2) `ci: static/unit/integration/http jobs and the Phase 1 acceptance scenario`.

---

### Task 22: End of task list (there is no Task 22)

Everything below is reference material for review, not an executable task. This heading exists only so that tooling which extracts a single task's text stops at the end of Task 21.

# Part C — Phase 1 summary

## 1. Phase 1 scope

Organization-aware hotels (create/edit/activate/deactivate, timezone, check-in/out, settings, ownership, license reference); floors; organization-wide room types with defaults; physical rooms with numbers, physical beds, sellable Haji capacity, features and lifecycle (retire/reactivate); versioned base capacity; seasonal (Hajj/Ramadan/special) date-effective capacity periods with room-specific overrides; preservation of historical capacity; overlap prevention at the database level; automatic hotel averages (base, date-effective, range, available-stay); operational blocks (block, maintenance, out of service) with history; the derived, filterable, paginated date-wise room calendar and daily summary; hotel-scoped user access with `allHotels`; tenant and hotel isolation as a structural property (scopes, repositories, composite FKs, per-request authorization); per-hotel immutable audit; hotel documents (deferrable); the isolated demo organization expanded to 5 hotels / 360 rooms / 9 personas; foundation debt closed (test infrastructure, connection lifecycle, migration tooling, HTTP tests, CI).

## 2. Out-of-scope items

| Area | Belongs to |
|---|---|
| Customers, agents, holds, bookings, allocation optimizer, room assignment, room transfers | Phase 2 |
| Rate plans, invoices, payments, receipts | Phase 3 |
| Check-in/out, housekeeping status, maintenance-ticket workflow (Phase 1 blocks are the manual precursor) | Phase 4 |
| Expenses, hotel contracts and break-even, profitability | Phase 5 |
| Employees, payroll, compliance documents | Phase 6 |
| Reminder engine, notifications, background jobs (hold expiry) | Phase 7 |
| KPI dashboards, occupancy/ADR/RevPAR, forecasting, report center, exports | Phase 8 |
| Row-level security, rate limiting/lockout, 2FA, S3 storage driver, backups drill, monitoring | Phase 9 |
| Any UI (pages, calendar grid, i18n/RTL, mobile) | UI phases |
| User/role management CRUD, password reset (Phase 1 ships only hotel-access assignment) | Users & Roles work |
| CSV import templates (rooms/employees/agents), package/itinerary grouping, Hijri display, multi-currency | later phases |
| Blocking over booked nights and "no future bookings before deactivation" | Phase 2 (the seams are documented in Tasks 12 and 16) |
| Atomic "adjust a running season from a date" server operation (Phase 1 uses the guided end-and-recreate workflow, D11) | later enhancement |
| Bilingual / localized entity names (hotel, room type, floor labels) — **required pre-production review item before onboarding Arabic-speaking production customers** (D14). Phase 1 keeps one `name` column per entity, which a later translation table can extend without rewriting existing columns | pre-production review |

## 3. Domain model

```text
organization ─┬─< app_user ──< user_role >── role >──< role_permission >── permission (global catalog)
              │      │  (all_hotels flag)
              │      └──< user_hotel_access >── hotel
              ├─< room_type            (org-level catalog: code, default beds, default sellable)
              ├─< hotel ─┬─< hotel_setting            (key/value, registry-validated)
              │          ├─< floor                    (level unique per hotel)
              │          ├─< room ─┬─< room_base_config          (versioned base capacity; open-ended last version)
              │          │         ├─< room_capacity_override    (dates = its period's; ≤ 1 per room per night)
              │          │         └─< room_operational_block    (OOS / MAINTENANCE / OPERATIONAL_BLOCK; soft-cancel)
              │          ├─< capacity_period                     (HAJJ / RAMADAN / SPECIAL; name unique per hotel)
              │          └─< hotel_document >── document_asset
              └─< audit_log            (hotel_id nullable; immutable)
room ──> floor (same hotel)      room ──> room_type (same org)
```
Key invariants: every arrow above is a composite FK that includes `organization_id` (and `hotel_id` for hotel-owned tables); a room is in inventory on a night iff a base version covers it; effective capacity = override, else base; blocks never change capacity, only availability; nothing is hard-deleted.

## 4. DB changes

| Migration | Task | Contents |
|---|---|---|
| `0001_tenancy_hardening` | 3 | `btree_gist`; `user_role.organization_id` (backfilled; cross-org rows purged); composite FKs; `UNIQUE(org,id)` on `app_user`, `role` |
| `0002_hotel_core` | 6 | `hotel`, `hotel_setting`, `user_hotel_access`, `app_user.all_hotels`; `audit_log.hotel_id` + 2 indexes + `BEFORE UPDATE` immutability trigger |
| `0003_floors_room_types` | 13 | `floor`, `room_type` |
| `0004_rooms_base_config` | 14 | `room`, `room_base_config` + **exclusion** `(room_id =, daterange &&)` |
| `0005_capacity_periods` | 15 | `capacity_period`, `room_capacity_override` + **exclusion** + composite FK `(period_id, valid_from, valid_to) → period(id, start_date, end_date) ON UPDATE CASCADE` |
| `0006_room_blocks` | 16 | `room_operational_block` (incl. `ended_early_at`, `ended_early_by`, `original_end_date` + 3 checks, S11) + **partial exclusion** `(room_id =, kind =, daterange &&) WHERE cancelled_at IS NULL` |
| `0007_documents` | 19 (deferrable; omitted entirely if Task 19 is deferred) | `document_asset`, `hotel_document` |

**Constraint catalogue:** three exclusion constraints (base versions, overrides, active same-kind blocks); one dates-sync composite FK with `ON UPDATE CASCADE`; composite tenancy FKs on every child table (room→hotel/floor/type; base/override/block→room; override→period; access/settings/documents/audit→hotel; `user_role`→user/role); `UNIQUE`: hotel `(org, code)`, floor `(hotel, level)`, room `(hotel, number)`, type `(org, code)`, period `(hotel, name)`, override `(period, room)`; `CHECK`: status/kind/ownership enums as text, currency length, level range, beds `1–30`, sellable `0–30`, range order, non-blank block reason, block ended-early consistency (all-or-none, not both cancelled and ended early, `original_end_date > end_date`; S11). **Index catalogue:** `(organization_id, hotel_id)` on every hotel-owned table; an index for every composite-FK column set; GiST indexes created by the three exclusion constraints (they serve the calendar page queries — 100-room page ≈ 1 ms measured); audit `(org, hotel, created_at)` and `(org, entity_type, entity_id, created_at)`. **Deletion/archive:** D14; FK delete actions are `NO ACTION`/`CASCADE` only.

## 5. API plan

| Area | Endpoints |
|---|---|
| Auth (Tasks 5, 7, 8) | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` (with `organization`, `roles`: S1), `GET /api/health` |
| Hotels (12) | `GET/POST /api/hotels` (`HotelSummary` with `today`: S2); `GET/PATCH /api/hotels/:hotelId` (`HotelDetail`); `POST …/activate`, `…/deactivate`; `GET/PUT …/settings`; `GET …/audit-log?entityType&entityId&action&cursor&limit` (S3) |
| Users (7) | `GET/PUT /api/users/:userId/hotel-access` |
| Floors (13) | `GET/POST …/floors`; `POST …/floors/bulk`; `PATCH …/floors/:floorId`; `POST …/activate\|deactivate` |
| Room types (13) | `GET/POST /api/room-types`; `PATCH /api/room-types/:id`; `POST …/activate\|deactivate` |
| Rooms (14) | `GET/POST …/rooms`; `POST …/rooms/bulk`; `GET/PATCH …/rooms/:roomId`; `POST …/base-config`, `…/retire`, `…/reactivate` |
| Capacity (15) | `GET/POST …/capacity-periods`; `GET/PATCH/DELETE …/capacity-periods/:periodId`; `GET/POST …/overrides`; `POST …/overrides/preview` (S6); `POST …/overrides/remove` (S8); `DELETE …/overrides/:overrideId`; `GET …/rooms/:roomId/capacity-timeline` (with `refs.periods`) |
| Blocks (16) | `GET …/room-blocks`; `POST …/rooms/:roomId/blocks`; `POST …/room-blocks/bulk`; `POST …/room-blocks/:blockId/cancel` |
| Averages (17) | `GET …/capacity/averages`; `GET /api/capacity/averages` |
| Calendar (18) | `GET …/room-calendar`; `GET …/inventory/daily-summary` |
| Documents (19) | `GET/POST …/documents`; `GET …/documents/:documentId/download`; `POST …/archive` |
| Admin (Phase 0, reworked 7/20) | `POST /api/admin/demo/reset` |
| Public (20) | `GET /api/public/demo-sign-in` — unauthenticated, 404 unless `DEMO_SIGN_IN_ENABLED` and `APP_ENV` ∈ {development, demo} (S14, D9) |

(`…` = `/api/hotels/:hotelId`.) Conventions: JSON only (multipart for uploads); dates `YYYY-MM-DD`; errors `{ statusCode, statusMessage, data: { code, details? } }`; lists paginated with caps; every hotel-scoped path passes through `authorizeHotel`.

## 6. Authorization model

**Layers:** (1) identity from the sealed session cookie (8 h, `httpOnly`, `sameSite=lax`, `secure` in production); (2) `resolveAuthContext` from the database each request — active user, permissions via the user's own organization's roles, `allHotels`, hotel ids; (3) `orgCan`/`hotelCan`/`authorizeHotel`; (4) branded scopes so repositories cannot run without an organization (and hotel) predicate; (5) composite FKs and constraints in the database.

**Outcomes:** id not in the caller's organization → **404**; hotel the caller has no access to → **the same 404**; access but no permission → **403**; unauthenticated/invalid session → **401**; body references outside scope → **422 `INVALID_REFERENCE`**; inactive hotel + write → **409 `HOTEL_INACTIVE`**. The only unauthenticated Phase 1 endpoints are `POST /api/auth/login`, `GET /api/health` and the gated `GET /api/public/demo-sign-in` (404 outside demo/development with the flag). Counts that reveal inventory (`HotelSummary.floorCount/roomCount`, `RoomTypeListItem.usageCount`) are `null` for callers who could not otherwise see that inventory (S2, S4).

**Escalation rules (hotel access assignment):** needs `user.manage`; a caller without `allHotels` may grant only hotels they hold, cannot grant `allHotels`, cannot change their own access, cannot modify an `allHotels` user; `allHotels` with explicit hotel ids is rejected.

**Phase 1 endpoint permissions by role** (S = Super Admin, HM = Hotel Manager, RM = Reservation Manager, A = Accountant, HR, R = Reception, RO = Read-only; ✓ granted, — not granted; hotel scoping always applies on top):

| Capability | S | HM | RM | A | HR | R | RO |
|---|---|---|---|---|---|---|---|
| View hotels (`hotel.view`) and floors, rooms, periods, calendar, averages (`room.view`) | ✓ | ✓ | ✓ | hotels only | hotels only | ✓ | ✓ |
| Manage hotel, settings (`hotel.manage`) | ✓ | ✓ (own hotels; **not create**) | — | — | — | — | — |
| Create hotel / write room types (`allHotels` required) | ✓ | — | — | — | — | — | — |
| Floors, rooms (`room.manage`) | ✓ | ✓ | — | — | — | — | — |
| Base capacity & seasonal periods (`capacity.manage`) | ✓ | ✓ | — | — | — | — | — |
| Blocks (`room.block`) | ✓ | ✓ | — | — | — | — | — |
| Audit log (`audit.view`) | ✓ | ✓ | — | — | — | — | — |
| Assign hotel access (`user.manage`) | ✓ | — | — | — | — | — | — |
| Reset demo (`organization.resetDemo`, demo org only) | ✓ (demo) | — | — | — | — | — | — |

## 7. Inventory calculation rules

1. **Night:** the unit of inventory is a night identified by the date it starts, in hotel time. Ranges are inclusive.
2. **In inventory(room, night)** ⇔ a `room_base_config` version covers the night.
3. **Effective capacity(room, night)** = override covering the night (physical, sellable) ▸ else base version ▸ else *none*.
4. **Blocks(room, night)** = active (non-cancelled) blocks covering the night; ignored when the room is not in inventory.
5. **Status(room, night)** by precedence: `NOT_IN_INVENTORY` › `OUT_OF_SERVICE` › `MAINTENANCE` › `OPERATIONAL_BLOCK` › *(Phase 2: `OCCUPIED` › `BOOKED` › `HELD`)* › `AVAILABLE`.
6. **Sellable(room, night)** ⇔ in inventory ∧ no covering block that blocks sales (`OUT_OF_SERVICE`, `OPERATIONAL_BLOCK` always; `MAINTENANCE` unless `inventory.maintenanceBlocksSales = false`) *(Phase 2 adds: ∧ no booking/hold)*.
7. **Stay availability** for `[checkIn, checkOut)`: the nights `checkIn … checkOut−1`; a room is stay-available iff it is sellable on every night; its stay capacity is the **minimum** effective sellable capacity over those nights.
8. **Segments:** the calendar returns per-room run-length segments of `(status, sellable, physicalBeds, sellableCapacity, capacitySource, periodId, blockIds)`; they cover the requested range exactly.
9. **Phase 2 integration:** reservations add one more unavailability source (`booking_room_assignment` with its own exclusion constraint, ARCHITECTURE §10) feeding rule 5–6; no Phase 1 table changes.

## 8. Capacity calculation formulas

Notation: `R(D)` = rooms in inventory on date `D` in hotel `h`; `cap_e(r,D)` = effective sellable capacity; `cap_b(r,D)` = base sellable capacity; `n` = nights.

- **Base Hotel Average(D)** = `Σ_{r∈R(D)} cap_b(r,D) ÷ |R(D)|` — seasonal overrides ignored; blocks ignored.
- **Date-Effective Hotel Average(D)** = `Σ_{r∈R(D)} cap_e(r,D) ÷ |R(D)|` — overrides included; blocks ignored.
- **Range Average [a,b]** = `Σ_{D∈[a,b]} Σ_{r∈R(D)} cap_e(r,D) ÷ Σ_{D∈[a,b]} |R(D)|` — weighted by room-nights (a room in inventory for 3 of 10 nights contributes 3).
- **Available-Stay Average(stay S)** = `Σ_{r∈E(S)} min_{D∈S} cap_e(r,D) ÷ |E(S)|`, where `E(S)` = rooms sellable on every night of `S`. *(Reservations narrow `E(S)` in Phase 2.)*
- **All-hotel value** = `Σ_h numerator_h ÷ Σ_h denominator_h` (never the mean of hotel averages).
- **Zero denominator** → `null` (`display: null`), never `0`, `NaN`, `Infinity`. **Display** = half-up to 2 decimals with integer arithmetic.
- **Worked examples (all executed in tests):** 310 ÷ 80 = 3.875 → `"3.88"`; 25 triples + 5 quads uplifted to 6 in Hajj → (310 + 75 + 10) ÷ 80 = 4.9375 → `"4.94"`, back to `"3.88"` after the period; two hotels (3 ÷ 1 and 400 ÷ 100) → 403 ÷ 101, not 3.5.
- **Room estimate** `ceil(hajiCount ÷ average)` is Phase 2 (uses the Date-Effective or Available-Stay Average); Phase 1 only guarantees the averages are correct and exposed.

## 9. Demo-data plan

See Task 20: five hotels (three in Makkah, two in Madinah), 360 rooms across 5–10 floors with four room types distributed differently per hotel; renovations, retirements, a temporarily closed room, an inactive floor; six named capacity periods per hotel family with historical (2026), current-season and future (2027, 2028) coverage, including the exact Room 401 example; ≈125 blocks of every kind including cancelled/ended-early; nine personas with hotel-scoped access; deterministic ids and seeded randomness; one-transaction reset that reproduces the fresh-seed fingerprint and never touches another organization; seed refuses production unless explicitly allowed.

## 10. Test matrix

| Requirement (from the brief) | Level | Task(s) |
|---|---|---|
| Tenant isolation | registry-driven repository behavior suite; composite-FK DB tests; service tests | 3, 4, 6, 12–19, 20 |
| Hotel access isolation | `authorizeHotel` matrix; HTTP 404 for inaccessible hotels; persona matrix | 7, 8, 12–19, 20, 21 |
| `allHotels` access | authContext, authorizeHotel, list isolation, personas | 7, 12, 20 |
| Hotel CRUD authorization | service + HTTP matrix | 12 |
| Floor uniqueness/business rules | DB + service + bulk atomicity | 13, 14 |
| Room-number uniqueness within hotel | DB + service + normalization + concurrency | 14 |
| Room type defaults / snapshot | service | 13, 14 |
| Room-level overrides | override rules + DB | 14, 15 |
| Base capacity / versioning | pure + service + DB | 10, 14 |
| Seasonal capacity & boundaries | pure + service + calendar | 10, 15, 18 |
| Overlap prevention | exclusion constraint tests + friendly pre-checks + concurrency | 14, 15, 16 |
| Effective capacity resolution | pure + integration + calendar | 10, 15, 18 |
| Automatic hotel average | pure + integration (310/80) | 10, 17, 20 |
| Inactive rooms / lifecycle | service + calendar + averages history | 14, 17, 18 |
| Operational blocks / maintenance / out-of-service | pure + service + DB | 11, 16, 18 |
| Date-wise inventory calculation | pure + calendar invariants + scale | 11, 18 |
| Demo reset after Phase 1 data exists | reset regression, wide FK graph, second populated org, atomicity, concurrency, performance | 6, 20, 21 |
| **Cross-tenant privilege-escalation regression class** | seed same-email foreign user; forced cross-org `user_role` (`session_replication_role`) never grants; composite FKs; hotel-access escalation matrix; resetDemo least privilege; foreign ids on every route; body-reference indistinguishability | 3, 4, 7, 12–19, 20 |
| Server authorization not deferred to UI | black-box HTTP suites on every route | 8, 12–19, 20 |
| Boundary dates / leap year / timezone | pure + service | 9, 10, 15, 16 |
| Concurrency | parallel-write tests per aggregate | 12, 14, 15, 16, 20 |
| Empty/zero states | averages/calendar/summary on empty hotels | 10, 11, 17, 18 |
| Oversized/malformed input | Zod schema tests + route tests | 5, 13–18 |
| Performance | scale tests with statement counting and `EXPLAIN` | 18 |
| UI contract (S1–S14): server-computed display truth (hotel today, status, next change, phases, impact, refs) and bounded statement counts | DTO shape tests, preview-equals-apply, `refs` exactness, gated demo sign-in | 7, 8, 12–18, 20 |
| Migrations | data-preserving migration harness, fresh-DB build, drift check | 2, 3, all schema tasks |

## 11. Risks

| Risk | Impact | Mitigation | Owner |
|---|---|---|---|
| Composite-FK/exclusion design confuses implementers | wrong constraints | verified SQL and TS embedded; DB behavior tests per task | 3, 6, 14–16 |
| Exclusion-constraint conflicts surface as raw Postgres errors | 500s | `translateDbError` with real-error tests per constraint; friendly pre-checks | 5, 14–16 |
| Per-request authorization adds DB round trips | latency | 3 small indexed queries; memoized per request; measured in HTTP suite | 7, 8 |
| Black-box HTTP harness slow or flaky in CI | pipeline friction | build once, decision gate at 4 min; `HTTP_TEST_SKIP_BUILD` locally | 8, 21 |
| Repository refactor breaks Phase 0 behavior | regression | behavior-preserving refactor with all Phase 0 tests unchanged | 4 |
| Scope brand bypassed with casts | isolation gap | lint + fitness test + behavioral registry with coverage check + FKs | 4 |
| Snapshot semantics of room types surprise users (Q1) | expectation gap | explicit "apply defaults from date" action deferred but documented; UI copy in later phase | 13, 14 |
| Started-period freeze forces "end and recreate" workflow | usability | documented rule; mid-season correction path tested | 15 |
| Demo dates go stale relative to the real calendar | demo looks old | fixed anchor is overridable at reset; Phase 8 can add "rebase to today" | 20 |
| Deterministic ids collide with real ids | data corruption | UUID v5 over a private namespace; demo org isolated and reset-only | 20 |
| Migration hand-edits drift from schema | broken deploys | `db:check`, `db:drift`, fresh-DB integration in CI, immutable-after-commit rule | 2, 21 |
| `btree_gist` requires privileges in managed Postgres | deploy failure | trusted extension on PG13+; documented in the deploy checklist | 3, 21 |
| Plan defects found during execution (Phase 0 had three) | rework | controller pre-flight conflict scan; verified code embedded; every fix logged | execution |
| Scope creep into Phase 2 (blocks-over-bookings, deactivation guards) | delay | seams documented, not built | 12, 16 |

## 12. Implementation task list

| # | Task | Depends on | Migration | Parallel? | Size | Suggested model tier |
|---|---|---|---|---|---|---|
| 1 | Test infrastructure hardening | — | — | no | S | mid |
| 2 | DB lifecycle & migration tooling | 1 | — | no | S | mid |
| 3 | Tenancy composite-key hardening | 1, 2 | 0001 | no | M | most capable (data-preserving migration) |
| 4 | Scope types & repository foundation | 3 | — | no | L | most capable |
| 5 | API conventions | 4, **9** | — | no | M | mid |
| 6 | Hotel core schema, audit, permissions | 3, 4, 5 | 0002 | no | M | mid |
| 7 | Authorization foundation | 4, 5, 6 | — | no | L | most capable (security) |
| 8 | HTTP test harness | 5, 7 | — | no | M | mid |
| 9 | Domain: dates & hotel time | — | — | **yes** (with 1–8; merge before 5) | S | cheap (code provided) |
| 10 | Domain: capacity & averages | 9 | — | **yes** | S | cheap (code provided) |
| 11 | Domain: room calendar | 9, 10 | — | **yes** | S | cheap (code provided) |
| 12 | Hotel management (reference pattern) | 5–9 | — | no | M | mid |
| 13 | Floors & room types | 12 | 0003 | no | M | mid |
| 14 | Rooms & versioned base config | 9, 10, **11**, 13 | 0004 | no | L | mid–high |
| 15 | Capacity periods & overrides | 10, 14 | 0005 | no | L | mid–high |
| 16 | Operational blocks | 11, 14 | 0006 | no | M | mid |
| 17 | Capacity averages service/API | 10, 11, 15, 16 | — | no | M | mid |
| 18 | Room calendar & summary + scale test | 11, 15, 16, 17 | — | no | L | mid–high |
| 19 | Hotel documents (deferrable) | 12 | 0007 | **worktree-parallel with 17/18** | M | mid |
| 20 | Demo dataset & reset regression | 12–18 (19) | — | no | L | mid–high |
| 21 | Docs, CI, acceptance gate | all | — | no | M | mid |

**Which tasks can safely be executed by separate subagents at the same time.** Only **9, 10, 11** are unconditionally parallel-safe (they create new files and touch nothing shared; run them in their own git worktrees and merge sequentially — the working tree is single-checkout, so "parallel" means separate worktrees, not two agents in one directory). **19** is parallel-safe against 17/18 in a separate worktree because its migration number is pre-assigned (`0007`) and its only shared edit is the append-only repository registry. **Everything else is sequential** because it either edits the same shared files (`server/repositories/index.ts`, the isolation registry, `package.json`, CI, `hotelDto.ts`, `roomService.ts`, seeds) or owns a numbered migration in a linear Drizzle snapshot chain.

## 13. Acceptance gate for completing Phase 1

Phase 1 is complete only when **all** of the following hold, verified on a clean checkout with `pnpm verify` and `pnpm test:integration:fresh`:

1. **Foundation:** no service/route/domain/util/shared file imports Drizzle or `db/schema|client` (lint + fitness test green); every tenant/hotel repository method appears in the isolation registry and passes; the composite-FK, exclusion, immutability-trigger and index-coverage tests pass; migrations `0001…0006` (plus `0007` if Task 19 is included) apply from an empty database and `db:check` + `db:drift` are clean.
2. **Authorization:** authorization is resolved per request; the session is identity-only with an 8-hour lifetime; the 404/403/401/422/409 outcome table (Part C §6) holds over real HTTP for every Phase 1 route; the escalation matrix and `resetDemo` least-privilege tests pass; the Phase 0 cross-tenant regression class is covered at repository, service and HTTP level.
3. **Inventory correctness:** the requirement examples pass through the real API: Room 401 = 4/4 → 6/6 (2027-05-01…07-31) → 4/4; 310 ÷ 80 = 3.875 → `"3.88"`; the date-effective average moves with seasons and reverts; historical periods and retired rooms remain queryable; overlapping periods/overrides/blocks are impossible in the database and reported as 409; nothing can rewrite a past night. Room, season and block DTOs expose server-computed `status`, `nextChange`, `phase`, `cancelAction`, `impact` and hotel-local `today`; the season preview returns exactly what apply writes (S2, S5–S7, S10).
4. **Calendar:** every listed filter works; derived (no room×day rows); the scale test meets its bounds; empty and oversized inputs behave (Review Focus 4–5).
5. **Audit:** every configuration write has a same-transaction audit row with before/after, per-hotel visibility rules hold, rows are immutable.
6. **Demo:** 5 hotels, 360 rooms, personas with hotel-scoped views; deterministic (identical fingerprints); reset restores the fresh fingerprint, keeps ids/sessions valid, leaves a second populated organization byte-identical, is atomic, concurrent-safe and < 15 s; seed refuses production by default. Personas carry display names; demo sign-in data is served only by the gated endpoint and never with `APP_ENV=production` (S14, D9).
7. **CI:** `static`, `unit`, `integration`, `http` jobs green on a pushed branch within the stated time gate; `README` and `ARCHITECTURE.md` match the code; the deploy checklist exists.
8. **Process:** an independent whole-phase review (most capable model) reports no Critical or Important findings, or each is fixed or ruled with a recorded rationale; the human partner approves.

---

## Execution notes (lessons carried from Phase 0)

- **Every dispatch brief must carry** the mandatory command prefix (Global Constraints), "pnpm only; never yarn; do not touch `packageManager`", "do not add scope beyond the task", and — for Task 3 onward — "migrations: hand-edit only before first commit".
- **Never tell an implementer to run a tool that is not yet installed** (Phase 0, Task 2: an instruction to `pnpm exec vitest` before Task 3 installed it led to a `yarn` detour that corrupted `node_modules`). Use `pnpm dlx` or reorder.
- **The controller runs a pre-flight conflict scan of this plan** (interface names and file ownership across tasks) and records rulings in the ledger before Task 1, as in Phase 0. Known things to check first: Task 5 depends on Task 9; Task 14 depends on Task 11 (S5); `roomDto.ts` gains fields in Tasks 14, 15 and 16 (S5) and `hotelDto.ts` in Tasks 12, 13 and 14 (S2); `blockRules.ts` gains `blockPhase` in Task 16 without changing the verified functions; `inventoryReadRepository.ts` is created in Task 17 and extended with `withRefs` in Task 18; `roomService.retireRoom` receives guards from Tasks 15 and 16; `hotelDto.ts` gains fields in Tasks 13 and 14; `server/repositories/index.ts` and the isolation registry are append-only shared files.
- **Reviews:** task reviewers get the brief, the report and a diff package; security-sensitive tasks (3, 4, 7, 20) get the most capable reviewer; the final whole-branch review uses the most capable model and is pointed at the ledger's deferred items.
- **Stop conditions** stay as in Phase 0: irreversible/destructive operations, security-sensitive actions outside the worktree, shared-state side effects, or a plan so broken every path is a guess. The two decision gates named above (HTTP harness runtime, CI wall time) are reported to the human partner, not weakened.
