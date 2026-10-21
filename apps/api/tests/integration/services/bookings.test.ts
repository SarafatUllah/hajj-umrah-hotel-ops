import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { agencyUser, booking, bookingChange, hotel as hotelTable, priceQuote } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { holdRequestSchema, staffHoldRequestSchema, staffStaySearchSchema, type StaySearchInput, staySearchSchema } from '@hajj/contracts/schemas/booking'
import { bookingOrgRepos } from '../../../server/repositories'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { agencyBookingReceipt, bookingReceipt, confirmAgencyBooking, confirmBooking, expireLapsedBookings, getAgencyBooking, getBooking, holdAgencyStay, holdStayForAgency, listAgencyBookings, listBookings, placeHold, searchAgencyStay, searchStayForAgency, type StayOption } from '../../../server/services/booking'
import { makeAgency, makeCustomer } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const NOW = new Date('2027-05-01T10:00:00Z')
const LATER = new Date(NOW.getTime() + 11 * 60_000)
const page = { page: 1, pageSize: 20 }

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

function staff(scope: OrganizationScope, userId: string, permissions: Permission[], hotelIds: string[] = []): AuthContext {
  return { identity: { userId, organizationId: scope.organizationId, email: 's@example.test', fullName: 'Seller' }, authz: { permissions: new Set(permissions), allHotels: hotelIds.length === 0, hotelIds: new Set(hotelIds) }, scope, db, now: () => NOW }
}

async function agencyCtx(scope: OrganizationScope, agencyId: string, now = NOW): Promise<AgencyContext> {
  const [user] = await db.insert(agencyUser).values({ organizationId: scope.organizationId, agencyId, email: `u-${agencyId}-${now.getTime()}@example.test`, passwordHash: 'h', fullName: 'Agent' }).returning()
  return (await resolveAgencyContext(db, { agencyUserId: user!.id, organizationId: scope.organizationId, agencyId }, () => now))!
}

async function setup() {
  const { scope } = await makeOrg(db)
  const stayHotel = await makeStayHotel(db, scope)
  const agencyRow = await makeAgency(db, scope, { name: 'Al-Noor Travels' })
  const seller = await makeUser(db, scope)
  return { scope, ...stayHotel, agencyId: agencyRow.id, agency: await agencyCtx(scope, agencyRow.id), manager: staff(scope, seller.id, ['booking.view', 'booking.create']) }
}

const fourMen = (hotelId: string, extra: Partial<StaySearchInput> = {}) => staySearchSchema.parse({ hotelId, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 4, totalCount: 4, ...extra })
/** The rooms of a searched option as a hold request sends them back. */
const chosen = (option: StayOption) => option.rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds }))

describe('agency bookings (v7 §6–7, §10)', () => {
  it('search → hold → confirm → receipt: the agency\'s own booking, a receipt with the QR token, the change log', async () => {
    const env = await setup()
    const search = fourMen(env.hotel.id)
    const { options } = await searchAgencyStay(env.agency, search)
    const held = await holdAgencyStay(env.agency, holdRequestSchema.parse({ ...search, rooms: chosen(options[0]!) }))

    const detail = await getAgencyBooking(env.agency, held.id)
    expect(detail).toMatchObject({ status: 'HELD', bookingNo: 'B-2027-0001', totalHalalas: 3 * 4 * 35000, receiptToken: null, guests: { total: 4, withDetails: 0, checkedIn: 0 } })
    expect(detail.rooms).toEqual([expect.objectContaining({ roomNumber: '101', floorLevel: 1, occupancy: 'MALE', status: 'HELD' })])
    await expect(agencyBookingReceipt(env.agency, held.id)).rejects.toMatchObject({ code: 'NOT_CONFIRMED', httpStatus: 409 })

    const confirmed = await confirmAgencyBooking(env.agency, held.id)
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', holdExpiresAt: null, confirmedAt: NOW.toISOString() })
    expect(confirmed.receiptToken).toMatch(/^[\w-]{32}$/)
    const receipt = await agencyBookingReceipt(env.agency, held.id)
    expect(receipt).toMatchObject({ bookingNo: 'B-2027-0001', agencyName: 'Al-Noor Travels', nights: 3, counts: { men: 4, total: 4 }, totalHalalas: 420000, qrToken: confirmed.receiptToken })
    expect(receipt.lines).toEqual([{ kind: 'PERSON', roomTypeId: env.quad.id, roomTypeName: 'Quad', quantity: 4, unitAmountHalalas: 35000, nights: 3, amountHalalas: 420000, vatIncluded: true }])
    expect(receipt.rooms).toEqual([{ roomNumber: '101', floorLevel: 1, occupancy: 'MALE', extraBeds: 0 }])

    const changes = await db.select().from(bookingChange).where(eq(bookingChange.bookingId, held.id))
    expect(changes.map(c => [c.kind, c.actorKind, c.actorId])).toEqual([['CREATED', 'agency', env.agency.identity.agencyUserId], ['CONFIRMED', 'agency', env.agency.identity.agencyUserId]])
    expect((await listAgencyBookings(env.agency, page)).items).toEqual([expect.objectContaining({ id: held.id, status: 'CONFIRMED', totalHalalas: 420000 })])
    // A retry after a lost answer gets the same confirmed booking; nothing is logged twice.
    expect(await confirmAgencyBooking(env.agency, held.id)).toMatchObject({ status: 'CONFIRMED', receiptToken: confirmed.receiptToken })
    expect(await db.select().from(bookingChange).where(and(eq(bookingChange.bookingId, held.id), eq(bookingChange.kind, 'CONFIRMED')))).toHaveLength(1)
  })

  it('a hold that lapsed reads EXPIRED and cannot be confirmed; another agency\'s booking is not found', async () => {
    const env = await setup()
    const held = await holdAgencyStay(env.agency, holdRequestSchema.parse({ ...fourMen(env.hotel.id), rooms: [{ roomId: env.rooms['101'], occupancy: 'MALE', seats: 4 }] }))
    const later = await agencyCtx(env.scope, env.agencyId, LATER)
    expect((await getAgencyBooking(later, held.id)).status).toBe('EXPIRED')
    await expect(confirmAgencyBooking(later, held.id)).rejects.toMatchObject({ code: 'HOLD_EXPIRED', httpStatus: 409 })

    const other = await agencyCtx(env.scope, (await makeAgency(db, env.scope)).id)
    await expect(getAgencyBooking(other, held.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', httpStatus: 404 })
    await expect(confirmAgencyBooking(other, held.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' })
    await expect(agencyBookingReceipt(other, held.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' })
    // An agency's list ignores an agencyId it sends.
    expect((await listAgencyBookings(other, { ...page, agencyId: env.agencyId })).items).toEqual([])

    // Once the sweep has run, the answer is the same.
    await expireLapsedBookings(db, [env.scope], LATER)
    await expect(confirmAgencyBooking(later, held.id)).rejects.toMatchObject({ code: 'HOLD_EXPIRED' })
  })

  it('lists filter by the effective status, booking number and hotel, with the total count', async () => {
    const env = await setup()
    const hold = (roomNo: string) => holdAgencyStay(env.agency, holdRequestSchema.parse({ ...fourMen(env.hotel.id), rooms: [{ roomId: env.rooms[roomNo], occupancy: 'MALE', seats: 4 }] }))
    const first = await hold('101')
    const second = await hold('102')
    await confirmAgencyBooking(env.agency, second.id)
    const later = await agencyCtx(env.scope, env.agencyId, LATER)
    // The first hold has lapsed but is not swept yet: it lists as EXPIRED, not HELD.
    expect((await listAgencyBookings(later, { ...page, status: 'HELD' })).items).toEqual([])
    expect((await listAgencyBookings(later, { ...page, status: 'EXPIRED' })).items.map(b => [b.id, b.status])).toEqual([[first.id, 'EXPIRED']])
    expect((await listAgencyBookings(later, { ...page, status: 'CONFIRMED' })).items.map(b => b.id)).toEqual([second.id])
    expect(await listAgencyBookings(env.agency, { page: 1, pageSize: 1 })).toMatchObject({ total: 2, items: [{ id: second.id }] })
    expect((await listBookings(env.manager, { ...page, q: second.bookingNo })).items.map(b => b.id)).toEqual([second.id])
    expect((await listBookings(env.manager, { ...page, hotelId: '00000000-0000-4000-8000-000000000001' })).items).toEqual([])
  })

  it('confirming a booking made at a quote marks the quote ACCEPTED', async () => {
    const env = await setup()
    const quote = await bookingOrgRepos(db, env.scope).quotes.insert({ refNo: 'Q-2027-0001', agencyId: env.agencyId, hotelId: env.hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 4, femaleCount: 0, totalCount: 4, status: 'OFFERED', amountHalalas: 30000, unit: 'PER_PERSON_NIGHT', vatIncluded: true, validUntil: new Date('2027-05-03T10:00:00Z'), offeredAt: NOW })
    const held = await holdAgencyStay(env.agency, holdRequestSchema.parse({ ...fourMen(env.hotel.id, { quoteId: quote.id }), rooms: [{ roomId: env.rooms['101'], occupancy: 'MALE', seats: 4 }] }))
    await confirmAgencyBooking(env.agency, held.id)
    expect((await db.select().from(priceQuote).where(eq(priceQuote.id, quote.id)))[0]!.status).toBe('ACCEPTED')
  })

  it('a quote staff declined after the hold stays declined; the booking keeps its frozen price', async () => {
    const env = await setup()
    const quote = await bookingOrgRepos(db, env.scope).quotes.insert({ refNo: 'Q-2027-0002', agencyId: env.agencyId, hotelId: env.hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 4, femaleCount: 0, totalCount: 4, status: 'OFFERED', amountHalalas: 30000, unit: 'PER_PERSON_NIGHT', vatIncluded: true, validUntil: new Date('2027-05-03T10:00:00Z'), offeredAt: NOW })
    const held = await holdAgencyStay(env.agency, holdRequestSchema.parse({ ...fourMen(env.hotel.id, { quoteId: quote.id }), rooms: [{ roomId: env.rooms['101'], occupancy: 'MALE', seats: 4 }] }))
    await db.update(priceQuote).set({ status: 'DECLINED' }).where(eq(priceQuote.id, quote.id))
    expect((await confirmAgencyBooking(env.agency, held.id)).totalHalalas).toBe(3 * 4 * 30000)
    expect((await db.select().from(priceQuote).where(eq(priceQuote.id, quote.id)))[0]!.status).toBe('DECLINED')
  })
})

describe('staff bookings (v7 §6: on an agency\'s behalf)', () => {
  it('a seller searches and holds for an agency; the booking is the agency\'s, made by the seller; a manager confirms', async () => {
    const env = await setup()
    const body = { hotelId: env.hotel.id, agencyId: env.agencyId, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 4, totalCount: 4 }
    const { options } = await searchStayForAgency(env.manager, staffStaySearchSchema.parse(body))
    expect(options[0]!.priceSource).toBe('AGENCY_DEFAULT')
    const held = await holdStayForAgency(env.manager, staffHoldRequestSchema.parse({ ...body, rooms: chosen(options[0]!) }))
    expect((await db.select().from(booking).where(eq(booking.id, held.id)))[0]).toMatchObject({ agencyId: env.agencyId, createdByUserId: env.manager.identity.userId, status: 'HELD' })

    const confirmed = await confirmBooking(env.manager, held.id)
    expect(confirmed.status).toBe('CONFIRMED')
    expect((await db.select().from(booking).where(eq(booking.id, held.id)))[0]!.confirmedBy).toBe(env.manager.identity.userId)
    expect((await bookingReceipt(env.manager, held.id)).qrToken).toBe(confirmed.receiptToken)
    // The agency sees the booking made on its behalf.
    expect((await getAgencyBooking(env.agency, held.id)).status).toBe('CONFIRMED')
    const [change] = await db.select().from(bookingChange).where(and(eq(bookingChange.bookingId, held.id), eq(bookingChange.kind, 'CREATED')))
    expect(change).toMatchObject({ actorKind: 'staff', actorId: env.manager.identity.userId })
  })

  it('a manager confirms an individual\'s request (REQUESTED → CONFIRMED)', async () => {
    const env = await setup()
    const customer = await makeCustomer(db, env.scope)
    const search = staySearchSchema.parse({ hotelId: env.hotel.id, bookingType: 'FAMILY', checkIn: '2027-06-01', checkOut: '2027-06-04', totalCount: 3 })
    const requested = await placeHold(db, env.scope, { kind: 'INDIVIDUAL', customerId: customer.id }, holdRequestSchema.parse({ ...search, rooms: [{ roomId: env.rooms['102'], occupancy: 'FAMILY', seats: 3 }] }), NOW)
    expect(requested.status).toBe('REQUESTED')
    const individual = { kind: 'INDIVIDUAL' as const, customerId: customer.id }
    const next = holdRequestSchema.parse({ ...search, rooms: [{ roomId: env.rooms['103'], occupancy: 'FAMILY', seats: 3 }] })
    await expect(placeHold(db, env.scope, individual, next, NOW)).rejects.toMatchObject({ code: 'TOO_MANY_OPEN_REQUESTS' })
    expect((await confirmBooking(env.manager, requested.id)).status).toBe('CONFIRMED')
    // Answered: the customer may ask again.
    expect((await placeHold(db, env.scope, individual, next, NOW)).status).toBe('REQUESTED')
  })

  it('no confirmation at an inactive hotel (409 HOTEL_INACTIVE), for staff and agencies alike', async () => {
    const env = await setup()
    const held = await holdAgencyStay(env.agency, holdRequestSchema.parse({ ...fourMen(env.hotel.id), rooms: [{ roomId: env.rooms['101'], occupancy: 'MALE', seats: 4 }] }))
    await db.update(hotelTable).set({ status: 'INACTIVE' }).where(eq(hotelTable.id, env.hotel.id))
    await expect(confirmBooking(env.manager, held.id)).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(confirmAgencyBooking(env.agency, held.id)).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    expect((await getBooking(env.manager, held.id)).status).toBe('HELD')
  })

  it('staff see only their hotels\' bookings (others are 404) and need booking.create to book or confirm (403)', async () => {
    const env = await setup()
    const held = await holdAgencyStay(env.agency, holdRequestSchema.parse({ ...fourMen(env.hotel.id), rooms: [{ roomId: env.rooms['101'], occupancy: 'MALE', seats: 4 }] }))
    const elsewhere = staff(env.scope, env.manager.identity.userId, ['booking.view', 'booking.create'], ['00000000-0000-4000-8000-000000000001'])
    expect((await listBookings(elsewhere, page)).items).toEqual([])
    await expect(getBooking(elsewhere, held.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', httpStatus: 404 })
    const viewer = staff(env.scope, env.manager.identity.userId, ['booking.view'])
    expect((await getBooking(viewer, held.id)).id).toBe(held.id)
    await expect(confirmBooking(viewer, held.id)).rejects.toMatchObject({ httpStatus: 403 })
    await expect(searchStayForAgency(viewer, staffStaySearchSchema.parse({ hotelId: env.hotel.id, agencyId: env.agencyId, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 1, totalCount: 1 }))).rejects.toMatchObject({ httpStatus: 403 })
    expect((await listBookings(env.manager, { ...page, q: 'B-2027-00' })).items.map(b => b.id)).toEqual([held.id])
    expect((await listBookings(env.manager, { ...page, status: 'CONFIRMED' })).items).toEqual([])
  })
})
