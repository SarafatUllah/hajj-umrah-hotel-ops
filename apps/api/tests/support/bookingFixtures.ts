import { randomUUID } from 'node:crypto'
import type { DbOrTx } from '@hajj/db/client'
import { agency, booking, bookingGuest, bookingRoom, customer, guestStay } from '@hajj/db/schema'
import { trustedHotelScope, type OrganizationScope } from '../../server/security/scope'
import { makeFloor, makeHotel, makeRoomType, makeRoomWithVersion } from './fixtures'

/**
 * Booking-platform rows for schema-level tests (Phase 2a), inserted directly: these tests prove the
 * database constraints themselves, before (and independently of) the repositories that later write them.
 */

type NewAgency = typeof agency.$inferInsert
type NewBooking = typeof booking.$inferInsert
type NewBookingRoom = typeof bookingRoom.$inferInsert
type NewBookingGuest = typeof bookingGuest.$inferInsert
type NewGuestStay = typeof guestStay.$inferInsert

const unique = () => randomUUID().slice(0, 8)
let phoneSequence = 0

/** A hotel with `roomCount` four-bed rooms on one floor. */
export async function makeHotelWithRooms(db: DbOrTx, scope: OrganizationScope, roomCount = 3) {
  const hotel = await makeHotel(db, scope)
  const hotelScope = trustedHotelScope(scope, hotel.id)
  const floor = await makeFloor(db, hotelScope)
  const roomType = await makeRoomType(db, scope)
  const rooms = []
  for (let i = 0; i < roomCount; i++) rooms.push((await makeRoomWithVersion(db, hotelScope, floor.id, roomType.id, { roomNumber: `${100 + i}` })).room)
  return { hotel, hotelScope, floor, roomType, rooms }
}

export async function makeAgency(db: DbOrTx, scope: OrganizationScope, overrides: Partial<NewAgency> = {}) {
  const n = unique()
  const [row] = await db.insert(agency).values({
    organizationId: scope.organizationId,
    name: `Agency ${n}`,
    licenseNo: `LIC-${n}`,
    contactName: 'Contact',
    phone: '+966500000000',
    email: `agency-${n}@example.test`,
    status: 'APPROVED',
    approvedAt: new Date(),
    ...overrides,
  }).returning()
  return row!
}

export async function makeCustomer(db: DbOrTx, scope: OrganizationScope) {
  const [row] = await db.insert(customer).values({ organizationId: scope.organizationId, fullName: 'Customer', phone: `+9665${String(++phoneSequence).padStart(8, '0')}` }).returning()
  return row!
}

const FAR_FUTURE = new Date('2099-01-01T00:00:00Z')

/** A confirmed agency GROUP booking by default (override anything). */
export async function makeBooking(db: DbOrTx, scope: OrganizationScope, hotelId: string, overrides: Partial<NewBooking> = {}) {
  const status = overrides.status ?? 'CONFIRMED'
  const confirmed = ['CONFIRMED', 'IN_HOUSE', 'COMPLETED'].includes(status)
  const [row] = await db.insert(booking).values({
    organizationId: scope.organizationId,
    hotelId,
    bookingNo: `B-${unique()}`,
    bookerType: 'AGENCY',
    bookingType: 'GROUP',
    checkIn: '2027-06-01',
    checkOut: '2027-06-06',
    maleCount: 2,
    totalCount: 2,
    priceSource: 'PUBLIC',
    status,
    holdExpiresAt: status === 'HELD' || status === 'REQUESTED' ? FAR_FUTURE : null,
    confirmedAt: confirmed ? new Date() : null,
    receiptToken: confirmed ? randomUUID() : null,
    ...overrides,
  }).returning()
  return row!
}

/** A room claim owned by the booking's agency (GROUP) unless `ownerBookingId` is given. */
export async function makeBookingRoom(db: DbOrTx, scope: OrganizationScope, b: { id: string, hotelId: string, agencyId: string | null, checkIn: string, checkOut: string, status: string }, roomId: string, overrides: Partial<NewBookingRoom> = {}) {
  const ownedByBooking = overrides.ownerBookingId !== undefined || b.agencyId === null
  const [row] = await db.insert(bookingRoom).values({
    organizationId: scope.organizationId,
    hotelId: b.hotelId,
    bookingId: b.id,
    roomId,
    ownerAgencyId: ownedByBooking ? null : b.agencyId,
    ownerBookingId: ownedByBooking ? (overrides.ownerBookingId ?? b.id) : null,
    occupancy: 'MALE',
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    status: b.status,
    ...overrides,
  }).returning()
  return row!
}

export async function makeGuest(db: DbOrTx, scope: OrganizationScope, bookingId: string, slotNo: number, overrides: Partial<NewBookingGuest> = {}) {
  const [row] = await db.insert(bookingGuest).values({ organizationId: scope.organizationId, bookingId, slotNo, gender: 'MALE', ageGroup: 'ADULT', ...overrides }).returning()
  return row!
}

export async function makeStay(db: DbOrTx, scope: OrganizationScope, bookingId: string, guestId: string, bookingRoomId: string, checkIn: string, checkOut: string, overrides: Partial<NewGuestStay> = {}) {
  const [row] = await db.insert(guestStay).values({ organizationId: scope.organizationId, bookingId, bookingGuestId: guestId, bookingRoomId, checkIn, checkOut, ...overrides }).returning()
  return row!
}
