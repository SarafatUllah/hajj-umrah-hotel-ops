# Hajj & Umrah Hotel Operations System — Architecture Review (Phase 0)

Status: **DRAFT FOR APPROVAL** — no application code has been written yet. This document is the required output before any implementation begins.

---

## 1. Requirement Analysis

This is a multi-hotel, multi-department B2B/B2C **operations system** for an organization running Hajj/Umrah hotels in Saudi Arabia: inventory & seasonal capacity, booking & allocation, rates & invoicing, payments/receivables, HR & Saudi compliance documents, expenses & hotel contracts, maintenance/housekeeping, a central reminder engine, and multi-hotel/all-hotel analytics — built demo-first with strict demo/production data isolation.

The defining domain characteristics that drive every downstream decision:

- **Capacity is date-effective, not static.** The same physical room has different sellable capacity depending on season (normal vs. Hajj vs. Ramadan), and this must never overwrite history.
- **Booking is by Haji count first, rooms second.** Users think in pilgrims; the system must translate that into room combinations, both as an estimate and as an optimized, auditable allocation.
- **Money and inventory must have one source of truth each.** Due amounts, occupancy, and employee cost must be derived, not independently stored and allowed to drift.
- **This is not a per-day pre-materialized grid.** With hundreds of rooms over years of history plus future Hajj inventory, naive one-row-per-room-per-day storage is wasteful; availability is computed from effective configuration + reservations.
- **Everything is server-side authoritative.** Permissions, tenant scoping, and inventory concurrency must be enforced in the database and service layer, never trusted from the client.
- **Demo-readiness is a first-class, permanent requirement**, not a one-time seed script — it must survive every phase and be resettable without touching real data.

## 2. Missing Requirements & Edge Cases Discovered

These are gaps in the spec that must be resolved with explicit, documented decisions (recommendations below; flag any you want changed):

1. **Pilgrim/guest roster.** The spec tracks Haji *count* per booking/room, but Saudi Hajj/Umrah operations typically require a per-room pilgrim manifest (name, passport/Iqama-equivalent, nationality) for internal reporting and potential Ministry-of-Hajj/Nusuk-style integration later. **Decision: add an optional `Pilgrim` entity linked to booking + room assignment, not mandatory in v1, but modeled now so it isn't bolted on later.**
2. **VAT/tax handling.** Saudi VAT (currently 15%) isn't mentioned. **Decision: invoices support a configurable tax rate per hotel/line item, tax-exclusive pricing stored, tax computed and snapshotted at invoice time.**
3. **Cancellation & refund policy.** No cancellation-fee or partial-refund model exists. **Decision: bookings support a cancellation policy reference (configurable %, cutoff days); refunds are modeled as negative/credit payment entries, never by mutating prior payments.**
4. **Agent commission.** Agents negotiate commission, which affects net revenue vs. payable-to-agent. **Decision: add commission rate/amount fields on Agent and/or Booking, tracked separately from the room price (affects agent statement, not room revenue).**
5. **Package/itinerary grouping.** Hajj trips commonly span Makkah + Madinah legs as one customer/agent package. **Decision: add an optional `Itinerary`/`Package` entity that groups multiple bookings (possibly across hotels) under one customer-facing reference, without forcing every booking to belong to one.**
6. **Approval thresholds.** "Approved by" appears for expenses/discounts but no matrix defines who can approve what. **Decision: approval authority is expressed as a permission (`expense.approve`) plus a configurable amount threshold per role; large-amount discounts require `booking.override`.**
7. **Division-by-zero in averages.** Hotel average capacity, occupancy %, and growth % all have zero-denominator cases (no active rooms, no prior-period value). **Decision: these are handled explicitly (see §31) and rendered as "N/A", never as `Infinity`/`NaN`/silently-0.**
8. **Multi-night stays crossing a capacity-period boundary.** A stay may start under "Normal" capacity and end under "Hajj 2027" capacity for the same room. **Decision: the allocation engine treats a room's usable capacity for a *stay* as the minimum effective capacity across every night of that stay; the UI warns when a stay spans a capacity-period boundary.**
9. **Overlapping capacity periods.** Spec says "prevent invalid overlapping configurations" but doesn't define the rule. **Decision: at most one capacity period per room may be active on any given date; enforced with a Postgres exclusion constraint (`EXCLUDE USING gist`), not just application validation.**
10. **Partial allocation / insufficient inventory.** What happens when no room combination covers the requested Haji count? **Decision: the allocation service returns a best-effort result plus a shortfall count; booking can proceed as a partial allocation only with explicit override permission, never silently.**
11. **Employee cost split across multiple hotels.** An employee "assigned to hotel(s)" plural, but payroll expense needs to land in specific hotel P&Ls. **Decision: `EmployeeHotelAssignment` carries an optional cost-allocation percentage per hotel, defaulting to 100% on the primary hotel.**
12. **Recurring expense edge dates.** A "recurring monthly on day 31" breaks in February. **Decision: recurrence uses a day-of-month with automatic clamp-to-last-day-of-month, documented in the job that materializes recurring expenses.**
13. **Soft-delete vs. hard-delete policy.** Not stated uniformly. **Decision: financial and booking records are never hard-deleted (status/reversal only); master data (rooms, employees, agents) uses an `isActive` flag; only pre-transactional draft records (e.g., an unsent Draft booking) may be hard-deleted.**
14. **Multi-currency exposure.** Each hotel has "a currency," but agents may remit in other currencies. **Decision: v1 assumes one operating currency per hotel (SAR default); cross-currency payment reconciliation is out of scope for v1 but the `Payment` table carries a currency + FX-rate-to-hotel-currency field now so it isn't a breaking schema change later.**
15. **Same-day turnover.** Check-out and next check-in on the same calendar date for the same room is normal in hospitality but easy to model as a false conflict. **Decision: availability uses half-open date ranges `[checkIn, checkOut)`, so checkout day = next check-in day is valid by construction.**

## 3. Recommended Architecture

**Modular monolith**, single Nuxt 4 application (Vue 3 + Nitro), TypeScript throughout, PostgreSQL as the single system of record, deployed as one container. Internally organized into **domain modules** (inventory, booking, finance, hr, compliance, notifications, reporting) each with its own service + repository layer, so any module can later be extracted into its own service without a rewrite — but nothing is split prematurely.

```
API route (thin) → service (business rules, orchestration) → domain (pure rules, calculations) → repository (DB access via Drizzle)
```

Rules:
- API routes (`server/api/**`) only parse/validate input (Zod), call a service, and shape the HTTP response. No business logic.
- Services orchestrate transactions and call domain logic + repositories. This is where authorization checks happen.
- Domain layer (`server/domain/**`) is framework-free, pure, unit-testable: capacity math, allocation optimizer, rate calculation, occupancy/ADR/RevPAR formulas, money arithmetic.
- Repositories are the only code that imports the Drizzle client.

## 4. Why a Nuxt Modular Monolith Is Appropriate

- **Single team, single deploy target, cost-sensitive v1** — microservices would add operational overhead (multiple deploys, network calls, distributed transactions) with no corresponding benefit yet.
- **Nuxt/Nitro gives one language (TypeScript) and one deployment artifact** across UI and API, which minimizes infra cost and cognitive overhead for a small team building 9 phases of interconnected domains.
- **Booking concurrency and financial consistency need transactional integrity** — keeping booking, inventory, and payment writes in one database, one transaction boundary, is far simpler and safer than distributed sagas across services.
- **Modular internal boundaries preserve the option to extract services later** (e.g., reporting/analytics or notifications could become standalone workers first, since they're read-heavy/async and least coupled to the transactional core).
- Nuxt's server routes (Nitro) run equally well as a long-lived Node server (needed here, since background jobs and DB connection pooling favor a persistent process) or containerized — good deployment flexibility without committing to a specific cloud.

## 5. ORM Recommendation: Drizzle ORM

**Recommendation: Drizzle ORM + drizzle-kit**, over Prisma.

Reasoning specific to this domain:
- Heavy reliance on **Postgres-native concurrency primitives** — `EXCLUDE USING gist` constraints (double-booking prevention, capacity-period overlap prevention), `SELECT ... FOR UPDATE`, `SERIALIZABLE` transactions, advisory locks for the allocation optimizer. Drizzle's SQL-first design makes these natural (raw `sql` escape hatches feel first-class, not bolted on); Prisma actively fights this pattern.
- **Money and date-range types** map more directly (`numeric`, `daterange`, `tsrange`) without Prisma's historically weaker support for Postgres range/exclusion types.
- Drizzle has **no separate query engine binary/runtime**, lighter footprint, faster cold starts — relevant for a low-cost deployment target and keeps future edge/serverless options open.
- Migrations via `drizzle-kit` are plain SQL files (reviewable, hand-editable for the exclusion constraints Drizzle's schema DSL can't fully express), which matters because several constraints here (GiST exclusion, partial/expression indexes) must be authored as raw SQL regardless of ORM choice.
- Trade-off acknowledged: Prisma has a more polished DX (Prisma Studio, more tutorials). We accept this trade-off given the domain's SQL-heavy correctness requirements.

## 6. PostgreSQL Schema / Domain Plan

Organized by module; see §24 for relationships and §25 for constraints. Money = `bigint` minor units (halalas). Dates = `date` for operational days, `timestamptz` for events. All tenant tables carry `organization_id`.

**Core/Tenancy:** `organization`, `user`, `role`, `permission`, `role_permission`, `user_role`, `user_hotel_access`, `session`, `audit_log`

**Inventory:** `hotel`, `hotel_settings`, `floor`, `room_type`, `room`, `capacity_period`, `room_capacity_override` (per-room override within a period), `room_status_event` (maintenance/OOS/housekeeping state changes)

**Booking:** `customer`, `agent`, `booking`, `booking_room_requirement`, `booking_room_allocation` (system-suggested + final, versioned), `booking_room_assignment` (physical room ↔ booking ↔ date range), `hold`, `hold_reminder_log`, `pilgrim` (optional roster), `room_transfer`, `itinerary` (optional package grouping)

**Commercial:** `rate_plan`, `rate_plan_night` (date-effective nightly rate), `booking_rate_snapshot` (immutable pricing captured at confirmation), `invoice`, `invoice_line`, `invoice_correction` (credit note), `payment`, `receipt`

**HR/Compliance:** `employee`, `employee_hotel_assignment`, `salary_component`, `payroll_run`, `payroll_line`, `compliance_document_type`, `compliance_document` (versioned, never overwritten — see §21), `document_reminder_policy`

**Finance/Ops:** `expense_category`, `expense`, `recurring_expense_rule`, `hotel_contract`, `maintenance_ticket`, `housekeeping_status_event`

**Notifications:** `reminder_policy`, `reminder_event`, `notification`, `notification_delivery_log`

**Reporting support:** narrow materialized views only where proven necessary (see §16), no generic "analytics" tables in v1.

## 7. Multi-Tenant Strategy

**Shared database, shared schema, `organization_id` discriminator column** on every tenant-scoped table (not schema-per-tenant, not database-per-tenant) — appropriate because: v1 has one real org + one demo org, so isolation must be logical/robust but doesn't yet need physical separation; schema-per-tenant would massively complicate migrations across many future customers.

Enforcement, layered:
1. **Repository layer never allows a query without an explicit `organization_id` predicate** — a lint rule / repository base class enforces this at the code level (every repository method takes `orgId` as a mandatory first argument).
2. **Every authenticated session carries `organizationId`**, resolved server-side from the user record, never from client input.
3. **Postgres Row-Level Security is added as defense-in-depth once real multi-org SaaS is on the roadmap** (not required for v1 given layer 1–2, but the schema is RLS-ready since `organization_id` is present on every table now).
4. **Demo isolation is the same mechanism**: the demo org is just another `organization` row; "Reset Demo Data" is scoped by `organization_id = <demo-org-id>` and physically cannot touch other orgs (see §14).

`hotel_id` is the second-level scope (`user_hotel_access` join table: user → one/many/all hotels within their org), enforced the same way in the service layer.

## 8. Authentication / RBAC Strategy

- **Session-based auth**, sealed encrypted httpOnly cookies via `nuxt-auth-utils` (avoids hand-rolling JWT/session infra; battle-tested with Nitro). Passwords hashed with argon2id.
- **RBAC model:** `permission` is a flat string catalog (`booking.create`, `payment.create`, …, exactly the list in the spec, extensible by inserting new rows — no code change needed to add a permission). `role` is a named bundle of permissions (seed roles: Super Admin, Hotel Manager, Reservation Manager, Accountant, HR Manager, Reception, Read-only Management — matching the demo personas in §38). Users get roles via `user_role`; **custom per-user permission overrides are not in v1** (adds complexity without a stated requirement) — roles are the unit of authorization.
- **Hotel scope is orthogonal to role**: `user_hotel_access` (user_id, hotel_id | ALL). A permission check is always `(does role grant permission) AND (does user have access to this hotel)`.
- **Every server route re-checks both**, via a shared `requirePermission(event, 'booking.create', hotelId)` helper used inside services — never inferred from UI state.
- Sensitive-field access (e.g., employee Iqama numbers) uses a dedicated finer-grained permission (`employee.viewSensitive`) checked at the field-serialization layer, not just the route layer, so a route granting general `employee.view` doesn't leak sensitive fields by accident.
- 2FA (TOTP) is schema-ready (optional `user.totp_secret`) but not required for v1 UI; recommended before production go-live for Super Admin/Accountant roles.

## 9. Inventory Architecture

**Derived, not pre-materialized.** No per-room-per-day row is created in advance. Availability for a room over a date range is computed as:

```
effective_capacity(room, date) =
    room_capacity_override active on date (most specific, date-effective)
    ELSE room_type default capacity
    ELSE room.physical_beds (base fallback)

is_available(room, [checkIn, checkOut)) =
    room.status = ACTIVE (not OOS)
    AND no existing booking_room_assignment for this room
        overlapping [checkIn, checkOut) with status in
        (HELD, CONFIRMED, CHECKED_IN)
    AND no operational block (maintenance/OOS event) overlapping the range
```

This is answered with a single indexed range-overlap query (GiST index on a `daterange` expression), not a scan of daily rows — scales to years of history and thousands of rooms without a materialization job.

Distinct statuses are modeled as **separate enums for separate concerns** rather than one ambiguous "blocked" state, per §8 of the spec:
- `booking_room_assignment.status`: HELD, CONFIRMED, CHECKED_IN, CHECKED_OUT, CANCELLED
- `room.operational_status`: ACTIVE, MAINTENANCE, OUT_OF_SERVICE
- `room.housekeeping_status` (decoupled module, §27): VACANT_CLEAN, VACANT_DIRTY, OCCUPIED, CLEANING, INSPECTED

A room is *sellable* only when operational_status = ACTIVE; housekeeping status never blocks a sale (only ops staff visibility), matching the "loosely coupled, disable if not needed" instruction.

## 10. Booking Concurrency Strategy

Double-booking is prevented **at the database level**, not just application logic:

- **Postgres exclusion constraint** (requires `btree_gist` extension) on `booking_room_assignment`:
  `EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out, '[)') WITH &&) WHERE (status IN ('HELD','CONFIRMED','CHECKED_IN'))`
  This makes a double-booked overlapping range a constraint violation the database itself refuses — impossible to bypass from any code path, including future ones.
- **Application flow still recheck-before-commit** (defense in depth + better UX than raw constraint errors):
  1. User selects rooms → server computes live availability (read).
  2. User confirms → server opens a transaction, re-queries availability for the exact rooms/range with `SELECT ... FOR UPDATE` on the candidate `room` rows to serialize concurrent attempts on the same rooms.
  3. Insert assignments inside the same transaction; the exclusion constraint is the final backstop if the row lock strategy is ever bypassed.
  4. On constraint violation, return a typed "rooms no longer available" error and re-run the allocation suggestion — never a raw DB error to the client.
- Hold→booking conversion uses the same transaction path; hold expiry release (§12) uses `SELECT ... FOR UPDATE SKIP LOCKED` in its background sweep so it never races a user actively confirming that same hold.

## 11. Smart Room-Allocation Algorithm Design

Implemented as a **pure, framework-free domain service** (`server/domain/allocation/allocateRooms.ts`), fully unit-testable with plain arrays in, plain result out — no DB, no HTTP.

```
Input:  { hajiCount, availableRooms: {roomId, capacity, floor, roomType}[],
          lockedRoomIds?, preferSameFloor?: boolean }
Output: { allocation: roomId[], totalCapacity, wastedCapacity, shortfall,
          alternatives?: roomId[][] }
```

Algorithm:
1. **Estimate (display only):** `ceil(hajiCount / effectiveHotelAverage)` — shown as a hint before real allocation runs, per §10 of the spec.
2. **Exact solve for small/medium pools** (room count × target sum within a bounded budget, typically true per-hotel/per-stay): subset-sum/bin-covering **dynamic programming** over achievable capacity sums to find the **minimum room count** whose combined capacity ≥ hajiCount, then a second DP pass among equal-minimal-count solutions to **minimize wasted capacity**.
3. **Heuristic fallback for large pools** (bounds exceeded): first-fit-decreasing by capacity to seed a feasible solution, then bounded local-search swaps (try replacing one room with a smaller one if it still covers the requirement) to reduce waste — capped iteration count so it's always fast.
4. **Tie-breaking preferences** applied after finding minimal-count/minimal-waste candidates: prefer same-floor grouping, prefer leaving larger contiguous blocks of remaining inventory intact (avoid fragmenting, e.g. don't break up a rare 6-bed room for a 3-Haji ask if 3+3 exists elsewhere) — implemented as a scoring function over otherwise-equal candidate sets, not baked into the DP itself.
5. **Locked rooms** are simply excluded from `availableRooms` before the algorithm runs.
6. **Insufficient inventory:** if even using every available room capacity < hajiCount, return the best partial covering plus `shortfall = hajiCount - totalCapacity`; the service layer requires `booking.override` permission to proceed with a partial allocation and records why.
7. **Both values are always stored**: `system_suggested_allocation` (algorithm output, immutable) and `final_user_allocation` (what was actually booked) on `booking_room_allocation`, with an audit entry (user, timestamp, before, after, reason) whenever they diverge — per spec §10.

## 12. Finance/Accounting Architecture

- **Money is `bigint` minor currency units** (halalas for SAR) everywhere — DB columns, TypeScript domain types (a branded `Money` type wrapping `bigint`), and all arithmetic goes through domain functions (`addMoney`, `multiplyMoney(qty)`, `allocatePayment`) that never touch IEEE-754 floats. Display formatting (division by 100, locale) happens only at the presentation edge.
- **One source of truth for "due":** `booking.due` is **never stored** as an independent field. Due is always computed as `invoice.total - SUM(payment.amount WHERE payment.status = CLEARED)` at read time (or cached in a read-optimized projection that is rebuilt from the ledger, never hand-edited). This directly satisfies §58 of the spec.
- **Rates are date-effective and snapshotted.** `rate_plan_night` holds the *current* configurable nightly price; at booking confirmation, the resolved nightly prices are copied into `booking_rate_snapshot` (immutable). Invoices are generated from the snapshot, never from live rates — so a later rate change never alters historical booking value (§15).
- **Invoices are append/correct, never rewritten.** Corrections are modeled as `invoice_correction` (credit/debit note) rows referencing the original invoice; the "current total" is the original plus corrections, and the original PDF remains re-downloadable unchanged (§17, §59).
- **Payments are an append-only ledger.** No payment row is ever deleted; refunds/reversals are new negative-amount rows referencing the original, all carrying actor/timestamp/method/reference — satisfying §59's "create, adjust, reverse, version" principle.

## 13. Notification / Background-Job Architecture

**One central reminder engine**, not ad-hoc notification calls scattered per module, per §29:

- **Job queue: `pg-boss`** (Postgres-backed queue/scheduler, runs inside the existing database — no Redis, no separate broker). This matches the low-cost-first deployment goal: one Postgres instance is the only stateful dependency for both data and jobs.
- **Reminder policies are data, not code**: `reminder_policy(source_type, offsets[], recipient_role)` — e.g., source_type = `HOLD_EXPIRY` with offsets `[-3d, -2d, -1d, 0d]`, or `COMPLIANCE_DOCUMENT` with offsets `[-90,-60,-30,-15,-7,-1]`. Adding a new reminder type is a config row plus a small event-producer, not new notification plumbing.
- **Flow:** a domain event (hold created, document expiring, payment due date set) → the engine schedules `reminder_event` rows at the policy's offsets → a recurring pg-boss job promotes due `reminder_event`s into `notification` rows addressed to the resolved responsible user(s) (role-based recipient resolution, e.g. Hotel HR Manager for that specific hotel, not a broadcast) → delivery workers send in-app (DB-backed, read via API) and email (via a `NotificationChannel` interface — initial implementation using Resend/SMTP, swappable).
- **Hold auto-release** is one more consumer of this same engine: a scheduled job finds expired, non-"do-not-auto-release" holds, re-verifies still-unconfirmed inside a transaction with `SKIP LOCKED`, releases inventory, emits the release notification, writes an audit entry.
- Delivery status tracked per notification (`scheduled`, `sent`, `failed`, `acknowledged`) with retry with backoff on failure, satisfying §29's tracking requirement. WhatsApp/SMS are future `NotificationChannel` implementations — no architectural change needed to add them.

## 14. Demo Data Architecture

- Demo data lives in one ordinary `organization` row (`slug = 'demo'`), using the exact same schema and code paths as real tenants — **no parallel "demo mode" code branch**, which is both simpler and guarantees the demo always reflects real behavior.
- Seed script is **idempotent and deterministic**: fixed seed for any randomization (Haji names, dates relative to a fixed anchor date recomputed at seed time), organized as composable seed modules per domain (hotels → rooms → capacity periods → employees → bookings → payments → expenses …) matching the phase build-out in §55, so each phase's `pnpm demo:seed` extends the same dataset.
- **"Reset Demo Data"** is a privileged server action: wrapped in a transaction that deletes only rows scoped to the demo `organization_id` (cascade-scoped via FK), then re-runs the deterministic seed, then writes an audit entry — requires `organization.resetDemo` permission (Super Admin only) plus a confirmation step in the UI. It is architecturally incapable of touching another `organization_id` because every delete/seed statement is parameterized by the demo org's id, and no other tenant row can satisfy the same FK chain.
- Demo realism/consistency rules (§56) are enforced by generating data **through the same domain services used at runtime** (e.g., seeding a booking calls the same allocation + invoicing + payment-application services a real user action would) rather than hand-crafting inconsistent rows directly via SQL — this is the single biggest guarantee against "impressive but wrong" fake data.

## 15. File Storage Architecture

- A `StorageDriver` interface (`put`, `getSignedUrl`, `delete`) abstracts storage; **local filesystem driver for development**, **S3-compatible object storage (Cloudflare R2 recommended for cost) for staging/production** — selected via env var, no code change to switch.
- Database stores only **metadata + storage key** (`document_asset(id, organization_id, storage_key, mime_type, size_bytes, original_filename, uploaded_by, entity_type, entity_id)`), never binary content in Postgres.
- Uploads are validated server-side (MIME allow-list, max size) before a signed key is issued; filenames are never trusted for storage paths — a generated UUID + extension is used, original filename kept only as display metadata.
- Sensitive documents (Iqama scans, contracts) get **signed, time-limited download URLs** issued per-request after a permission check, never public bucket URLs.

## 16. Reporting Architecture

- The default path for all reports is **server-side aggregate SQL queries** directly against transactional tables, parameterized by the shared filter set (hotel, date range, category, etc.) — correct-by-construction since it reads the same ledger as everything else, no separate "analytics DB" to keep in sync in v1.
- **Materialized views are added only for specific, proven-slow aggregates** (e.g., a daily occupancy/room-nights rollup once history spans years), refreshed by a scheduled pg-boss job — not introduced speculatively (§53 explicitly warns against premature pre-materialization).
- **Large/export reports run asynchronously**: a report request enqueues a pg-boss job, generates the file (PDF/XLSX) into object storage, and notifies the user when ready — keeps the request/response cycle fast and avoids timeouts on big date ranges (§34).
- Multi-hotel aggregates use **weighted calculations** (e.g., overall occupancy % = total occupied room-nights ÷ total available room-nights across hotels, not an average of each hotel's %) — implemented once as shared domain functions (`server/domain/analytics/`) so every dashboard/report reuses the same correct formula (§30, §58).

## 17. Deployment Architecture

- **Single Docker image** running the Nuxt/Nitro server (Node preset) — includes the HTTP server and the pg-boss worker in-process for v1 (simplest possible ops model; can be split into a separate worker container later purely by changing the start command, no code change).
- **Managed PostgreSQL** (Neon or Supabase recommended — see §18) rather than self-hosted, for automated backups/PITR without ops burden.
- **Object storage**: Cloudflare R2 (S3-compatible, no egress fees).
- **Reverse proxy/TLS/CDN**: handled by the hosting platform (Railway/Render/Fly all provide this) rather than custom nginx config.
- Config fully via environment variables (`DATABASE_URL`, `STORAGE_*`, `EMAIL_*`, `SESSION_SECRET`, `APP_ENV`) — four environments (`development`, `demo`, `staging`, `production`) differ only by env vars and which `organization` rows exist, never by code branches.

## 18. Low-Cost Deployment Options

Recommended starting stack (re-evaluate only if usage outgrows it):
- **App hosting:** Railway or Fly.io — container-native, cheap always-on small instances (needed since background jobs require a persistent process, ruling out pure serverless functions for the worker).
- **Database:** Neon (serverless Postgres, generous free/low tier, branching for staging-from-production-shape testing, automated backups/PITR built in).
- **Object storage:** Cloudflare R2 (free egress, S3-compatible SDK).
- **Email:** Resend (generous free tier, simple API, easy to swap later).
- Estimated all-in cost for demo + small-real-customer scale: low tens of USD/month.

## 19. Backup & Recovery Plan

- Rely on the managed Postgres provider's **automated continuous backups + point-in-time recovery** (Neon/Supabase both provide this) as the primary mechanism, rather than hand-rolled `pg_dump` cron jobs as the only line of defense.
- **Supplementary nightly `pg_dump`** to object storage (R2), retained on a rolling window (e.g., 30 daily + 12 monthly), as a provider-independent second copy.
- **Restore procedure is documented and tested on staging on a defined cadence** (e.g., quarterly): restore latest backup into a scratch staging DB, run the smoke test suite against it, record the result — an untested backup is treated as equivalent to no backup, per the spec's explicit requirement (§48).
- Migrations are forward-only, reviewed SQL (drizzle-kit generated + hand-reviewed for the raw-SQL constraint files), applied via a single migration-runner step in the deploy pipeline before the new app version receives traffic.

## 20. Observability

- Structured JSON logging (pino) for all server routes and background jobs, correlated with a request id.
- API errors logged with context (route, org/hotel, actor, input shape — never raw secrets/PII in logs).
- Background job failures logged by pg-boss's built-in failure tracking, surfaced in an internal `/admin/jobs` view.
- Email delivery status persisted per notification (§13).
- `/api/health` endpoint checks DB connectivity and job-queue liveness for platform health checks.
- Architecture leaves a clean seam to add Sentry (or similar) later — a single error-reporting hook point in the Nitro error handler and a client-side Vue error boundary, not wired to a vendor yet.

## 21. Security Requirements

- Server-side authorization on every route (§8) — never UI-only hiding.
- Session cookies: httpOnly, secure, sealed/encrypted, short-lived with rolling renewal; CSRF protection via same-site cookies + origin check on state-changing routes.
- Passwords: argon2id, minimum complexity policy, rate-limited login attempts (per-IP and per-account) to prevent brute force.
- Rate limiting on sensitive routes (login, password reset, file upload, export generation) via a lightweight in-process limiter backed by Postgres (consistent with the "one stateful dependency" goal) rather than adding Redis solely for this.
- Input validation with Zod schemas shared between client and server (`shared/schemas`) — server validation is authoritative regardless of client checks.
- File upload validated by MIME + magic-byte sniffing + size limits; stored under generated keys (§15).
- Sensitive employee fields (Iqama number, passport number, salary) gated by dedicated permissions, redacted from API responses when the caller lacks them — not just hidden in the UI.
- Full audit logging (§35) with before/after values for all financial, capacity, permission, and compliance changes.
- Secrets only via environment variables / the hosting platform's secret manager — never committed, never hard-coded per-environment URLs.

## 22. Testing Strategy

- **Unit tests (Vitest)** for the pure domain layer — this is the highest-value test surface and is fast/deterministic: capacity resolution, seasonal overrides, hotel averages, allocation optimizer (including edge cases from §2), nightly rate/booking totals, money arithmetic, payment application/due calculation, occupancy/ADR/RevPAR, weighted multi-hotel aggregation, payroll calculation, reminder-offset scheduling, permission/hotel-scope checks.
- **Integration tests** against a real ephemeral Postgres (Docker Compose service, or Testcontainers) for: the booking transaction end-to-end (concurrent double-booking attempt must fail exactly one of two simultaneous requests), hold expiry sweep under `SKIP LOCKED`, tenant-isolation (a query scoped to org A must never return org B rows), exclusion-constraint enforcement for capacity-period overlap.
- **E2E (Playwright)**, added from Phase 2 onward once real screens exist, covering the golden paths: create booking → allocate rooms → pay → invoice; and a role-based access smoke test per persona (§38).
- Test data uses the same seed-module system as demo data (§14) at reduced scale, run against a disposable test database per CI run, never against demo/production.

## 23. Full Implementation Milestones

Matches spec §54, restated with the concrete deliverables this review adds:

- **Phase 0 — Architecture (this document).** Approve decisions above, scaffold repo structure, DB connection, auth skeleton, RBAC seed, CI test harness, empty demo-org shell.
- **Phase 1 — Inventory Foundation.** Organization/hotel/floor/room-type/room CRUD, capacity periods + overrides with exclusion-constraint enforcement, effective-capacity + hotel-average domain functions (unit-tested), room calendar (virtualized grid), demo seed: 5 hotels, 300+ rooms, seasonal periods.
- **Phase 2 — Booking Core.** Customers/agents, availability engine, allocation optimizer, holds + expiry sweep, booking creation with concurrency-safe room assignment, audit trail for allocation overrides. Demo seed: holds, confirmed/cancelled bookings, room transfers.
- **Phase 3 — Commercial.** Rate plans + nightly pricing + snapshotting, invoices + corrections, payments/receipts, agent/customer statements. Demo seed: realistic paid/partial/overdue mix.
- **Phase 4 — Operations.** Check-in/out, room transfers (already modeled in Phase 2, UI here), maintenance tickets, housekeeping status (decoupled module, feature-flaggable).
- **Phase 5 — Finance.** Expenses + recurring rules, hotel contracts + break-even/margin calculations, hotel and all-hotel financial dashboards (weighted aggregation).
- **Phase 6 — HR.** Employees, payroll runs, compliance document versioning + renewal workflow, sensitive-field permission gating.
- **Phase 7 — Automation.** Central reminder engine (pg-boss), email channel, hold-expiry + payment-due + compliance reminders wired to the engine built in Phase 2/6.
- **Phase 8 — Analytics.** KPI dashboard, trend/period comparisons, forecast-vs-actual separation, unsold-inventory alerts, report center + async export.
- **Phase 9 — Production Hardening.** Security review pass, load/performance testing on realistic data volume, backup/restore drill, monitoring wiring, 2FA rollout, staging sign-off checklist.

Each phase, when executed, will get its own scoped plan (DB migration diff, API surface, UI screens, tests, demo-seed extension, acceptance criteria) — not implemented in one shot.

## 24. Proposed Directory Structure

```text
app/
  components/
  pages/
  layouts/
  composables/
  stores/
server/
  api/                # thin route handlers
  services/           # orchestration, auth checks, transactions
  domain/             # pure business rules (capacity, allocation, pricing, analytics)
  repositories/        # Drizzle queries, one per aggregate
  middleware/          # session resolution, tenant/hotel scoping
  jobs/                 # pg-boss job definitions (reminders, hold-expiry, recurring expenses, exports)
  utils/
shared/
  types/
  schemas/             # Zod schemas, shared client+server
  constants/            # permission catalog, status enums
  business-rules/      # constants that are policy, not code (thresholds, default offsets)
db/
  schema/               # Drizzle table definitions, per module
  migrations/           # drizzle-kit generated + hand-authored constraint SQL
  seed/                 # composable, idempotent demo/test seed modules
tests/
  unit/
  integration/
  e2e/
docs/
  ARCHITECTURE.md       # this file
  phases/                # per-phase plans, added as each phase starts
```

## 25. Major Database Entities & Relationships

```
organization 1─* hotel 1─* floor 1─* room *─1 room_type
hotel 1─* capacity_period 1─* room_capacity_override *─1 room
hotel 1─* customer, agent, employee, expense, hotel_contract, maintenance_ticket
booking *─1 hotel, *─1 customer(nullable), *─1 agent(nullable), *─0..1 itinerary
booking 1─* booking_room_requirement 1─1 booking_room_allocation (suggested + final)
booking_room_allocation 1─* booking_room_assignment *─1 room
booking 1─0..1 hold
booking 1─* booking_rate_snapshot
booking 1─1 invoice 1─* invoice_line, invoice 1─* invoice_correction
invoice 1─* payment 1─0..1 receipt
employee *─1 hotel (via employee_hotel_assignment, many-to-many with allocation %)
employee 1─* compliance_document *─1 compliance_document_type
employee 1─* payroll_line *─1 payroll_run
reminder_policy 1─* reminder_event *─1 notification
user *─* role (user_role) ; role *─* permission (role_permission) ; user *─* hotel (user_hotel_access)
every table above → organization_id (direct or via hotel_id)
```

## 26. Critical Indexes / Constraints

- `EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out, '[)') WITH &&) WHERE status IN ('HELD','CONFIRMED','CHECKED_IN')` on `booking_room_assignment` — hard double-booking prevention.
- `EXCLUDE USING gist (room_id WITH =, daterange(start_date, end_date, '[]') WITH &&)` on `room_capacity_override` — no overlapping capacity periods per room.
- Composite index `(organization_id, hotel_id)` on every tenant table used in list/filter queries (rooms, bookings, expenses, employees…).
- Index on `(hotel_id, check_in, check_out)` for room-calendar and availability queries; GiST index on the `daterange` expression itself for range-overlap performance.
- Unique constraint `(organization_id, invoice_number)` and `(organization_id, booking_reference)` — human-facing sequences unique per org, generated via a per-org sequence, not global.
- `FOR UPDATE`-friendly primary key indexes on `room` (locked during allocation confirm) and `hold` (locked during expiry sweep with `SKIP LOCKED`).
- Partial index on `compliance_document (expiry_date) WHERE status <> 'RENEWED'` to keep the reminder-scan job cheap as history grows.
- Check constraints on money columns (`amount >= 0` where negative isn't valid, e.g., invoice totals; explicitly allow negative on `payment.amount` for refunds).

## 27. Risks & Trade-offs

- **Drizzle vs. Prisma** — chosen for SQL-native concurrency control; trade-off is a less polished admin-UI/DX ecosystem. Mitigation: document raw-SQL patterns once, reuse across modules.
- **pg-boss on the primary Postgres** — simplest low-cost option, but background job load shares resources/connections with the transactional workload. Mitigation: modest job volume expected at this scale; revisit (separate worker DB or Redis-backed queue) only if job throughput becomes a measured bottleneck.
- **Shared-schema multi-tenancy without RLS in v1** — relies on disciplined repository-layer scoping rather than a database-enforced guarantee. Mitigation: repository base class makes org-scoping structurally mandatory (can't compile/call without it) plus integration tests specifically assert cross-tenant isolation; RLS can be layered in later without a schema change since `organization_id` already exists everywhere.
- **Exact DP allocation solver has a complexity ceiling** — degrades to heuristic for very large room pools. Mitigation: realistic hotel/stay-scoped pools (tens to a few hundred candidate rooms) stay well within exact-solve bounds; the heuristic path is still unit-tested against known-good outcomes.
- **Derived-inventory queries vs. pre-materialized grids** — cheaper to store and always correct, but relies on well-tuned range/GiST indexes for performance at scale. Mitigation: covered in §16/§53; add a read-optimized projection only if profiling proves it necessary, not speculatively.
- **Single-region managed Postgres** is a v1 simplicity trade-off against multi-region resilience — acceptable given the cost target and current scale; revisit if uptime SLAs tighten.

---

## Assumptions Made (no open blocking questions)

Per instruction, decisions answerable by standard engineering practice were made directly rather than asked as questions; the ones most worth your explicit awareness:

- Operating currency defaults to SAR with VAT handling added now (§2.2) even though not explicitly requested, since it's a near-certain real requirement.
- Drizzle over Prisma (§5) — reversible early, harder to reverse once Phase 1+ schema code exists, flagging it clearly for your review.
- pg-boss over a separate broker (Redis/BullMQ) for jobs, to keep infra to one stateful dependency (§13, §18).
- RBAC uses role-based permissions only in v1 (no per-user overrides) — can be added later without a schema break.
- Pilgrim roster and itinerary/package grouping (§2.1, §2.5) added to the schema as optional/nullable now, not required workflows, so they don't block Phase 1–2 but avoid a costly retrofit.

No item above blocks starting Phase 0 scaffolding. Flag anything you'd like changed and it will be revised before code is written.
