import { allOrganizationScopes } from '../security/organizations'
import { expireLapsedBookings, expireOfferedQuotes } from '../services/booking'
import { defineJob } from './definition'

/** Hourly: OFFERED quotes past their validity become EXPIRED (reads already treat them as expired). */
export const quoteExpiryJob = defineJob<Record<string, never>>({
  name: 'booking.quote-expiry',
  tier: 'light',
  schedule: { cron: '5 * * * *' },
  handle: async (_data, { db }) => {
    await expireOfferedQuotes(db, await allOrganizationScopes(db), new Date())
  },
})

/**
 * Every minute (v7 §10): pending bookings whose hold lapsed become EXPIRED and free their seats for good. The
 * seat count already ignores a lapsed hold, and every hold transaction expires the lapsed holds on the rooms it
 * locks; this sweep is the backup that also releases quotes and keeps statuses truthful.
 */
export const holdExpiryJob = defineJob<Record<string, never>>({
  name: 'booking.hold-expiry',
  tier: 'light',
  schedule: { cron: '* * * * *' },
  handle: async (_data, { db }) => {
    await expireLapsedBookings(db, await allOrganizationScopes(db), new Date())
  },
})
