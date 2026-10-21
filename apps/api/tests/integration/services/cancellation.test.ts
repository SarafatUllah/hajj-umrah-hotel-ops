import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agency as agencyTable, agencyUser, booking, bookingChange, hotelTask, priceQuote } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import type { DomainEvent } from '@hajj/contracts/events/domainEvents'
import { holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { setEventSink } from '../../../server/events/bus'
import { setSmsSenderForTests, type SmsMessage } from '../../../server/notifications/sms'
import { bookingRepos } from '../../../server/repositories'
import { PriceQuoteRepository } from '../../../server/repositories/booking'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { cancelBooking, confirmAgencyBooking, holdAgencyStay, notifyBookingCancelled, releaseAgencyHold } from '../../../server/services/booking'
import { handleEventOnce } from '../../../server/services/eventHandling'
import { makeAgency, makeBooking, makeBookingRoom, makeCustomer } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const NOW = new Date('2027-05-01T10:00:00Z')
const STAY = { from: '2027-06-01', to: '2027-06-03' }
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

async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, hotelScope, rooms } = await makeStayHotel(db, scope)
  const agencyRow = await makeAgency(db, scope)
  const agency = await agencyCtx(scope, agencyRow.id)
  const held = await holdAgencyStay(agency, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, femaleCount: 1, totalCount: 3,
    rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 2 }, { roomId: rooms['201'], occupancy: 'FEMALE', seats: 1 }],
  }))
  const manager = staff(scope, (await makeUser(db, scope)).id, ['booking.view', 'booking.cancel'])
  const seats = () => bookingRepos(db, hotelScope).inventory.seatsUsed([rooms['101']!, rooms['201']!], STAY)
  return { scope, hotel, rooms, agencyRow, agency, bookingId: held.id, manager, seats }
}

describe('cancellation (v7 §12)', () => {
  it('staff cancel a confirmed booking with a reason: seats free at once, open tasks cancelled, logged, the booker told', async () => {
    const env = await setup()
    await confirmAgencyBooking(env.agency, env.bookingId)
    await db.insert(hotelTask).values({ organizationId: env.scope.organizationId, hotelId: env.hotel.id, roomId: env.rooms['101']!, bookingId: env.bookingId, kind: 'EXTRA_BED_SETUP', dueDate: '2027-06-01' })
    expect((await env.seats()).length).toBeGreaterThan(0)
    events = []

    expect(await cancelBooking(env.manager, env.bookingId, { reason: 'Group did not get visas' })).toMatchObject({ status: 'CANCELLED' })
    expect(await env.seats()).toEqual([])
    expect(await db.select().from(hotelTask)).toMatchObject([{ status: 'CANCELLED' }])
    expect((await db.select().from(booking).where(eq(booking.id, env.bookingId)))[0]).toMatchObject({ cancelReason: 'Group did not get visas', cancelledBy: env.manager.identity.userId, cancelledAt: expect.any(Date) })
    const change = (await db.select().from(bookingChange).where(eq(bookingChange.kind, 'CANCELLED')))[0]!
    expect(change).toMatchObject({ actorKind: 'staff', beforeData: { status: 'CONFIRMED' } })
    expect(JSON.stringify(change)).not.toContain('visas') // the reason never reaches the append-only log
    expect(events).toMatchObject([{ type: 'booking.cancelled', payload: { bookingId: env.bookingId, previousStatus: 'CONFIRMED', cancelledBy: 'staff' } }])

    await handleEventOnce(db, events[0]!, 'booking.cancelled:notify-booker', notifyBookingCancelled)
    const [agencyRow] = await db.select().from(agencyTable).where(eq(agencyTable.id, env.agencyRow.id))
    expect(sms).toMatchObject([{ to: agencyRow!.phone, text: expect.stringContaining('was cancelled by the hotel') }])

    // A second cancel answers it unchanged and publishes nothing.
    expect(await cancelBooking(env.manager, env.bookingId, { reason: 'again' })).toMatchObject({ status: 'CANCELLED' })
    expect(events).toHaveLength(1)
  })

  it('refuses what cannot be cancelled: pilgrims in the house, a completed booking; needs booking.cancel', async () => {
    const env = await setup()
    await confirmAgencyBooking(env.agency, env.bookingId)
    const seller = staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view', 'booking.edit'])
    await expect(cancelBooking(seller, env.bookingId, { reason: 'no' })).rejects.toMatchObject({ httpStatus: 403 })
    await db.update(booking).set({ status: 'IN_HOUSE' }).where(eq(booking.id, env.bookingId))
    await expect(cancelBooking(env.manager, env.bookingId, { reason: 'too late' })).rejects.toMatchObject({ code: 'BOOKING_IN_HOUSE', httpStatus: 409 })
    await db.update(booking).set({ status: 'COMPLETED' }).where(eq(booking.id, env.bookingId))
    await expect(cancelBooking(env.manager, env.bookingId, { reason: 'too late' })).rejects.toMatchObject({ code: 'BOOKING_NOT_CANCELLABLE' })
  })

  it('a lapsed hold is already free: not cancellable; staff cancel a customer\'s request too', async () => {
    const env = await setup()
    await db.update(booking).set({ holdExpiresAt: new Date('2027-04-01T00:00:00Z') }).where(eq(booking.id, env.bookingId))
    await expect(cancelBooking(env.manager, env.bookingId, { reason: 'old' })).rejects.toMatchObject({ code: 'BOOKING_NOT_CANCELLABLE' })

    const customer = await makeCustomer(db, env.scope)
    const request = await makeBooking(db, env.scope, env.hotel.id, { bookerType: 'INDIVIDUAL', customerId: customer.id, bookingType: 'FAMILY', maleCount: 0, totalCount: 2, status: 'REQUESTED', checkIn: '2027-06-01', checkOut: '2027-06-04' })
    await makeBookingRoom(db, env.scope, request, env.rooms['202']!, { occupancy: 'FAMILY' })
    expect(await cancelBooking(env.manager, request.id, { reason: 'No answer from the guest' })).toMatchObject({ status: 'CANCELLED' })
    expect(events.at(-1)).toMatchObject({ payload: { previousStatus: 'REQUESTED', bookerType: 'INDIVIDUAL' } })
  })

  it('an agency lets go of its own hold (not texted); a confirmed booking is the hotel\'s to cancel; another agency\'s is not found', async () => {
    const env = await setup()
    // The quote a cancelled hold used is spent (it was never reusable; now it also says so).
    const quote = await new PriceQuoteRepository(db, env.scope).insert({ refNo: 'Q-2027-0001', agencyId: env.agencyRow.id, hotelId: env.hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, femaleCount: 1, totalCount: 3, status: 'OFFERED', amountHalalas: 30000, unit: 'PER_PERSON_NIGHT', vatIncluded: true, validUntil: new Date('2099-01-01T00:00:00Z'), offeredAt: NOW })
    await db.update(booking).set({ quoteId: quote.id, priceSource: 'QUOTE' }).where(eq(booking.id, env.bookingId))
    expect(await releaseAgencyHold(env.agency, env.bookingId)).toMatchObject({ status: 'CANCELLED' })
    expect(await env.seats()).toEqual([])
    expect((await db.select().from(priceQuote).where(eq(priceQuote.id, quote.id)))[0]!.status).toBe('ACCEPTED')
    expect(events).toMatchObject([{ payload: { cancelledBy: 'agency', previousStatus: 'HELD' } }])
    await handleEventOnce(db, events[0]!, 'booking.cancelled:notify-booker', notifyBookingCancelled)
    expect(sms).toEqual([])

    const second = await holdAgencyStay(env.agency, holdRequestSchema.parse({
      hotelId: env.hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, totalCount: 2,
      rooms: [{ roomId: env.rooms['101'], occupancy: 'MALE', seats: 2 }],
    }))
    await confirmAgencyBooking(env.agency, second.id)
    await expect(releaseAgencyHold(env.agency, second.id)).rejects.toMatchObject({ code: 'CANCEL_BY_HOTEL', httpStatus: 409 })
    const other = await agencyCtx(env.scope, (await makeAgency(db, env.scope)).id)
    await expect(releaseAgencyHold(other, second.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', httpStatus: 404 })
  })
})
