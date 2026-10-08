# Hajj & Umrah Hotel Operations System — Architecture

Status: **approved in Phase 0; updated at the end of Phase 1 (Inventory Foundation) to match the shipped code.** Sections describing later phases (bookings, finance, HR, notifications, reporting, …) remain the agreed direction, not shipped behavior. What Phase 1 actually ships is described in §6 (table catalogue), §7–§8 (tenancy and authorization), §9 (inventory), §14 (demo), §15 (documents and storage), §20 (health), §22 (testing) and §28 (Phase 1 divergence register, changelog and known limitations). Operational guides: `README.md` (developer workflow, demo personas), `docs/MIGRATIONS.md` (migration policy), `docs/DEPLOY_CHECKLIST.md` (deployment prerequisites).

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

Organized by module; see §25 for relationships and §26 for constraints. Money = `bigint` minor units (halalas). Dates = `date` for operational days, `timestamptz` for events. All tenant tables carry `organization_id`.

### 6.1 Shipped tables (Phase 0 + Phase 1, migrations `0000`–`0007`)

There is **no session table**: sessions are sealed cookies (§8). There is **no `room_status_event` table**: maintenance/out-of-service are `room_operational_block` rows, and housekeeping status is a Phase 4 concern.

| Table | Scope | Purpose (Phase 1) |
|---|---|---|
| `organization` | platform | A tenant. `slug` unique; `is_demo` flags the demo organization. |
| `app_user` | organization | A login. Email unique per organization; `all_hotels` flag; `is_active`. Argon2id password hash. |
| `role`, `role_permission`, `user_role` | organization | Roles per organization (seeded from `shared/constants/roles.ts`), their permission keys, and user↔role links (`user_role.organization_id` + composite FKs, migration `0001`). |
| `permission` | platform | The global permission-key catalogue (`shared/constants/permissions.ts`). |
| `hotel` | organization | A hotel: code (unique per organization), name, city/country, IANA timezone, check-in/out times, currency, ownership type, license reference, status `ACTIVE`/`INACTIVE`. |
| `hotel_setting` | hotel | Key/value settings validated against a registry (`shared/business-rules/hotelSettings.ts`); Phase 1 has `inventory.maintenanceBlocksSales` (default `true`). |
| `user_hotel_access` | hotel | Explicit hotel access for users without `all_hotels`. |
| `floor` | hotel | Level (unique per hotel, −5…200), label, active flag. |
| `room_type` | organization | Organization-wide catalogue: code, default physical beds and default sellable capacity (copied — snapshot — into a room's base version when a room is created). |
| `room` | hotel | A physical room: number (unique per hotel, never reused, immutable), floor, room type, features, notes. Rooms are never deleted. |
| `room_base_config` | hotel | Versioned base capacity: `[valid_from, valid_to]` (`valid_to` null = open-ended), physical beds 1–30, sellable 0–30, origin, reason. A room is **in inventory** on a night iff a version covers it. Exclusion constraint: no two versions of one room overlap. |
| `capacity_period` | hotel | A dated season (`HAJJ`/`RAMADAN`/`SPECIAL`), name unique per hotel. |
| `room_capacity_override` | hotel | One room's capacity during one period; its dates always equal the period's (composite FK `(period_id, valid_from, valid_to)` → period `(id, start_date, end_date)` `ON UPDATE CASCADE`). Exclusion constraint: at most one override per room per night. |
| `room_operational_block` | hotel | `OUT_OF_SERVICE` / `MAINTENANCE` / `OPERATIONAL_BLOCK` over dates, with a required reason; soft-cancel (`cancelled_*`) and ended-early columns (`ended_early_at`, `ended_early_by`, `original_end_date`). Partial exclusion constraint: no two **active** blocks of the **same kind** on one room and night. |
| `audit_log` | organization (+ optional hotel) | Immutable (a `BEFORE UPDATE` trigger raises) before/after audit rows; `hotel_id` set for hotel-scoped events. |
| `document_asset` | organization | Document metadata: server-generated `storage_key` (unique), sanitized original filename, MIME (`application/pdf`/`image/png`/`image/jpeg`), size 1 B–10 MiB, SHA-256, `archived_at`. Bytes are not in PostgreSQL (§15). |
| `hotel_document` | hotel | Links an asset to a hotel with document type (`LICENSE`/`CONTRACT`/`INSURANCE`/`PERMIT`/`OTHER`), title, description. |

Every hotel-owned table carries `organization_id` **and** `hotel_id` and references its parents through **composite foreign keys that include `organization_id`** (and `hotel_id` where the parent is hotel-owned), so a row can never point at another tenant's (or another hotel's) row. `btree_gist` is required for the three exclusion constraints (see `docs/MIGRATIONS.md`).

### 6.2 Planned tables (later phases — not shipped)

The names below are the direction for later phases and do not exist yet.

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

**As shipped in Phase 1** (layers 1–2 above, made structural; RLS is still not used — Phase 9):

- **Branded scopes.** `OrganizationScope` and `HotelScope` (`server/security/scope.ts`) are branded types that only `server/security`, the seeds and tests may mint (`trusted*`, enforced by ESLint `no-restricted-imports`). Tenant repositories (`server/repositories/tenant`) take an `OrganizationScope`, hotel repositories (`server/repositories/hotel`) a `HotelScope`; every query they build carries the `organization_id` (and `hotel_id`) predicate (`server/repositories/base/scopedQuery.ts`). Platform repositories (`server/repositories/platform`: organizations, permission catalogue) are the only unscoped ones.
- **Layering.** Only repositories import Drizzle or `db/schema`/`db/client`; services, routes, domain, utils and `shared` may not (ESLint rule + `tests/unit/architecture/layering.test.ts`). Every tenant/hotel repository method is listed in an isolation registry exercised by `tests/integration/security/tenantIsolation.test.ts`.
- **Database backstop.** Composite foreign keys including `organization_id` (and `hotel_id`) on every child table, plus `UNIQUE (organization_id, id)` targets, make a cross-tenant or cross-hotel reference impossible even for code that bypasses the services (§6.1).
- **Demo isolation.** The demo organization is an ordinary tenant flagged `is_demo`; its reset deletes exactly that organization (one cascading delete by id) and recreates it (§14).

## 8. Authentication / RBAC Strategy

- **Session-based auth**, sealed encrypted httpOnly cookies via `nuxt-auth-utils` (avoids hand-rolling JWT/session infra; battle-tested with Nitro). Passwords hashed with argon2id.
- **RBAC model:** `permission` is a flat string catalog (`booking.create`, `payment.create`, …, exactly the list in the spec, extensible by inserting new rows — no code change needed to add a permission). `role` is a named bundle of permissions (seed roles: Super Admin, Hotel Manager, Reservation Manager, Accountant, HR Manager, Reception, Read-only Management — matching the demo personas in §38). Users get roles via `user_role`; **custom per-user permission overrides are not in v1** (adds complexity without a stated requirement) — roles are the unit of authorization.
- **Hotel scope is orthogonal to role**: `user_hotel_access` (user_id, hotel_id | ALL). A permission check is always `(does role grant permission) AND (does user have access to this hotel)`.
- **Every server route re-checks both**, via a shared `requirePermission(event, 'booking.create', hotelId)` helper used inside services — never inferred from UI state.
- Sensitive-field access (e.g., employee Iqama numbers) uses a dedicated finer-grained permission (`employee.viewSensitive`) checked at the field-serialization layer, not just the route layer, so a route granting general `employee.view` doesn't leak sensitive fields by accident.
- 2FA (TOTP) is schema-ready (optional `user.totp_secret`) but not required for v1 UI; recommended before production go-live for Super Admin/Accountant roles.

### 8.1 As shipped in Phase 1

- **Identity-only sealed session.** `POST /api/auth/login` (organization slug + email + password; one identical 401 `INVALID_CREDENTIALS` for unknown organization, unknown email or wrong password) stores only `{ user: { id, organizationId, email, fullName }, loggedInAt }` in the `nuxt-auth-utils` sealed cookie (`httpOnly`, `sameSite=lax`, `secure` by default — `NUXT_SESSION_COOKIE_SECURE=false` only for local HTTP/tests — `maxAge` 8 hours, sealed with `NUXT_SESSION_PASSWORD`, minimum 32 characters). No permission or hotel-access snapshot is ever stored in the cookie. There is no session table. 2FA, login rate limiting and lockout are not implemented (Phase 9).
- **Per-request authorization context.** Every authenticated request calls `resolveAuthContext` (`server/security/authContext.ts`) once (memoized per request): the active user row (scoped to the session's organization), the permission keys of the user's roles in its **own** organization, and its explicit hotel ids — three queries, fresh from the database, so a role change, a deactivated user or revoked hotel access takes effect on the next request. A user that no longer resolves clears the session and answers 401 `SESSION_INVALID`.
- **Roles and permissions** are database rows (§6.1). Hotel access = `app_user.all_hotels` **or** a `user_hotel_access` row. `organization.resetDemo` is demo-only: it is granted to the demo organization's Super Admin by the demo seed and is never part of the generic Super Admin role.
- **One authorization path for hotels.** `authorizeHotel(ctx, permission, hotelId)` (`server/security/authorize.ts`) is called by every hotel-scoped service and is the only place a `HotelScope` is minted for a request; organization-level operations use `requireOrgPermission` / `requireAllHotels`. Creating hotels and writing room types require `allHotels` as well as the permission.
- **Outcome semantics** (verified over real HTTP in `tests/http/**`):

| Situation | Response |
|---|---|
| No session, invalid or expired session, user deactivated/removed | **401** (`UNAUTHENTICATED` / `SESSION_INVALID`) |
| Resource id that is not in the caller's organization | **404** (e.g. `HOTEL_NOT_FOUND`, `ROOM_NOT_FOUND`, `BLOCK_NOT_FOUND`) |
| Hotel of the caller's organization that the caller has no access to | **the same 404** `HOTEL_NOT_FOUND` — indistinguishable from a nonexistent hotel |
| Accessible resource, but the caller lacks the permission | **403** `FORBIDDEN` |
| A body references an id outside the authorized scope (e.g. a floor/room type/room of another hotel or organization in a create, override selector or bulk request) | **422** `INVALID_REFERENCE` |
| Write to an `INACTIVE` hotel | **409** `HOTEL_INACTIVE` (reads stay allowed) |

  Counts that would reveal inventory to callers without `room.view` are `null` (`HotelSummary.floorCount/roomCount`), and room-type `usageCount` is `null` unless the caller has `allHotels`. The only unauthenticated endpoints are `POST /api/auth/login`, `GET /api/health` and the runtime-gated `GET /api/public/demo-sign-in` (§14).

## 9. Inventory Architecture (as shipped in Phase 1)

**Derived, not pre-materialized.** No room × day row exists anywhere. Every per-night answer (capacity, status, availability, averages, calendar, daily summary) is computed on request by pure functions in `server/domain/inventory/**` from four kinds of stored facts, loaded per request with a fixed number of batched queries (never one per room or per night):

| Stored fact | Table | Meaning |
|---|---|---|
| Base versions | `room_base_config` | The room's normal capacity over `[valid_from, valid_to]` (open-ended last version). Changes close the current version the day before and open a new one (`planBaseChange`); retirement closes the open version (`planRetire`); reactivation opens a new open-ended version after a gap (`planReactivate`). History is never rewritten: no change may take effect before the hotel's today. |
| Capacity periods | `capacity_period` | A dated season (`HAJJ`, `RAMADAN`, `SPECIAL`). Phase (`FUTURE`/`ACTIVE`/`ENDED`) is computed with the hotel-local today; ENDED periods allow only name/notes edits, ACTIVE periods have a frozen start and kind (the end may be extended, or shortened to yesterday), FUTURE periods are fully editable but cannot start in the past. |
| Room capacity overrides | `room_capacity_override` | A room's capacity during one period (dates = the period's, kept in sync by the composite FK with `ON UPDATE CASCADE`). Applied by selector (`all`, `floorIds`, `roomTypeIds`, `roomIds` ≤ 1,000) with `ABSOLUTE` or `DELTA` values (DELTA is applied to the room's base capacity on the period's first night); rooms not in inventory for every night of the period, or already overridden, are skipped with a reason. The preview endpoint runs the same planning function without writing. Overrides may be added/removed only while the period is FUTURE. |
| Operational blocks | `room_operational_block` | `OUT_OF_SERVICE`, `MAINTENANCE`, `OPERATIONAL_BLOCK` over dates with a reason. New blocks start on the hotel's today or later, are at most 731 nights, and must cover nights on which the room is in inventory. Cancelling an upcoming block soft-cancels it; "cancelling" a running block ends it yesterday (ended early, S11); ended or cancelled blocks cannot be changed. Blocks never change capacity, only status and sellability. |

**Rules** (a *night* is identified by the date it starts, in hotel time; ranges are inclusive; "today" is always `todayInTimezone(hotel.timezone, now)`, never the server's or browser's date):

1. **In inventory(room, night)** ⇔ a base version covers the night.
2. **Effective capacity(room, night)** = the override covering the night (`source: PERIOD_OVERRIDE`, with its `periodId`) ▸ else the base version (`source: BASE`) ▸ else none (not in inventory, even if an override row exists). Physical beds and sellable (Haji) capacity are always carried separately.
3. **Status(room, night)** by precedence: `NOT_IN_INVENTORY` › `OUT_OF_SERVICE` › `MAINTENANCE` › `OPERATIONAL_BLOCK` › `AVAILABLE` (Phase 2 inserts `OCCUPIED` › `BOOKED` › `HELD` before `AVAILABLE`; the constant already reserves them). Only active (non-cancelled) blocks count.
4. **Sellable(room, night)** ⇔ in inventory ∧ no covering block that stops sales: `OUT_OF_SERVICE` and `OPERATIONAL_BLOCK` always, `MAINTENANCE` unless the hotel setting `inventory.maintenanceBlocksSales` is `false`.
5. **Stay** `[checkIn, checkOut)` = the nights `checkIn … checkOut − 1`; a room is available for the stay iff it is sellable on every night; its stay capacity is the minimum effective sellable capacity over those nights.

**Calendar segments.** `GET /api/hotels/:hotelId/room-calendar` returns, per room, run-length **segments** `{ from, to, status, sellable, physicalBeds, sellableCapacity, capacitySource, periodId, blockIds }` that cover the requested range exactly (no gap, no overlap), plus `meta: { today, maintenanceBlocksSales }` and `refs` holding exactly the periods and blocks referenced by the returned page (S13). Filters: floor, room type, room-number prefix `q`, capacity bounds, statuses with `statusMatch` `any`/`all`, `includeOutOfInventory`; derived filters apply before paging, so `total` is exact. Bounds: ≤ 400 days, page size ≤ 200 (default 50), at most 5,000 candidate rooms (more → 422 `TOO_MANY_ROOMS`, never a truncated answer), and a 2 MiB response-body budget (a larger page → 422 `CALENDAR_RESPONSE_TOO_LARGE`; narrow the page or range). The capacity timeline (`GET …/rooms/:roomId/capacity-timeline`) returns the same capacity segments for one room with `refs.periods`.

**Daily summary.** `GET …/inventory/daily-summary` returns one row per date: `roomsInInventory`, `sellableRooms`, `outOfService`, `maintenance`, `operationalBlock`, `effectiveSellableCapacity` (all rooms in inventory) and `sellableRoomCapacity` (sellable rooms only) — zeros, never `NaN`, when nothing is in inventory. Same derivation as the calendar.

**Capacity averages** (`server/domain/inventory/averages.ts`, `calendar.ts`; served by `GET /api/hotels/:hotelId/capacity/averages` and `GET /api/capacity/averages`). Notation: `R(D)` = rooms of the hotel in inventory on `D`; `base(r,D)` / `eff(r,D)` = base / effective sellable capacity.

| Average | Formula | Basis |
|---|---|---|
| Base Hotel Average(D) | `Σ_{r∈R(D)} base(r,D) ÷ |R(D)|` — seasonal overrides and blocks ignored | `ROOMS` |
| Date-Effective Hotel Average(D) | `Σ_{r∈R(D)} eff(r,D) ÷ |R(D)|` — overrides included, blocks ignored | `ROOMS` |
| Range Average [a, b] | `Σ_{D∈[a,b]} Σ_{r∈R(D)} eff(r,D) ÷ Σ_{D∈[a,b]} |R(D)|` — weighted by room-nights (≤ 400 days) | `ROOM_NIGHTS` |
| Available-Stay Average(S) | `Σ_{r∈E(S)} min_{D∈S} eff(r,D) ÷ |E(S)|`, `E(S)` = rooms sellable on every night of the stay (honours `maintenanceBlocksSales`; stay ≤ 90 nights; `eligibleRoomCount` always exact) | `ROOMS` |
| All-hotel (organization) | `Σ_h numerator_h ÷ Σ_h denominator_h` over the accessible ACTIVE hotels (or the explicit `hotelIds`), each evaluated on the explicit `date` or on its **own** hotel-local today — never the mean of hotel averages | as the parts |

Every average returns `{ numerator, denominator, value, display, basis }`. A **zero denominator** gives `value: null, display: null` — never `0`, `NaN` or `Infinity`. `display` is the ratio rounded **half-up to 2 decimals with integer arithmetic** (`formatRatio`). Worked examples (asserted in tests over the demo data): MKK-AJYAD base average on 2025-07-01 = 310 ÷ 80 = 3.875 → `"3.88"`; demo organization base average on 2025-07-01 = 1578 ÷ 360 = 4.3833… → `"4.38"`; during Hajj 2027 MKK-GRAND's date-effective average is above its base average and equals it again from 2027-08-01. Room estimates (`ceil(hajiCount ÷ average)`) are Phase 2.

**Concurrency.** Each write runs in one transaction with its audit row. Writers that must not interleave take row locks first (the room row for base changes, retirement and blocks; the period row, then the rooms in ascending id order, for override application and period date edits). The three exclusion constraints are the database backstop; a constraint conflict surfaces as 409 (`RANGE_OVERLAP`, `BLOCK_OVERLAP`, …), and the exclusion-check deadlock (`40P01`) is translated to the same 409 for blocks and overrides. Residual non-corrupting race outcomes are listed in §28.

**Phase 2 integration.** Reservations add one more unavailability source (`booking_room_assignment`, §10) to rules 3–5 and narrow `E(S)`; no Phase 1 table changes. Blocking over booked nights and "no future bookings before deactivation" are Phase 2 seams, not built.

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

- Demo data lives in one ordinary `organization` row (`slug = 'demo'`, `is_demo = true`), using the exact same schema and code paths as real tenants — **no parallel "demo mode" code branch**, which is both simpler and guarantees the demo always reflects real behavior.
- **"Reset Demo Data"** is a privileged server action that deletes only the demo organization and re-runs the deterministic seed in one transaction, then writes an audit entry; it is architecturally incapable of touching another `organization_id`.
- Demo realism/consistency rules (§56 of the brief) are a permanent requirement; later phases extend the same dataset (bookings, payments, …) as their modules ship.

### 14.1 As shipped in Phase 1

- **Dataset** (`db/seed/demo-org.ts`, `db/seed/demo/**`, catalogues in `server/demo/catalog.ts` and `server/demo/personas.ts`): 5 hotels (3 Makkah, 2 Madinah), 360 rooms on 36 floors, 4 organization-level room types, versioned base capacity with renovations, sellable reductions, retirements, a temporarily closed and reactivated room and an inactive floor, 24 capacity periods (six named seasons per hotel family — Ramadan 2026/2027, Hajj 2026/2027/2028 and an Umrah peak Dec 2026 — applied to the hotels each belongs to) with 830 room overrides, 123 operational blocks of every kind at the default anchor (including cancelled and ended-early ones), and 9 personas with 11 explicit hotel-access rows (all-hotels personas hold the flag instead). The story: MKK-GRAND room 401 is a Quad (4/4) that becomes 6/6 during Hajj 2027 (2027-05-01…2027-07-31); MKK-AJYAD's base average is 3.88; different roles see different hotels.
- **Deterministic ids.** Every durable demo id is a UUID v5 of a stable key under a fixed private namespace (`db/seed/demo/ids.ts`: organization, roles, users, room types, hotels, floors, rooms, base versions, periods, overrides, blocks). The same key yields the same id on every seed in every environment.
- **Seeded randomness.** Every random choice uses a per-hotel, per-purpose `mulberry32` stream seeded from a string (`db/seed/demo/random.ts`), so the generated data is identical on every machine.
- **Anchor date.** Time-relative rows (running maintenance, ended-early and historical blocks) hang off `DEMO_ANCHOR_DATE` (default `2026-09-01`, a real date within 2000-01-01…2100-12-31); seasonal periods are fixed calendar dates. A reset may pass another `anchorDate` to bring the demo forward.
- **Seed = reset.** `seedDemoOrganization` runs in one transaction under a transaction-level advisory lock (`lockDemoSeed`), deletes an existing `is_demo` organization with one cascading statement by its id (a non-demo organization holding the slug is refused), and recreates everything under the **same ids**, so sessions, bookmarks and client caches stay valid. All nine personas share one Argon2id hash computed once per run. `pnpm db:seed` and `POST /api/admin/demo/reset` both use it; the reset additionally records a `DEMO_RESET` audit row in the same transaction. A failure anywhere rolls everything back; concurrent resets are serialized by the advisory lock.
- **Who may reset.** The route requires `organization.resetDemo` (403 `FORBIDDEN` otherwise — no other organization's Super Admin holds it) and the service additionally requires the caller to belong to the demo organization (also 403). Body: optional `{ "anchorDate": "YYYY-MM-DD" }`, strict.
- **Second-organization isolation.** Tests seed a second, fully populated organization and prove its fingerprint (`tests/support/fingerprint.ts`) is byte-identical after resets; the Phase 1 acceptance scenario (`tests/integration/acceptance/phase1.test.ts`) repeats this end to end.
- **Production guard.** The seed and the reset refuse to run with `APP_ENV=production` unless `ALLOW_DEMO_SEED=true` is set deliberately (`DemoSeedForbiddenError`; the reset route answers 403 `DEMO_SEED_NOT_ALLOWED`).
- **Public demo sign-in metadata.** `GET /api/public/demo-sign-in` is unauthenticated metadata for a demo login screen (slug, the demo password and the persona list with display names, role names, hotels and `phase1Available`). It is **not** authentication: it mints no session and exposes no id or hash. It answers only when `DEMO_SIGN_IN_ENABLED=true` **and** `APP_ENV` is `development` or `demo` **and** an `is_demo` organization with slug `demo` exists; otherwise it returns exactly the unknown-route 404. Configuration rules: `APP_ENV=production` with `DEMO_SIGN_IN_ENABLED=true` is an invalid configuration that **stops startup** (`server/plugins/demoEnv.ts`); `APP_ENV=staging` with the flag `true` is a **valid** configuration that starts normally, but the runtime gate keeps the endpoint closed (404); `production` with the flag `false`/unset serves 404.

## 15. File Storage Architecture

Direction (unchanged): a `StorageDriver` abstraction, metadata in PostgreSQL, bytes outside it, generated keys, server-side validation, and S3-compatible object storage (Cloudflare R2 recommended for cost) once a cloud driver exists.

### 15.1 As shipped in Phase 1 (hotel documents)

- **Metadata in PostgreSQL, bytes behind `StorageDriver`.** `document_asset` + `hotel_document` (§6.1) hold metadata only; bytes go through `StorageDriver` (`put` — never overwrites, `get` — stream, `exists`, `delete`) in `server/storage/**`.
- **Local driver only.** Phase 1 ships exactly one driver, `local` (`STORAGE_DRIVER=local`, files under `STORAGE_LOCAL_DIR`, default `.data/uploads`, resolved against the process working directory). Any other `STORAGE_DRIVER` value is a configuration error that stops startup (`server/plugins/storage.ts`); there is no silent fallback. **An S3-compatible driver is not implemented** (Phase 9).
- **Server-generated keys.** `<organizationId>/<year>/<random uuid><ext>`, built only from the organization id, the clock and a random UUID; the user's filename never reaches a path (it is sanitized and kept as display metadata only).
- **Validation.** Allow-list `application/pdf`, `image/png`, `image/jpeg`; the bytes must start with the declared type's signature (magic bytes); 1 byte to 10 MiB (also enforced by a check constraint). Uploads are `multipart/form-data` with a mandatory `Content-Length` (missing length or `Transfer-Encoding` → 411; a declared length above 10 MiB plus 64 KiB framing → 422 `FILE_TOO_LARGE` before any byte is read). The body is buffered in memory (not streamed).
- **Write order.** Authorize (`hotel.manage`) → validate → write the object → one transaction (asset row, hotel-document row, `DOCUMENT_ADDED` audit). A failed transaction deletes the object again.
- **Download and archive.** Downloads stream through the API after `authorizeHotel` (`hotel.view`); there is **no public storage URL** and no signed URL. Archiving sets `archived_at` (+ audit) and **keeps the bytes and rows**; archived documents are visible/downloadable only with `includeArchived` and `hotel.manage`. Nothing is hard-deleted.
- **Persistence requirement.** With the local driver, `STORAGE_LOCAL_DIR` must be writable and **persistent** across deploys/restarts and included in the deployment's backup plan; an ephemeral container filesystem loses every document while its metadata rows remain (downloads then fail with 500 `DOCUMENT_FILE_MISSING`). The demo reset removes demo document rows with the organization but does not delete stored files (the demo seeds no documents).

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
- Config fully via environment variables — four environments (`APP_ENV`: `development`, `demo`, `staging`, `production`) differ only by env vars and which `organization` rows exist, never by code branches. Phase 1 reads `APP_ENV`, `DATABASE_URL`, `DATABASE_POOL_MAX`, `NUXT_SESSION_PASSWORD`, `NUXT_SESSION_COOKIE_SECURE`, `STORAGE_DRIVER`, `STORAGE_LOCAL_DIR`, `ALLOW_DEMO_SEED`, `DEMO_ANCHOR_DATE` and `DEMO_SIGN_IN_ENABLED` (validated by `server/utils/env.ts`; documented in `.env.example`). Email settings arrive with the notification phase.
- **Migrations run before the new app version takes traffic** (`pnpm db:migrate`); see `docs/MIGRATIONS.md` and `docs/DEPLOY_CHECKLIST.md`. Phase 1 has no object storage yet: with the local storage driver the document directory must be a persistent volume (§15.1).

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
- `GET /api/health` (shipped, unauthenticated) runs `select 1` and answers 200 `{ status: 'ok', db: 'ok' }`, or 503 `{ status: 'degraded', db: 'down' }`. The first database use also validates the full environment (`getEnv()`), so an invalid `DATABASE_URL`/`NUXT_SESSION_PASSWORD` shows up here as 503. Job-queue liveness is added with pg-boss (Phase 7).
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
- **Phase 1 status:** server-side authorization on every route, the sealed `httpOnly` / `sameSite=lax` / `secure` session cookie, Argon2id, Zod validation, magic-byte upload validation, generated storage keys and before/after audit for every configuration write are shipped (§8.1, §15.1). Login rate limiting/lockout, an explicit CSRF origin check beyond `sameSite=lax`, 2FA and RLS are not yet implemented (Phase 9).

## 22. Testing Strategy

- **Unit tests (Vitest)** for the pure domain layer — this is the highest-value test surface and is fast/deterministic: capacity resolution, seasonal overrides, hotel averages, allocation optimizer (including edge cases from §2), nightly rate/booking totals, money arithmetic, payment application/due calculation, occupancy/ADR/RevPAR, weighted multi-hotel aggregation, payroll calculation, reminder-offset scheduling, permission/hotel-scope checks.
- **Integration tests** against a real ephemeral Postgres (Docker Compose service, or Testcontainers) for: the booking transaction end-to-end (concurrent double-booking attempt must fail exactly one of two simultaneous requests), hold expiry sweep under `SKIP LOCKED`, tenant-isolation (a query scoped to org A must never return org B rows), exclusion-constraint enforcement for capacity-period overlap.
- **E2E (Playwright)** browser tests arrive with the Phase 1 **UI** work (`docs/UI-UX-MASTER-DIRECTION.md` §45: persona navigation, golden paths, server-side 403/404 for hidden actions) and grow with every later phase (e.g. create booking → allocate rooms → pay → invoice). They are not part of the backend Phase 1 delivery.
- Test data uses the same seed-module system as demo data (§14) at reduced scale, run against a disposable test database per CI run, never against demo/production.

**As shipped in Phase 1:**

| Layer | Command | What it covers |
|---|---|---|
| Unit | `pnpm test:unit` (`tests/unit/**`) | Pure domain (dates, capacity, averages, calendar, rules), schemas, architecture/layering fitness tests. No database. |
| Type-level | `pnpm typecheck:types` (`tests/types/**`) | Compile-time proofs, e.g. a tenant query cannot choose its own organization. |
| Integration | `pnpm test:integration` (`tests/integration/**`) | Real PostgreSQL 16 (`*_test` database only — enforced): repositories, constraints, migrations harness, services, authorization/isolation registry, demo seed/reset, performance bounds (calendar/averages scale), and the **Phase 1 acceptance scenario** (`tests/integration/acceptance/phase1.test.ts`). Runs migrations first; `pnpm test:integration:fresh` rebuilds the test schema from zero. |
| HTTP (black-box) | `pnpm test:http` (`tests/http/**`) | Builds the production Nitro artifact, starts it as a child process on a free port, and exercises every Phase 1 route over real HTTP (cookies, session lifetime, 401/403/404/409/422 shapes, uploads, demo sign-in gating). `HTTP_TEST_SKIP_BUILD=1` reuses an existing `.output`. |
| All gates | `pnpm verify` | lint, typecheck, type-level tests, `db:check`, `db:drift`, unit, integration, HTTP — the same gates CI runs (`.github/workflows/ci.yml`). |

Browser E2E is not part of the backend Phase 1 delivery; it arrives with the Phase 1 UI work (see above).

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
  integration/          # incl. acceptance/phase1.test.ts
  http/                 # black-box HTTP suite against the built server
  types/                # compile-only type tests
  e2e/                  # browser tests (arrive with the UI work; empty in backend Phase 1)
docs/
  ARCHITECTURE.md       # this file
  MIGRATIONS.md         # migration policy
  DEPLOY_CHECKLIST.md   # deployment prerequisites
  UI-UX-MASTER-DIRECTION.md
  superpowers/plans/    # per-phase implementation plans
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
- Shipped in Phase 1 (all `daterange(..., '[]')`, inclusive): `room_base_config_no_overlap` `EXCLUDE USING gist (room_id WITH =, daterange(valid_from, valid_to) WITH &&)` (no overlapping base versions); `room_override_no_overlap` on `room_capacity_override` (at most one override per room per night); `room_block_no_overlap` `EXCLUDE USING gist (room_id WITH =, kind WITH =, daterange(start_date, end_date) WITH &&) WHERE (cancelled_at IS NULL)` (no two active same-kind blocks per room per night). All three need `btree_gist`.
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

## 28. Phase 1 — changelog, divergence register and known limitations

### 28.1 Changelog (what Phase 1 added)

- **Schema** (migrations `0001`–`0007`, `docs/MIGRATIONS.md`): tenancy hardening (`btree_gist`, `user_role.organization_id`, composite FKs); hotel core (`hotel`, `hotel_setting`, `user_hotel_access`, `app_user.all_hotels`, `audit_log.hotel_id` + immutability trigger); floors and room types; rooms and versioned base capacity; capacity periods and overrides; operational blocks; hotel documents.
- **Foundation:** branded scopes and scoped repositories with an isolation registry; per-request authorization with an identity-only 8-hour session; standard error shape and DB-error translation; black-box HTTP test harness; CI with static/unit/integration/http jobs.
- **Inventory:** hotel, floor, room type and room management (bulk create, retire/reactivate), base-capacity versioning, seasonal periods with override preview/apply/remove, operational blocks (bulk, cancel/end early), capacity averages, the derived room calendar, capacity timeline and daily summary, hotel-scoped audit read with cursor paging, hotel documents on the local storage driver.
- **Demo:** the deterministic 5-hotel / 360-room / 9-persona demo organization with same-id transactional reset and the gated demo sign-in metadata endpoint.

### 28.2 Divergence register (intentional differences from the Phase 1 plan)

Only differences that matter to a reader of the plan are listed; each was accepted in its task's review.

| # | Area (task) | Plan said | Shipped | Why / consequence |
|---|---|---|---|---|
| D-1 | Demo sign-in on staging (20) | Task 21 deploy text: "startup validation also refuses" `DEMO_SIGN_IN_ENABLED=true` on staging | Only `APP_ENV=production` + `true` stops startup. `staging` + `true` is a **valid** configuration; the runtime gate keeps the endpoint closed (unknown-route 404). | Staging may mirror production configuration without a crash; the endpoint is still never served there. Operational policy (`DEPLOY_CHECKLIST.md`) still says: leave it unset/false on staging. |
| D-2 | Demo dataset counts (20) | Approximate targets ("≈125 blocks", "six named periods per hotel family") | Exact, deterministic: 5 hotels, 36 floors, 360 rooms, 4 room types, 24 capacity periods, 830 overrides, 123 blocks (default anchor), 9 users, 11 explicit hotel-access rows | Determinism; the numbers are asserted by the demo tests and change only with the seed. |
| D-3 | Calendar size bound (18) | "Response stays under 2 MB for 2,000 rooms" | Page size ≤ 200; a hard 2 MiB response-body budget (422 `CALENDAR_RESPONSE_TOO_LARGE`, never truncated) and at most 5,000 candidate rooms per request (422 `TOO_MANY_ROOMS`) | Bounded memory/latency with data-dependent segment counts; clients narrow the page or the range. |
| D-4 | Uploads (19) | Multipart upload with a 10 MB limit | Body is **buffered** in memory (h3 `readMultipartFormData`); `Content-Length` is **mandatory** (411 otherwise, no chunked uploads); a declared length over the limit is rejected before reading | Bounded buffering without a streaming parser. Accepted windows: if the metadata transaction fails and the cleanup delete also fails, an orphan file remains (logged with its key); if a commit succeeds but its acknowledgement is lost, the cleanup can delete a referenced object (download then answers 500 `DOCUMENT_FILE_MISSING`). Separately, `LocalStorageDriver.put` removes a partial file when `writeFile` fails, but if the final file close itself throws after a successful write, `put` rejects before `documentService` owns the key for compensation, so an extremely rare fully-written object may remain without metadata. |
| D-5 | Concurrency residuals (14–16) | Every writer serialized by row locks | `deleteCapacityPeriod` does not lock the period row; `reactivateRoom` does not lock the room row | Non-corrupting: a delete racing an override apply is stopped by the override→period foreign key (surfaces as 422 `INVALID_REFERENCE` instead of 409 `PERIOD_HAS_OVERRIDES`); two simultaneous reactivations of one room are stopped by `room_base_config_no_overlap` (409 `RANGE_OVERLAP`, or — if PostgreSQL resolves the exclusion wait as a deadlock `40P01`, which is translated only for blocks and overrides — a 500). Data stays correct in every case. |
| D-6 | Capacity timeline refs (15/S13) | `refs.periods` as in the calendar | Timeline `refs.periods[id]` also carries `id`, and the response carries `meta.today` | Additive. |
| D-7 | Hotel write responses (12–14/S2) | `HotelDetail` with counts | `GET /api/hotels` and `GET /api/hotels/:hotelId` return real `floorCount`/`roomCount`; create/update/activate/deactivate responses return them as `null` | Clients re-read the hotel after a write when they need counts. |
| D-8 | Browser E2E (22) | "E2E from Phase 2 onward" (Phase 0 text) | Black-box HTTP tests are part of backend Phase 1; browser E2E arrives with the Phase 1 UI work (`UI-UX-MASTER-DIRECTION.md` §45) | Plan Task 21 correction. |

### 28.3 Open findings

None recorded at the Phase 1 gate. (The final acceptance gate did find and correct one contract mismatch — Task 19 wrote document audit rows with `entityType: 'hotel_document'` while the public audit filter's fixed list names `document` — so document audit rows are now written as `document`, filterable by `entityType=document`; the relational table is still `hotel_document`. This was a defect, not a divergence.)

### 28.4 Known limitations (accepted Phase 1 scope, not bugs)

- Uploads are buffered in memory (≤ 10 MiB + framing), not streamed.
- Only the local storage driver exists; it needs a persistent, backed-up directory. No S3-compatible driver (Phase 9).
- The demo data is a fixed deterministic dataset (movable only through the anchor date).
- No reservations, holds or bookings (Phase 2); availability counts only inventory and blocks.
- No browser UI and no browser E2E tests in the backend Phase 1 delivery.
- No RLS, login rate limiting/lockout or 2FA (Phase 9).

### 28.5 Test-infrastructure note

`tests/integration/db/tenancyHardening.migration.test.ts` builds scratch databases and intermittently exceeds Vitest's default 5 s per-test timeout on a loaded machine. It is a timing issue in the test, not a behavior failure; CI must report it rather than retry it silently.

---

## Assumptions Made (no open blocking questions)

Per instruction, decisions answerable by standard engineering practice were made directly rather than asked as questions; the ones most worth your explicit awareness:

- Operating currency defaults to SAR with VAT handling added now (§2.2) even though not explicitly requested, since it's a near-certain real requirement.
- Drizzle over Prisma (§5) — reversible early, harder to reverse once Phase 1+ schema code exists, flagging it clearly for your review.
- pg-boss over a separate broker (Redis/BullMQ) for jobs, to keep infra to one stateful dependency (§13, §18).
- RBAC uses role-based permissions only in v1 (no per-user overrides) — can be added later without a schema break.
- Pilgrim roster and itinerary/package grouping (§2.1, §2.5) added to the schema as optional/nullable now, not required workflows, so they don't block Phase 1–2 but avoid a costly retrofit.

No item above blocks starting Phase 0 scaffolding. Flag anything you'd like changed and it will be revised before code is written.
