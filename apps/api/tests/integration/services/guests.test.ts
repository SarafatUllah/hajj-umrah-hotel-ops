import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agencyUser, booking, bookingChange, bookingGuest, bookingGuestDetail, piiAccessLog, pilgrim } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { type GuestDetailsInput, guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { holdAgencyStay, listAgencyGuests, listGuests, saveAgencyGuest, saveGuest } from '../../../server/services/booking'
import { makeAgency } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const NOW = new Date('2027-05-01T10:00:00Z')

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

/** A GROUP of two men (Quad 101), a woman with a child and an infant (Double 201). Slots 1–2 men, 3 woman, 4 child, 5 infant. */
async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, rooms } = await makeStayHotel(db, scope)
  const agency = await agencyCtx(scope, (await makeAgency(db, scope)).id)
  const held = await holdAgencyStay(agency, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, femaleCount: 1, childCount: 1, infantCount: 1, totalCount: 4,
    rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 2 }, { roomId: rooms['201'], occupancy: 'FEMALE', seats: 2 }],
  }))
  const slots = await listAgencyGuests(agency, held.id)
  const manager = staff(scope, (await makeUser(db, scope)).id, ['booking.view', 'booking.edit', 'pilgrim.view', 'pilgrim.viewSensitive'])
  const reception = staff(scope, (await makeUser(db, scope)).id, ['booking.view', 'booking.edit', 'pilgrim.view'])
  return { scope, hotel, rooms, agency, bookingId: held.id, slot: (n: number) => slots[n - 1]!.id, manager, reception }
}

const karim: GuestDetailsInput = guestDetailsSchema.parse({ fullName: 'Md. Karim', gender: 'MALE', nationality: 'bgd', dateOfBirth: '1980-01-01', passportNo: 'a1234 567', passportExpiry: '2030-01-01', extras: { address: 'Dhaka' } })

describe('pilgrim details (v7 §7, §13, §16)', () => {
  it('the agency fills a slot: READY, encrypted at rest, its own copy in full (logged), staff see it masked', async () => {
    const env = await setup()
    const saved = await saveAgencyGuest(env.agency, env.bookingId, env.slot(1), karim)
    expect(saved).toMatchObject({ status: 'READY', roomNumber: '101', details: { fullName: 'Md. Karim', nationality: 'BGD', passportNo: '•••567', complete: true, extras: null } })

    const [row] = await db.select().from(bookingGuestDetail).where(eq(bookingGuestDetail.bookingGuestId, env.slot(1)))
    expect(row!.passportNoEncrypted).not.toContain('A1234567')
    expect(row!.detailsEncrypted).not.toContain('Dhaka')
    expect(row!.passportLookup).toMatch(/^[0-9a-f]{64}$/)

    const mine = await listAgencyGuests(env.agency, env.bookingId)
    expect(mine[0]!.details).toMatchObject({ passportNo: 'A1234567', extras: { address: 'Dhaka' } })
    expect(mine.map(s => [s.slotNo, s.gender, s.ageGroup, s.roomNumber])).toEqual([[1, 'MALE', 'ADULT', '101'], [2, 'MALE', 'ADULT', '101'], [3, 'FEMALE', 'ADULT', '201'], [4, null, 'CHILD', '201'], [5, null, 'INFANT', '201']])
    expect(await db.select().from(piiAccessLog)).toEqual([expect.objectContaining({ actorKind: 'agency', subjectType: 'BOOKING_GUEST_DETAIL', subjectId: row!.id, fields: ['passport_no', 'details'] })])

    expect((await listGuests(env.reception, env.bookingId, {}))[0]!.details).toMatchObject({ passportNo: '•••567', extras: null })
    await expect(listGuests(env.reception, env.bookingId, { reveal: 'passport' })).rejects.toMatchObject({ httpStatus: 403 })
    expect((await listGuests(env.manager, env.bookingId, { reveal: 'passport' }))[0]!.details!.passportNo).toBe('A1234567')
    expect(await db.select().from(piiAccessLog).where(eq(piiAccessLog.actorKind, 'staff'))).toHaveLength(1)

    // The change log carries no personal data.
    const changes = await db.select().from(bookingChange).where(eq(bookingChange.kind, 'DETAILS_UPDATED'))
    expect(JSON.stringify(changes)).not.toMatch(/Karim|A1234567|Dhaka/)
  })

  it('refuses a person who does not fit the slot: the other gender\'s side, a boy of 11 as a child in the women\'s room, an older child in an infant slot', async () => {
    const env = await setup()
    const woman = { ...karim, fullName: 'Amina', gender: 'FEMALE' as const }
    await expect(saveAgencyGuest(env.agency, env.bookingId, env.slot(1), woman)).rejects.toMatchObject({ code: 'GUEST_DETAILS_REJECTED', httpStatus: 422, details: { issues: ['GENDER_MISMATCH'] } })
    await expect(saveAgencyGuest(env.agency, env.bookingId, env.slot(4), { ...karim, fullName: 'Boy', dateOfBirth: '2016-01-01', passportNo: 'B1111111' })).rejects.toMatchObject({ details: { issues: ['GENDER_MISMATCH'] } })
    expect((await saveAgencyGuest(env.agency, env.bookingId, env.slot(4), { ...karim, fullName: 'Boy', dateOfBirth: '2019-01-01', passportNo: 'B2222222' })).ageGroup).toBe('CHILD')
    await expect(saveAgencyGuest(env.agency, env.bookingId, env.slot(5), { ...karim, fullName: 'Toddler', dateOfBirth: '2023-01-01', passportNo: 'B3333333' })).rejects.toMatchObject({ details: { issues: ['AGE_GROUP_MISMATCH'] } })
    // The same passport twice in one booking.
    await saveAgencyGuest(env.agency, env.bookingId, env.slot(1), karim)
    await expect(saveAgencyGuest(env.agency, env.bookingId, env.slot(2), { ...karim, fullName: 'Copy' })).rejects.toMatchObject({ code: 'DUPLICATE_PASSPORT_IN_BOOKING' })
  })

  it('warns about a passport valid less than the minimum; partial details keep the slot PENDING_DETAILS', async () => {
    const env = await setup()
    expect((await saveAgencyGuest(env.agency, env.bookingId, env.slot(1), { ...karim, passportExpiry: '2027-10-01' })).warnings).toEqual([{ code: 'PASSPORT_EXPIRES_SOON' }])
    expect(await saveAgencyGuest(env.agency, env.bookingId, env.slot(2), guestDetailsSchema.parse({ fullName: 'Rahim' }))).toMatchObject({ status: 'PENDING_DETAILS', details: { complete: false } })
  })

  it('staff entries of complete details create the staff master; agencies never link to it; only staff see the passport twice', async () => {
    const env = await setup()
    const saved = await saveGuest(env.manager, env.bookingId, env.slot(1), karim)
    const masters = await db.select().from(pilgrim)
    expect(masters).toEqual([expect.objectContaining({ fullName: 'Md. Karim', nationality: 'BGD' })])
    expect(masters[0]!.passportNoEncrypted).not.toContain('A1234567')
    expect((await db.select().from(bookingGuest).where(eq(bookingGuest.id, saved.id)))[0]!.pilgrimId).toBe(masters[0]!.id)

    // Another agency books the same person on overlapping nights: its copy is not linked (a typed passport proves
    // nothing), and only staff are warned — staff who can see that hotel.
    const other = await agencyCtx(env.scope, (await makeAgency(db, env.scope)).id)
    const second = await holdAgencyStay(other, holdRequestSchema.parse({ hotelId: env.hotel.id, bookingType: 'GROUP', checkIn: '2027-06-02', checkOut: '2027-06-05', maleCount: 1, totalCount: 1, rooms: [{ roomId: env.rooms['102'], occupancy: 'MALE', seats: 1 }] }))
    const [secondSlot] = await listAgencyGuests(other, second.id)
    const theirs = await saveAgencyGuest(other, second.id, secondSlot!.id, karim)
    expect(theirs.warnings).toEqual([])
    expect((await db.select().from(bookingGuest).where(eq(bookingGuest.id, theirs.id)))[0]!.pilgrimId).toBeNull()
    const [first] = await listGuests(env.manager, env.bookingId, {})
    expect(first!.warnings).toEqual([{ code: 'DUPLICATE_PASSPORT', bookingNo: second.bookingNo }])
    const elsewhere = { ...env.manager, authz: { ...env.manager.authz, allHotels: false, hotelIds: new Set([env.hotel.id, '00000000-0000-4000-8000-000000000009']) } }
    expect((await listGuests(elsewhere, env.bookingId, {}))[0]!.warnings).toHaveLength(1)

    // A staff save that disagrees with the master leaves the master as it was and says so.
    const changed = await saveGuest(env.manager, second.id, secondSlot!.id, { ...karim, dateOfBirth: '1981-01-01' })
    expect(changed.warnings).toContainEqual({ code: 'MASTER_DIFFERS' })
    expect(await db.select().from(pilgrim)).toEqual([expect.objectContaining({ id: masters[0]!.id, dateOfBirth: '1980-01-01' })])
    expect((await db.select().from(bookingGuest).where(eq(bookingGuest.id, secondSlot!.id)))[0]!.pilgrimId).toBe(masters[0]!.id)

    // Reception (no pilgrim.viewSensitive) learns nothing about an existing master: no link, no warning.
    const atReception = await saveGuest(env.reception, env.bookingId, env.slot(2), { ...karim, fullName: 'Someone Else', passportNo: 'Z9999999' })
    expect(atReception.warnings).toEqual([])
    // (The agency's own Quad 102 for these dates still has seats: "own room first".)
    const third = await holdAgencyStay(other, holdRequestSchema.parse({ hotelId: env.hotel.id, bookingType: 'GROUP', checkIn: '2027-06-02', checkOut: '2027-06-05', maleCount: 1, totalCount: 1, rooms: [{ roomId: env.rooms['102'], occupancy: 'MALE', seats: 1 }] }))
    const [thirdSlot] = await listAgencyGuests(other, third.id)
    expect((await saveGuest(env.reception, third.id, thirdSlot!.id, { ...karim, dateOfBirth: '1979-01-01' })).warnings).not.toContainEqual({ code: 'MASTER_DIFFERS' })
    expect((await db.select().from(bookingGuest).where(eq(bookingGuest.id, thirdSlot!.id)))[0]!.pilgrimId).toBeNull()
  })

  it('an agency cannot turn a seated pilgrim into an infant (quota and price would drop)', async () => {
    const env = await setup()
    await expect(saveAgencyGuest(env.agency, env.bookingId, env.slot(1), { ...karim, dateOfBirth: '2026-03-01' })).rejects.toMatchObject({ code: 'GUEST_DETAILS_REJECTED', details: { issues: ['AGE_GROUP_MISMATCH'] } })
    await expect(saveAgencyGuest(env.agency, env.bookingId, env.slot(1), { ...karim, dateOfBirth: '2028-01-01' })).rejects.toMatchObject({ details: { issues: ['IMPLAUSIBLE_DATE'] } })
  })

  it('another agency cannot read or write the slots (404); the agency cannot change a checked-in pilgrim; a cancelled booking is closed', async () => {
    const env = await setup()
    const other = await agencyCtx(env.scope, (await makeAgency(db, env.scope)).id)
    await expect(listAgencyGuests(other, env.bookingId)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', httpStatus: 404 })
    await expect(saveAgencyGuest(other, env.bookingId, env.slot(1), karim)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' })

    await db.update(bookingGuest).set({ status: 'CHECKED_IN', checkedInAt: NOW }).where(eq(bookingGuest.id, env.slot(1)))
    await expect(saveAgencyGuest(env.agency, env.bookingId, env.slot(1), karim)).rejects.toMatchObject({ code: 'GUEST_LOCKED', httpStatus: 409 })
    expect((await saveGuest(env.reception, env.bookingId, env.slot(1), karim)).status).toBe('CHECKED_IN')

    await db.update(booking).set({ status: 'CANCELLED', cancelledAt: NOW, holdExpiresAt: null }).where(eq(booking.id, env.bookingId))
    await expect(saveAgencyGuest(env.agency, env.bookingId, env.slot(2), karim)).rejects.toMatchObject({ code: 'BOOKING_CLOSED', httpStatus: 409 })
  })
})
