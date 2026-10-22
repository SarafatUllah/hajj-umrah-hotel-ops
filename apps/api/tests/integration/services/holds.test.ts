import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { booking, bookingChange, bookingGuest, bookingPriceLine, bookingRoom, guestStay } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import { type HoldRequestInput, holdRequestSchema, type StaySearchInput, staySearchSchema } from '@hajj/contracts/schemas/booking'
import { bookingOrgRepos, bookingRepos } from '../../../server/repositories'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { type Booker, expireLapsedBookings, placeHold, searchStay, type StayOption } from '../../../server/services/booking'
import { makeAgency, makeCustomer } from '../../support/bookingFixtures'
import { makeOrg, makeRoomBlock } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const NOW = new Date('2027-05-01T10:00:00Z')
const LATER = new Date(NOW.getTime() + 11 * 60_000)

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

const agencyBooker = (agencyId: string): Booker => ({ kind: 'AGENCY', agencyId, agencyUserId: null, staffUserId: null })

/** The shared stay hotel (4 Quads, 2 Doubles, June rates) and one approved agency. */
async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, hotelScope, rooms } = await makeStayHotel(db, scope)
  const agencyRow = await makeAgency(db, scope)
  return { scope, hotel, hotelScope, rooms, agencyId: agencyRow.id, agency: agencyBooker(agencyRow.id) }
}

const stay = (hotelId: string, counts: Partial<StaySearchInput> = {}): StaySearchInput =>
  staySearchSchema.parse({ hotelId, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 4, femaleCount: 2, totalCount: 6, ...counts })

const holdOf = (search: StaySearchInput, option: Pick<StayOption, 'rooms'>): HoldRequestInput =>
  holdRequestSchema.parse({ ...search, rooms: option.rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds })) })

const holdIn = (search: StaySearchInput, roomId: string, occupancy: string, seats: number): HoldRequestInput =>
  holdRequestSchema.parse({ ...search, rooms: [{ roomId, occupancy, seats }] })

async function seatsIn(scope: OrganizationScope, hotelId: string, roomId: string): Promise<number[]> {
  const rows = await bookingRepos(db, trustedHotelScope(scope, hotelId)).inventory.seatsUsed([roomId], { from: '2027-06-01', to: '2027-06-03' })
  return rows.map(r => r.seatsUsed)
}

describe('search and hold (v7 §9–10)', () => {
  it('a GROUP search offers men and women their own rooms, priced on the chosen rooms; holding it saves everything HELD for 10 minutes', async () => {
    const env = await setup()
    const search = stay(env.hotel.id)
    const { options, quotaHeadroom } = await searchStay(db, env.scope, env.agency, search, NOW)
    expect(quotaHeadroom).toBeNull()
    expect(options[0]!.rooms.map(r => [r.roomNumber, r.occupancy, r.seats])).toEqual([['101', 'MALE', 4], ['201', 'FEMALE', 2]])
    // 3 nights × (4 men × agency default 350 + 2 women × public 450 for the Double, which has no agency default).
    expect(options[0]).toMatchObject({ newRooms: 2, emptySeats: 0, extraBeds: 0, totalHalalas: 3 * (4 * 35000 + 2 * 45000), priceSource: 'AGENCY_DEFAULT' })

    const held = await placeHold(db, env.scope, env.agency, holdOf(search, options[0]!), NOW)
    expect(held).toMatchObject({ bookingNo: 'B-2027-0001', status: 'HELD', holdExpiresAt: '2027-05-01T10:10:00.000Z', totalHalalas: 690000 })
    const [row] = await db.select().from(booking).where(eq(booking.id, held.id))
    expect(row).toMatchObject({ bookerType: 'AGENCY', bookingType: 'GROUP', priceSource: 'AGENCY_DEFAULT', childSide: 'MOTHER', totalCount: 6 })
    const claims = await db.select().from(bookingRoom).where(eq(bookingRoom.bookingId, held.id))
    expect(claims.map(c => [c.occupancy, c.ownerAgencyId, c.status]).sort()).toEqual([['FEMALE', env.agencyId, 'HELD'], ['MALE', env.agencyId, 'HELD']])
    const guests = await db.select().from(bookingGuest).where(eq(bookingGuest.bookingId, held.id))
    expect(guests.map(g => g.gender).sort()).toEqual(['FEMALE', 'FEMALE', 'MALE', 'MALE', 'MALE', 'MALE'])
    expect(await db.select().from(guestStay).where(eq(guestStay.bookingId, held.id))).toHaveLength(6)
    expect(await db.select().from(bookingPriceLine).where(eq(bookingPriceLine.bookingId, held.id))).toHaveLength(6)
    expect(await seatsIn(env.scope, env.hotel.id, env.rooms['101']!)).toEqual([4, 4, 4])
    const [created] = await db.select().from(bookingChange).where(eq(bookingChange.bookingId, held.id))
    expect(created).toMatchObject({ kind: 'CREATED', actorKind: 'agency' })

    // The held rooms are gone from the next search, which stays near the agency's rooms.
    const next = await searchStay(db, env.scope, env.agency, stay(env.hotel.id, { maleCount: 4, femaleCount: 0, totalCount: 4 }), NOW)
    expect(next.options[0]!.rooms.map(r => r.roomNumber)).toEqual(['102'])
  })

  it('concurrent holds of the same room: exactly one wins, the others are told to search again (409)', async () => {
    const env = await setup()
    const request = holdIn(stay(env.hotel.id, { maleCount: 4, femaleCount: 0, totalCount: 4 }), env.rooms['101']!, 'MALE', 4)
    const agencies = await Promise.all(Array.from({ length: 6 }, () => makeAgency(db, env.scope)))
    const results = await Promise.allSettled(agencies.map(a => placeHold(db, env.scope, agencyBooker(a.id), request, NOW)))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results.filter(r => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'OPTION_UNAVAILABLE', httpStatus: 409 })
    expect(await seatsIn(env.scope, env.hotel.id, env.rooms['101']!)).toEqual([4, 4, 4])
  })

  it('the agency quota counts held persons; beyond it the search and the hold say how many are still possible (422)', async () => {
    const env = await setup()
    await bookingRepos(db, env.hotelScope).agencyQuotas.insert({ agencyId: null, startDate: '2027-06-01', endDate: '2027-06-30', maxPersons: 6 })
    const four = stay(env.hotel.id, { maleCount: 4, femaleCount: 0, totalCount: 4 })
    // Two holds of one agency at once: the quota lock lets exactly one through.
    const results = await Promise.allSettled(['101', '102'].map(n => placeHold(db, env.scope, env.agency, holdIn(four, env.rooms[n]!, 'MALE', 4), NOW)))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'QUOTA_EXCEEDED', httpStatus: 422, details: { maxPersons: 2 } })
    await expect(searchStay(db, env.scope, env.agency, stay(env.hotel.id, { maleCount: 3, femaleCount: 0, totalCount: 3 }), NOW)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', details: { maxPersons: 2 } })
    expect((await searchStay(db, env.scope, env.agency, stay(env.hotel.id, { maleCount: 2, femaleCount: 0, totalCount: 2 }), NOW)).quotaHeadroom).toBe(2)
  })

  it('a lapsed hold on the rooms is expired inside the next hold\'s transaction (v7 §10 step 3)', async () => {
    const env = await setup()
    const request = holdIn(stay(env.hotel.id, { maleCount: 4, femaleCount: 0, totalCount: 4 }), env.rooms['101']!, 'MALE', 4)
    const first = await placeHold(db, env.scope, env.agency, request, NOW)
    const other = agencyBooker((await makeAgency(db, env.scope)).id)
    await expect(placeHold(db, env.scope, other, request, NOW)).rejects.toMatchObject({ code: 'OPTION_UNAVAILABLE' })
    expect((await placeHold(db, env.scope, other, request, LATER)).status).toBe('HELD')
    const [expired] = await db.select().from(booking).where(eq(booking.id, first.id))
    expect(expired!.status).toBe('EXPIRED')
    const changes = await db.select().from(bookingChange).where(and(eq(bookingChange.bookingId, first.id), eq(bookingChange.kind, 'EXPIRED')))
    expect(changes).toEqual([expect.objectContaining({ actorKind: 'system', beforeData: { status: 'HELD' } })])
  })

  it('the minute sweep expires every lapsed hold once', async () => {
    const env = await setup()
    const search = stay(env.hotel.id)
    const { options } = await searchStay(db, env.scope, env.agency, search, NOW)
    await placeHold(db, env.scope, env.agency, holdOf(search, options[0]!), NOW)
    expect(await expireLapsedBookings(db, [env.scope], NOW)).toBe(0)
    expect(await expireLapsedBookings(db, [env.scope], LATER)).toBe(1)
    expect(await expireLapsedBookings(db, [env.scope], LATER)).toBe(0)
    expect(await seatsIn(env.scope, env.hotel.id, env.rooms['101']!)).toEqual([])
  })

  it('own room first: a second booking of the agency with the same dates fills its room before a new one', async () => {
    const env = await setup()
    await placeHold(db, env.scope, env.agency, holdIn(stay(env.hotel.id, { maleCount: 3, femaleCount: 0, totalCount: 3 }), env.rooms['103']!, 'MALE', 3), NOW)
    const one = stay(env.hotel.id, { maleCount: 1, femaleCount: 0, totalCount: 1 })
    const { options } = await searchStay(db, env.scope, env.agency, one, NOW)
    expect(options[0]!.rooms).toEqual([expect.objectContaining({ roomNumber: '103', seats: 1, existing: true })])
    expect(options[0]!.newRooms).toBe(0)
    // Opening a new room while the agency's own room still has a seat is refused (search again).
    await expect(placeHold(db, env.scope, env.agency, holdIn(one, env.rooms['102']!, 'MALE', 1), NOW))
      .rejects.toMatchObject({ code: 'OPTION_UNAVAILABLE', httpStatus: 409, details: { problems: [{ code: 'OWN_ROOMS_FIRST', occupancy: 'MALE' }] } })
    await placeHold(db, env.scope, env.agency, holdOf(one, options[0]!), NOW)
    expect(await seatsIn(env.scope, env.hotel.id, env.rooms['103']!)).toEqual([4, 4, 4])
    // Another agency never gets a seat in that room.
    const other = agencyBooker((await makeAgency(db, env.scope)).id)
    await expect(placeHold(db, env.scope, other, holdIn(one, env.rooms['104']!, 'MALE', 1), NOW)).resolves.toMatchObject({ status: 'HELD' })
    await expect(placeHold(db, env.scope, other, holdIn(one, env.rooms['103']!, 'MALE', 1), NOW)).rejects.toMatchObject({ code: 'OPTION_UNAVAILABLE' })
  })

  it('a quote prices the stay and serves one live booking only; a booking that does not match it is refused', async () => {
    const env = await setup()
    const quote = await bookingOrgRepos(db, env.scope).quotes.insert({ refNo: 'Q-2027-0001', agencyId: env.agencyId, hotelId: env.hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 4, femaleCount: 0, totalCount: 4, status: 'OFFERED', amountHalalas: 30000, unit: 'PER_PERSON_NIGHT', vatIncluded: true, validUntil: new Date('2027-05-03T10:00:00Z'), offeredAt: NOW })
    const search = stay(env.hotel.id, { maleCount: 4, femaleCount: 0, totalCount: 4, quoteId: quote.id })
    const { options } = await searchStay(db, env.scope, env.agency, search, NOW)
    expect(options[0]).toMatchObject({ priceSource: 'QUOTE', totalHalalas: 3 * 4 * 30000 })
    const held = await placeHold(db, env.scope, env.agency, holdOf(search, options[0]!), NOW)
    expect((await db.select().from(booking).where(eq(booking.id, held.id)))[0]).toMatchObject({ quoteId: quote.id, priceSource: 'QUOTE' })
    await expect(placeHold(db, env.scope, env.agency, holdIn(search, env.rooms['102']!, 'MALE', 4), NOW)).rejects.toMatchObject({ code: 'QUOTE_ALREADY_USED', httpStatus: 409 })
    await expect(searchStay(db, env.scope, env.agency, { ...search, maleCount: 3, totalCount: 3 }, NOW)).rejects.toMatchObject({ code: 'QUOTE_MISMATCH', httpStatus: 422 })
  })

  it('an individual FAMILY request: whole rooms only, owned by the booking, REQUESTED for 24 hours', async () => {
    const env = await setup()
    const customer: Booker = { kind: 'INDIVIDUAL', customerId: (await makeCustomer(db, env.scope)).id }
    const search = stay(env.hotel.id, { bookingType: 'FAMILY', maleCount: 0, femaleCount: 0, totalCount: 3, infantCount: 1 })
    const { options } = await searchStay(db, env.scope, customer, search, NOW)
    expect(options[0]).toMatchObject({ rooms: [expect.objectContaining({ roomNumber: '101', occupancy: 'FAMILY', seats: 3 })], emptySeats: 1, totalHalalas: 3 * 140000, priceSource: 'PUBLIC' })
    const held = await placeHold(db, env.scope, customer, holdOf(search, options[0]!), NOW)
    expect(held).toMatchObject({ status: 'REQUESTED', holdExpiresAt: '2027-05-02T10:00:00.000Z' })
    const [claim] = await db.select().from(bookingRoom).where(eq(bookingRoom.bookingId, held.id))
    expect(claim).toMatchObject({ ownerBookingId: held.id, ownerAgencyId: null, occupancy: 'FAMILY' })
    const guests = await db.select().from(bookingGuest).where(eq(bookingGuest.bookingId, held.id))
    expect(guests.map(g => g.ageGroup).sort()).toEqual(['ADULT', 'ADULT', 'ADULT', 'INFANT'])
    expect(await seatsIn(env.scope, env.hotel.id, env.rooms['101']!)).toEqual([3, 3, 3])
    // One open request at a time (v7 §10): the next waits until this one is answered or lapses.
    await expect(placeHold(db, env.scope, customer, holdIn(search, env.rooms['102']!, 'FAMILY', 3), NOW)).rejects.toMatchObject({ code: 'TOO_MANY_OPEN_REQUESTS', httpStatus: 409 })
    expect((await placeHold(db, env.scope, customer, holdIn(search, env.rooms['102']!, 'FAMILY', 3), new Date('2027-05-02T10:00:01Z'))).status).toBe('REQUESTED')
  })

  it('refuses an option that breaks the rules (422), a room blocked since the search (409) and a stay without prices (422)', async () => {
    const env = await setup()
    const four = stay(env.hotel.id, { maleCount: 4, femaleCount: 0, totalCount: 4 })
    await expect(placeHold(db, env.scope, env.agency, holdIn(four, env.rooms['101']!, 'MALE', 3), NOW))
      .rejects.toMatchObject({ code: 'INVALID_OPTION', httpStatus: 422, details: { problems: [{ code: 'HEADCOUNT', occupancy: 'MALE' }] } })
    await expect(placeHold(db, env.scope, env.agency, holdIn(four, env.rooms['101']!, 'FEMALE', 4), NOW)).rejects.toMatchObject({ code: 'INVALID_OPTION' })

    await makeRoomBlock(db, env.hotelScope, env.rooms['101']!, { kind: 'OUT_OF_SERVICE', startDate: '2027-06-02', endDate: '2027-06-02' })
    await expect(placeHold(db, env.scope, env.agency, holdIn(four, env.rooms['101']!, 'MALE', 4), NOW))
      .rejects.toMatchObject({ code: 'OPTION_UNAVAILABLE', httpStatus: 409, details: { problems: [{ code: 'ROOM_NOT_SELLABLE', roomId: env.rooms['101'] }] } })

    // A hand-made option may not spread four men over four rooms, or sit children where no adult sleeps.
    const spread = holdRequestSchema.parse({ ...four, rooms: ['102', '103', '104', '201'].map(n => ({ roomId: env.rooms[n], occupancy: 'MALE', seats: 1 })) })
    await expect(placeHold(db, env.scope, env.agency, spread, NOW)).rejects.toMatchObject({ code: 'INVALID_OPTION', details: { problems: [{ code: 'IDLE_ROOMS', occupancy: 'MALE' }] } })
    await expect(searchStay(db, env.scope, env.agency, stay(env.hotel.id, { maleCount: 2, femaleCount: 0, childCount: 1, totalCount: 3 }), NOW))
      .rejects.toMatchObject({ code: 'CHILDREN_NEED_AN_ADULT', httpStatus: 422 })
    // Infants too: they sleep on the children's side (later removals and additions apply the same rule).
    await expect(searchStay(db, env.scope, env.agency, stay(env.hotel.id, { maleCount: 2, femaleCount: 0, infantCount: 1, totalCount: 2 }), NOW))
      .rejects.toMatchObject({ code: 'CHILDREN_NEED_AN_ADULT', httpStatus: 422 })

    const july = stay(env.hotel.id, { checkIn: '2027-07-01', checkOut: '2027-07-03', maleCount: 4, femaleCount: 0, totalCount: 4 })
    expect((await searchStay(db, env.scope, env.agency, july, NOW)).options).toEqual([])
    await expect(placeHold(db, env.scope, env.agency, holdIn(july, env.rooms['102']!, 'MALE', 4), NOW)).rejects.toMatchObject({ code: 'STAY_UNPRICED', httpStatus: 422 })
    expect((await db.execute(sql`select count(*)::int as n from booking`))[0]).toEqual({ n: 0 })
  })
})
