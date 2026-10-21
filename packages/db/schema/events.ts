import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { organizationColumn } from './columns'

/**
 * Which domain-event handler already ran for which event (Phase 2a ticket 7): a handler claims its row in the same
 * transaction as its own effects, so a retried or duplicated delivery does nothing twice. Per organization, so one
 * organization's rows never stand in the way of another's.
 */
export const eventReceipt = pgTable('event_receipt', {
  organizationId: organizationColumn(),
  eventId: uuid('event_id').notNull(),
  handler: text('handler').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.organizationId, t.eventId, t.handler] }),
])
