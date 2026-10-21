import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { agencyUser, booking, bookingChange, bookingGuest, bookingPriceLine, bookingRoom } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { addGuestsSchema, guestAdditionSearchSchema, holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { bookingRepos } from '../../../server/repositories'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { addAgencyGuests, addGuests, confirmAgencyBooking, holdAgencyStay, listAgencyGuests, removeGuest, searchAgencyGuestAdditions, searchGuestAdditions } from '../../../server/services/booking'
import { makeAgency, makeBooking, makeBookingRoom, makeCustomer, makeGuest, makeStay } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestClient, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const client = getTestClient()
const NOW = new Date('2027-05-01T10:00:00Z')
const STAY = { from: '2027-06-01', to: '2027-06-03' }

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

/** A confirmed GROUP, June 1–4: two men in Quad 101 (two seats free), a woman in Double 201 (one free). */
async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, hotelScope, rooms } = await makeStayHotel(db, scope)
  const agency = await agencyCtx(scope, (await makeAgency(db, scope)).id)
  const held = await holdAgencyStay(agency, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, femaleCount: 1, totalCount: 3,
    rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 2 }, { roomId: rooms['201'], occupancy: 'FEMALE', seats: 1 }],
  }))
  await confirmAgencyBooking(agency, held.id)
  const manager = staff(scope, (await makeUser(db, scope)).id, ['booking.view', 'booking.edit', 'booking.cancel'])
  const seats = (roomId: string) => bookingRepos(db, hotelScope).inventory.seatsUsed([roomId], STAY)
  return { scope, hotel, hotelScope, rooms, agency, bookingId: held.id, manager, seats }
}

const bookingRow = async (id: string) => (await db.select().from(booking).where(eq(booking.id, id)))[0]!
const asChosen = (rooms: ReadonlyArray<{ roomId: string, occupancy: string, seats: number, extraBeds: number }>) => rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds }))

describe('removing a pilgrim (v7 §12)', () => {
  it('the slot becomes REMOVED: its seat is free, the head count follows, the agency keeps its room; the last pilgrim stays', async () => {
    const env = await setup()
    const [man1, man2, woman] = await listAgencyGuests(env.agency, env.bookingId)
    expect(await removeGuest(env.manager, env.bookingId, man2!.id)).toMatchObject({ status: 'CONFIRMED' })
    expect(await bookingRow(env.bookingId)).toMatchObject({ maleCount: 1, femaleCount: 1, totalCount: 2 })
    expect(await env.seats(env.rooms['101']!)).toMatchObject([{ seatsUsed: 1 }, { seatsUsed: 1 }, { seatsUsed: 1 }])
    expect((await listAgencyGuests(env.agency, env.bookingId)).map(s => s.status)).toEqual(['PENDING_DETAILS', 'REMOVED', 'PENDING_DETAILS'])
    expect(await removeGuest(env.manager, env.bookingId, man2!.id)).toMatchObject({ status: 'CONFIRMED' }) // twice: unchanged
    expect(await db.select().from(bookingChange).where(eq(bookingChange.kind, 'GUEST_REMOVED'))).toHaveLength(1)

    await removeGuest(env.manager, env.bookingId, woman!.id)
    // The agency's room stays its own (a seat for its other bookings of the same dates).
    expect(await db.select().from(bookingRoom).where(and(eq(bookingRoom.bookingId, env.bookingId), eq(bookingRoom.roomId, env.rooms['201']!)))).toMatchObject([{ status: 'CONFIRMED' }])
    await expect(removeGuest(env.manager, env.bookingId, man1!.id)).rejects.toMatchObject({ code: 'LAST_PILGRIM', httpStatus: 409 })
  })

  it('refuses a pilgrim already in the house, staff without booking.cancel, and children left without an adult', async () => {
    const env = await setup()
    const [man1, man2] = await listAgencyGuests(env.agency, env.bookingId)
    const reception = staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view', 'booking.edit'])
    await expect(removeGuest(reception, env.bookingId, man1!.id)).rejects.toMatchObject({ httpStatus: 403 })

    // A mother and her child: the mother cannot leave the child alone.
    const customer = await makeCustomer(db, env.scope)
    const family = await makeBooking(db, env.scope, env.hotel.id, { bookerType: 'INDIVIDUAL', customerId: customer.id, bookingType: 'GROUP', maleCount: 0, femaleCount: 1, childCount: 1, totalCount: 2, childSide: 'MOTHER', checkIn: '2027-06-01', checkOut: '2027-06-04' })
    const claim = await makeBookingRoom(db, env.scope, family, env.rooms['202']!, { occupancy: 'FEMALE' })
    const mother = await makeGuest(db, env.scope, family.id, 1, { gender: 'FEMALE' })
    const child = await makeGuest(db, env.scope, family.id, 2, { gender: null, ageGroup: 'CHILD' })
    for (const slot of [mother, child]) await makeStay(db, env.scope, family.id, slot.id, claim.id, family.checkIn, family.checkOut)
    await expect(removeGuest(env.manager, family.id, mother.id)).rejects.toMatchObject({ code: 'CHILDREN_NEED_AN_ADULT', httpStatus: 422 })

    // In the house: checked out at the desk, not removed.
    await db.update(booking).set({ status: 'IN_HOUSE' }).where(eq(booking.id, env.bookingId))
    await db.update(bookingGuest).set({ status: 'CHECKED_IN', checkedInAt: NOW }).where(eq(bookingGuest.id, man2!.id))
    await expect(removeGuest(env.manager, env.bookingId, man2!.id)).rejects.toMatchObject({ code: 'GUEST_STATUS', httpStatus: 409 })
  })

  it('recounts from the slots as they are now: a slot a passport made a child leaves no negative count', async () => {
    const env = await setup()
    const [, man2] = await listAgencyGuests(env.agency, env.bookingId)
    await db.update(bookingGuest).set({ ageGroup: 'CHILD' }).where(eq(bookingGuest.id, man2!.id))
    await removeGuest(env.manager, env.bookingId, man2!.id)
    expect(await bookingRow(env.bookingId)).toMatchObject({ maleCount: 1, femaleCount: 1, childCount: 0, totalCount: 2 })
  })

  it('a room the booking itself owns that nobody sleeps in any more is let go', async () => {
    const env = await setup()
    const customer = await makeCustomer(db, env.scope)
    const family = await makeBooking(db, env.scope, env.hotel.id, { bookerType: 'INDIVIDUAL', customerId: customer.id, bookingType: 'FAMILY', maleCount: 0, totalCount: 3, checkIn: '2027-06-01', checkOut: '2027-06-04' })
    const big = await makeBookingRoom(db, env.scope, family, env.rooms['102']!, { occupancy: 'FAMILY' })
    const small = await makeBookingRoom(db, env.scope, family, env.rooms['202']!, { occupancy: 'FAMILY' })
    const slots = [await makeGuest(db, env.scope, family.id, 1, { gender: null }), await makeGuest(db, env.scope, family.id, 2, { gender: null }), await makeGuest(db, env.scope, family.id, 3, { gender: null })]
    await makeStay(db, env.scope, family.id, slots[0]!.id, big.id, family.checkIn, family.checkOut)
    await makeStay(db, env.scope, family.id, slots[1]!.id, big.id, family.checkIn, family.checkOut)
    await makeStay(db, env.scope, family.id, slots[2]!.id, small.id, family.checkIn, family.checkOut)

    await removeGuest(env.manager, family.id, slots[2]!.id)
    expect((await db.select().from(bookingRoom).where(eq(bookingRoom.id, small.id)))[0]!.status).toBe('RELEASED')
    expect((await db.select().from(bookingRoom).where(eq(bookingRoom.id, big.id)))[0]!.status).toBe('CONFIRMED')
    expect(await bookingRow(family.id)).toMatchObject({ totalCount: 2 })
  })
})

describe('adding pilgrims (v7 §12)', () => {
  it('the booking\'s own free seats first: a man joins Quad 101 at the booking\'s frozen price', async () => {
    const env = await setup()
    const before = await db.select().from(bookingPriceLine).where(eq(bookingPriceLine.bookingId, env.bookingId))
    const counts = guestAdditionSearchSchema.parse({ maleCount: 1, totalCount: 1 })
    const { options } = await searchAgencyGuestAdditions(env.agency, env.bookingId, counts)
    expect(options[0]).toMatchObject({ newRooms: 0, rooms: [{ roomId: env.rooms['101'], seats: 1, existing: true }] })

    expect(await addAgencyGuests(env.agency, env.bookingId, addGuestsSchema.parse({ ...counts, rooms: asChosen(options[0]!.rooms) }))).toMatchObject({ status: 'CONFIRMED' })
    expect(await bookingRow(env.bookingId)).toMatchObject({ maleCount: 3, totalCount: 4 })
    expect((await listAgencyGuests(env.agency, env.bookingId)).at(-1)).toMatchObject({ slotNo: 4, gender: 'MALE', roomNumber: '101', status: 'PENDING_DETAILS' })
    expect(await env.seats(env.rooms['101']!)).toMatchObject([{ seatsUsed: 3 }, { seatsUsed: 3 }, { seatsUsed: 3 }])

    // The night's person line grew by one at its frozen unit price; no new line.
    const after = await db.select().from(bookingPriceLine).where(eq(bookingPriceLine.bookingId, env.bookingId))
    expect(after).toHaveLength(before.length)
    const quadLine = after.find(l => l.night === '2027-06-01' && l.quantity === 3)!
    expect(quadLine.amountHalalas).toBe(3 * quadLine.unitAmountHalalas)
    expect((await db.select().from(bookingChange).where(eq(bookingChange.kind, 'GUEST_ADDED')))[0]).toMatchObject({ actorKind: 'agency', afterData: { totalCount: 4 } })
  })

  it('a family fills its own room first too, and is not charged for the room again', async () => {
    const env = await setup()
    const customer = await makeCustomer(db, env.scope)
    const family = await makeBooking(db, env.scope, env.hotel.id, { bookerType: 'INDIVIDUAL', customerId: customer.id, bookingType: 'FAMILY', maleCount: 0, totalCount: 3, checkIn: '2027-06-01', checkOut: '2027-06-04' })
    const quad = await makeBookingRoom(db, env.scope, family, env.rooms['102']!, { occupancy: 'FAMILY' })
    for (const n of [1, 2, 3]) await makeStay(db, env.scope, family.id, (await makeGuest(db, env.scope, family.id, n, { gender: null })).id, quad.id, family.checkIn, family.checkOut)

    const counts = guestAdditionSearchSchema.parse({ totalCount: 1 })
    const { options } = await searchGuestAdditions(env.manager, family.id, counts)
    expect(options[0]).toMatchObject({ newRooms: 0, totalHalalas: 0, rooms: [{ roomId: env.rooms['102'], seats: 1, existing: true }] })
    await addGuests(env.manager, family.id, addGuestsSchema.parse({ ...counts, rooms: asChosen(options[0]!.rooms) }))
    expect(await bookingRow(family.id)).toMatchObject({ totalCount: 4 })
    expect(await db.select().from(bookingRoom).where(eq(bookingRoom.bookingId, family.id))).toHaveLength(1)
    expect(await db.select().from(bookingPriceLine).where(eq(bookingPriceLine.bookingId, family.id))).toEqual([])
  })

  it('more than its own rooms hold: a new room joins the booking; infants alone just join its rooms', async () => {
    const env = await setup()
    const counts = guestAdditionSearchSchema.parse({ maleCount: 4, totalCount: 4 })
    const { options } = await searchAgencyGuestAdditions(env.agency, env.bookingId, counts)
    const chosen = options[0]!.rooms
    expect(chosen.filter(r => r.existing).map(r => r.roomId)).toEqual([env.rooms['101']])
    expect(options[0]!.newRooms).toBeGreaterThan(0)
    await addAgencyGuests(env.agency, env.bookingId, addGuestsSchema.parse({ ...counts, rooms: asChosen(chosen) }))
    expect(await bookingRow(env.bookingId)).toMatchObject({ maleCount: 6, totalCount: 7 })
    expect((await db.select().from(bookingRoom).where(eq(bookingRoom.bookingId, env.bookingId))).length).toBe(1 + chosen.length)

    await addGuests(env.manager, env.bookingId, addGuestsSchema.parse({ infantCount: 1 }))
    expect(await bookingRow(env.bookingId)).toMatchObject({ infantCount: 1, totalCount: 7 })
    expect((await listAgencyGuests(env.agency, env.bookingId)).at(-1)).toMatchObject({ ageGroup: 'INFANT', roomNumber: '201' }) // the children's (mother's) side
  })

  it('refuses: no rooms chosen for seated pilgrims, a wrong option, a wrong head count, another agency, a booking already started', async () => {
    const env = await setup()
    await expect(addAgencyGuests(env.agency, env.bookingId, addGuestsSchema.parse({ maleCount: 1, totalCount: 1 }))).rejects.toMatchObject({ code: 'ROOMS_REQUIRED', httpStatus: 422 })
    await expect(addAgencyGuests(env.agency, env.bookingId, addGuestsSchema.parse({ maleCount: 1, totalCount: 1, rooms: [{ roomId: env.rooms['201']!, occupancy: 'FEMALE', seats: 1 }] }))).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_OPTION|OPTION_UNAVAILABLE/) })
    await expect(addAgencyGuests(env.agency, env.bookingId, addGuestsSchema.parse({ femaleCount: 1, totalCount: 2 }))).rejects.toMatchObject({ code: 'INVALID_HEADCOUNT' })
    // Infants take no seat: rooms sent with them are refused (they would otherwise be claimed without a check or price).
    expect(addGuestsSchema.safeParse({ infantCount: 1, rooms: [{ roomId: env.rooms['103']!, occupancy: 'MALE', seats: 1 }] }).success).toBe(false)
    await expect(addAgencyGuests(env.agency, env.bookingId, { maleCount: 0, femaleCount: 0, childCount: 0, totalCount: 0, infantCount: 1, rooms: [{ roomId: env.rooms['103']!, occupancy: 'MALE', seats: 1, extraBeds: 0 }] })).rejects.toMatchObject({ code: 'ROOMS_NOT_ALLOWED', httpStatus: 422 })
    expect(await db.select().from(bookingRoom).where(and(eq(bookingRoom.bookingId, env.bookingId), eq(bookingRoom.roomId, env.rooms['103']!)))).toEqual([])
    const other = await agencyCtx(env.scope, (await makeAgency(db, env.scope)).id)
    await expect(searchAgencyGuestAdditions(other, env.bookingId, guestAdditionSearchSchema.parse({ maleCount: 1, totalCount: 1 }))).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' })
    await db.update(booking).set({ status: 'IN_HOUSE' }).where(eq(booking.id, env.bookingId))
    await expect(searchAgencyGuestAdditions(env.agency, env.bookingId, guestAdditionSearchSchema.parse({ maleCount: 1, totalCount: 1 }))).rejects.toMatchObject({ code: 'BOOKING_NOT_CHANGEABLE', httpStatus: 409 })
  })

  it('dates changed while it waited for the booking\'s lock: refused (search again), nothing added', async () => {
    const env = await setup()
    const counts = guestAdditionSearchSchema.parse({ maleCount: 1, totalCount: 1 })
    const { options } = await searchAgencyGuestAdditions(env.agency, env.bookingId, counts)
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let locked!: () => void
    const lockTaken = new Promise<void>((resolve) => { locked = resolve })
    // Another transaction holds the booking (as a date change does) and moves its check-out before letting go.
    const holder = client.begin(async (sql) => {
      await sql`select id from booking where id = ${env.bookingId} for update`
      locked()
      await released
      await sql`update booking set check_out = '2027-06-05' where id = ${env.bookingId}`
    })
    await lockTaken
    const adding = addAgencyGuests(env.agency, env.bookingId, addGuestsSchema.parse({ ...counts, rooms: asChosen(options[0]!.rooms) })).catch((error: unknown) => error)
    await vi.waitFor(async () => {
      const [row] = await client<Array<{ n: number }>>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
      if (!row || row.n < 1) throw new Error('the addition never waited on the booking\'s lock')
    }, { timeout: 5_000, interval: 20 })
    release()
    await holder
    expect(await adding).toMatchObject({ code: 'BOOKING_CHANGED', httpStatus: 409 })
    expect(await bookingRow(env.bookingId)).toMatchObject({ maleCount: 2, totalCount: 3, checkOut: '2027-06-05' })
  })
})
