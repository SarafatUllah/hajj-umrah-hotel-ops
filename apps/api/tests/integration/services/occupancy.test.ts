import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { Database } from '@hajj/db/client'
import { agencyUser } from '@hajj/db/schema'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import { bookingRepos } from '../../../server/repositories'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { confirmAgencyBooking, getOccupancy, getOccupancyDay, holdAgencyStay, listAgencyGuests, saveAgencyGuest } from '../../../server/services/booking'
import { makeAgency } from '../../support/bookingFixtures'
import { makeOrg, makeRoomBlock, makeUser } from '../../support/fixtures'
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

/**
 * Quads 101–104 (floor 1), doubles 201–202 (floor 2). Agency A: confirmed GROUP June 1–4, two men in 101 (one
 * named), a woman in 201. Agency B: a hold (not confirmed) of two men in 102, June 2–5. Room 104 out of service.
 */
async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, hotelScope, rooms } = await makeStayHotel(db, scope)
  const agencyA = await makeAgency(db, scope)
  const agencyB = await makeAgency(db, scope)
  const a = await agencyCtx(scope, agencyA.id)
  const b = await agencyCtx(scope, agencyB.id)
  const confirmed = await holdAgencyStay(a, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, femaleCount: 1, totalCount: 3,
    rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 2 }, { roomId: rooms['201'], occupancy: 'FEMALE', seats: 1 }],
  }))
  await confirmAgencyBooking(a, confirmed.id)
  const [man] = await listAgencyGuests(a, confirmed.id)
  await saveAgencyGuest(a, confirmed.id, man!.id, guestDetailsSchema.parse({ fullName: 'Md. Karim', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-01-01', passportNo: 'A1234567', passportExpiry: '2032-01-01' }))
  const held = await holdAgencyStay(b, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-02', checkOut: '2027-06-05', maleCount: 2, totalCount: 2,
    rooms: [{ roomId: rooms['102'], occupancy: 'MALE', seats: 2 }],
  }))
  await makeRoomBlock(db, hotelScope, rooms['104']!, { kind: 'OUT_OF_SERVICE', startDate: '2027-06-01', endDate: '2027-06-10' })
  const manager = staff(scope, (await makeUser(db, scope)).id, ['occupancy.view', 'pilgrim.view'])
  return { scope, hotel, hotelScope, rooms, agencyA, agencyB, confirmed, held, manager }
}

describe('occupancy calendar (v7 §14)', () => {
  it('year and month views: per day the rooms by state, the seats, the fill, the confirmed arrivals and departures', async () => {
    const env = await setup()
    const view = await getOccupancy(env.manager, env.hotel.id, { from: '2027-06-01', to: '2027-06-05' })
    expect(view.days.map(d => d.date)).toEqual(['2027-06-01', '2027-06-02', '2027-06-03', '2027-06-04', '2027-06-05'])
    expect(view.days[0]).toMatchObject({
      rooms: { total: 6, full: 0, partial: 2, held: 0, empty: 3, blocked: 1 },
      seats: { total: 16, pilgrims: 3, held: 0, empty: 13 },
      occupancyPercent: 19,
      arrivals: 3,
      departures: 0,
    })
    expect(view.days[1]).toMatchObject({ rooms: { held: 1, empty: 2 }, seats: { pilgrims: 3, held: 2, empty: 11 }, occupancyPercent: 31, arrivals: 0 })
    expect(view.days[3]).toMatchObject({ rooms: { partial: 0, held: 1 }, seats: { pilgrims: 0, held: 2 }, departures: 3 })
    expect(view.days[4]).toMatchObject({ rooms: { held: 0, empty: 5, blocked: 1 }, seats: { pilgrims: 0, held: 0 } })
  })

  it('day view: floors of rooms with their bookings and pilgrims, the bookers of the day and what is still missing', async () => {
    const env = await setup()
    const day = await getOccupancyDay(env.manager, env.hotel.id, '2027-06-02')
    expect(day.floors.map(f => [f.level, f.rooms.map(r => [r.roomNumber, r.state])])).toEqual([
      [1, [['101', 'PARTIAL'], ['102', 'HELD'], ['103', 'EMPTY'], ['104', 'BLOCKED']]],
      [2, [['201', 'PARTIAL'], ['202', 'EMPTY']]],
    ])
    const room101 = day.floors[0]!.rooms[0]!
    expect(room101).toMatchObject({ capacity: 4, booked: 2, held: 0, claims: [{ bookingId: env.confirmed.id, status: 'CONFIRMED', booker: { agencyId: env.agencyA.id, name: env.agencyA.name }, occupancy: 'MALE', checkIn: '2027-06-01', checkOut: '2027-06-04' }] })
    expect(room101.claims[0]!.guests).toMatchObject([{ slotNo: 1, name: 'Md. Karim', detailsComplete: true }, { slotNo: 2, name: null, detailsComplete: false }])
    expect(day.floors[0]!.rooms[3]).toMatchObject({ inventoryStatus: 'OUT_OF_SERVICE', claims: [] })
    expect(day.summary).toMatchObject({
      rooms: { total: 6, partial: 2, held: 1, empty: 2, blocked: 1 },
      seats: { pilgrims: 3, held: 2 },
      arrivals: 0,
      detailsPending: 4,
      byBooker: [{ agencyId: env.agencyA.id, pilgrims: 3, rooms: 2 }, { agencyId: env.agencyB.id, pilgrims: 2, rooms: 1 }],
    })
  })

  it('names only with pilgrim.view; nothing without occupancy.view', async () => {
    const env = await setup()
    const reception = staff(env.scope, (await makeUser(db, env.scope)).id, ['occupancy.view'])
    const day = await getOccupancyDay(reception, env.hotel.id, '2027-06-02')
    expect(day.floors[0]!.rooms[0]!.claims[0]!.guests[0]).toMatchObject({ name: null, detailsComplete: true })
    const seller = staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view'])
    await expect(getOccupancy(seller, env.hotel.id, { from: '2027-06-01', to: '2027-06-02' })).rejects.toMatchObject({ httpStatus: 403 })
    await expect(getOccupancyDay(seller, env.hotel.id, '2027-06-02')).rejects.toMatchObject({ httpStatus: 403 })
  })

  it('the split seat count agrees with room_night_occupancy (the allocator\'s count)', async () => {
    const env = await setup()
    const range = { from: '2027-05-31', to: '2027-06-06' }
    const repos = bookingRepos(db, env.hotelScope)
    const split = (await repos.occupancy.nightlySeats(range)).map(s => ({ roomId: s.roomId, night: s.night, seatsUsed: s.booked + s.held }))
    const byKey = (rows: Array<{ roomId: string, night: string }>) => [...rows].sort((x, y) => `${x.roomId}${x.night}`.localeCompare(`${y.roomId}${y.night}`))
    expect(byKey(split)).toEqual(byKey(await repos.inventory.seatsUsed(null, range)))
    expect(split.length).toBeGreaterThan(0)
  })
})
