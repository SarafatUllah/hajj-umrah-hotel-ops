import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { booking, bookingGuestDetail, customer } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import { customerRequestSchema, customerStaySearchSchema } from '@hajj/contracts/schemas/booking'
import { accountsRepos } from '../../../server/repositories'
import type { AuthContext } from '../../../server/security/authContext'
import { type CustomerContext, resolveCustomerContext } from '../../../server/security/customerContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { confirmBooking, requestCustomerStay, searchCustomerStay } from '../../../server/services/booking'
import { closeCustomerAccount } from '../../../server/services/customerAccountService'
import { makeCustomer } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const NOW = new Date('2027-05-01T10:00:00Z')
const AFTER_THE_STAY = new Date('2027-06-10T10:00:00Z')
const LEAD = { fullName: 'Yusuf Rahman', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-03-01', passportNo: 'BG1234567', passportExpiry: '2030-01-01' }
const FAMILY = { bookingType: 'FAMILY', checkIn: '2027-06-01', checkOut: '2027-06-04', totalCount: 3 }

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

/** The customer's session as of `now`, its code verified `signedAgoMs` before. */
async function sessionOf(scope: OrganizationScope, customerId: string, now: Date, signedAgoMs = 60_000): Promise<CustomerContext | null> {
  return resolveCustomerContext(db, { customerId, organizationId: scope.organizationId, signedInAt: new Date(now.getTime() - signedAgoMs) }, () => now)
}

async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel } = await makeStayHotel(db, scope)
  const row = await makeCustomer(db, scope)
  const ctx = (await sessionOf(scope, row.id, NOW))!
  const request = async () => {
    const { options } = await searchCustomerStay(ctx, customerStaySearchSchema.parse({ hotelId: hotel.id, ...FAMILY }))
    const rooms = options[0]!.rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds }))
    return requestCustomerStay(ctx, customerRequestSchema.parse({ hotelId: hotel.id, ...FAMILY, rooms, lead: LEAD }))
  }
  const confirm = async (bookingId: string) => {
    const staff: AuthContext = { identity: { userId: (await makeUser(db, scope)).id, organizationId: scope.organizationId, email: 's@example.test', fullName: 'Staff' }, authz: { permissions: new Set(['booking.view', 'booking.create']), allHotels: true, hotelIds: new Set() }, scope, db, now: () => NOW }
    await confirmBooking(staff, bookingId)
  }
  return { scope, row, ctx, request, confirm }
}

const customerRow = async (id: string) => (await db.select().from(customer).where(eq(customer.id, id)))[0]!
const bookingRow = async (id: string) => (await db.select().from(booking).where(eq(booking.id, id)))[0]!

describe('customer account closure (step 15b)', () => {
  it('withdraws the open request, anonymizes the account, ends its sessions and frees the phone for a new account', async () => {
    const env = await setup()
    const open = await env.request()
    expect(await closeCustomerAccount(env.ctx)).toEqual({ withdrawn: [open.bookingNo] })

    expect(await bookingRow(open.id)).toMatchObject({ status: 'CANCELLED', customerId: env.row.id })
    // The withdrawn request's pilgrim data goes at once (no stay will use it), not after the retention months.
    expect(await db.select().from(bookingGuestDetail).where(eq(bookingGuestDetail.bookingId, open.id))).toMatchObject([{ erasedAt: NOW, passportNoEncrypted: null, passportLookup: null }])
    expect(await customerRow(env.row.id)).toMatchObject({ phone: null, fullName: 'Closed account', email: null, isActive: false, closedAt: NOW, sessionVersion: env.row.sessionVersion + 1 })
    expect(await sessionOf(env.scope, env.row.id, NOW)).toBeNull()
    // The number signs up again as a new account, with no history.
    expect(await accountsRepos(db, env.scope).customers.insert({ phone: env.row.phone!, fullName: 'New Owner', phoneVerifiedAt: NOW })).toMatchObject({ isActive: true })
    // A session from before the closure finds nothing to act on.
    await expect(closeCustomerAccount(env.ctx)).rejects.toMatchObject({ code: 'ACCOUNT_CLOSED', httpStatus: 409 })
    await expect(env.request()).rejects.toMatchObject({ code: 'ACCOUNT_CLOSED' })
  })

  it('needs a fresh code', async () => {
    const env = await setup()
    const stale = (await sessionOf(env.scope, env.row.id, NOW, 30 * 60_000))!
    await expect(closeCustomerAccount(stale)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', httpStatus: 403 })
    const unknown = { ...env.ctx, signedInAt: null }
    await expect(closeCustomerAccount(unknown)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' })
    expect(await customerRow(env.row.id)).toMatchObject({ isActive: true, closedAt: null })
  })

  it('a confirmed stay not over yet refuses it (the hotel cancels first); once the stay is over it closes', async () => {
    const env = await setup()
    const confirmed = await env.request()
    await env.confirm(confirmed.id)
    await expect(closeCustomerAccount(env.ctx)).rejects.toMatchObject({ code: 'ACTIVE_BOOKINGS', httpStatus: 409, details: { bookingNos: [confirmed.bookingNo] } })
    expect(await customerRow(env.row.id)).toMatchObject({ isActive: true, closedAt: null })

    const later = (await sessionOf(env.scope, env.row.id, AFTER_THE_STAY))!
    expect(await closeCustomerAccount(later)).toEqual({ withdrawn: [] })
    expect(await bookingRow(confirmed.id)).toMatchObject({ status: 'CONFIRMED', customerId: env.row.id })
  })
})
