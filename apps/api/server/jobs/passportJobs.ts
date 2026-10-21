import { allOrganizationScopes } from '../security/organizations'
import { purgeExpiredPassportImages, readPassportScan, setPassportReadQueue } from '../services/booking'
import { defineJob } from './definition'
import { enqueue } from './runtime'

/**
 * Reads one uploaded passport image (v7 §13): OCR and the MRZ are CPU-heavy, so the job runs only in the worker
 * process (one at a time per worker). Idempotent per scan; a reading that throws ends FAILED, so a retry only covers
 * a crash — it comes after the 10-minute mark at which a stale reading may be taken over.
 */
export const passportReadJob = defineJob<{ organizationId: string, scanId: string }>({
  name: 'booking.passport-read',
  tier: 'heavy',
  queue: { retryLimit: 3, retryDelay: 11 * 60, retryBackoff: true },
  handle: async (data, { db }) => {
    await readPassportScan(db, data.organizationId, data.scanId, new Date())
  },
})

/** Daily (ticket 4, passport images): images past their retention, and discarded ones not yet deleted, are deleted. */
export const passportRetentionJob = defineJob<Record<string, never>>({
  name: 'booking.passport-retention',
  tier: 'light',
  schedule: { cron: '30 2 * * *' },
  handle: async (_data, { db }) => {
    await purgeExpiredPassportImages(db, await allOrganizationScopes(db), new Date())
  },
})

/** Called once the job runtime is up (any mode that can enqueue): uploads then enqueue their reading in their own transaction. */
export function wirePassportReading(): void {
  setPassportReadQueue((tx, data) => enqueue(passportReadJob, data, { tx }))
}
