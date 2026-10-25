import { sql, type SQL } from 'drizzle-orm'
import { timestamp, uuid } from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { organization } from './tenancy'

/** Shared column builders for the Phase 2 tables (the Phase 1 files keep their own local copies). */
export const idColumn = () => uuid('id').primaryKey().defaultRandom()

/** Every tenant table carries `organization_id`; composite foreign keys lead with it (tenancy rule, v7 §16). */
export const organizationColumn = () => uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' })

export const timestampColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** `('A', 'B', …)`: a closed set of string literals (the shared value lists of `@hajj/contracts`). */
export function sqlList(values: readonly string[]): SQL {
  return sql`(${sql.join(values.map(value => sql.raw(`'${value.replace(/'/g, "''")}'`)), sql`, `)})`
}

/** `column in ('A', 'B', …)` for a CHECK constraint or an index predicate over a closed set of values. */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in ${sqlList(values)}`
}
