import { purgeExpiredRateLimits } from '../security/rateLimit'
import { defineJob } from './definition'

/** Daily: drops rate-limit buckets whose window ended long ago (the table would otherwise only grow). */
export const rateLimitCleanupJob = defineJob<Record<string, never>>({
  name: 'security.rate-limit-cleanup',
  tier: 'light',
  schedule: { cron: '17 3 * * *' },
  handle: async (_data, { db }) => {
    await purgeExpiredRateLimits(db, new Date())
  },
})
