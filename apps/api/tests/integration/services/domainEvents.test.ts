import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agencyUser, bookingGuest, eventReceipt, pilgrim } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import type { DomainEvent } from '@hajj/contracts/events/domainEvents'
import { holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import { setEventSink } from '../../../server/events/bus'
import { wireDomainEvents } from '../../../server/jobs/eventJobs'
import { setSmsSenderForTests, type SmsMessage } from '../../../server/notifications/sms'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { confirmAgencyBooking, confirmBooking, holdAgencyStay, listAgencyGuests, notifyBookingConfirmed, readAgencyGuests, readBookingSlots, saveAgencyGuest } from '../../../server/services/booking'
import { handleEventOnce, pruneEventReceipts } from '../../../server/services/eventHandling'
import { makeAgency, makeBooking, makeBookingRoom, makeCustomer } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const NOW = new Date('2027-05-01T10:00:00Z')
const HANDLER = 'booking.confirmed:notify-booker'
let events: DomainEvent[] = []
let sms: SmsMessage[] = []

beforeEach(() => {
  events = []
  sms = []
  setEventSink(async (_tx, event) => { events.push(event) })
  setSmsSenderForTests({ send: async (message) => { sms.push(message) } })
})

afterEach(async () => {
  setEventSink(null)
  setSmsSenderForTests(null)
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

const groupStay = (hotelId: string, rooms: Record<string, string>) => holdRequestSchema.parse({
  hotelId, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, femaleCount: 1, totalCount: 3,
  rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 2 }, { roomId: rooms['201'], occupancy: 'FEMALE', seats: 1 }],
})

describe('domain events (Phase 2a ticket 7)', () => {
  it('staff confirming a customer\'s request publishes booking.confirmed; its handler texts the customer exactly once', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, rooms } = await makeStayHotel(db, scope)
    const customer = await makeCustomer(db, scope)
    const request = await makeBooking(db, scope, hotel.id, { bookerType: 'INDIVIDUAL', customerId: customer.id, bookingType: 'FAMILY', maleCount: 0, totalCount: 2, status: 'REQUESTED', checkIn: '2027-06-01', checkOut: '2027-06-04' })
    await makeBookingRoom(db, scope, request, rooms['201']!, { occupancy: 'FAMILY' })
    const manager = staff(scope, (await makeUser(db, scope)).id, ['booking.view', 'booking.create'])

    await confirmBooking(manager, request.id)
    expect(events).toMatchObject([{ type: 'booking.confirmed', version: 1, organizationId: scope.organizationId, payload: { bookingId: request.id, bookerType: 'INDIVIDUAL', customerId: customer.id, confirmedBy: 'staff' } }])

    await handleEventOnce(db, events[0]!, HANDLER, notifyBookingConfirmed)
    await handleEventOnce(db, events[0]!, HANDLER, notifyBookingConfirmed) // a duplicated delivery
    expect(sms).toEqual([{ to: customer.phone, text: `Booking ${request.bookingNo} at ${hotel.name} is confirmed: 2027-06-01 to 2027-06-04.` }])
  })

  it('a booker that confirmed itself is not texted; a handler that fails gives its claim back for the retry', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, rooms } = await makeStayHotel(db, scope)
    const agency = await agencyCtx(scope, (await makeAgency(db, scope)).id)
    const held = await holdAgencyStay(agency, groupStay(hotel.id, rooms))
    await confirmAgencyBooking(agency, held.id)
    expect(events[0]!.payload).toMatchObject({ confirmedBy: 'agency', bookerType: 'AGENCY' })
    await handleEventOnce(db, events[0]!, HANDLER, notifyBookingConfirmed)
    expect(sms).toEqual([])

    let runs = 0
    await expect(handleEventOnce(db, events[0]!, 'test:flaky', async () => { runs += 1; throw new Error('provider down') })).rejects.toThrow('provider down')
    await handleEventOnce(db, events[0]!, 'test:flaky', async () => { runs += 1 })
    await handleEventOnce(db, events[0]!, 'test:flaky', async () => { runs += 1 })
    expect(runs).toBe(2)
  })

  it('without a job runtime — never wired, or stopped — the event is dropped (logged) and the change still commits', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, rooms } = await makeStayHotel(db, scope)
    const agency = await agencyCtx(scope, (await makeAgency(db, scope)).id)
    setEventSink(null)
    const first = await holdAgencyStay(agency, groupStay(hotel.id, rooms))
    expect(await confirmAgencyBooking(agency, first.id)).toMatchObject({ status: 'CONFIRMED' })
    // Wired, but this test process never started the runtime (as in a process that is stopping).
    wireDomainEvents()
    const another = await agencyCtx(scope, (await makeAgency(db, scope)).id)
    const second = await holdAgencyStay(another, groupStay(hotel.id, { '101': rooms['102']!, '201': rooms['202']! }))
    expect(await confirmAgencyBooking(another, second.id)).toMatchObject({ status: 'CONFIRMED' })
  })

  it('receipts are pruned after 30 days', async () => {
    const { scope } = await makeOrg(db)
    await db.insert(eventReceipt).values([
      { organizationId: scope.organizationId, eventId: '00000000-0000-4000-8000-000000000001', handler: 'h', processedAt: new Date('2027-03-01T00:00:00Z') },
      { organizationId: scope.organizationId, eventId: '00000000-0000-4000-8000-000000000002', handler: 'h', processedAt: new Date('2027-04-20T00:00:00Z') },
    ])
    expect(await pruneEventReceipts(db, [scope], NOW)).toBe(1)
    expect(await db.select().from(eventReceipt)).toHaveLength(1)
  })
})

describe('booking public read API (Phase 2a ticket 8)', () => {
  it('slots without personal data; an agency\'s own pilgrims from its copies, never the staff master', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, rooms } = await makeStayHotel(db, scope)
    const agency = await agencyCtx(scope, (await makeAgency(db, scope)).id)
    const held = await holdAgencyStay(agency, groupStay(hotel.id, rooms))
    const [man] = await listAgencyGuests(agency, held.id)
    await saveAgencyGuest(agency, held.id, man!.id, guestDetailsSchema.parse({ fullName: 'Md. Karim', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-01-01', passportNo: 'A1234567', passportExpiry: '2032-01-01' }))
    // Staff keep a master record under another spelling; the agency-facing read must not show it.
    const [master] = await db.insert(pilgrim).values({ organizationId: scope.organizationId, fullName: 'MOHAMMAD KARIM', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-01-01', passportNoEncrypted: 'x', passportLookup: 'f'.repeat(64), passportExpiry: '2032-01-01' }).returning()
    await db.update(bookingGuest).set({ pilgrimId: master!.id }).where(eq(bookingGuest.id, man!.id))

    const view = await readBookingSlots(db, scope, held.id, NOW)
    expect(view).toMatchObject({ bookingId: held.id, status: 'HELD', counts: { men: 2, women: 1, total: 3 }, slots: [{ slotNo: 1, gender: 'MALE', ageGroup: 'ADULT', status: 'READY' }, { slotNo: 2 }, { slotNo: 3, gender: 'FEMALE' }] })
    expect(JSON.stringify(view)).not.toMatch(/Karim|KARIM|A1234567/)
    expect(await readBookingSlots(db, scope, '00000000-0000-4000-8000-000000000000', NOW)).toBeNull()

    const guests = await readAgencyGuests(agency, held.id)
    expect(guests[0]).toEqual({ guestId: man!.id, slotNo: 1, fullName: 'Md. Karim', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-01-01' })
    expect(JSON.stringify(guests)).not.toMatch(/MOHAMMAD|A1234567/)
    const other = await agencyCtx(scope, (await makeAgency(db, scope)).id)
    await expect(readAgencyGuests(other, held.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' })
  })
})
