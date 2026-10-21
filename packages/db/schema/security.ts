import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Fixed-window rate-limit counters (design v7 §21: login, OTP and public-search limits). Platform scope:
 * keys are `<policy>:<sha256 of the subject>` (e.g. `login-ip:<hex>`, built by apps/api/server/security/rateLimit.ts),
 * never tenant data in clear text.
 * One row per key; a request either increments the current window or restarts it (one atomic UPSERT).
 */
export const rateLimitBucket = pgTable('rate_limit_bucket', {
  key: text('key').primaryKey(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  hits: integer('hits').notNull(),
}, table => [
  check('rate_limit_bucket_hits_check', sql`${table.hits} >= 1`),
])
