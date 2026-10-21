import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agency as agencyTable, agencyUser, booking, bookingChange, bookingSetting } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import { setSmsSenderForTests, type SmsMessage } from '../../../server/notifications/sms'
import { bookingOrgRepos } from '../../../server/repositories'
import { type AgencyContext, resolveAgencyContext } from '../../../server/security/agencyContext'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { agencyBookingReceipt, checkInGuest, checkOutGuest, completeHotelTask, confirmAgencyBooking, holdAgencyStay, listAgencyGuests, listHotelTasks, lookupReceipt, markGuestNoShow, saveAgencyGuest, sendDetailsReminders } from '../../../server/services/booking'
import { makeAgency, makeBooking, makeBookingRoom, makeGuest } from '../../support/bookingFixtures'
import { makeOrg, makeUser } from '../../support/fixtures'
import { makeStayHotel } from '../../support/stayFixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const BOOKED_AT = new Date('2027-05-01T10:00:00Z')
/** The first day of the stay, mid-day in Makkah. */
const ARRIVAL = new Date('2027-06-01T09:00:00Z')

afterEach(async () => {
  setSmsSenderForTests(null)
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

function staff(scope: OrganizationScope, userId: string, permissions: Permission[], now: Date = ARRIVAL): AuthContext {
  return { identity: { userId, organizationId: scope.organizationId, email: 's@example.test', fullName: 'Staff' }, authz: { permissions: new Set(permissions), allHotels: true, hotelIds: new Set() }, scope, db, now: () => now }
}

async function agencyCtx(scope: OrganizationScope, agencyId: string): Promise<AgencyContext> {
  const [user] = await db.insert(agencyUser).values({ organizationId: scope.organizationId, agencyId, email: `u-${agencyId}@example.test`, passwordHash: 'h', fullName: 'Agent' }).returning()
  return (await resolveAgencyContext(db, { agencyUserId: user!.id, organizationId: scope.organizationId, agencyId }, () => BOOKED_AT))!
}

const details = (fullName: string, gender: 'MALE' | 'FEMALE', passportNo: string) =>
  guestDetailsSchema.parse({ fullName, gender, nationality: 'BGD', dateOfBirth: '1980-01-01', passportNo, passportExpiry: '2032-01-01' })

/** A confirmed GROUP: two men (Quad 101) and a woman (Double 201), June 1–4; the men's details are in. */
async function setup() {
  const { scope } = await makeOrg(db)
  const { hotel, rooms } = await makeStayHotel(db, scope)
  const agency = await agencyCtx(scope, (await makeAgency(db, scope)).id)
  const held = await holdAgencyStay(agency, holdRequestSchema.parse({
    hotelId: hotel.id, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 2, femaleCount: 1, totalCount: 3,
    rooms: [{ roomId: rooms['101'], occupancy: 'MALE', seats: 2 }, { roomId: rooms['201'], occupancy: 'FEMALE', seats: 1 }],
  }))
  await confirmAgencyBooking(agency, held.id)
  const [man1, man2, woman] = await listAgencyGuests(agency, held.id)
  await saveAgencyGuest(agency, held.id, man1!.id, details('Md. Karim', 'MALE', 'A1234567'))
  await saveAgencyGuest(agency, held.id, man2!.id, details('Abdul Rahim', 'MALE', 'B7654321'))
  const desk = staff(scope, (await makeUser(db, scope)).id, ['booking.view', 'booking.checkIn'])
  return { scope, hotel, rooms, agency, bookingId: held.id, man1: man1!.id, man2: man2!.id, woman: woman!.id, desk }
}

describe('check-in at the desk (v7 §12, §17)', () => {
  it('the receipt\'s QR code finds the booking for staff with booking.checkIn only', async () => {
    const env = await setup()
    const { qrToken } = await agencyBookingReceipt(env.agency, env.bookingId)
    expect(await lookupReceipt(env.desk, { receiptToken: qrToken })).toMatchObject({ bookingId: env.bookingId, status: 'CONFIRMED', checkIn: '2027-06-01' })
    const seller = staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view'])
    await expect(lookupReceipt(seller, { receiptToken: qrToken })).rejects.toMatchObject({ httpStatus: 403 })
    await expect(lookupReceipt(env.desk, { receiptToken: 'A'.repeat(32) })).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', httpStatus: 404 })
  })

  it('each pilgrim on their own: details first, a day of the stay; IN_HOUSE from the first arrival, COMPLETED when all left or never came', async () => {
    const env = await setup()
    const early = staff(env.scope, env.desk.identity.userId, ['booking.checkIn'], new Date('2027-05-31T09:00:00Z'))
    await expect(checkInGuest(early, env.bookingId, env.man1)).rejects.toMatchObject({ code: 'BEFORE_CHECK_IN', httpStatus: 409 })
    await expect(checkInGuest(env.desk, env.bookingId, env.woman)).rejects.toMatchObject({ code: 'DETAILS_INCOMPLETE', httpStatus: 422 })
    await expect(checkOutGuest(env.desk, env.bookingId, env.man1)).rejects.toMatchObject({ code: 'GUEST_STATUS' })

    expect(await checkInGuest(env.desk, env.bookingId, env.man1)).toMatchObject({ status: 'CHECKED_IN', bookingStatus: 'IN_HOUSE', checkedInAt: ARRIVAL.toISOString() })
    expect(await checkInGuest(env.desk, env.bookingId, env.man1)).toMatchObject({ status: 'CHECKED_IN', bookingStatus: 'IN_HOUSE' }) // a double scan
    expect(await markGuestNoShow(env.desk, env.bookingId, env.woman)).toMatchObject({ status: 'NO_SHOW', bookingStatus: 'IN_HOUSE' })
    expect(await checkOutGuest(env.desk, env.bookingId, env.man1)).toMatchObject({ status: 'CHECKED_OUT', bookingStatus: 'IN_HOUSE' })
    await checkInGuest(env.desk, env.bookingId, env.man2)
    expect(await checkOutGuest(env.desk, env.bookingId, env.man2)).toMatchObject({ status: 'CHECKED_OUT', bookingStatus: 'COMPLETED' })

    expect((await db.select().from(booking).where(eq(booking.id, env.bookingId)))[0]!.status).toBe('COMPLETED')
    const kinds = (await db.select().from(bookingChange).where(eq(bookingChange.bookingId, env.bookingId))).map(c => c.kind)
    expect(kinds.filter(k => ['CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW'].includes(k)).sort()).toEqual(['CHECKED_IN', 'CHECKED_IN', 'CHECKED_OUT', 'CHECKED_OUT', 'NO_SHOW'])
  })

  it('staff without booking.checkIn cannot move pilgrims; another organization\'s desk does not find the booking', async () => {
    const env = await setup()
    const seller = staff(env.scope, (await makeUser(db, env.scope)).id, ['booking.view', 'booking.edit'])
    await expect(checkInGuest(seller, env.bookingId, env.man1)).rejects.toMatchObject({ httpStatus: 403 })
    const { scope: other } = await makeOrg(db)
    const foreignDesk = staff(other, (await makeUser(db, other)).id, ['booking.checkIn'])
    await expect(checkInGuest(foreignDesk, env.bookingId, env.man1)).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', httpStatus: 404 })
  })
})

describe('extra-bed tasks (v7 §11)', () => {
  it('confirming a booking with extra beds gives the hotel a set-up and a removal task; reception marks them done', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, rooms } = await makeStayHotel(db, scope)
    const agencyRow = await makeAgency(db, scope)
    const agency = await agencyCtx(scope, agencyRow.id)
    const held = await makeBooking(db, scope, hotel.id, { agencyId: agencyRow.id, status: 'HELD', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 5, totalCount: 5 })
    await makeBookingRoom(db, scope, held, rooms['101']!, { extraBeds: 1 })
    await makeBookingRoom(db, scope, held, rooms['102']!)
    await confirmAgencyBooking(agency, held.id)
    await confirmAgencyBooking(agency, held.id) // idempotent: no second set of tasks

    const desk = staff(scope, (await makeUser(db, scope)).id, ['booking.view', 'booking.checkIn'])
    const tasks = await listHotelTasks(desk, hotel.id, { status: 'OPEN' })
    expect(tasks).toMatchObject([
      { kind: 'EXTRA_BED_SETUP', roomNumber: '101', quantity: 1, dueDate: '2027-06-01', bookingId: held.id },
      { kind: 'EXTRA_BED_REMOVAL', roomNumber: '101', quantity: 1, dueDate: '2027-06-04', bookingId: held.id },
    ])
    expect(await completeHotelTask(desk, hotel.id, tasks[0]!.id)).toMatchObject({ status: 'DONE', doneAt: ARRIVAL.toISOString() })
    expect(await completeHotelTask(desk, hotel.id, tasks[0]!.id)).toMatchObject({ status: 'DONE' })
    expect(await listHotelTasks(desk, hotel.id, { status: 'OPEN' })).toHaveLength(1)

    const other = await makeStayHotel(db, scope)
    await expect(completeHotelTask(desk, other.hotel.id, tasks[1]!.id)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', httpStatus: 404 })
    const viewer = staff(scope, (await makeUser(db, scope)).id, ['booking.view'])
    await expect(completeHotelTask(viewer, hotel.id, tasks[1]!.id)).rejects.toMatchObject({ httpStatus: 403 })
  })
})

describe('details reminder (v7 §15)', () => {
  it('reminds the agency once by text message within detailsReminderDays of check-in, while details are missing', async () => {
    const env = await setup()
    const sent: SmsMessage[] = []
    setSmsSenderForTests({ send: async (message) => { sent.push(message) } })
    const [agencyRow] = await db.select().from(agencyTable).where(eq(agencyTable.id, env.agency.scope.agencyId))

    expect(await sendDetailsReminders(db, [env.scope], new Date('2027-05-20T06:00:00Z'))).toBe(0) // 12 days ahead
    expect(await sendDetailsReminders(db, [env.scope], new Date('2027-05-26T06:00:00Z'))).toBe(1)
    const [booked] = await db.select().from(booking).where(eq(booking.id, env.bookingId))
    expect(sent).toEqual([{ to: agencyRow!.phone, text: `Booking ${booked!.bookingNo}: 1 of 3 pilgrims still need their passport details before check-in on 2027-06-01.` }])
    expect(await sendDetailsReminders(db, [env.scope], new Date('2027-05-27T06:00:00Z'))).toBe(0)
  })

  it('the due bookings come soonest first and page by (check-in, id), so failures never hold up the rest', async () => {
    const env = await setup()
    const later = await makeBooking(db, env.scope, env.hotel.id, { agencyId: env.agency.scope.agencyId, status: 'CONFIRMED', checkIn: '2027-06-02', checkOut: '2027-06-05' })
    await makeGuest(db, env.scope, later.id, 1)
    const records = bookingOrgRepos(db, env.scope).records
    const [first] = await records.dueForDetailsReminder('2027-05-26', '2027-06-02', 1)
    expect(first!.booking.id).toBe(env.bookingId)
    const [second] = await records.dueForDetailsReminder('2027-05-26', '2027-06-02', 1, { checkIn: first!.booking.checkIn, id: first!.booking.id })
    expect(second).toMatchObject({ booking: { id: later.id }, pending: 1, slots: 1 })
    expect(await records.dueForDetailsReminder('2027-05-26', '2027-06-02', 1, { checkIn: second!.booking.checkIn, id: second!.booking.id })).toEqual([])
  })

  it('a failed message is tried again the next day; 0 days turns the reminder off', async () => {
    const env = await setup()
    let failing = true
    setSmsSenderForTests({ send: async () => { if (failing) throw new Error('gateway down') } })
    expect(await sendDetailsReminders(db, [env.scope], new Date('2027-05-26T06:00:00Z'))).toBe(0)
    failing = false
    await db.update(bookingSetting).set({ detailsReminderDays: 0 }).where(eq(bookingSetting.organizationId, env.scope.organizationId))
    expect(await sendDetailsReminders(db, [env.scope], new Date('2027-05-27T06:00:00Z'))).toBe(0)
    await db.update(bookingSetting).set({ detailsReminderDays: 7 }).where(eq(bookingSetting.organizationId, env.scope.organizationId))
    expect(await sendDetailsReminders(db, [env.scope], new Date('2027-05-27T06:00:00Z'))).toBe(1)
  })
})
