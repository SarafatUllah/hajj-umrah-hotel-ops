import { sql } from 'drizzle-orm'
import { check, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { DOCUMENT_SEQUENCE_KINDS } from '@hajj/contracts/constants/booking'
import { oneOf, organizationColumn } from './columns'

/**
 * Gap-tolerant counters for human reference numbers (quote `Q-2027-0142`, booking `B-2027-0088`), per organization,
 * kind and year. One atomic UPSERT hands out the next value; the row lock it takes lasts until the caller's
 * transaction ends, so two concurrent writers never get the same number (a rolled-back writer leaves a gap).
 */
export const documentSequence = pgTable('document_sequence', {
  organizationId: organizationColumn(),
  kind: text('kind').notNull(),
  year: integer('year').notNull(),
  lastValue: integer('last_value').notNull(),
}, t => [
  primaryKey({ columns: [t.organizationId, t.kind, t.year] }),
  check('document_sequence_kind_check', oneOf(t.kind, DOCUMENT_SEQUENCE_KINDS)),
  check('document_sequence_year_check', sql`${t.year} between 2000 and 2200`),
  check('document_sequence_value_check', sql`${t.lastValue} >= 1`),
])
