import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { booking, customer } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import { setEmailSenderForTests, type EmailMessage } from '../../../server/notifications/email'
import { setSmsSenderForTests, type SmsMessage } from '../../../server/notifications/sms'
import type { OrganizationScope } from '../../../server/security/scope'
import { notifyBookingCancelled, notifyBookingConfirmed, sendDetailsReminders } from '../../../server/services/booking'
import { bookingCancelledEvent, bookingConfirmedEvent } from '../../../server/services/booking/bookingEvents'
import { makeBooking, makeCustomer, makeGuest } from '../../support/bookingFixtures'
import { makeHotel, makeOrg } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb() as Database
const NOW = new Date('2027-05-26T06:00:00Z')
let emails: EmailMessage[] = []
let texts: SmsMessage[] = []

beforeEach(() => {
  emails = []
  texts = []
  setEmailSenderForTests({ send: async (message) => { emails.push(message) } })
  setSmsSenderForTests({ send: async (message) => { texts.push(message) } })
})

afterEach(async () => {
  setEmailSenderForTests(null)
  setSmsSenderForTests(null)
  vi.restoreAllMocks()
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

/** A confirmed family stay (June 1–4) of a customer who signs in with e-mail only, one pilgrim's details missing. */
async function emailCustomerBooking(scope: OrganizationScope) {
  const hotel = await makeHotel(db, scope)
  const [row] = await db.insert(customer).values({ organizationId: scope.organizationId, fullName: 'Aisha Rahman', email: 'aisha@example.test', emailVerifiedAt: NOW }).returning()
  const stay = await makeBooking(db, scope, hotel.id, { bookerType: 'INDIVIDUAL', customerId: row!.id, bookingType: 'FAMILY', maleCount: 0, totalCount: 1, checkIn: '2027-06-01', checkOut: '2027-06-04' })
  await makeGuest(db, scope, stay.id, 1)
  return { hotel, customerRow: row!, stay }
}

describe('messages to a customer who signs in with e-mail (D-P2-68)', () => {
  it('a confirmation and a cancellation by the hotel go by e-mail to the verified address, never as a text', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, stay } = await emailCustomerBooking(scope)

    await notifyBookingConfirmed(db, scope, bookingConfirmedEvent(stay, 'staff', NOW))
    await notifyBookingCancelled(db, scope, bookingCancelledEvent(stay, 'CONFIRMED', 'staff', NOW))

    expect(texts).toEqual([])
    expect(emails.map(({ to, subject, text }) => ({ to, subject, text }))).toEqual([
      { to: 'aisha@example.test', subject: `Booking ${stay.bookingNo} is confirmed`, text: `Booking ${stay.bookingNo} at ${hotel.name} is confirmed: 2027-06-01 to 2027-06-04.` },
      { to: 'aisha@example.test', subject: `Booking ${stay.bookingNo} was cancelled`, text: `Booking ${stay.bookingNo} at ${hotel.name} (2027-06-01 to 2027-06-04) was cancelled by the hotel.` },
    ])
    expect(emails[0]!.html).toContain(`<p>Booking ${stay.bookingNo} at`)
  })

  it('without an e-mail provider the message is skipped with a log line naming the booking only (a phone booker is still texted)', async () => {
    const { scope } = await makeOrg(db)
    const { stay } = await emailCustomerBooking(scope)
    setEmailSenderForTests(null) // .env.test: EMAIL_DRIVER unset, disabled
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    await notifyBookingConfirmed(db, scope, bookingConfirmedEvent(stay, 'staff', NOW))
    expect(info).toHaveBeenCalledWith(`[booker-message] booking ${stay.bookingNo}: not sent, EMAIL_DRIVER is not configured`)
    expect(JSON.stringify(info.mock.calls)).not.toContain('aisha')

    const phoneCustomer = await makeCustomer(db, scope)
    const phoneStay = await makeBooking(db, scope, stay.hotelId, { bookerType: 'INDIVIDUAL', customerId: phoneCustomer.id, bookingType: 'FAMILY', maleCount: 0, totalCount: 1 })
    await notifyBookingConfirmed(db, scope, bookingConfirmedEvent(phoneStay, 'staff', NOW))
    expect(texts).toMatchObject([{ to: phoneCustomer.phone }])
    expect(emails).toEqual([])
  })

  it('the details reminder e-mails them once; while e-mail is not configured it waits (unmarked) for a later run', async () => {
    const { scope } = await makeOrg(db)
    const { stay } = await emailCustomerBooking(scope)
    setEmailSenderForTests(null)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    // Text messages are configured (the override), e-mail is not: the run happens, this booker is skipped.
    expect(await sendDetailsReminders(db, [scope], NOW)).toBe(0)
    expect(info).toHaveBeenCalledWith(`[booker-message] booking ${stay.bookingNo}: not sent, EMAIL_DRIVER is not configured`)
    expect((await db.select().from(booking).where(eq(booking.id, stay.id)))[0]!.detailsRemindedAt).toBeNull()

    setEmailSenderForTests({ send: async (message) => { emails.push(message) } })
    expect(await sendDetailsReminders(db, [scope], new Date('2027-05-27T06:00:00Z'))).toBe(1)
    expect(emails).toMatchObject([{ to: 'aisha@example.test', subject: `Booking ${stay.bookingNo}: pilgrims' details needed`, text: `Booking ${stay.bookingNo}: 1 of 1 pilgrims still need their passport details before check-in on 2027-06-01.` }])
    expect(texts).toEqual([])
    expect(await sendDetailsReminders(db, [scope], new Date('2027-05-28T06:00:00Z'))).toBe(0)
  })

  it('a closed account is reached by no channel: nothing is sent and the reminder is marked done', async () => {
    const { scope } = await makeOrg(db)
    const { stay, customerRow } = await emailCustomerBooking(scope)
    await db.update(customer).set({ email: null, emailVerifiedAt: null, fullName: 'Closed account', isActive: false, closedAt: NOW }).where(eq(customer.id, customerRow.id))

    expect(await sendDetailsReminders(db, [scope], NOW)).toBe(0)
    expect([...emails, ...texts]).toEqual([])
    expect((await db.select().from(booking).where(eq(booking.id, stay.id)))[0]!.detailsRemindedAt).toEqual(NOW)
  })
})
