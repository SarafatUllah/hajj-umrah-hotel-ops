# Hajj & Umrah Hotel Operations System

Multi-hotel Hajj/Umrah hotel inventory, booking, finance, HR, compliance,
operations & analytics platform. See `docs/ARCHITECTURE.md` for the
approved architecture and `docs/superpowers/plans/` for phase-by-phase
implementation plans.

## Local development

1. `fnm use` (reads `.node-version`) or ensure Node 22.19.0 is active.
2. `pnpm install`
3. `docker compose up -d` — starts local Postgres on port 5433, creates the
   `hajj_umrah_dev` and `hajj_umrah_test` databases.
4. `cp .env.example .env` and set a real `NUXT_SESSION_PASSWORD` (32+ chars).
5. `pnpm db:migrate` — applies migrations to `hajj_umrah_dev`.
6. `pnpm db:seed` — creates (or resets to its baseline) the demo organization with its complete demo dataset; see
   [Demo organization](#demo-organization).
7. `pnpm dev` — starts the app at http://localhost:3000.

## Testing

- `pnpm test:unit` — fast, no database required.
- `pnpm test:integration` — requires `docker compose up -d` first; runs
  migrations against `hajj_umrah_test` and executes tests in
  `tests/integration/**` against a real Postgres instance.
- `pnpm test:http` — black-box HTTP tests (`tests/http/**`) against the real
  production artifact: builds the app (`nuxt build`), starts
  `node .output/server/index.mjs` as a child process on a free port, waits
  for `GET /api/health`, and runs real HTTP requests against it (cookies,
  session freshness, error shapes) — the layer service-level tests can't
  see. Requires `docker compose up -d` first. Set `HTTP_TEST_SKIP_BUILD=1`
  to skip the build step when iterating locally against an artifact you
  already built.

## Demo organization

`pnpm db:seed` builds one isolated, deterministic **demo organization** (slug `demo`, flagged `is_demo`): 5 hotels
(3 Makkah, 2 Madinah), 360 rooms in 4 organization-level room types, versioned base capacity with renovations,
retirements and temporary closures, seasonal capacity periods (Ramadan, Hajj, Umrah peak) with room overrides,
operational blocks (including cancelled and ended-early ones) and 9 personas with hotel-scoped access. The story it
tells: MKK-GRAND room 401 is a Quad (4/4) that becomes 6/6 during Hajj 2027, MKK-AJYAD averages 3.88 beds per room,
and different roles see different hotels.

Every id is derived from a stable key (UUID v5), and all randomness is seeded, so the same anchor date always produces
the same data and a reset recreates the **same ids** (sessions and bookmarks stay valid).

**Demo password (public by design, shared by all nine personas):** `DemoPassword123!`  — organization slug `demo`.

| Login (`@demo.alsafahotels.test`) | Name | Role | Hotels | Phase 1 |
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

"Phase 1" is presentation only: every account can sign in and every role keeps exactly its normal permissions.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_ANCHOR_DATE` | `2026-09-01` | Real ISO date (between 2000-01-01 and 2100-12-31) every time-relative demo row hangs off (running maintenance, ended-early and historical blocks). Seasonal periods are fixed calendar dates. |
| `ALLOW_DEMO_SEED` | `false` | The demo seed and reset **refuse to run with `APP_ENV=production`** unless this is `true`. |
| `DEMO_SIGN_IN_ENABLED` | `false` | Turns on the public demo sign-in endpoint below. `true` only takes effect with `APP_ENV=development` or `demo`. With `production`, `true` is a configuration error and the server refuses to start; with `staging`, `true` is accepted (the server starts) but the endpoint stays closed (unknown-route 404). |

Invalid values (a non-boolean flag, a calendar-invalid date) are configuration errors, never silent defaults.

### Demo sign-in endpoint

`GET /api/public/demo-sign-in` (no session) returns `{ organizationSlug, password, personas: [{ email, fullName, roleName,
hotels: [{ code, name }], phase1Available }] }` so the sign-in page can offer one-click demo logins. It answers **404,
identical to an unknown route**, unless `DEMO_SIGN_IN_ENABLED=true` **and** `APP_ENV` is `development` or `demo`, **and** an
organization with slug `demo` and `is_demo = true` exists. It never signs anyone in and exposes no hash, id or tenant data.
Production and staging never serve it (production refuses to start with the flag on; staging starts and answers the 404).

### Resetting the demo

`POST /api/admin/demo/reset` (permission `organization.resetDemo`, held only by the demo organization's Super Admin;
body optional: `{ "anchorDate": "YYYY-MM-DD" }`, nothing else is accepted) deletes and recreates the demo organization in
**one transaction** (all or nothing; concurrent resets are serialized) under the same ids, then records a `DEMO_RESET`
audit entry. No other organization is touched. Stored document files are not cleaned up by a reset (the demo has none).
`pnpm db:seed` does the same without the audit entry: re-running it returns the demo organization to its baseline.
