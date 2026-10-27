import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq, sql, TransactionRollbackError } from 'drizzle-orm'
import { agency, agencyQuota, agencyUser, allocationRule, booking, bookingChange, bookingGuestDetail, bookingPriceLine, bookingRoom, bookingSetting, customer, documentAsset, extraBedPolicy, guestStay, hotelTask, otpChallenge, passportScan, piiAccessLog, pilgrim, priceQuote, rate } from '@hajj/db/schema'
import { extractPgError } from '../../../server/errors/dbErrors'
import type { OrganizationScope } from '../../../server/security/scope'
import { makeAgency, makeBooking, makeBookingRoom, makeCustomer, makeGuest, makeHotelWithRooms, makeStay } from '../../support/bookingFixtures'
import { makeOrg } from '../../support/fixtures'
import { closeTestDb, getTestClient, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
const client = getTestClient()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

/** The SQLSTATE and constraint a statement failed with (the test fails if it succeeded). */
async function failure(statement: PromiseLike<unknown>): Promise<{ code: string, constraint?: string }> {
  try {
    await statement
  }
  catch (error) {
    const pg = extractPgError(error)
    if (pg) return { code: pg.code, constraint: pg.constraint }
    throw error
  }
  throw new Error('expected the statement to fail')
}

const CHECK = '23514'
const EXCLUSION = '23P01'
const FOREIGN_KEY = '23503'
const UNIQUE = '23505'

async function setup(roomCount = 3) {
  const { organization, scope } = await makeOrg(db)
  const hotel = await makeHotelWithRooms(db, scope, roomCount)
  const agencyA = await makeAgency(db, scope)
  const agencyB = await makeAgency(db, scope)
  return { organization, scope, ...hotel, agencyA, agencyB }
}

describe('booking: row rules', () => {
  it('a booker is exactly an agency or a customer, matching booker_type', async () => {
    const { scope, hotel, agencyA } = await setup()
    const customer = await makeCustomer(db, scope)
    expect(await failure(makeBooking(db, scope, hotel.id, { bookerType: 'AGENCY' }))).toMatchObject({ code: CHECK, constraint: 'booking_booker_check' })
    expect(await failure(makeBooking(db, scope, hotel.id, { bookerType: 'INDIVIDUAL', agencyId: agencyA.id }))).toMatchObject({ constraint: 'booking_booker_check' })
    await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    await makeBooking(db, scope, hotel.id, { bookerType: 'INDIVIDUAL', customerId: customer.id, bookingType: 'FAMILY', maleCount: 0, totalCount: 3 })
  })

  it('GROUP counts add up (men + women + children); FAMILY carries only a total; children need a side', async () => {
    const { scope, hotel, agencyA } = await setup()
    const base = { agencyId: agencyA.id }
    expect(await failure(makeBooking(db, scope, hotel.id, { ...base, maleCount: 2, femaleCount: 1, totalCount: 2 }))).toMatchObject({ constraint: 'booking_group_counts_check' })
    expect(await failure(makeBooking(db, scope, hotel.id, { ...base, bookingType: 'FAMILY', maleCount: 2, totalCount: 2 }))).toMatchObject({ constraint: 'booking_group_counts_check' })
    expect(await failure(makeBooking(db, scope, hotel.id, { ...base, maleCount: 2, childCount: 1, totalCount: 3 }))).toMatchObject({ constraint: 'booking_child_side_check' })
    await makeBooking(db, scope, hotel.id, { ...base, maleCount: 2, femaleCount: 1, childCount: 1, childSide: 'MOTHER', infantCount: 1, totalCount: 4 })
  })

  it('ticket 2: a pending booking always has an expiry (no NULL can silently release its seats)', async () => {
    const { scope, hotel, agencyA } = await setup()
    expect(await failure(makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, status: 'HELD', holdExpiresAt: null }))).toMatchObject({ code: CHECK, constraint: 'booking_hold_expiry_check' })
  })

  it('REQUESTED is for individual bookers only; confirmed bookings carry a receipt token; CANCELLED ⇔ cancelled_at', async () => {
    const { scope, hotel, agencyA } = await setup()
    expect(await failure(makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, status: 'REQUESTED' }))).toMatchObject({ constraint: 'booking_requested_check' })
    expect(await failure(makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, receiptToken: null }))).toMatchObject({ constraint: 'booking_confirmed_check' })
    expect(await failure(makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, status: 'CANCELLED' }))).toMatchObject({ constraint: 'booking_cancelled_check' })
  })

  it('a quote is used by one live booking; an expired hold gives it back; the quote must exist in the organization', async () => {
    const { scope, hotel, agencyA } = await setup()
    const [quote] = await db.insert(priceQuote).values({ organizationId: scope.organizationId, refNo: 'Q-2027-0001', agencyId: agencyA.id, hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-06', maleCount: 2, totalCount: 2 }).returning()
    const withQuote = { agencyId: agencyA.id, priceSource: 'QUOTE', quoteId: quote!.id }
    await makeBooking(db, scope, hotel.id, { ...withQuote, status: 'EXPIRED' })
    await makeBooking(db, scope, hotel.id, withQuote)
    expect(await failure(makeBooking(db, scope, hotel.id, withQuote))).toMatchObject({ code: UNIQUE, constraint: 'booking_quote_once' })
    expect(await failure(makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, priceSource: 'PUBLIC', quoteId: quote!.id }))).toMatchObject({ constraint: 'booking_quote_source_check' })

    const other = await makeOrg(db)
    const otherHotel = await makeHotelWithRooms(db, other.scope, 1)
    const otherAgency = await makeAgency(db, other.scope)
    expect(await failure(makeBooking(db, other.scope, otherHotel.hotel.id, { agencyId: otherAgency.id, priceSource: 'QUOTE', quoteId: quote!.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'booking_quote_fk' })
  })

  it('a booking may use only its own agency\'s quote, for the quote\'s hotel', async () => {
    const { scope, hotel, agencyA, agencyB } = await setup()
    const second = await makeHotelWithRooms(db, scope, 1)
    const [quote] = await db.insert(priceQuote).values({ organizationId: scope.organizationId, refNo: 'Q-2027-0002', agencyId: agencyA.id, hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-06', maleCount: 2, totalCount: 2 }).returning()
    expect(await failure(makeBooking(db, scope, hotel.id, { agencyId: agencyB.id, priceSource: 'QUOTE', quoteId: quote!.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'booking_quote_fk' })
    expect(await failure(makeBooking(db, scope, second.hotel.id, { agencyId: agencyA.id, priceSource: 'QUOTE', quoteId: quote!.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'booking_quote_fk' })
  })

  it('an agency user named as creator or quote requester belongs to the same agency', async () => {
    const { scope, hotel, agencyA, agencyB } = await setup()
    const [userOfB] = await db.insert(agencyUser).values({ organizationId: scope.organizationId, agencyId: agencyB.id, email: 'b@example.test', passwordHash: 'h', fullName: 'B' }).returning()
    expect(await failure(makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, createdByAgencyUserId: userOfB!.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'booking_created_by_agency_user_fk' })
    expect(await failure(db.insert(priceQuote).values({ organizationId: scope.organizationId, refNo: 'Q-X', agencyId: agencyA.id, hotelId: hotel.id, bookingType: 'FAMILY', checkIn: '2027-06-01', checkOut: '2027-06-02', totalCount: 2, requestedByAgencyUserId: userOfB!.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'price_quote_requested_by_agency_user_fk' })
    await makeBooking(db, scope, hotel.id, { agencyId: agencyB.id, createdByAgencyUserId: userOfB!.id })
  })

  it('tenancy: a booking can reference neither another organization\'s hotel nor its agency', async () => {
    const { scope, hotel } = await setup()
    const other = await makeOrg(db)
    const foreignAgency = await makeAgency(db, other.scope)
    expect(await failure(makeBooking(db, scope, hotel.id, { agencyId: foreignAgency.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'booking_agency_fk' })
    expect(await failure(makeBooking(db, other.scope, hotel.id, { agencyId: foreignAgency.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'booking_hotel_fk' })
  })
})

describe('booking_room: one owner and one occupancy per room and night (v7 §16)', () => {
  it('exactly one owner; an owning booking is the booking itself; an owning agency is the booking\'s agency', async () => {
    const { scope, hotel, rooms, agencyA, agencyB } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    expect(await failure(makeBookingRoom(db, scope, b, rooms[0]!.id, { ownerAgencyId: agencyA.id, ownerBookingId: b.id }))).toMatchObject({ constraint: 'booking_room_owner_check' })
    const other = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    expect(await failure(makeBookingRoom(db, scope, b, rooms[0]!.id, { ownerBookingId: other.id }))).toMatchObject({ constraint: 'booking_room_owner_self_check' })
    expect(await failure(makeBookingRoom(db, scope, b, rooms[0]!.id, { ownerAgencyId: agencyB.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'booking_room_owner_agency_fk' })
    const claim = await makeBookingRoom(db, scope, b, rooms[0]!.id)
    expect(claim.ownerKey).toBe(`a:${agencyA.id}`)
  })

  it('a room of another hotel can never be claimed by the booking', async () => {
    const { scope, hotel, agencyA } = await setup()
    const second = await makeHotelWithRooms(db, scope, 1)
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    expect(await failure(makeBookingRoom(db, scope, b, second.rooms[0]!.id))).toMatchObject({ code: FOREIGN_KEY, constraint: 'booking_room_room_fk' })
  })

  it('two agencies never share a room on overlapping nights; the same agency may; back-to-back stays never overlap', async () => {
    const { scope, hotel, rooms, agencyA, agencyB } = await setup()
    const a1 = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    const a2 = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    const bOverlap = await makeBooking(db, scope, hotel.id, { agencyId: agencyB.id, checkIn: '2027-06-05', checkOut: '2027-06-08' })
    const bAfter = await makeBooking(db, scope, hotel.id, { agencyId: agencyB.id, checkIn: '2027-06-06', checkOut: '2027-06-09' })
    const room = rooms[0]!.id

    await makeBookingRoom(db, scope, a1, room)
    await makeBookingRoom(db, scope, a2, room)
    expect(await failure(makeBookingRoom(db, scope, bOverlap, room))).toMatchObject({ code: EXCLUSION, constraint: 'booking_room_one_owner' })
    await makeBookingRoom(db, scope, bAfter, room)
  })

  it('a family room belongs to that booking only — not even another family booking of the same agency', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const family = { agencyId: agencyA.id, bookingType: 'FAMILY', maleCount: 0, totalCount: 3 }
    const f1 = await makeBooking(db, scope, hotel.id, family)
    const f2 = await makeBooking(db, scope, hotel.id, family)
    await makeBookingRoom(db, scope, f1, rooms[0]!.id, { ownerBookingId: f1.id, occupancy: 'FAMILY' })
    expect(await failure(makeBookingRoom(db, scope, f2, rooms[0]!.id, { ownerBookingId: f2.id, occupancy: 'FAMILY' }))).toMatchObject({ code: EXCLUSION, constraint: 'booking_room_one_owner' })
  })

  it('men and women of one agency never share a room on overlapping nights', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const men = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    const women = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, maleCount: 0, femaleCount: 2 })
    await makeBookingRoom(db, scope, men, rooms[0]!.id, { occupancy: 'MALE' })
    expect(await failure(makeBookingRoom(db, scope, women, rooms[0]!.id, { occupancy: 'FEMALE' }))).toMatchObject({ code: EXCLUSION, constraint: 'booking_room_one_occupancy' })
  })

  it('one booking never claims the same room twice for overlapping nights', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    await makeBookingRoom(db, scope, b, rooms[0]!.id)
    expect(await failure(makeBookingRoom(db, scope, b, rooms[0]!.id))).toMatchObject({ code: EXCLUSION, constraint: 'booking_room_no_duplicate' })
  })

  it('cancelled, expired, completed and released claims never block a room', async () => {
    const { scope, hotel, rooms, agencyA, agencyB } = await setup()
    const room = rooms[0]!.id
    for (const status of ['CANCELLED', 'EXPIRED', 'COMPLETED', 'RELEASED'] as const) {
      const bookingStatus = status === 'RELEASED' ? 'CONFIRMED' : status
      const extra = bookingStatus === 'CANCELLED' ? { cancelledAt: new Date() } : {}
      const old = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, status: bookingStatus, ...extra })
      await makeBookingRoom(db, scope, old, room, { status })
    }
    const fresh = await makeBooking(db, scope, hotel.id, { agencyId: agencyB.id })
    await makeBookingRoom(db, scope, fresh, room, { occupancy: 'FEMALE' })
  })
})

describe('booking_guest and guest_stay', () => {
  it('a stay can only join a guest and a room claim of the SAME booking (composite FKs)', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const a = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    const claimB = await makeBookingRoom(db, scope, b, rooms[0]!.id)
    const guestA = await makeGuest(db, scope, a.id, 1)

    expect(await failure(makeStay(db, scope, a.id, guestA.id, claimB.id, a.checkIn, a.checkOut))).toMatchObject({ code: FOREIGN_KEY, constraint: 'guest_stay_room_fk' })
    expect(await failure(makeStay(db, scope, b.id, guestA.id, claimB.id, a.checkIn, a.checkOut))).toMatchObject({ code: FOREIGN_KEY, constraint: 'guest_stay_guest_fk' })
  })

  it('one bed per pilgrim per night: a room move is two back-to-back stays, an overlap is refused', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, checkIn: '2027-06-01', checkOut: '2027-06-11' })
    const roomA = await makeBookingRoom(db, scope, b, rooms[0]!.id, { checkIn: '2027-06-01', checkOut: '2027-06-06' })
    const roomB = await makeBookingRoom(db, scope, b, rooms[1]!.id, { checkIn: '2027-06-06', checkOut: '2027-06-11' })
    const guest = await makeGuest(db, scope, b.id, 1)

    await makeStay(db, scope, b.id, guest.id, roomA.id, '2027-06-01', '2027-06-06')
    await makeStay(db, scope, b.id, guest.id, roomB.id, '2027-06-06', '2027-06-11')
    expect(await failure(makeStay(db, scope, b.id, guest.id, roomB.id, '2027-06-05', '2027-06-07'))).toMatchObject({ code: EXCLUSION, constraint: 'guest_stay_one_bed_per_night' })
  })

  it('slot numbers are unique per booking; an infant is never an extra bed; checked-in slots carry their time', async () => {
    const { scope, hotel, agencyA } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    await makeGuest(db, scope, b.id, 1)
    expect(await failure(makeGuest(db, scope, b.id, 1))).toMatchObject({ code: UNIQUE, constraint: 'booking_guest_slot_unique' })
    expect(await failure(makeGuest(db, scope, b.id, 2, { ageGroup: 'INFANT', isExtraBed: true }))).toMatchObject({ constraint: 'booking_guest_infant_bed_check' })
    expect(await failure(makeGuest(db, scope, b.id, 3, { status: 'CHECKED_IN' }))).toMatchObject({ constraint: 'booking_guest_check_in_check' })
  })
})

describe('room_night_occupancy(): the one seat-counting rule', () => {
  /** Seats per night of one room (or every room with `roomId` null) between `from` and `to` (inclusive). */
  const seats = async (scope: OrganizationScope, hotelId: string, roomId: string | null, from = '2027-01-01', to = '2027-12-31') =>
    (await client<Array<{ night: string, seats: number }>>`
      select night::text as night, seats_used as seats from room_night_occupancy(${scope.organizationId}, ${hotelId}, ${from}::date, ${to}::date, ${roomId === null ? null : [roomId]}::uuid[])
      order by night, seats_used`).map(r => ({ night: r.night, seats: r.seats }))

  async function claimWithGuests(scope: OrganizationScope, b: Awaited<ReturnType<typeof makeBooking>>, roomId: string, guests: Array<Parameters<typeof makeGuest>[3]>, firstSlot = 1) {
    const claim = await makeBookingRoom(db, scope, b, roomId)
    let slot = firstSlot - 1
    for (const overrides of guests) {
      const guest = await makeGuest(db, scope, b.id, ++slot, overrides)
      await makeStay(db, scope, b.id, guest.id, claim.id, b.checkIn, b.checkOut)
    }
    return claim
  }

  it('counts each night of [check_in, check_out) once per seated pilgrim; infants (by age group) and removed slots never count', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, checkIn: '2027-06-01', checkOut: '2027-06-03' })
    await claimWithGuests(scope, b, rooms[0]!.id, [{}, {}, { ageGroup: 'INFANT', gender: null }, { status: 'REMOVED' }])

    expect(await seats(scope, hotel.id, rooms[0]!.id)).toEqual([{ night: '2027-06-01', seats: 2 }, { night: '2027-06-02', seats: 2 }])
  })

  it('expands only the requested nights; NULL rooms = the whole hotel; another hotel or organization sees nothing', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, checkIn: '2027-06-01', checkOut: '2027-06-11' })
    await claimWithGuests(scope, b, rooms[0]!.id, [{}])
    await claimWithGuests(scope, b, rooms[1]!.id, [{}, {}], 2)

    expect(await seats(scope, hotel.id, rooms[0]!.id, '2027-06-03', '2027-06-04')).toEqual([{ night: '2027-06-03', seats: 1 }, { night: '2027-06-04', seats: 1 }])
    expect(await seats(scope, hotel.id, null, '2027-06-10', '2027-06-30')).toEqual([{ night: '2027-06-10', seats: 1 }, { night: '2027-06-10', seats: 2 }])
    expect(await seats(scope, hotel.id, null, '2027-06-11', '2027-06-30')).toEqual([])
    const other = await makeHotelWithRooms(db, scope, 1)
    expect(await seats(scope, other.hotel.id, null)).toEqual([])
    expect(await seats((await makeOrg(db)).scope, hotel.id, null)).toEqual([])
  })

  it('two bookings of one agency in one room add up; a shortened stay (early checkout) frees the later nights', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const room = rooms[0]!.id
    const first = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, checkIn: '2027-06-01', checkOut: '2027-06-03' })
    const second = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, checkIn: '2027-06-01', checkOut: '2027-06-03' })
    await claimWithGuests(scope, first, room, [{}])
    const claim = await makeBookingRoom(db, scope, second, room)
    const guest = await makeGuest(db, scope, second.id, 1)
    await makeStay(db, scope, second.id, guest.id, claim.id, '2027-06-01', '2027-06-02')

    expect(await seats(scope, hotel.id, room)).toEqual([{ night: '2027-06-01', seats: 2 }, { night: '2027-06-02', seats: 1 }])
  })

  it('a live hold counts; an expired hold stops counting before any sweep; cancelled and released claims never count', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const stay = { agencyId: agencyA.id, checkIn: '2027-06-01', checkOut: '2027-06-02' }
    const live = await makeBooking(db, scope, hotel.id, { ...stay, status: 'HELD', holdExpiresAt: new Date(Date.now() + 600_000) })
    await claimWithGuests(scope, live, rooms[0]!.id, [{}])
    const expired = await makeBooking(db, scope, hotel.id, { ...stay, status: 'HELD', holdExpiresAt: new Date(Date.now() - 1000) })
    await claimWithGuests(scope, expired, rooms[1]!.id, [{}])
    const cancelled = await makeBooking(db, scope, hotel.id, { ...stay, status: 'CANCELLED', cancelledAt: new Date() })
    await claimWithGuests(scope, cancelled, rooms[2]!.id, [{}])
    const released = await makeBooking(db, scope, hotel.id, stay)
    const releasedClaim = await claimWithGuests(scope, released, rooms[2]!.id, [{}])
    await db.update(bookingRoom).set({ status: 'RELEASED' }).where(eq(bookingRoom.id, releasedClaim.id))

    expect(await seats(scope, hotel.id, rooms[0]!.id)).toEqual([{ night: '2027-06-01', seats: 1 }])
    expect(await seats(scope, hotel.id, rooms[1]!.id)).toEqual([])
    expect(await seats(scope, hotel.id, rooms[2]!.id)).toEqual([])
  })

  it('ticket 2: a pending booking with a NULL expiry is still COUNTED (proved with the CHECK lifted inside a rolled-back transaction)', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    let counted: unknown[] = []
    await db.transaction(async (tx) => {
      await tx.execute(sql`alter table booking drop constraint booking_hold_expiry_check`)
      const held = await makeBooking(tx, scope, hotel.id, { agencyId: agencyA.id, status: 'HELD', holdExpiresAt: null, checkIn: '2027-06-01', checkOut: '2027-06-02' })
      const claim = await makeBookingRoom(tx, scope, held, rooms[0]!.id)
      const guest = await makeGuest(tx, scope, held.id, 1)
      await makeStay(tx, scope, held.id, guest.id, claim.id, '2027-06-01', '2027-06-02')
      counted = (await tx.execute(sql`select night::text as night, seats_used from room_night_occupancy(${scope.organizationId}, ${hotel.id}, '2027-06-01', '2027-06-30')`)) as unknown[]
      tx.rollback()
    }).catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error
    })

    expect(counted).toEqual([{ night: '2027-06-01', seats_used: 1 }])
    // The rollback restored the CHECK.
    expect(await failure(makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, status: 'HELD', holdExpiresAt: null }))).toMatchObject({ constraint: 'booking_hold_expiry_check' })
  })
})

describe('booking ⇄ room claim consistency (triggers)', () => {
  it('a claim always carries its booking\'s status: changes are copied to every unreleased claim, a mismatch is refused', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const held = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, status: 'HELD' })
    const kept = await makeBookingRoom(db, scope, held, rooms[0]!.id)
    const released = await makeBookingRoom(db, scope, held, rooms[1]!.id)
    await db.update(bookingRoom).set({ status: 'RELEASED' }).where(eq(bookingRoom.id, released.id))
    expect(await failure(makeBookingRoom(db, scope, held, rooms[2]!.id, { status: 'CONFIRMED' }))).toMatchObject({ code: CHECK, constraint: 'booking_room_status_matches_booking' })

    await db.update(booking).set({ status: 'CONFIRMED', holdExpiresAt: null, confirmedAt: new Date(), receiptToken: 'tok-1' }).where(eq(booking.id, held.id))

    const claims = await db.select({ id: bookingRoom.id, status: bookingRoom.status }).from(bookingRoom).where(eq(bookingRoom.bookingId, held.id))
    expect(new Map(claims.map(c => [c.id, c.status]))).toEqual(new Map([[kept.id, 'CONFIRMED'], [released.id, 'RELEASED']]))
    expect(await failure(db.update(bookingRoom).set({ status: 'CANCELLED' }).where(eq(bookingRoom.id, kept.id)))).toMatchObject({ constraint: 'booking_room_status_matches_booking' })
  })

  it('confirming clears the hold expiry (a confirmed booking never keeps one)', async () => {
    const { scope, hotel, agencyA } = await setup()
    expect(await failure(makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, holdExpiresAt: new Date() }))).toMatchObject({ constraint: 'booking_confirmed_expiry_check' })
  })

  it('containment, checked at commit: a stay within its claim, a claim within its booking', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, checkIn: '2027-06-01', checkOut: '2027-06-06' })
    expect(await failure(makeBookingRoom(db, scope, b, rooms[0]!.id, { checkIn: '2027-05-31' }))).toMatchObject({ code: CHECK, constraint: 'booking_room_within_booking' })
    const claim = await makeBookingRoom(db, scope, b, rooms[0]!.id, { checkIn: '2027-06-01', checkOut: '2027-06-04' })
    const guest = await makeGuest(db, scope, b.id, 1)
    expect(await failure(makeStay(db, scope, b.id, guest.id, claim.id, '2027-06-01', '2027-06-05'))).toMatchObject({ code: CHECK, constraint: 'guest_stay_within_claim' })
    await makeStay(db, scope, b.id, guest.id, claim.id, '2027-06-01', '2027-06-04')
    expect(await failure(db.update(booking).set({ checkOut: '2027-06-03' }).where(eq(booking.id, b.id)))).toMatchObject({ constraint: 'booking_room_within_booking' })
    expect(await failure(db.update(bookingRoom).set({ checkOut: '2027-06-03' }).where(eq(bookingRoom.id, claim.id)))).toMatchObject({ constraint: 'guest_stay_within_claim' })
  })

  it('a date change moving booking, claims and stays inside ONE transaction commits in any statement order', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id, checkIn: '2027-06-01', checkOut: '2027-06-06' })
    const claim = await makeBookingRoom(db, scope, b, rooms[0]!.id)
    const guest = await makeGuest(db, scope, b.id, 1)
    await makeStay(db, scope, b.id, guest.id, claim.id, b.checkIn, b.checkOut)

    await db.transaction(async (tx) => {
      await tx.update(guestStay).set({ checkIn: '2027-07-01', checkOut: '2027-07-06' }).where(eq(guestStay.bookingId, b.id))
      await tx.update(bookingRoom).set({ checkIn: '2027-07-01', checkOut: '2027-07-06' }).where(eq(bookingRoom.id, claim.id))
      await tx.update(booking).set({ checkIn: '2027-07-01', checkOut: '2027-07-06' }).where(eq(booking.id, b.id))
    })
    const [moved] = await db.select().from(guestStay).where(eq(guestStay.bookingId, b.id))
    expect(moved).toMatchObject({ checkIn: '2027-07-01', checkOut: '2027-07-06' })
  })
})

describe('pricing and rule tables', () => {
  it('rates: one price per hotel, room type, price type and unit per night; amounts never negative', async () => {
    const { scope, hotel, roomType } = await setup()
    const base = { organizationId: scope.organizationId, hotelId: hotel.id, roomTypeId: roomType.id, priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', amountHalalas: 38000, vatIncluded: true }
    await db.insert(rate).values({ ...base, startDate: '2027-05-01', endDate: '2027-05-31' })
    await db.insert(rate).values({ ...base, startDate: '2027-06-01', endDate: '2027-06-30' })
    await db.insert(rate).values({ ...base, priceType: 'AGENCY_DEFAULT', startDate: '2027-05-15', endDate: '2027-06-15' })
    await db.insert(rate).values({ ...base, unit: 'PER_ROOM_NIGHT', startDate: '2027-05-15', endDate: '2027-06-15' })
    expect(await failure(db.insert(rate).values({ ...base, startDate: '2027-05-31', endDate: '2027-06-01' }))).toMatchObject({ code: EXCLUSION, constraint: 'rate_no_overlap' })
    expect(await failure(db.insert(rate).values({ ...base, startDate: '2028-01-01', endDate: '2028-01-02', amountHalalas: -1 }))).toMatchObject({ constraint: 'rate_amount_check' })
  })

  it('quotas: one row per agency (or the default) per night; room-mix rules never overlap in group size', async () => {
    const { scope, hotel, agencyA } = await setup()
    const quota = { organizationId: scope.organizationId, hotelId: hotel.id, maxPersons: 30 }
    await db.insert(agencyQuota).values({ ...quota, startDate: '2027-05-01', endDate: '2027-06-30' })
    await db.insert(agencyQuota).values({ ...quota, agencyId: agencyA.id, startDate: '2027-05-01', endDate: '2027-06-30', maxPersons: 40 })
    expect(await failure(db.insert(agencyQuota).values({ ...quota, startDate: '2027-06-30', endDate: '2027-07-10' }))).toMatchObject({ code: EXCLUSION, constraint: 'agency_quota_no_overlap' })
    expect(await failure(db.insert(agencyQuota).values({ ...quota, agencyId: agencyA.id, startDate: '2027-06-01', endDate: '2027-06-02' }))).toMatchObject({ constraint: 'agency_quota_no_overlap' })

    const rule = { organizationId: scope.organizationId, hotelId: hotel.id }
    await db.insert(allocationRule).values({ ...rule, groupMin: 1, groupMax: 10, maxRooms: 1 })
    await db.insert(allocationRule).values({ ...rule, groupMin: 41, groupMax: null, maxRooms: 5 })
    expect(await failure(db.insert(allocationRule).values({ ...rule, groupMin: 10, groupMax: 20, maxRooms: 2 }))).toMatchObject({ code: EXCLUSION, constraint: 'allocation_rule_no_overlap' })
    expect(await failure(db.insert(allocationRule).values({ ...rule, groupMin: 100, groupMax: 200, maxRooms: 9 }))).toMatchObject({ constraint: 'allocation_rule_no_overlap' })
  })

  it('an offered quote carries its price and validity; GROUP quote sides add up', async () => {
    const { scope, hotel, agencyA } = await setup()
    const base = { organizationId: scope.organizationId, agencyId: agencyA.id, hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-10', maleCount: 18, femaleCount: 12, totalCount: 30 }
    expect(await failure(db.insert(priceQuote).values({ ...base, refNo: 'Q-1', status: 'OFFERED' }))).toMatchObject({ constraint: 'price_quote_offer_check' })
    expect(await failure(db.insert(priceQuote).values({ ...base, refNo: 'Q-2', totalCount: 29 }))).toMatchObject({ constraint: 'price_quote_group_counts_check' })
    await db.insert(priceQuote).values({ ...base, refNo: 'Q-3', status: 'OFFERED', amountHalalas: 35000, unit: 'PER_PERSON_NIGHT', vatIncluded: true, validUntil: new Date(), offeredAt: new Date() })
  })

  it('price lines: amount is always quantity × unit amount', async () => {
    const { scope, hotel, agencyA } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    const line = { organizationId: scope.organizationId, bookingId: b.id, night: '2027-06-01', kind: 'PERSON', quantity: 2, unitAmountHalalas: 35000, vatIncluded: true }
    await db.insert(bookingPriceLine).values({ ...line, amountHalalas: 70000 })
    expect(await failure(db.insert(bookingPriceLine).values({ ...line, amountHalalas: 69999 }))).toMatchObject({ constraint: 'booking_price_line_amount_check' })
    expect(await failure(db.insert(bookingPriceLine).values({ ...line, amountHalalas: 70000 }))).toMatchObject({ code: UNIQUE, constraint: 'booking_price_line_unique' })
  })
})

describe('pilgrim data', () => {
  const lookup = (char: string) => char.repeat(64)

  it('the staff master is unique per passport lookup; bookers\' copies are not (two bookers may enter one passport)', async () => {
    const { scope, hotel, agencyA, agencyB } = await setup()
    const master = { organizationId: scope.organizationId, fullName: 'Md. Karim', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1970-01-01', passportNoEncrypted: 'pii1.x', passportExpiry: '2030-01-01' }
    await db.insert(pilgrim).values({ ...master, passportLookup: lookup('a') })
    expect(await failure(db.insert(pilgrim).values({ ...master, passportLookup: lookup('a') }))).toMatchObject({ code: UNIQUE, constraint: 'pilgrim_org_passport_lookup_unique' })
    expect(await failure(db.insert(pilgrim).values({ ...master, passportLookup: 'not-hex' }))).toMatchObject({ constraint: 'pilgrim_lookup_check' })

    for (const agencyId of [agencyA.id, agencyB.id]) {
      const b = await makeBooking(db, scope, hotel.id, { agencyId })
      const guest = await makeGuest(db, scope, b.id, 1)
      await db.insert(bookingGuestDetail).values({ organizationId: scope.organizationId, bookingId: b.id, bookingGuestId: guest.id, fullName: 'Md. Karim', passportNoEncrypted: 'pii1.y', passportLookup: lookup('a'), enteredByKind: 'agency' })
    }
    expect(await db.select().from(bookingGuestDetail).where(eq(bookingGuestDetail.passportLookup, lookup('a')))).toHaveLength(2)
  })

  it('a booker\'s copy has a lookup exactly when it has a passport number, and belongs to its own booking\'s slot', async () => {
    const { scope, hotel, agencyA } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    const other = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    const guest = await makeGuest(db, scope, b.id, 1)
    const detail = { organizationId: scope.organizationId, bookingId: b.id, bookingGuestId: guest.id, fullName: 'X', enteredByKind: 'staff' }
    expect(await failure(db.insert(bookingGuestDetail).values({ ...detail, passportNoEncrypted: 'pii1.z' }))).toMatchObject({ constraint: 'booking_guest_detail_passport_check' })
    expect(await failure(db.insert(bookingGuestDetail).values({ ...detail, bookingId: other.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'booking_guest_detail_guest_fk' })
    await db.insert(bookingGuestDetail).values(detail)
    expect(await failure(db.insert(bookingGuestDetail).values(detail))).toMatchObject({ code: UNIQUE, constraint: 'booking_guest_detail_guest_unique' })
  })

  it('ticket 1: a passport scan fills only a copy of its own booking\'s slot — never the staff master (no pilgrim column)', async () => {
    const { scope, hotel, agencyA } = await setup()
    const [a, b] = [await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id }), await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })]
    const [slotA, slotB] = [await makeGuest(db, scope, a.id, 1), await makeGuest(db, scope, b.id, 1)]
    const copyOf = async (bookingId: string, bookingGuestId: string) => (await db.insert(bookingGuestDetail).values({ organizationId: scope.organizationId, bookingId, bookingGuestId, fullName: 'X', enteredByKind: 'agency' }).returning())[0]!
    const [copyA, copyB] = [await copyOf(a.id, slotA.id), await copyOf(b.id, slotB.id)]
    const [doc] = await db.insert(documentAsset).values({ organizationId: scope.organizationId, storageKey: `passport/${a.id}`, originalFilename: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64) }).returning()
    const scan = { organizationId: scope.organizationId, bookingId: a.id, documentId: doc!.id, uploadedByKind: 'agency', reviewedByKind: 'agency', reviewedAt: new Date() }

    expect(await failure(db.insert(passportScan).values({ ...scan, status: 'CONFIRMED' }))).toMatchObject({ constraint: 'passport_scan_confirmed_check' })
    expect(await failure(db.insert(passportScan).values({ ...scan, bookingGuestDetailId: copyA.id }))).toMatchObject({ constraint: 'passport_scan_detail_slot_check' })
    expect(await failure(db.insert(passportScan).values({ ...scan, bookingGuestId: slotA.id, bookingGuestDetailId: copyB.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'passport_scan_detail_fk' })
    await db.insert(passportScan).values({ ...scan, status: 'CONFIRMED', bookingGuestId: slotA.id, bookingGuestDetailId: copyA.id })

    const columns = await client<Array<{ column_name: string }>>`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'passport_scan'`
    expect(columns.map(c => c.column_name)).not.toContain('pilgrim_id')
  })
})

describe('row checks of the account and settings tables', () => {
  it('E.164 phones, recorded approvals, unique licences, setting and extra-bed bounds, quote units, a task\'s booking in its hotel', async () => {
    const { scope, hotel, rooms, roomType, agencyA } = await setup()
    const org = scope.organizationId
    expect(await failure(db.insert(customer).values({ organizationId: org, fullName: 'C', phone: '0501234567' }))).toMatchObject({ constraint: 'customer_phone_check' })
    expect(await failure(makeAgency(db, scope, { status: 'APPROVED', approvedAt: null }))).toMatchObject({ constraint: 'agency_approval_check' })
    expect(await failure(makeAgency(db, scope, { licenseNo: agencyA.licenseNo }))).toMatchObject({ code: UNIQUE, constraint: 'agency_org_license_unique' })
    expect(await failure(db.insert(bookingSetting).values({ organizationId: org, holdMinutes: 0 }))).toMatchObject({ constraint: 'booking_setting_hold_check' })
    expect(await failure(db.insert(bookingSetting).values({ organizationId: org, whatsappNumber: '+966500000000' }))).toMatchObject({ constraint: 'booking_setting_whatsapp_check' })
    await db.insert(bookingSetting).values({ organizationId: org, whatsappNumber: '966500000000' })
    expect(await failure(db.insert(extraBedPolicy).values({ organizationId: org, hotelId: hotel.id, roomTypeId: roomType.id, maxPerRoom: 6, maxPerBooking: 2, amountHalalas: 8000, vatIncluded: true }))).toMatchObject({ constraint: 'extra_bed_policy_limits_check' })
    expect(await failure(db.insert(priceQuote).values({ organizationId: org, refNo: 'Q-U', agencyId: agencyA.id, hotelId: hotel.id, bookingType: 'FAMILY', checkIn: '2027-06-01', checkOut: '2027-06-02', totalCount: 2, unit: 'PER_BED' }))).toMatchObject({ constraint: 'price_quote_unit_check' })
    const second = await makeHotelWithRooms(db, scope, 1)
    const otherHotelBooking = await makeBooking(db, scope, second.hotel.id, { agencyId: agencyA.id })
    expect(await failure(db.insert(hotelTask).values({ organizationId: org, hotelId: hotel.id, roomId: rooms[0]!.id, bookingId: otherHotelBooking.id, kind: 'EXTRA_BED_SETUP', dueDate: '2027-06-01' }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'hotel_task_booking_fk' })
    expect(await db.select().from(agency).where(eq(agency.organizationId, org))).toHaveLength(2)
  })

  it('D-P2-68: a customer signs in with a phone or a verified e-mail (stored lower-case, unique when verified); a code goes to exactly one', async () => {
    const { scope } = await setup()
    const org = scope.organizationId
    const now = new Date()
    expect(await failure(db.insert(customer).values({ organizationId: org, fullName: 'C', email: 'c@example.com' }))).toMatchObject({ code: CHECK, constraint: 'customer_closed_check' })
    expect(await failure(db.insert(customer).values({ organizationId: org, fullName: 'C', email: 'C@Example.com', emailVerifiedAt: now }))).toMatchObject({ constraint: 'customer_email_check' })
    expect(await failure(db.insert(customer).values({ organizationId: org, fullName: 'C', email: ' c@example.com', emailVerifiedAt: now }))).toMatchObject({ constraint: 'customer_email_check' })
    expect(await failure(db.insert(customer).values({ organizationId: org, fullName: 'C', email: 'no-at-sign', emailVerifiedAt: now }))).toMatchObject({ constraint: 'customer_email_check' })
    expect(await failure(db.insert(customer).values({ organizationId: org, fullName: 'C', phone: '+966501234567', emailVerifiedAt: now }))).toMatchObject({ constraint: 'customer_email_verified_check' })
    await db.insert(customer).values({ organizationId: org, fullName: 'C', email: 'c@example.com', emailVerifiedAt: now })
    expect(await failure(db.insert(customer).values({ organizationId: org, fullName: 'D', email: 'c@example.com', emailVerifiedAt: now }))).toMatchObject({ code: UNIQUE, constraint: 'customer_org_verified_email_unique' })
    // An unverified copy is contact data only; a closed account keeps neither identity nor any e-mail.
    await db.insert(customer).values({ organizationId: org, fullName: 'E', phone: '+966501234568', email: 'c@example.com' })
    expect(await failure(db.insert(customer).values({ organizationId: org, fullName: 'Closed account', email: 'old@example.com', isActive: false, closedAt: now }))).toMatchObject({ constraint: 'customer_closed_check' })

    const code = { organizationId: org, codeHash: 'a'.repeat(64), expiresAt: now }
    expect(await failure(db.insert(otpChallenge).values(code))).toMatchObject({ constraint: 'otp_challenge_destination_check' })
    expect(await failure(db.insert(otpChallenge).values({ ...code, phone: '+966501234567', email: 'c@example.com' }))).toMatchObject({ constraint: 'otp_challenge_destination_check' })
    expect(await failure(db.insert(otpChallenge).values({ ...code, email: 'C@example.com' }))).toMatchObject({ constraint: 'otp_challenge_email_check' })
    await db.insert(otpChallenge).values({ ...code, email: 'c@example.com' })
  })
})

describe('append-only logs', () => {
  it('booking_change and pii_access_log rows cannot be updated', async () => {
    const { scope, hotel, agencyA } = await setup()
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    await db.insert(bookingChange).values({ organizationId: scope.organizationId, bookingId: b.id, kind: 'CREATED', actorKind: 'staff' })
    await db.insert(piiAccessLog).values({ organizationId: scope.organizationId, actorKind: 'staff', subjectType: 'PILGRIM', subjectId: b.id, fields: ['passport_no'] })

    expect((await failure(db.update(bookingChange).set({ reason: 'x' }))).code).toBe('55000')
    expect((await failure(db.update(piiAccessLog).set({ purpose: 'x' }))).code).toBe('55000')
  })
})

describe('hotel_task', () => {
  it('DONE ⇔ done_at, and the task\'s room and booking are in the same hotel', async () => {
    const { scope, hotel, rooms, agencyA } = await setup()
    const second = await makeHotelWithRooms(db, scope, 1)
    const b = await makeBooking(db, scope, hotel.id, { agencyId: agencyA.id })
    const task = { organizationId: scope.organizationId, hotelId: hotel.id, roomId: rooms[0]!.id, bookingId: b.id, kind: 'EXTRA_BED_SETUP', dueDate: '2027-06-01' }
    await db.insert(hotelTask).values(task)
    expect(await failure(db.insert(hotelTask).values({ ...task, status: 'DONE' }))).toMatchObject({ constraint: 'hotel_task_done_check' })
    expect(await failure(db.insert(hotelTask).values({ ...task, roomId: second.rooms[0]!.id }))).toMatchObject({ code: FOREIGN_KEY, constraint: 'hotel_task_room_fk' })
  })
})

