import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { agencyUser, booking, bookingChange, bookingGuest, bookingPriceLine, bookingRoom, guestStay, hotelTask, priceQuote } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { changeDatesSchema, dateChangeSearchSchema, holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { bookingOrgRepos, bookingRepos } from '../../../server/repositories'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { changeDates, confirmAgencyBooking, holdAgencyStay, listAgencyGuests, searchDateChange } from '../../../server/services/booking'
import { makeAgency } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const BOOKED_AT = new Date('2027-05-01T10:00:00Z')
const SECOND_DAY = new Date('2027-06-02T09:00:00Z')
const NEW_DATES = { checkIn: '2027-06-02', checkOut: '2027-06-05' }

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

function staff(scope: OrganizationScope, userId: string, permissions: Permission[], now: Date): AuthContext {
  return { identity: { userId, organizationId: scope.organizationId, email: 's@example.test', fullName: 'Staff' }, authz: { permissions: new Set(permissions), allHotels: true, hotelIds: new Set() }, scope, db, now: () => now }
}

async function agencyCtx(scope: OrganizationScope, agencyId: string): Promise<AgencyContext> {
  const [user] = await db.insert(agencyUser).values({ organizationId: scope.organizationId, agencyId, email: `u-${agencyId}@example.test`, passwordHash: 'h', fullName: 'Agent' }).returning()
  return (await resolveAgencyContext(db, { agencyUserId: user!.id, organizationId: scope.organizationId, agencyId }, () => BOOKED_AT))!
}

/**
 * A confirmed GROUP of one agency, June 1–4: four men fill Quad 101, two women Double 201. Another agency holds the
 * rest of the hotel (102–104, 202) June 1–10, so on overlapping new dates only the booking's own rooms are left.
 */
async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, hotelScope, rooms } = await makeStayHotel(db, scope)
  const agency = await agencyCtx(scope, (await makeAgency(db, scope)).id)
  const held = await holdAgencyStay(agency, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 4, femaleCount: 2, totalCount: 6,
    rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 4 }, { roomId: rooms['201'], occupancy: 'FEMALE', seats: 2 }],
  }))
  await confirmAgencyBooking(agency, held.id)
  const other = await agencyCtx(scope, (await makeAgency(db, scope)).id)
  await holdAgencyStay(other, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-10', maleCount: 12, femaleCount: 2, totalCount: 14,
    rooms: [...['102', '103', '104'].map(n => ({ roomId: rooms[n], occupancy: 'MALE', seats: 4 })), { roomId: rooms['202'], occupancy: 'FEMALE', seats: 2 }],
  }))
  const userId = (await makeUser(db, scope)).id
  const manager = (now: Date) => staff(scope, userId, ['booking.view', 'booking.edit'], now)
  return { scope, hotel, hotelScope, rooms, agency, bookingId: held.id, manager }
}

const ownRooms = (rooms: Record<string, string>) => [{ roomId: rooms['101']!, occupancy: 'MALE' as const, seats: 4 }, { roomId: rooms['201']!, occupancy: 'FEMALE' as const, seats: 2 }]
const claimsOf = (bookingId: string) => db.select().from(bookingRoom).where(eq(bookingRoom.bookingId, bookingId)).orderBy(asc(bookingRoom.checkIn), asc(bookingRoom.occupancy))
const staysOf = (bookingId: string) => db.select().from(guestStay).where(eq(guestStay.bookingId, bookingId)).orderBy(asc(guestStay.bookingGuestId))
const nightsPriced = async (bookingId: string) => [...new Set((await db.select().from(bookingPriceLine).where(eq(bookingPriceLine.bookingId, bookingId))).map(l => l.night))].sort()

describe('date change (v7 §12)', () => {
  it('plans the new dates as if the booking had given up its own rooms, then moves it whole: same pilgrims, new claims, stays and nightly price', async () => {
    const env = await setup()
    const search = await searchDateChange(env.manager(BOOKED_AT), env.bookingId, dateChangeSearchSchema.parse(NEW_DATES))
    expect(search.options[0]?.rooms.map(r => r.roomNumber).sort()).toEqual(['101', '201'])

    const before = await listAgencyGuests(env.agency, env.bookingId)
    const rooms = search.options[0]!.rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds }))
    expect(await changeDates(env.manager(BOOKED_AT), env.bookingId, changeDatesSchema.parse({ ...NEW_DATES, rooms }))).toMatchObject({ ...NEW_DATES, status: 'CONFIRMED' })

    expect(await claimsOf(env.bookingId)).toMatchObject([
      { roomId: env.rooms['201'], occupancy: 'FEMALE', status: 'CONFIRMED', ...NEW_DATES, ownerAgencyId: env.agency.scope.agencyId },
      { roomId: env.rooms['101'], occupancy: 'MALE', status: 'CONFIRMED', ...NEW_DATES, ownerAgencyId: env.agency.scope.agencyId },
    ])
    const after = await listAgencyGuests(env.agency, env.bookingId)
    expect(after.map(g => g.id)).toEqual(before.map(g => g.id))
    expect(after.map(g => g.roomNumber)).toEqual(['101', '101', '101', '101', '201', '201'])
    expect((await staysOf(env.bookingId)).map(s => [s.checkIn, s.checkOut])).toEqual(Array.from({ length: 6 }, () => ['2027-06-02', '2027-06-05']))
    expect(await nightsPriced(env.bookingId)).toEqual(['2027-06-02', '2027-06-03', '2027-06-04'])
    expect(await bookingRepos(db, env.hotelScope).inventory.seatsUsed([env.rooms['101']!], { from: '2027-06-01', to: '2027-06-05' })).toMatchObject([
      { night: '2027-06-02', seatsUsed: 4 }, { night: '2027-06-03', seatsUsed: 4 }, { night: '2027-06-04', seatsUsed: 4 },
    ])
    expect(await db.select().from(bookingChange).where(eq(bookingChange.kind, 'DATES_CHANGED'))).toMatchObject([
      { actorKind: 'staff', beforeData: { checkIn: '2027-06-01', checkOut: '2027-06-04' }, afterData: { ...NEW_DATES, priceSource: 'AGENCY_DEFAULT' } },
    ])
  })

  it('all or nothing: a room taken on the new nights refuses the change and leaves the booking as it was', async () => {
    const env = await setup()
    const [claims, stays, nights] = [await claimsOf(env.bookingId), await staysOf(env.bookingId), await nightsPriced(env.bookingId)]
    const taken = [{ roomId: env.rooms['102']!, occupancy: 'MALE' as const, seats: 4 }, { roomId: env.rooms['201']!, occupancy: 'FEMALE' as const, seats: 2 }]
    await expect(changeDates(env.manager(BOOKED_AT), env.bookingId, changeDatesSchema.parse({ ...NEW_DATES, rooms: taken }))).rejects.toMatchObject({ code: 'OPTION_UNAVAILABLE', httpStatus: 409 })
    expect((await db.select().from(booking).where(eq(booking.id, env.bookingId)))[0]).toMatchObject({ checkIn: '2027-06-01', checkOut: '2027-06-04' })
    expect(await claimsOf(env.bookingId)).toEqual(claims)
    expect(await staysOf(env.bookingId)).toEqual(stays)
    expect(await nightsPriced(env.bookingId)).toEqual(nights)
  })

  it('the agency\'s quota counts the booking\'s own persons as given up', async () => {
    const env = await setup()
    await bookingRepos(db, env.hotelScope).agencyQuotas.insert({ agencyId: env.agency.scope.agencyId, startDate: '2027-06-01', endDate: '2027-06-30', maxPersons: 6 })
    expect(await searchDateChange(env.manager(BOOKED_AT), env.bookingId, dateChangeSearchSchema.parse(NEW_DATES))).toMatchObject({ quotaHeadroom: 6 })
    await changeDates(env.manager(BOOKED_AT), env.bookingId, changeDatesSchema.parse({ ...NEW_DATES, rooms: ownRooms(env.rooms) }))
    expect((await claimsOf(env.bookingId)).map(c => c.checkIn)).toEqual(['2027-06-02', '2027-06-02'])
  })

  it('a new quote for the new dates prices the stay and becomes ACCEPTED; the old dates\' open extra-bed tasks are cancelled', async () => {
    const env = await setup()
    const quote = await bookingOrgRepos(db, env.scope).quotes.insert({ refNo: 'Q-2027-0009', agencyId: env.agency.scope.agencyId, hotelId: env.hotel.id, bookingType: 'GROUP', ...NEW_DATES, maleCount: 4, femaleCount: 2, totalCount: 6, status: 'OFFERED', amountHalalas: 30000, unit: 'PER_PERSON_NIGHT', vatIncluded: true, validUntil: new Date('2099-01-01T00:00:00Z'), offeredAt: BOOKED_AT })
    const [task] = await db.insert(hotelTask).values({ organizationId: env.scope.organizationId, hotelId: env.hotel.id, roomId: env.rooms['101']!, bookingId: env.bookingId, kind: 'EXTRA_BED_SETUP', dueDate: '2027-06-01' }).returning()

    const detail = await changeDates(env.manager(BOOKED_AT), env.bookingId, changeDatesSchema.parse({ ...NEW_DATES, quoteId: quote.id, rooms: ownRooms(env.rooms) }))
    expect(detail).toMatchObject({ priceSource: 'QUOTE', totalHalalas: 6 * 3 * 30000 })
    expect((await db.select().from(booking).where(eq(booking.id, env.bookingId)))[0]).toMatchObject({ quoteId: quote.id })
    expect((await db.select().from(priceQuote).where(eq(priceQuote.id, quote.id)))[0]).toMatchObject({ status: 'ACCEPTED' })
    expect((await db.select().from(hotelTask).where(eq(hotelTask.id, task!.id)))[0]).toMatchObject({ status: 'CANCELLED' })
  })

  it('refuses the same dates, a start in the past, a stay begun, a quote for other dates, no booking.edit, a cancelled booking', async () => {
    const env = await setup()
    const manager = env.manager(BOOKED_AT)
    const search = (body: object, ctx = manager) => searchDateChange(ctx, env.bookingId, dateChangeSearchSchema.parse(body))
    await expect(search({ checkIn: '2027-06-01', checkOut: '2027-06-04' })).rejects.toMatchObject({ code: 'SAME_DATES', httpStatus: 422 })
    await expect(search({ checkIn: '2027-06-01', checkOut: '2027-06-05' }, env.manager(SECOND_DAY))).rejects.toMatchObject({ code: 'DATES_IN_PAST' })
    const oldQuote = await bookingOrgRepos(db, env.scope).quotes.insert({ refNo: 'Q-2027-0010', agencyId: env.agency.scope.agencyId, hotelId: env.hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 4, femaleCount: 2, totalCount: 6, status: 'OFFERED', amountHalalas: 30000, unit: 'PER_PERSON_NIGHT', vatIncluded: true, validUntil: new Date('2099-01-01T00:00:00Z'), offeredAt: BOOKED_AT })
    await expect(search({ ...NEW_DATES, quoteId: oldQuote.id })).rejects.toMatchObject({ code: 'QUOTE_MISMATCH' })
    const reception = staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view'], BOOKED_AT)
    await expect(search(NEW_DATES, reception)).rejects.toMatchObject({ httpStatus: 403 })

    const [first] = await listAgencyGuests(env.agency, env.bookingId)
    await db.update(bookingGuest).set({ status: 'NO_SHOW' }).where(eq(bookingGuest.id, first!.id))
    await expect(search(NEW_DATES)).rejects.toMatchObject({ code: 'STAY_BEGUN', httpStatus: 409 })
    await expect(changeDates(manager, env.bookingId, changeDatesSchema.parse({ ...NEW_DATES, rooms: ownRooms(env.rooms) }))).rejects.toMatchObject({ code: 'STAY_BEGUN' })
    await db.update(booking).set({ status: 'CANCELLED', cancelledAt: BOOKED_AT }).where(eq(booking.id, env.bookingId))
    await expect(search(NEW_DATES)).rejects.toMatchObject({ code: 'BOOKING_NOT_CHANGEABLE' })
  })
})
