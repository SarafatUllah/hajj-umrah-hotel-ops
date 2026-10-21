import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agencyUser, booking } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { confirmAgencyBooking, holdAgencyStay } from '../../../server/services/booking'
import { getRoomCalendar } from '../../../server/services/roomCalendarService'
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

/** One agency's confirmed stay in Quad 101 (June 1–4, 2027) and its held one in Quad 102 (June 2–5). */
async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, rooms } = await makeStayHotel(db, scope)
  const agencyRow = await makeAgency(db, scope)
  const agency = await agencyCtx(scope, agencyRow.id)
  const confirmed = await holdAgencyStay(agency, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 4, femaleCount: 0, totalCount: 4,
    rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 4 }],
  }))
  await confirmAgencyBooking(agency, confirmed.id)
  const held = await holdAgencyStay(agency, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-02', checkOut: '2027-06-05', maleCount: 2, femaleCount: 0, totalCount: 2,
    rooms: [{ roomId: rooms['102'], occupancy: 'MALE', seats: 2 }],
  }))
  const viewer = staff(scope, (await makeUser(db, scope)).id, ['room.view'])
  return { hotel, rooms, agencyName: agencyRow.name, confirmed, held, viewer }
}

const segmentsOf = (dto: Awaited<ReturnType<typeof getRoomCalendar>>, roomId: string) => dto.rooms.find(r => r.roomId === roomId)!.segments.map(s => `${s.from}..${s.to} ${s.status} [${s.bookingIds.join(',')}]`)

describe('bookings on the room calendar (UI-UX §19, §31.2)', () => {
  it('a confirmed stay shows booked and a hold held, each named in refs with its number, agency and stay', async () => {
    const env = await setup()
    const calendar = await getRoomCalendar(env.viewer, env.hotel.id, { from: '2027-05-31', to: '2027-06-05' })

    expect(segmentsOf(calendar, env.rooms['101']!)).toEqual(['2027-05-31..2027-05-31 AVAILABLE []', `2027-06-01..2027-06-03 BOOKED [${env.confirmed.id}]`, '2027-06-04..2027-06-05 AVAILABLE []'])
    expect(segmentsOf(calendar, env.rooms['102']!)).toEqual(['2027-05-31..2027-06-01 AVAILABLE []', `2027-06-02..2027-06-04 HELD [${env.held.id}]`, '2027-06-05..2027-06-05 AVAILABLE []'])
    expect(calendar.refs.bookings).toEqual({
      [env.confirmed.id]: { bookingNo: env.confirmed.bookingNo, agencyName: env.agencyName, checkIn: '2027-06-01', checkOut: '2027-06-04' },
      [env.held.id]: { bookingNo: env.held.bookingNo, agencyName: env.agencyName, checkIn: '2027-06-02', checkOut: '2027-06-05' },
    })
  })

  it('a stay in the house shows occupied; a cancelled or lapsed booking shows nothing; the status filter finds them', async () => {
    const env = await setup()
    await db.update(booking).set({ status: 'IN_HOUSE' }).where(eq(booking.id, env.confirmed.id))
    await db.update(booking).set({ holdExpiresAt: new Date('2020-01-01T00:00:00Z') }).where(eq(booking.id, env.held.id))
    const calendar = await getRoomCalendar(env.viewer, env.hotel.id, { from: '2027-06-01', to: '2027-06-03' })
    expect(segmentsOf(calendar, env.rooms['101']!)).toEqual([`2027-06-01..2027-06-03 OCCUPIED [${env.confirmed.id}]`])
    expect(segmentsOf(calendar, env.rooms['102']!)).toEqual(['2027-06-01..2027-06-03 AVAILABLE []'])
    expect(Object.keys(calendar.refs.bookings)).toEqual([env.confirmed.id])

    const occupied = await getRoomCalendar(env.viewer, env.hotel.id, { from: '2027-06-01', to: '2027-06-03', status: ['OCCUPIED'] })
    expect(occupied.rooms.map(r => r.roomId)).toEqual([env.rooms['101']])
  })
})
