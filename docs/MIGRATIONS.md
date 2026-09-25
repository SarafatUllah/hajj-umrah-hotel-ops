# Migration policy

Migrations are **forward-only**. There is no down-migration tooling and none
should be added: fixing a mistake means writing a new forward migration, not
reverting an old one.

## One migration per schema task

Each plan task that changes the schema generates exactly one migration file,
named after the task:

```sh
pnpm db:generate --name <task-slug>
```

## Hand-editing

Hand-editing a generated migration is allowed **only before its first
commit**, and only to:

- (a) reorder statements,
- (b) add backfills for existing rows,
- (c) append raw SQL Drizzle cannot express itself (extensions, exclusion
  constraints, triggers).

**Once a migration is committed it is immutable.** Never edit a committed
migration file — write a new one instead.

Extensions are created inside the migration that first needs them (not in a
separate "setup" migration), so `pnpm test:integration:fresh` can apply the
whole migration history to an empty database in order.

## Verification

Every migration must:

- apply cleanly to an empty database — verified by `pnpm test:integration:fresh`;
- when it touches existing rows (a backfill or a column narrowing), have a
  data-preserving test written against the migration harness (Task 3).

## Drift and schema checks

- `pnpm db:check` runs `drizzle-kit check` — validates the migration
  history itself (no gaps, no conflicting revisions).
- `pnpm db:drift` runs [`db/scripts/checkDrift.ts`](../db/scripts/checkDrift.ts) —
  fails if `db/schema/**` has diverged from `db/migrations/**`, i.e. if
  `pnpm db:generate` would produce a new migration right now. Run it after
  any schema change and before committing.

Both run in CI after install and need no live database connection (they
diff files, not schema against a running instance) — CI supplies a
placeholder `DATABASE_URL` purely to satisfy `drizzle.config.ts`, which
requires the variable to be set.
