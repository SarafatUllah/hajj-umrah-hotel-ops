import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { booking, bookingChange } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { customerRequestSchema, customerStaySearchSchema } from '@hajj/contracts/schemas/booking'
import type { AuthContext } from '../../../server/security/authContext'
import { type CustomerContext, resolveCustomerContext } from '../../../server/security/customerContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { confirmBooking, customerBookingReceipt, getCustomerBooking, listCustomerBookings, listCustomerGuests, requestCustomerStay, saveCustomerGuest, searchCustomerStay, withdrawCustomerRequest } from '../../../server/services/booking'
import { listPublicHotels } from '../../../server/services/hotelService'
import { makeCustomer } from '../../support/bookingFixtures'
import { makeHotel, makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const NOW = new Date('2027-05-01T10:00:00Z')
const LEAD = { fullName: 'Yusuf Rahman', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-03-01', passportNo: 'BG1234567', passportExpiry: '2030-01-01' }
const FAMILY = { bookingType: 'FAMILY', checkIn: '2027-06-01', checkOut: '2027-06-04', totalCount: 3 }

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

async function customerCtx(scope: OrganizationScope): Promise<CustomerContext> {
  const row = await makeCustomer(db, scope)
  return (await resolveCustomerContext(db, { customerId: row.id, organizationId: scope.organizationId }, () => NOW))!
}

function staff(scope: OrganizationScope, userId: string, permissions: Permission[]): AuthContext {
  return { identity: { userId, organizationId: scope.organizationId, email: 's@example.test', fullName: 'Staff' }, authz: { permissions: new Set(permissions), allHotels: true, hotelIds: new Set() }, scope, db, now: () => NOW }
}

async function setup() {
  const { scope, organization } = await makeOrg(db)
  const { hotel, rooms } = await makeStayHotel(db, scope)
  const customer = await customerCtx(scope)
  const search = () => searchCustomerStay(customer, customerStaySearchSchema.parse({ hotelId: hotel.id, ...FAMILY }))
  const request = async (ctx = customer, lead: object = LEAD) => {
    const { options } = await searchCustomerStay(ctx, customerStaySearchSchema.parse({ hotelId: hotel.id, ...FAMILY }))
    const chosen = options[0]!.rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds }))
    return requestCustomerStay(ctx, customerRequestSchema.parse({ hotelId: hotel.id, ...FAMILY, rooms: chosen, lead }))
  }
  return { scope, organization, hotel, rooms, customer, search, request }
}

describe('public booking flow (v7 §6, §10)', () => {
  it('a customer searches at the public price and requests with the lead pilgrim\'s passport; the hotel confirms; the receipt follows', async () => {
    const env = await setup()
    expect((await env.search()).options[0]).toMatchObject({ priceSource: 'PUBLIC' })

    const requested = await env.request()
    expect(requested).toMatchObject({ status: 'REQUESTED', bookerType: 'INDIVIDUAL', customerId: env.customer.scope.customerId, priceSource: 'PUBLIC', guests: { total: 3, withDetails: 1 } })
    const guests = await listCustomerGuests(env.customer, requested.id)
    expect(guests[0]).toMatchObject({ status: 'READY', details: { fullName: 'Yusuf Rahman', nationality: 'BGD', dateOfBirth: null, passportExpiry: null, passportNo: expect.not.stringContaining('1234567'), complete: true } })
    // A complete slot is the hotel's to correct (D-P2-27b); an empty one the customer fills.
    await expect(saveCustomerGuest(env.customer, requested.id, guests[0]!.id, { ...LEAD, fullName: 'Someone Else' })).rejects.toMatchObject({ code: 'GUEST_LOCKED', httpStatus: 409 })
    expect(await db.select().from(bookingChange).where(eq(bookingChange.bookingId, requested.id))).toMatchObject([
      { kind: 'CREATED', actorKind: 'customer' },
      { kind: 'DETAILS_UPDATED', actorKind: 'customer' },
    ])
    await expect(customerBookingReceipt(env.customer, requested.id)).rejects.toMatchObject({ code: 'NOT_CONFIRMED', httpStatus: 409 })

    await saveCustomerGuest(env.customer, requested.id, guests[1]!.id, { fullName: 'Maryam Rahman' })
    await confirmBooking(staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view', 'booking.create']), requested.id)
    expect(await getCustomerBooking(env.customer, requested.id)).toMatchObject({ status: 'CONFIRMED', receiptToken: expect.any(String) })
    expect(await customerBookingReceipt(env.customer, requested.id)).toMatchObject({ bookingNo: requested.bookingNo, counts: { total: 3 } })
    expect(await listCustomerBookings(env.customer, { page: 1, pageSize: 20 })).toMatchObject({ total: 1, items: [{ id: requested.id, status: 'CONFIRMED' }] })
  })

  it('one open request at a time; withdrawing it frees the place (and its rooms); a confirmed booking is the hotel\'s to cancel', async () => {
    const env = await setup()
    const first = await env.request()
    await expect(env.request()).rejects.toMatchObject({ code: 'TOO_MANY_OPEN_REQUESTS', httpStatus: 409 })
    expect(await withdrawCustomerRequest(env.customer, first.id)).toMatchObject({ status: 'CANCELLED' })
    const second = await env.request()
    expect(second).toMatchObject({ status: 'REQUESTED' })

    await confirmBooking(staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view', 'booking.create']), second.id)
    await expect(withdrawCustomerRequest(env.customer, second.id)).rejects.toMatchObject({ code: 'CANCEL_BY_HOTEL', httpStatus: 409 })
  })

  it('no request without a fitting lead passport: the whole request is refused and nothing stays held', async () => {
    const env = await setup()
    await expect(env.request(env.customer, { ...LEAD, dateOfBirth: '2020-01-01' })).rejects.toMatchObject({ code: 'LEAD_NOT_ADULT', httpStatus: 422 })
    // Refused before any lock: an implausible passport (an expiry decades away); an expiring one is only a warning.
    await expect(env.request(env.customer, { ...LEAD, passportExpiry: '2060-01-01' })).rejects.toMatchObject({ code: 'GUEST_DETAILS_REJECTED' })
    // Two men: a woman's passport fits no slot — refused after the hold was written, which rolls back with it.
    const men = { hotelId: env.hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, totalCount: 2 }
    const { options } = await searchCustomerStay(env.customer, customerStaySearchSchema.parse(men))
    const rooms = options[0]!.rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds }))
    await expect(requestCustomerStay(env.customer, customerRequestSchema.parse({ ...men, rooms, lead: { ...LEAD, fullName: 'Amina Rahman', gender: 'FEMALE' } }))).rejects.toMatchObject({ code: 'LEAD_DOES_NOT_FIT', httpStatus: 422 })
    expect(customerRequestSchema.safeParse({ hotelId: env.hotel.id, ...FAMILY, rooms: [{ roomId: env.rooms['101'], occupancy: 'FAMILY', seats: 3 }], lead: { fullName: 'No Passport' } }).success).toBe(false)
    expect(await db.select().from(booking)).toEqual([])
  })

  it('a customer reaches only their own bookings', async () => {
    const env = await setup()
    const mine = await env.request()
    const other = await customerCtx(env.scope)
    await expect(getCustomerBooking(other, mine.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', httpStatus: 404 })
    await expect(listCustomerGuests(other, mine.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' })
    await expect(withdrawCustomerRequest(other, mine.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' })
    expect(await listCustomerBookings(other, { page: 1, pageSize: 20 })).toMatchObject({ total: 0, items: [] })
  })

  it('the public hotel list shows the organization\'s active hotels only, nothing internal', async () => {
    const env = await setup()
    await makeHotel(db, env.scope, { status: 'INACTIVE' })
    const hotels = await listPublicHotels(db, env.organization.slug, { clientIp: '203.0.113.9', now: NOW })
    expect(hotels).toEqual([{ id: env.hotel.id, name: env.hotel.name, city: env.hotel.city, country: env.hotel.country, address: env.hotel.address }])
    await expect(listPublicHotels(db, 'no-such-org', { clientIp: '203.0.113.9', now: NOW })).rejects.toMatchObject({ code: 'ORGANIZATION_NOT_FOUND', httpStatus: 404 })
  })
})
