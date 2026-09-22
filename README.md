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
6. `pnpm db:seed` — creates the demo organization and demo admin login.
7. `pnpm dev` — starts the app at http://localhost:3000.

## Testing

- `pnpm test:unit` — fast, no database required.
- `pnpm test:integration` — requires `docker compose up -d` first; runs
  migrations against `hajj_umrah_test` and executes tests in
  `tests/integration/**` against a real Postgres instance.
