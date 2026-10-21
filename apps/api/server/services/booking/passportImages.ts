import type { Readable } from 'node:stream'
import { todayInTimezone } from '@hajj/contracts/utils/dates'
import { bookingOrgRepos, tenantRepos } from '../../repositories'
import type { ScanImageDue } from '../../repositories/booking'
import type { OrganizationScope } from '../../security/scope'
import { getStorageDriver } from '../../storage'
import { usePiiCipher } from '../../utils/pii'
import { sweepOrganizations } from './sweep'

type Db = Parameters<typeof bookingOrgRepos>[0]

// Ciphertexts bound to their row: the image to its storage key, the reading to its scan.
export const imageContext = (storageKey: string) => `passport_scan.image:${storageKey}`
export const extractedContext = (scanId: string) => `passport_scan.extracted:${scanId}`

/** Images deleted per batch (a run goes on until a batch comes back short, so a mass check-out never waits days). */
const PURGE_BATCH = 200

/** A stored passport image, decrypted (in memory only). */
export async function readStoredImage(storageKey: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of await getStorageDriver().get(storageKey) as Readable) chunks.push(Buffer.from(chunk as Uint8Array))
  return usePiiCipher().decryptBytes(Buffer.concat(chunks), imageContext(storageKey))
}

/**
 * Deletes a scan's image: the stored object first, then its asset is archived and the reading taken from it
 * cleared. An archived asset therefore always means the object is gone; when the deletion fails the scan stays
 * due, and the retention sweep tries again.
 */
export async function purgeImage(db: Db, scope: OrganizationScope, image: ScanImageDue, now: Date): Promise<void> {
  await getStorageDriver().delete(image.storageKey)
  await db.transaction(async (tx) => {
    await tenantRepos(tx, scope).documentAssets.markArchived(image.documentId, now)
    await bookingOrgRepos(tx, scope).passportScans.clearReading(image.scanId, now)
  })
}

/**
 * Ticket 4, passport images (PDPL storage limitation): the daily sweep deletes every image whose retention ended
 * (`delete_after`: `passportImageRetentionMonths` after check-out, or the day a scan was discarded). One image that
 * cannot be deleted is logged and skipped (the others still go); the organization's sweep then fails so it is retried.
 */
export async function purgeExpiredPassportImages(db: Db, scopes: readonly OrganizationScope[], now: Date): Promise<number> {
  const today = todayInTimezone('UTC', now)
  return sweepOrganizations('passport-retention', scopes, async (scope) => {
    let deleted = 0
    for (;;) {
      const due = await bookingOrgRepos(db, scope).passportScans.imagesDue(today, now, PURGE_BATCH)
      const failures: unknown[] = []
      for (const image of due) {
        await purgeImage(db, scope, image, now).catch((error: unknown) => {
          console.error(`[passport-retention] could not delete the image of scan ${image.scanId}:`, error instanceof Error ? error.message : error)
          failures.push(error)
        })
      }
      // A failed image stays due: stop here (it would come back in the next batch) and let the sweep be retried.
      if (failures.length > 0) throw new AggregateError(failures, `${failures.length} passport image(s) could not be deleted`)
      deleted += due.length
      if (due.length < PURGE_BATCH) return deleted
    }
  })
}
