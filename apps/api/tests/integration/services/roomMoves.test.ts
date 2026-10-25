import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { agencyUser, booking, bookingChange, bookingRoom, guestStay } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { addGuestsSchema, guestAdditionSearchSchema, holdRequestSchema, moveGuestsSchema } from '@hajj/contracts/schemas/booking'
import { bookingRepos } from '../../../server/repositories'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { addAgencyGuests, confirmAgencyBooking, holdAgencyStay, listAgencyGuests, moveGuests, searchAgencyGuestAdditions } from '../../../server/services/booking'
import { makeAgency } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const BOOKED_AT = new Date('2027-05-01T10:00:00Z')
const SECOND_NIGHT = new Date('2027-06-02T09:00:00Z')
const STAY = { from: '2027-06-01', to: '2027-06-03' }

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

/** A confirmed GROUP, June 1–4: two men in Quad 101, a woman in Double 201. */
async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, hotelScope, rooms } = await makeStayHotel(db, scope)
  const agency = await agencyCtx(scope, (await makeAgency(db, scope)).id)
  const held = await holdAgencyStay(agency, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, femaleCount: 1, totalCount: 3,
    rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 2 }, { roomId: rooms['201'], occupancy: 'FEMALE', seats: 1 }],
  }))
  await confirmAgencyBooking(agency, held.id)
  const [man1, man2, woman] = await listAgencyGuests(agency, held.id)
  const userId = (await makeUser(db, scope)).id
  const manager = (now: Date) => staff(scope, userId, ['booking.view', 'booking.edit'], now)
  const seats = (roomId: string) => bookingRepos(db, hotelScope).inventory.seatsUsed([roomId], STAY)
  return { scope, hotel, rooms, agency, bookingId: held.id, man1: man1!.id, man2: man2!.id, woman: woman!.id, manager, seats }
}

const claimsOf = (bookingId: string) => db.select().from(bookingRoom).where(eq(bookingRoom.bookingId, bookingId)).orderBy(asc(bookingRoom.checkIn))
const staysOf = (guestId: string) => db.select().from(guestStay).where(eq(guestStay.bookingGuestId, guestId)).orderBy(asc(guestStay.checkIn))

describe('room move (v7 §12)', () => {
  it('before the stay begins the whole stay moves; the room left empty is let go', async () => {
    const env = await setup()
    await moveGuests(env.manager(BOOKED_AT), env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1, env.man2], roomId: env.rooms['103'] }))
    expect(await env.seats(env.rooms['101']!)).toEqual([])
    expect(await env.seats(env.rooms['103']!)).toMatchObject([{ seatsUsed: 2 }, { seatsUsed: 2 }, { seatsUsed: 2 }])
    const claims = await claimsOf(env.bookingId)
    expect(claims.find(c => c.roomId === env.rooms['101'])).toMatchObject({ status: 'RELEASED' })
    expect(claims.find(c => c.roomId === env.rooms['103'])).toMatchObject({ status: 'CONFIRMED', occupancy: 'MALE', checkIn: '2027-06-01', checkOut: '2027-06-04', ownerAgencyId: env.agency.scope.agencyId })
    expect((await listAgencyGuests(env.agency, env.bookingId))[0]).toMatchObject({ roomNumber: '103' })
    expect(await db.select().from(bookingChange).where(eq(bookingChange.kind, 'ROOM_MOVED'))).toMatchObject([{ actorKind: 'staff', afterData: { from: '2027-06-01', slotNos: [1, 2] } }])
  })

  it('mid-stay the stays split at today: the nights already slept stay where they were', async () => {
    const env = await setup()
    await moveGuests(env.manager(SECOND_NIGHT), env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1], roomId: env.rooms['102'] }))
    expect(await staysOf(env.man1)).toMatchObject([{ checkIn: '2027-06-01', checkOut: '2027-06-02' }, { checkIn: '2027-06-02', checkOut: '2027-06-04' }])
    expect(await env.seats(env.rooms['101']!)).toMatchObject([{ night: '2027-06-01', seatsUsed: 2 }, { night: '2027-06-02', seatsUsed: 1 }, { night: '2027-06-03', seatsUsed: 1 }])

    await moveGuests(env.manager(SECOND_NIGHT), env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man2], roomId: env.rooms['102'] }))
    expect((await claimsOf(env.bookingId)).find(c => c.roomId === env.rooms['101'])).toMatchObject({ status: 'CONFIRMED', checkIn: '2027-06-01', checkOut: '2027-06-02' })
    expect(await env.seats(env.rooms['102']!)).toMatchObject([{ night: '2027-06-02', seatsUsed: 2 }, { night: '2027-06-03', seatsUsed: 2 }])
  })

  it('a claim of the other side that ends on the move day is not stretched: the room gets a new claim of the movers\' side', async () => {
    const env = await setup()
    await moveGuests(env.manager(SECOND_NIGHT), env.bookingId, moveGuestsSchema.parse({ guestIds: [env.woman], roomId: env.rooms['202'] }))
    await moveGuests(env.manager(SECOND_NIGHT), env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1], roomId: env.rooms['201'] }))
    const upstairs = (await claimsOf(env.bookingId)).filter(c => c.roomId === env.rooms['201'])
    expect(upstairs).toMatchObject([
      { occupancy: 'FEMALE', status: 'CONFIRMED', checkIn: '2027-06-01', checkOut: '2027-06-02' },
      { occupancy: 'MALE', status: 'CONFIRMED', checkIn: '2027-06-02', checkOut: '2027-06-04' },
    ])
  })

  it('a man added after the men moved from the second night sleeps in one men\'s room for the whole stay; a partly claimed room is refused', async () => {
    const env = await setup()
    await moveGuests(env.manager(BOOKED_AT), env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1, env.man2], roomId: env.rooms['103'], from: '2027-06-02' }))
    // The men's two claims now each cover part of the stay: 101 the first night, 103 the rest.
    expect((await claimsOf(env.bookingId)).filter(c => c.occupancy === 'MALE')).toMatchObject([
      { roomId: env.rooms['101'], checkIn: '2027-06-01', checkOut: '2027-06-02' },
      { roomId: env.rooms['103'], checkIn: '2027-06-02', checkOut: '2027-06-04' },
    ])

    const counts = guestAdditionSearchSchema.parse({ maleCount: 1, totalCount: 1 })
    const { options } = await searchAgencyGuestAdditions(env.agency, env.bookingId, counts)
    const rooms = options[0]!.rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds }))
    await addAgencyGuests(env.agency, env.bookingId, addGuestsSchema.parse({ ...counts, rooms }))

    const added = (await listAgencyGuests(env.agency, env.bookingId)).at(-1)!
    const [stay] = await staysOf(added.id)
    expect(stay).toMatchObject({ checkIn: '2027-06-01', checkOut: '2027-06-04' })
    expect((await claimsOf(env.bookingId)).find(c => c.id === stay!.bookingRoomId)).toMatchObject({ occupancy: 'MALE', status: 'CONFIRMED', checkIn: '2027-06-01', checkOut: '2027-06-04' })

    // Chosen by hand, the room the men moved into (claimed for part of the stay only) is refused before anything is written.
    await expect(addAgencyGuests(env.agency, env.bookingId, addGuestsSchema.parse({ ...counts, rooms: [{ roomId: env.rooms['103']!, occupancy: 'MALE', seats: 1 }] })))
      .rejects.toMatchObject({ code: 'OPTION_UNAVAILABLE', httpStatus: 409 })
  })

  it('refuses when one of the chosen pilgrims has no night left to move', async () => {
    const env = await setup()
    await db.update(guestStay).set({ checkOut: '2027-06-02' }).where(eq(guestStay.bookingGuestId, env.man2))
    await expect(moveGuests(env.manager(SECOND_NIGHT), env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1, env.man2], roomId: env.rooms['103'] }))).rejects.toMatchObject({ code: 'GUEST_STATUS', httpStatus: 409 })
    expect(await staysOf(env.man1)).toMatchObject([{ checkIn: '2027-06-01', checkOut: '2027-06-04' }])
  })

  it('refuses the other side\'s room, both sides at once, another agency\'s room, a day outside the stay, no booking.edit, a cancelled booking', async () => {
    const env = await setup()
    const manager = env.manager(BOOKED_AT)
    await expect(moveGuests(manager, env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1], roomId: env.rooms['201'] }))).rejects.toMatchObject({ code: 'ROOM_TAKEN', httpStatus: 409 })
    await expect(moveGuests(manager, env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1, env.woman], roomId: env.rooms['103'] }))).rejects.toMatchObject({ code: 'MIXED_SIDES', httpStatus: 422 })
    const other = await agencyCtx(env.scope, (await makeAgency(db, env.scope)).id)
    await holdAgencyStay(other, holdRequestSchema.parse({ hotelId: env.hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 1, totalCount: 1, rooms: [{ roomId: env.rooms['104'], occupancy: 'MALE', seats: 1 }] }))
    await expect(moveGuests(manager, env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1], roomId: env.rooms['104'] }))).rejects.toMatchObject({ code: 'ROOM_TAKEN' })
    await expect(moveGuests(manager, env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1], roomId: env.rooms['103'], from: '2027-06-04' }))).rejects.toMatchObject({ code: 'MOVE_OUTSIDE_STAY' })
    const reception = staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view'], BOOKED_AT)
    await expect(moveGuests(reception, env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1], roomId: env.rooms['103'] }))).rejects.toMatchObject({ httpStatus: 403 })
    await db.update(booking).set({ status: 'CANCELLED', cancelledAt: BOOKED_AT }).where(eq(booking.id, env.bookingId))
    await expect(moveGuests(manager, env.bookingId, moveGuestsSchema.parse({ guestIds: [env.man1], roomId: env.rooms['103'] }))).rejects.toMatchObject({ code: 'BOOKING_NOT_CHANGEABLE' })
  })
})
