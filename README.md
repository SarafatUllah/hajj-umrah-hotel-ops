# Hajj & Umrah Hotel Operations System

Multi-hotel Hajj/Umrah hotel inventory, booking, finance, HR, compliance,
operations & analytics platform, built phase by phase as a Nuxt 4 / Nitro
modular monolith on PostgreSQL 16 with Drizzle ORM.

**Current state: Phase 1 (Inventory Foundation, backend).** Hotels, floors,
room types, rooms with versioned base capacity, seasonal capacity periods and
room overrides, operational blocks, capacity averages, the derived room
calendar and daily summary, hotel-scoped access, per-hotel audit, hotel
documents and the isolated demo organization. There is no browser UI yet and
no reservations (Phase 2).

Documentation:

- `docs/ARCHITECTURE.md` — architecture, the shipped Phase 1 design (§6–§9,
  §14–§15, §22) and the Phase 1 divergence register (§28).
- `docs/MIGRATIONS.md` — migration policy and the `btree_gist` prerequisite.
- `docs/DEPLOY_CHECKLIST.md` — what must hold before a deployment.
- `docs/UI-UX-MASTER-DIRECTION.md` — the UI/UX direction for the Phase 1 UI.
- `docs/superpowers/plans/` — the phase implementation plans (historical
  planning documents).

## Prerequisites

- Node **22.19.0** (`.node-version`; e.g. `fnm use` or `nvm use`).
- **pnpm 9.4.0** — pinned in `package.json` (`packageManager`); use pnpm only
  (`corepack enable` picks the pinned version).
- Docker (for the local PostgreSQL 16 container), or any PostgreSQL 16 where
  you can create the `btree_gist` extension (see `docs/MIGRATIONS.md`).

## Local setup (from zero)

1. `pnpm install`
2. `docker compose up -d` — starts PostgreSQL 16 on **localhost:5433**
   (user `hajj_umrah`, password `hajj_umrah_dev_password`), creates the
   `hajj_umrah_dev` and `hajj_umrah_test` databases and the `btree_gist`
   extension in both (`db/docker/init.sql`, first start of the volume only).
   Wait until `docker compose ps` reports the service `healthy`.
3. `cp .env.example .env` and set `NUXT_SESSION_PASSWORD` to a random secret
   of **at least 32 characters** (e.g. `openssl rand -base64 48`). Every
   variable is documented in `.env.example`.
4. `pnpm db:migrate` — applies all migrations to the database in
   `DATABASE_URL` (`hajj_umrah_dev`).
5. `pnpm db:seed` — creates (or resets to its baseline) the demo
   organization; see [Demo organization](#demo-organization).
6. `pnpm dev` — starts the app at http://localhost:3000. Check
   `GET http://localhost:3000/api/health` → `{"status":"ok","db":"ok"}`.

Sign in with `POST /api/auth/login` and a JSON body
`{ "organizationSlug": "demo", "email": "<persona email>", "password": "<demo password>" }`;
the response sets the session cookie. `GET /api/auth/me` returns the
signed-in user, organization, roles, permissions and hotel access.

The test suites use `.env.test` (committed, test-only values) and the
`hajj_umrah_test` database; integration tests refuse to run against a
database whose name does not end in `_test`.

## Developer workflow

| Command | What it does |
|---|---|
| `pnpm dev` | Development server with hot reload. |
| `pnpm build` | Production build (`.output/`). |
| `pnpm db:migrate` | Apply pending migrations to `DATABASE_URL`. |
| `pnpm db:seed` | Create/reset the demo organization (refused under `APP_ENV=production` unless `ALLOW_DEMO_SEED=true`). |
| `pnpm db:generate --name <name>` | Generate one migration from a `db/schema/**` change (then read the SQL — `docs/MIGRATIONS.md`). |
| `pnpm db:check` | Validate the migration history (`drizzle-kit check`). |
| `pnpm db:drift` | Fail if the schema and the committed migrations differ. |
| `pnpm lint` | ESLint (includes the layering/scope import rules). |
| `pnpm typecheck` | `nuxt typecheck`. |
| `pnpm typecheck:types` | Compile-only type tests (`tests/types`). |
| `pnpm test:unit` | Unit tests (`tests/unit/**`), no database. `pnpm test` is the same suite. |
| `pnpm test:integration` | Migrates `hajj_umrah_test`, then runs `tests/integration/**` (incl. the Phase 1 acceptance scenario) against real PostgreSQL. Needs `docker compose up -d`. |
| `pnpm test:integration:fresh` | Rebuilds the test database schema from zero (`pnpm db:test:reset`), then runs `pnpm test:integration`. |
| `pnpm test:http` | Black-box HTTP suite (`tests/http/**`): migrates the test database, builds the production artifact (`nuxt build`), starts `node .output/server/index.mjs` on a free port, waits for `/api/health` and sends real HTTP requests. `HTTP_TEST_SKIP_BUILD=1` reuses an existing build. Uploaded test files go to a temporary directory. |
| `pnpm verify` | Every gate CI runs, in order: lint, typecheck, type-level tests, `db:check`, `db:drift`, unit, integration, HTTP. Needs the database container. |

Before pushing: `pnpm verify`; after any migration change also
`pnpm test:integration:fresh`.

CI (`.github/workflows/ci.yml`) runs the same gates in four jobs — `static`,
`unit`, `integration` and `http` — against a fresh PostgreSQL 16 service.

## Demo organization

`pnpm db:seed` builds one isolated, deterministic **demo organization** (slug `demo`, flagged `is_demo`): 5 hotels
(3 Makkah, 2 Madinah), 360 rooms in 4 organization-level room types, versioned base capacity with renovations,
retirements and temporary closures, 24 seasonal capacity periods (Ramadan, Hajj, Umrah peak) with 830 room overrides,
operational blocks (including cancelled and ended-early ones) and 9 personas with hotel-scoped access. The story it
tells: MKK-GRAND room 401 is a Quad (4/4) that becomes 6/6 during Hajj 2027 (2027-05-01 to 2027-07-31), MKK-AJYAD
averages 3.88 beds per room (310 ÷ 80 on 2025-07-01), and different roles see different hotels.

Every id is derived from a stable key (UUID v5), and all randomness is seeded, so the same anchor date always produces
the same data and a reset recreates the **same ids** (sessions and bookmarks stay valid).

> **DEMO CREDENTIAL — NEVER USE IN PRODUCTION.** All nine personas share the public demo password
> `DemoPassword123!` (organization slug `demo`). It exists only for the demo organization, is published here on
> purpose, and must never be used for a real account. Do not seed the demo organization into a production
> database.

| Login (`@demo.alsafahotels.test`) | Display name | Role | Hotels | Phase 1 |
|---|---|---|---|---|
| `admin` | Faisal Al-Otaibi | Super Admin (+ demo reset) | all | yes |
| `manager.grand` | Nora Al-Qahtani | Hotel Manager | MKK-GRAND | yes |
| `manager.madinah` | Omar Siddiqui | Hotel Manager | MED-CENT, MED-QUBA | yes |
| `reservations` | Aisha Rahman | Reservation Manager | MKK-GRAND, MKK-AJYAD, MKK-AZIZ | yes (read-only inventory) |
| `accountant` | Khalid Al-Harbi | Accountant | all | later phases |
| `hr` | Maryam Yusuf | HR Manager | MKK-GRAND, MKK-AJYAD, MED-CENT | later phases |
| `reception.grand` | Ahmed Hassan | Reception | MKK-GRAND | yes (read-only inventory) |
| `reception.ajyad` | Imran Chowdhury | Reception | MKK-AJYAD | yes (read-only inventory) |
| `management` | Sarah Al-Mutairi | Read-only Management | all | yes (read-only) |

The full email is the login plus the domain, e.g. `manager.grand@demo.alsafahotels.test`. Hotel codes: MKK-GRAND
(Al Safa Grand Makkah), MKK-AJYAD (Al Safa Ajyad Towers), MKK-AZIZ (Al Safa Aziziyah Residence), MED-CENT (Al Safa
Madinah Central), MED-QUBA (Al Safa Quba Suites). "Phase 1" is presentation only: every account can sign in and every
role keeps exactly its normal permissions (Accountant and HR have no inventory permission, so in Phase 1 they see the
hotels list only). A persona without access to a hotel gets the same 404 as for a hotel that does not exist.

### Demo environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_ANCHOR_DATE` | `2026-09-01` | Real ISO date (between 2000-01-01 and 2100-12-31) every time-relative demo row hangs off (running maintenance, ended-early and historical blocks). Seasonal periods are fixed calendar dates. |
| `ALLOW_DEMO_SEED` | `false` | The demo seed and reset **refuse to run with `APP_ENV=production`** unless this is `true`. Never set it on a real production deployment. |
| `DEMO_SIGN_IN_ENABLED` | `false` | Turns on the public demo sign-in endpoint below. `true` only takes effect with `APP_ENV=development` or `demo`. With `APP_ENV=production`, `true` is a configuration error and the server refuses to start; with `APP_ENV=staging`, `true` is a valid configuration (the server starts) but the endpoint stays closed (unknown-route 404). |

Invalid values (a non-boolean flag, a calendar-invalid date) are configuration errors, never silent defaults.

### Demo sign-in endpoint

`GET /api/public/demo-sign-in` (no session) is **unauthenticated metadata for a demo login screen, not authentication**:
it returns `{ organizationSlug, password, personas: [{ email, fullName, roleName, hotels: [{ code, name }],
phase1Available }] }` so a sign-in page can offer one-click demo logins, and it never signs anyone in, never sets a
cookie and exposes no hash, id or tenant data. It answers **404, identical to an unknown route**, unless
`DEMO_SIGN_IN_ENABLED=true` **and** `APP_ENV` is `development` or `demo`, **and** an organization with slug `demo` and
`is_demo = true` exists. Production never serves it (and refuses to start with the flag on); staging never serves it
(it starts normally with the flag on and answers the 404).

### Resetting the demo

`POST /api/admin/demo/reset` (permission `organization.resetDemo`, held only by the demo organization's Super Admin —
any other caller gets 403; body optional: `{ "anchorDate": "YYYY-MM-DD" }`, nothing else is accepted) deletes and
recreates the demo organization in **one transaction** (all or nothing; concurrent resets are serialized) under the
same ids, then records a `DEMO_RESET` audit entry. No other organization is touched. Stored document files are not
cleaned up by a reset (the demo has none). `pnpm db:seed` does the same without the audit entry: re-running it returns
the demo organization to its baseline.

## Environment and deployment

`.env.example` documents every variable the application reads (database, session, storage, demo). Before any
deployment work through `docs/DEPLOY_CHECKLIST.md`; in short: secure cookies and a strong session password, the demo
seed and demo sign-in off, `btree_gist` available, migrations applied before the new version takes traffic, and a
persistent, backed-up document storage directory.
