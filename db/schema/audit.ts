import { foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { hotel } from './hotel'
import { organization } from './tenancy'

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  hotelId: uuid('hotel_id'),
  actorUserId: uuid('actor_user_id'),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  action: text('action').notNull(),
  beforeData: jsonb('before_data'),
  afterData: jsonb('after_data'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'audit_log_hotel_fk' }),
  index('audit_log_org_hotel_time_idx').on(t.organizationId, t.hotelId, t.createdAt),
  index('audit_log_entity_idx').on(t.organizationId, t.entityType, t.entityId, t.createdAt),
])
