# Deploy checklist (Phase 1)

Work through every item before a staging or production deployment. Variables are documented in `.env.example`
and validated by `server/utils/env.ts`; background in `docs/ARCHITECTURE.md` and `docs/MIGRATIONS.md`.

## Configuration

- [ ] `APP_ENV` is set explicitly (`production` or `staging`; the default is `development`).
- [ ] `NUXT_SESSION_COOKIE_SECURE=true` (or unset — the default is `true`). Never `false` outside local HTTP
      development and tests. The site is served over HTTPS.
- [ ] `NUXT_SESSION_PASSWORD` is a strong random secret of **at least 32 characters** (the schema minimum; prefer
      48+ random characters), unique per environment, stored in the platform's secret manager — never committed.
      Rotating it signs every user out.
- [ ] Session lifetime reviewed: sessions last **8 hours** (`nuxt.config.ts`, `runtimeConfig.session.maxAge`); the
      cookie holds identity only, and permissions/hotel access are re-read from the database on every request.
- [ ] `DATABASE_URL` points at the intended PostgreSQL 16 database; `DATABASE_POOL_MAX` (1–50, default 10) fits the
      database's connection limit times the number of server processes.
- [ ] `ALLOW_DEMO_SEED` is **unset or `false` in production** (the demo seed/reset then refuses `APP_ENV=production`).
- [ ] `DEMO_SIGN_IN_ENABLED` is **unset or `false` in production and in staging.** Production with `true` fails
      startup; staging with `true` starts but keeps the endpoint closed (404). Policy is still: off on both.
- [ ] No demo organization in production: `pnpm db:seed` is never run against a production database, and the public
      demo password is never used for a real account.
- [ ] Environment validated before traffic: the server starts (an invalid storage or demo setting stops startup),
      and the health check below answers 200 (the first database use validates `DATABASE_URL` and
      `NUXT_SESSION_PASSWORD`; an invalid value shows up there as 503).

## Database and migrations

- [ ] The migrating role can run `CREATE EXTENSION btree_gist` — on PostgreSQL 13+ `btree_gist` is a trusted
      extension, so a non-superuser with `CREATE` privilege on the database may create it — **or** an administrator
      has pre-created it: `CREATE EXTENSION IF NOT EXISTS btree_gist;` in the target database. Never edit a
      migration to work around this.
- [ ] `pnpm db:check` and `pnpm db:drift` are clean on the commit being deployed (CI `static` job green).
- [ ] `pnpm db:migrate` has **succeeded before the new application version receives traffic**; a failed migration
      stops the deploy (the script exits non-zero). Migrations are forward-only.
- [ ] Database backups/point-in-time recovery are enabled by the database provider (`ARCHITECTURE.md` §19).

## Document storage

- [ ] `STORAGE_DRIVER=local` (the only Phase 1 driver; S3-compatible storage is not implemented).
- [ ] `STORAGE_LOCAL_DIR` is writable by the server process and on **persistent** storage (a mounted volume, not the
      container's ephemeral filesystem), shared by every server process that serves downloads.
- [ ] Acknowledged: document bytes live only in that directory (metadata in PostgreSQL). Database backups do not
      contain them; include the directory in the deployment's backup/restore plan, or accept that lost files make
      their documents fail to download (500 `DOCUMENT_FILE_MISSING`). Phase 1 ships no backup mechanism of its own.

## Verification after the deploy

- [ ] `GET /api/health` → `200 {"status":"ok","db":"ok"}` (`503 {"status":"degraded","db":"down"}` means the database
      is unreachable or the environment is invalid).
- [ ] The session cookie set by `POST /api/auth/login` carries `Secure`, `HttpOnly` and `SameSite=Lax`.
- [ ] Production and staging: `GET /api/public/demo-sign-in` answers 404.
