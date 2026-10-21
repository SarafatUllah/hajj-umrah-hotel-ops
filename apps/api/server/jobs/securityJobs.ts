import { purgeExpiredRateLimits } from '../security/rateLimit'
import { platformRepos } from '../repositories'
import { defineJob } from './definition'

/** Expired sign-in codes are kept a day (for support questions), then removed. */
const OTP_RETENTION_MS = 24 * 60 * 60 * 1000

/** Daily: drops rate-limit buckets and sign-in codes long past their window or expiry (the tables would otherwise only grow). */
export const securityCleanupJob = defineJob<Record<string, never>>({
  name: 'security.cleanup',
  tier: 'light',
  schedule: { cron: '17 3 * * *' },
  handle: async (_data, { db }) => {
    const now = new Date()
    await purgeExpiredRateLimits(db, now)
    await platformRepos(db).otpChallenges.deleteExpiredBefore(new Date(now.getTime() - OTP_RETENTION_MS))
  },
})
