# 0001 — Module data ownership: one `public` schema, ownership enforced in code

- **Status:** accepted (Phase 2-0, 2026-10-21)
- **Context:** design v7 adds modules (account, pilgrim, booking, pricing, passport; transport later)
  to the Phase 1 modular monolith. Ticket 6 asked whether to give every module its own PostgreSQL
  schema (`booking.*`, `transport.*`) and whether to move the Phase 1 tables out of `public`.

## Decision

Keep every table in the `public` schema. Module ownership is enforced in code, where it can actually
be checked:

1. **Schema files per module** in `@hajj/db` (`packages/db/schema/<module>.ts`). A table belongs to
   exactly one module.
2. **Only the owning module's repositories write its tables**, and other modules reach that data only
   through the owner's public service (`server/services/<module>/index.ts`) — ticket 5's layering
   rule, checked by ESLint and `tests/unit/architecture/layering.test.ts`.
3. Cross-module **foreign keys stay** (a booking really does reference a room): one database, one
   transaction, real integrity.

## Why not schema-per-module

- A PostgreSQL schema makes the boundary visible but enforces nothing: any role with access can still
  join across schemas. The guarantee we want (no module reaching into another's tables) comes from the
  code rules above, not from the schema name.
- Moving the Phase 1 tables would rewrite every migration-era assumption (`search_path`, drizzle-kit
  snapshots, the exclusion constraints and composite foreign keys) for no behavioural gain.
- If a module is ever extracted into its own service, its tables are already known (its schema file)
  and only its repositories touch them; moving them to a separate schema or database at that point is a
  mechanical migration.

## Consequences

- No table move in 2a. New modules add schema files under `packages/db/schema/`.
- The module → tables map is kept in `docs/ARCHITECTURE.md` (§25) as modules land.
