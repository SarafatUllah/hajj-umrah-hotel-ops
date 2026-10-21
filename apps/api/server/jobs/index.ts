import type { JobDefinition } from './definition'
import { holdExpiryJob, quoteExpiryJob } from './bookingJobs'
import { passportReadJob, passportRetentionJob } from './passportJobs'
import { securityCleanupJob } from './securityJobs'

/**
 * Every job the application knows about. Modules register their jobs here as they land (hold sweep,
 * reminders, passport OCR, retention). Order is irrelevant.
 */
export const JOBS: readonly JobDefinition<never>[] = [
  securityCleanupJob,
  quoteExpiryJob,
  holdExpiryJob,
  passportReadJob,
  passportRetentionJob,
]
