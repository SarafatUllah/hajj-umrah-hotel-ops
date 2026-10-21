import { allOrganizationScopes } from '../security/organizations'
import { expireOfferedQuotes } from '../services/booking'
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
