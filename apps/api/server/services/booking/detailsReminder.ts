import { addDays, type IsoDate, todayInTimezone } from '@hajj/contracts/utils/dates'
import { bookingOrgRepos } from '../../repositories'
import type { DetailsReminderRow } from '../../repositories/booking'
import type { OrganizationScope } from '../../security/scope'
import { canMessageBookers, messageBooker, type BookerDelivery } from './bookerMessages'
import { loadBookingSettings } from './bookingSettingsService'
import { sweepOrganizations } from './sweep'

type Db = Parameters<typeof bookingOrgRepos>[0]

/** Bookings read per page, and the most one organization is reminded of in one run (the next run continues). */
const REMINDER_PAGE = 200
const MAX_REMINDERS_PER_RUN = 2000

/** The reminder's text: no personal data, only the booking and what is missing. */
export function reminderText(booking: { bookingNo: string, checkIn: IsoDate }, pending: number, slots: number): string {
  return `Booking ${booking.bookingNo}: ${pending} of ${slots} pilgrims still need their passport details before check-in on ${booking.checkIn}.`
}

/**
 * Daily (v7 §15 `detailsReminderDays`, 7 by default; 0 turns it off): a confirmed booking checking in within that
 * many days with pilgrims' details still missing is reminded once, on the booker's channel (D-P2-68): a text message
 * to the agency's or customer's phone, else an e-mail to the customer's verified address (a booking whose booker is
 * gone is marked and skipped). Sent first, marked after: a failed send, or one whose channel is not configured yet, is
 * tried again the next day while the check-in is still ahead, and the run pages past them so they never hold up the
 * others. Days are UTC: the job runs at 06:00 UTC, the same date as in Saudi Arabia (UTC+3). Nothing is attempted
 * while neither text messages nor e-mail are configured.
 */
export async function sendDetailsReminders(db: Db, scopes: readonly OrganizationScope[], now: Date): Promise<number> {
  if (!canMessageBookers()) return 0
  const today = todayInTimezone('UTC', now)
  return sweepOrganizations('details-reminder', scopes, async (scope) => {
    const { detailsReminderDays } = await loadBookingSettings(db, scope)
    if (detailsReminderDays === 0) return 0
    const records = bookingOrgRepos(db, scope).records
    let sent = 0
    let after: { checkIn: IsoDate, id: string } | undefined
    for (let seen = 0; seen < MAX_REMINDERS_PER_RUN;) {
      const page = await records.dueForDetailsReminder(today, addDays(today, detailsReminderDays), REMINDER_PAGE, after)
      for (const due of page) {
        if (await remind(db, scope, due, now)) sent += 1
      }
      if (page.length < REMINDER_PAGE) break
      seen += page.length
      after = { checkIn: page.at(-1)!.booking.checkIn, id: page.at(-1)!.booking.id }
    }
    return sent
  })
}

/** One booking's reminder: true when a message went out. Marked once sent, or when there is nobody to send it to. */
async function remind(db: Db, scope: OrganizationScope, { booking, pending, slots }: DetailsReminderRow, now: Date): Promise<boolean> {
  const message = { subject: `Booking ${booking.bookingNo}: pilgrims' details needed`, text: reminderText(booking, pending, slots) }
  const delivery: BookerDelivery | 'failed' = await messageBooker(db, scope, booking, message)
    .catch((error: unknown) => { console.error(`[details-reminder] booking ${booking.id} not reminded:`, error instanceof Error ? error.message : error); return 'failed' as const })
  if (delivery === 'sent' || delivery === 'no-contact') await bookingOrgRepos(db, scope).records.markDetailsReminded(booking.id, now)
  return delivery === 'sent'
}
