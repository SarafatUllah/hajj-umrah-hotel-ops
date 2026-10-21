import { type IsoDate, todayInTimezone, toEpochDay } from '@hajj/contracts/utils/dates'
import { addMonths } from '../../domain/booking/guestRules'
import { bookingOrgRepos } from '../../repositories'
import type { OrganizationScope } from '../../security/scope'
import { loadBookingSettings } from './bookingSettingsService'
import { sweepOrganizations } from './sweep'

type Db = Parameters<typeof bookingOrgRepos>[0]

const MS_PER_DAY = 24 * 60 * 60 * 1000
/** Bookings erased per transaction (the sweep continues until none is left). */
const ERASURE_BATCH = 500

/**
 * One batch, in the lock order of a details save (the bookings, their slots, then the copies): free text cleared,
 * slots let go of the staff master, copies erased in place, passport readings cleared and images made due (the image
 * sweep deletes them), task notes cleared. Returns how many copies were erased.
 */
export async function eraseBookingData(tx: Db, scope: OrganizationScope, bookingIds: readonly string[], today: IsoDate, now: Date): Promise<number> {
  const repos = bookingOrgRepos(tx, scope)
  await repos.records.clearFreeText(bookingIds)
  await repos.guests.releaseMasters(bookingIds)
  const erased = await repos.guests.eraseCopies(bookingIds, now)
  await repos.passportScans.expireForBookings(bookingIds, today, now)
  await repos.hotelTasks.clearNotes(bookingIds)
  return erased
}

/**
 * Ticket 4 (PDPL storage limitation): `guestDataRetentionMonths` after a booking's check-out, every copy of its
 * pilgrims' personal data goes — the bookers' copies erased in place (the slots and their history stay), passport
 * readings and images (whatever `passportImageRetentionMonths` says), free text that may name them; then every staff
 * master no slot points at any more, untouched since the cutoff, is deleted. Batches of bookings, one transaction
 * each; a re-run finds nothing to do.
 */
export async function eraseExpiredGuestData(db: Db, scopes: readonly OrganizationScope[], now: Date): Promise<number> {
  return sweepOrganizations('guest-data-retention', scopes, async (scope) => {
    const { guestDataRetentionMonths } = await loadBookingSettings(db, scope)
    const today = todayInTimezone('UTC', now)
    const cutoff = addMonths(today, -guestDataRetentionMonths)
    let erased = 0
    let after: { checkOut: IsoDate, id: string } | undefined
    for (;;) {
      const due = await bookingOrgRepos(db, scope).records.dueForErasure(cutoff, today, ERASURE_BATCH, after)
      if (due.length === 0) break
      erased += await db.transaction(tx => eraseBookingData(tx, scope, due.map(b => b.id), today, now))
      if (due.length < ERASURE_BATCH) break
      after = due.at(-1)!
    }
    const deleted = await bookingOrgRepos(db, scope).pilgrims.deleteUnreferenced(new Date(toEpochDay(cutoff) * MS_PER_DAY))
    return erased + deleted
  })
}
