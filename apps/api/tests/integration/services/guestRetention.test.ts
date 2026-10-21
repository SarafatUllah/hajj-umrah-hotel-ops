import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agencyUser, auditLog, booking, bookingChange, bookingGuest, bookingGuestDetail, documentAsset, eventReceipt, passportScan, piiAccessLog, pilgrim } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { confirmAgencyBooking, eraseExpiredGuestData, holdAgencyStay, listAgencyGuests, listGuests, saveAgencyGuest, saveGuest } from '../../../server/services/booking'
import { makeAgency, makeBooking, makeGuest } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const NOW = new Date('2027-05-01T10:00:00Z')
/** Personal data that must never reach a log, and must be gone after the retention period. */
const AGENCY_PILGRIM = { fullName: 'Abdul Haque Rahman', passportNo: 'Z9876543', dateOfBirth: '1975-03-17' }
const AGENCY_ADDRESS = 'Road 12 Mirpur'
const STAFF_PILGRIM = { fullName: 'Nurul Islam Chowdhury', passportNo: 'Y1112223', dateOfBirth: '1968-11-02' }
const PII = /Abdul Haque|Z9876543|1975-03-17|Road 12|Nurul Islam|Y1112223|1968-11-02/

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

function staff(scope: OrganizationScope, userId: string, permissions: Permission[]): AuthContext {
  return { identity: { userId, organizationId: scope.organizationId, email: 's@example.test', fullName: 'Staff' }, authz: { permissions: new Set(permissions), allHotels: true, hotelIds: new Set() }, scope, db, now: () => NOW }
}

async function agencyCtx(scope: OrganizationScope, agencyId: string): Promise<AgencyContext> {
  const [user] = await db.insert(agencyUser).values({ organizationId: scope.organizationId, agencyId, email: `u-${agencyId}@example.test`, passwordHash: 'h', fullName: 'Agent' }).returning()
  return (await resolveAgencyContext(db, { agencyUserId: user!.id, organizationId: scope.organizationId, agencyId }, () => NOW))!
}

/** A confirmed GROUP, June 1–4 2027: the agency fills slot 1; reception (with pilgrim.viewSensitive) fills slot 2 (a staff master). */
async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, rooms } = await makeStayHotel(db, scope)
  const agency = await agencyCtx(scope, (await makeAgency(db, scope)).id)
  const held = await holdAgencyStay(agency, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, femaleCount: 1, totalCount: 3,
    rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 2 }, { roomId: rooms['201'], occupancy: 'FEMALE', seats: 1 }],
  }))
  await confirmAgencyBooking(agency, held.id)
  const [first, second] = await listAgencyGuests(agency, held.id)
  await saveAgencyGuest(agency, held.id, first!.id, guestDetailsSchema.parse({ ...AGENCY_PILGRIM, gender: 'MALE', nationality: 'BGD', passportExpiry: '2032-01-01', extras: { address: AGENCY_ADDRESS } }))
  const manager = staff(scope, (await makeUser(db, scope)).id, ['booking.view', 'booking.edit', 'pilgrim.view', 'pilgrim.viewSensitive'])
  await saveGuest(manager, held.id, second!.id, guestDetailsSchema.parse({ ...STAFF_PILGRIM, gender: 'MALE', nationality: 'BGD', passportExpiry: '2032-01-01' }))
  await listGuests(manager, held.id, { reveal: 'passport' })
  return { scope, hotel, agency, manager, bookingId: held.id, slots: [first!.id, second!.id] }
}

describe('retention of every copy of a pilgrim\'s details (Phase 2a ticket 4)', () => {
  it('nothing before guestDataRetentionMonths after check-out; then every booker\'s copy is erased in place and unused masters are deleted', async () => {
    const env = await setup()
    expect(await db.select().from(pilgrim)).toHaveLength(1)
    expect(await eraseExpiredGuestData(db, [env.scope], new Date('2029-06-01T00:00:00Z'))).toBe(0) // 24 months end on June 4
    expect(await eraseExpiredGuestData(db, [env.scope], new Date('2029-06-05T00:00:00Z'))).toBe(3) // 2 copies + 1 master

    const copies = await db.select().from(bookingGuestDetail)
    expect(copies).toHaveLength(2)
    for (const copy of copies) expect(copy).toMatchObject({ fullName: '', gender: null, nationality: null, dateOfBirth: null, passportNoEncrypted: null, passportLookup: null, passportExpiry: null, detailsEncrypted: null, erasedAt: expect.any(Date) })
    expect(await db.select().from(pilgrim)).toEqual([])
    expect(JSON.stringify(await db.select().from(bookingGuestDetail))).not.toMatch(PII)

    // The slots and their history stay, without personal data.
    const slots = await listAgencyGuests(env.agency, env.bookingId)
    expect(slots.map(s => s.status)).toEqual(['READY', 'READY', 'PENDING_DETAILS'])
    expect(slots[0]).toMatchObject({ details: null, warnings: [{ code: 'DETAILS_ERASED' }] })
    expect(await eraseExpiredGuestData(db, [env.scope], new Date('2029-06-06T00:00:00Z'))).toBe(0)
  })

  it('a master another booking still relies on is kept (only that booking\'s slot let go of it)', async () => {
    const env = await setup()
    const [master] = await db.select().from(pilgrim)
    const later = await makeBooking(db, env.scope, env.hotel.id, { agencyId: env.agency.scope.agencyId, status: 'CONFIRMED', checkIn: '2029-06-01', checkOut: '2029-07-01' })
    const laterSlot = await makeGuest(db, env.scope, later.id, 1, { pilgrimId: master!.id })

    await eraseExpiredGuestData(db, [env.scope], new Date('2029-06-05T00:00:00Z'))
    expect(await db.select().from(pilgrim)).toHaveLength(1)
    expect((await db.select().from(bookingGuest).where(eq(bookingGuest.id, env.slots[1]!)))[0]!.pilgrimId).toBeNull()
    expect((await db.select().from(bookingGuest).where(eq(bookingGuest.id, laterSlot.id)))[0]!.pilgrimId).toBe(master!.id)
  })

  it('a passport reading and image outlive no erased copy, whatever the image retention; free text that may name people goes too', async () => {
    const env = await setup()
    const [asset] = await db.insert(documentAsset).values({ organizationId: env.scope.organizationId, storageKey: `${env.scope.organizationId}/2027/scan.png`, originalFilename: 'p.png', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64) }).returning()
    const [scan] = await db.insert(passportScan).values({ organizationId: env.scope.organizationId, bookingId: env.bookingId, documentId: asset!.id, status: 'NEEDS_REVIEW', uploadedByKind: 'agency', extractedEncrypted: 'ciphertext', deleteAfter: '2037-06-04' }).returning()
    await db.update(booking).set({ notes: 'Mr. Abdul Haque calls at 9' }).where(eq(booking.id, env.bookingId))

    await eraseExpiredGuestData(db, [env.scope], new Date('2029-06-05T00:00:00Z'))
    expect((await db.select().from(passportScan).where(eq(passportScan.id, scan!.id)))[0]).toMatchObject({ extractedEncrypted: null, deleteAfter: '2029-06-05' })
    expect((await db.select().from(booking).where(eq(booking.id, env.bookingId)))[0]).toMatchObject({ notes: null, cancelReason: null })
    expect(await eraseExpiredGuestData(db, [env.scope], new Date('2029-06-05T00:00:00Z'))).toBe(0)
  })

  it('re-entering details on an erased slot makes it a live copy again', async () => {
    const env = await setup()
    await eraseExpiredGuestData(db, [env.scope], new Date('2029-06-05T00:00:00Z'))
    await saveGuest(env.manager, env.bookingId, env.slots[0]!, guestDetailsSchema.parse({ ...AGENCY_PILGRIM, gender: 'MALE', nationality: 'BGD', passportExpiry: '2032-01-01' }))
    const [slot] = await listGuests(env.manager, env.bookingId, {})
    expect(slot).toMatchObject({ details: { fullName: AGENCY_PILGRIM.fullName }, warnings: [] })
  })

  it('personal data never reaches a log: audit log, booking change log, PII access log, event receipts', async () => {
    await setup()
    const logs = await Promise.all([db.select().from(auditLog), db.select().from(bookingChange), db.select().from(piiAccessLog), db.select().from(eventReceipt)])
    expect(logs[1].length).toBeGreaterThan(0)
    expect(logs[2].length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toMatch(PII)
  })
})
