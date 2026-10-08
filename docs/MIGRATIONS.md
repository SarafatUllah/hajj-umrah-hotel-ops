# Migration policy

Migrations are **forward-only**. There is no down-migration tooling and none
should be added: fixing a mistake means writing a new forward migration, not
reverting an old one.

## The current chain (end of Phase 1)

Migrations live in `db/migrations/` (SQL files plus Drizzle's
`meta/_journal.json` and snapshots) and are applied in journal order:

| File | Phase / task | Contents |
|---|---|---|
| `0000_famous_wallop.sql` | Phase 0 | `organization`, `app_user`, `role`, `permission`, `role_permission`, `user_role`, `audit_log` |
| `0001_tenancy_hardening.sql` | Phase 1, Task 3 | `CREATE EXTENSION IF NOT EXISTS btree_gist`; `user_role.organization_id` (backfilled, cross-organization rows purged); `UNIQUE (organization_id, id)` on `app_user` and `role`; composite tenancy foreign keys |
| `0002_hotel_core.sql` | Task 6 | `hotel`, `hotel_setting`, `user_hotel_access`, `app_user.all_hotels`; `audit_log.hotel_id` + indexes + the `BEFORE UPDATE` immutability trigger |
| `0003_floors_room_types.sql` | Task 13 | `floor`, `room_type` |
| `0004_rooms_base_config.sql` | Task 14 | `room`, `room_base_config` + exclusion constraint `room_base_config_no_overlap` |
| `0005_capacity_periods.sql` | Task 15 | `capacity_period`, `room_capacity_override` + exclusion constraint `room_override_no_overlap` + the dates-sync composite FK (`ON UPDATE CASCADE`) |
| `0006_room_blocks.sql` | Task 16 | `room_operational_block` (incl. the ended-early columns) + partial exclusion constraint `room_block_no_overlap` |
| `0007_documents.sql` | Task 19 | `document_asset`, `hotel_document` |

## Committed migrations are immutable

**Once a migration is committed it is immutable.** Never edit, rename,
reorder or delete a committed migration file (or its journal/snapshot
entries) — not even a comment. Databases that already applied it would
silently diverge from fresh ones. A correction is always a new migration.

Hand-editing a *generated* migration is allowed **only before its first
commit**, and only to:

- (a) reorder statements,
- (b) add backfills for existing rows,
- (c) append raw SQL Drizzle cannot express itself (extensions, exclusion
  constraints, triggers).

## Making a schema change

1. Change the Drizzle schema in `db/schema/**`.
2. Generate exactly one migration for the task:

   ```sh
   pnpm db:generate --name <task-slug>
   ```

3. **Read the generated SQL** in `db/migrations/` before committing: check
   for unintended drops/renames, table rewrites on large tables, missing
   backfills for `NOT NULL` columns, and add any raw SQL the schema DSL
   cannot express (rule (c) above).
4. `pnpm db:check` and `pnpm db:drift` must be clean (below).
5. Prove the whole chain on an empty database: `pnpm test:integration:fresh`.
6. A migration that touches existing rows (a backfill or a column narrowing)
   also needs a data-preserving test written against the migration harness
   (`tests/integration/support/migrationHarness.ts`, see
   `tests/integration/db/tenancyHardening.migration.test.ts`).

## Drift and schema checks

- `pnpm db:check` runs `drizzle-kit check` — validates the migration
  history itself (no gaps, no conflicting revisions).
- `pnpm db:drift` runs [`db/scripts/checkDrift.ts`](../db/scripts/checkDrift.ts) —
  fails if `db/schema/**` has diverged from `db/migrations/**`, i.e. if
  `pnpm db:generate` would produce a new migration right now. It removes
  whatever it generated and restores the journal, so it never leaves files
  behind. Run it after any schema change and before committing.

Neither connects to a database (they diff files, not a running instance),
but `drizzle.config.ts` requires `DATABASE_URL` to be set, so CI passes a
placeholder value.

## Fresh-database verification

`pnpm test:integration:fresh` = `pnpm db:test:reset` (drops and recreates the
`public` and `drizzle` schemas of the **`*_test`** database — it refuses any
other database name — and replays every migration from `0000`) followed by
`pnpm test:integration`. CI's integration and HTTP jobs always start from an
empty PostgreSQL 16 service database, so every run also proves the chain
applies from zero.

## The `btree_gist` extension

The three exclusion constraints combine an equality column (`room_id`, and
`kind` for blocks) with a `daterange` overlap, which needs the `btree_gist`
extension. Migration `0001_tenancy_hardening` creates it as its first
statement (`CREATE EXTENSION IF NOT EXISTS btree_gist`), and `0004`, `0005`
and `0006` repeat the same idempotent statement before their constraints, so
applying the chain from an empty database creates it automatically.

Consequences for operators:

- The database role that runs migrations must be allowed to run
  `CREATE EXTENSION btree_gist` (on PostgreSQL 13+ `btree_gist` is a
  *trusted* extension: a non-superuser with `CREATE` privilege on the
  database may create it), **or** the extension must be created beforehand
  by an administrator (`CREATE EXTENSION IF NOT EXISTS btree_gist;` in the
  target database). The statements in the migrations are then no-ops.
- Never edit an old migration to remove or change these statements; handle
  privilege problems by pre-creating the extension.
- The local Docker setup (`db/docker/init.sql`) pre-creates it in both the
  dev and test databases.

## Applying migrations in an environment

`pnpm db:migrate` (`db/migrate.ts`) applies every pending migration to the
database named by `DATABASE_URL`. In a deployment, migrations run **before**
the new application version receives traffic, and a failed migration stops
the deploy (see `docs/DEPLOY_CHECKLIST.md`). Migrations are forward-only:
there is no automated down step to roll a schema back.
