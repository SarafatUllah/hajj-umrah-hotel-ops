import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDbWithClient } from '@hajj/db/client'
import { documentAsset, passportScan } from '@hajj/db/schema'
import { makeAgency, makeBooking } from '../../support/bookingFixtures'
import { makeHotel, makeOrg } from '../../support/fixtures'
import { migrateAll, migrateThrough, withScratchDatabase } from '../support/migrationHarness'

const SCRATCH_DB = 'hajj_umrah_migrate_filenames_test'
/** The last migration before 0020 (review indexes, the passport filename scrub). */
const BEFORE_SCRUB = 19

// A scratch database replays the whole chain: well past the 5 s default under a full-suite run.
describe('migration 0020 (passport filenames)', { timeout: 60_000 }, () => {
  it('renames every stored passport photo to "passport" and its extension; a hotel document keeps its name', async () => {
    await withScratchDatabase(SCRATCH_DB, async (url) => {
      await migrateThrough(url, BEFORE_SCRUB)
      const { db, close } = createDbWithClient(url, { max: 1 })
      try {
        // Arrange: a booking with two passport photos named after the pilgrim, and a hotel document.
        const { scope } = await makeOrg(db)
        const hotel = await makeHotel(db, scope)
        const stay = await makeBooking(db, scope, hotel.id, { agencyId: (await makeAgency(db, scope)).id })
        const asset = async (originalFilename: string, mimeType: string) => (await db.insert(documentAsset).values({ organizationId: scope.organizationId, storageKey: `${scope.organizationId}/${originalFilename}`, originalFilename, mimeType, sizeBytes: 1, sha256: originalFilename.padEnd(64, 'a').slice(0, 64) }).returning())[0]!
        const [png, jpeg, contract] = [await asset('Karim MD passport.png', 'image/png'), await asset('Ayesha passport.jpg', 'image/jpeg'), await asset('Lease 2027.pdf', 'application/pdf')]
        for (const photo of [png, jpeg]) await db.insert(passportScan).values({ organizationId: scope.organizationId, bookingId: stay.id, documentId: photo.id, status: 'QUEUED', uploadedByKind: 'agency', deleteAfter: '2028-06-04' })

        // Act
        await migrateAll(url)

        // Assert
        const nameOf = async (id: string) => (await db.select().from(documentAsset).where(eq(documentAsset.id, id)))[0]!.originalFilename
        expect([await nameOf(png.id), await nameOf(jpeg.id), await nameOf(contract.id)]).toEqual(['passport.png', 'passport.jpg', 'Lease 2027.pdf'])
      }
      finally {
        await close()
      }
    })
  })
})
