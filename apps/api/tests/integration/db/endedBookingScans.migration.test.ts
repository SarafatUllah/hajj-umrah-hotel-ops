import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDbWithClient } from '@hajj/db/client'
import { documentAsset, passportScan } from '@hajj/db/schema'
import { makeAgency, makeBooking } from '../../support/bookingFixtures'
import { makeHotel, makeOrg } from '../../support/fixtures'
import { migrateAll, migrateThrough, withScratchDatabase } from '../support/migrationHarness'

const SCRATCH_DB = 'hajj_umrah_migrate_ended_scans_test'
/** The last migration before 0021 (ended bookings' scans). */
const BEFORE_BACKFILL = 20

// A scratch database replays the whole chain: well past the 5 s default under a full-suite run.
describe('migration 0021 (ended bookings\' passport scans)', { timeout: 60_000 }, () => {
  it('a cancelled or lapsed booking\'s scans lose their reading and become due today; a live booking\'s keep theirs', async () => {
    await withScratchDatabase(SCRATCH_DB, async (url) => {
      await migrateThrough(url, BEFORE_BACKFILL)
      const { db, close } = createDbWithClient(url, { max: 1 })
      try {
        // Arrange: a cancelled, an expired and a confirmed booking, each with a read passport photo kept until 2028.
        const { scope } = await makeOrg(db)
        const hotel = await makeHotel(db, scope)
        const agencyId = (await makeAgency(db, scope)).id
        const scanOf = async (status: 'CANCELLED' | 'EXPIRED' | 'CONFIRMED') => {
          const ended = status === 'CANCELLED' ? { cancelledAt: new Date('2027-05-01T10:00:00Z') } : status === 'EXPIRED' ? { holdExpiresAt: new Date('2027-05-01T10:10:00Z') } : {}
          const stay = await makeBooking(db, scope, hotel.id, { agencyId, status, ...ended })
          const [asset] = await db.insert(documentAsset).values({ organizationId: scope.organizationId, storageKey: `${scope.organizationId}/${status}.png`, originalFilename: 'passport.png', mimeType: 'image/png', sizeBytes: 1, sha256: status.padEnd(64, 'a') }).returning()
          const [scan] = await db.insert(passportScan).values({ organizationId: scope.organizationId, bookingId: stay.id, documentId: asset!.id, status: 'NEEDS_REVIEW', uploadedByKind: 'agency', extractedEncrypted: 'ciphertext', deleteAfter: '2028-06-04' }).returning()
          return scan!.id
        }
        const [cancelled, expired, live] = [await scanOf('CANCELLED'), await scanOf('EXPIRED'), await scanOf('CONFIRMED')]

        // Act
        await migrateAll(url)

        // Assert
        const today = new Date().toISOString().slice(0, 10)
        const rowOf = async (id: string) => (await db.select().from(passportScan).where(eq(passportScan.id, id)))[0]!
        for (const ended of [cancelled, expired]) expect(await rowOf(ended)).toMatchObject({ extractedEncrypted: null, deleteAfter: today })
        expect(await rowOf(live)).toMatchObject({ extractedEncrypted: 'ciphertext', deleteAfter: '2028-06-04' })
      }
      finally {
        await close()
      }
    })
  })
})
