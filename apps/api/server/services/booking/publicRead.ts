import type { AgeGroup, BookingStatus, BookingType, Gender, GuestStatus } from '@hajj/contracts/constants/booking'
import type { IsoDate } from '@hajj/contracts/utils/dates'
import { effectiveBookingStatus } from '../../domain/booking/bookingView'
import { bookingOrgRepos } from '../../repositories'
import type { AgencyContext } from '../../security/agencyContext'
import { consumeRateLimit, RATE_LIMITS } from '../../security/rateLimit'
import type { OrganizationScope } from '../../security/scope'
import { loadForAgency } from './bookingAccess'

type Db = Parameters<typeof bookingOrgRepos>[0]

/** A booking as other modules see it (Phase 2a ticket 8): dates, head counts and slots — no personal data. */
export interface BookingSlotsView {
  bookingId: string
  bookingNo: string
  hotelId: string
  /** Effective (a pending booking past its hold reads EXPIRED). */
  status: BookingStatus
  bookingType: BookingType
  agencyId: string | null
  checkIn: IsoDate
  checkOut: IsoDate
  counts: { men: number, women: number, children: number, infants: number, total: number }
  slots: Array<{ guestId: string, slotNo: number, gender: Gender | null, ageGroup: AgeGroup, status: GuestStatus }>
}

/** One of an agency's own pilgrims as its booking copy has them (never the staff master, never passport data). */
export interface AgencyGuestView {
  guestId: string
  slotNo: number
  fullName: string | null
  gender: Gender | null
  nationality: string | null
  dateOfBirth: IsoDate | null
}

/**
 * Ticket 8, for other modules (transport: seats in a bus, pickup dates): a booking's dates, head counts and slots
 * still on it (removed ones left out), without any personal data; null when the organization has no such booking.
 * The caller authorizes its own reader.
 */
export async function readBookingSlots(db: Db, scope: OrganizationScope, bookingId: string, now: Date): Promise<BookingSlotsView | null> {
  const repos = bookingOrgRepos(db, scope)
  const row = await repos.records.findById(bookingId)
  if (!row) return null
  const slots = (await repos.guests.listForBooking(row.id)).filter(({ guest }) => guest.status !== 'REMOVED')
  return {
    bookingId: row.id,
    bookingNo: row.bookingNo,
    hotelId: row.hotelId,
    status: effectiveBookingStatus({ status: row.status as BookingStatus, holdExpiresAt: row.holdExpiresAt }, now),
    bookingType: row.bookingType as BookingType,
    agencyId: row.agencyId,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    counts: { men: row.maleCount, women: row.femaleCount, children: row.childCount, infants: row.infantCount, total: row.totalCount },
    slots: slots.map(({ guest }) => ({ guestId: guest.id, slotNo: guest.slotNo, gender: guest.gender as Gender | null, ageGroup: guest.ageGroup as AgeGroup, status: guest.status as GuestStatus })),
  }
}

/**
 * Ticket 8, for agency-facing code of other modules (a transport manifest): the agency's own pilgrims of its own
 * booking, from its own copies — another agency's booking is "not found", and the staff master `pilgrim` is never
 * read here. Rate limited like the agency's guest list; passport numbers and extras stay out (the booking module's
 * guest screens show those, logged).
 */
export async function readAgencyGuests(ctx: AgencyContext, bookingId: string): Promise<AgencyGuestView[]> {
  const booking = await loadForAgency(ctx, bookingId)
  await consumeRateLimit(ctx.db, RATE_LIMITS.guestListPerAgencyUser, ctx.identity.agencyUserId, ctx.now())
  const slots = (await bookingOrgRepos(ctx.db, ctx.scope).guests.listForBooking(booking.id)).filter(({ guest }) => guest.status !== 'REMOVED')
  return slots.map(({ guest, detail }) => {
    const own = detail && !detail.erasedAt ? detail : null // erased by the retention sweep: nothing to show
    return {
      guestId: guest.id,
      slotNo: guest.slotNo,
      fullName: own?.fullName ?? null,
      gender: (own?.gender ?? guest.gender) as Gender | null,
      nationality: own?.nationality ?? null,
      dateOfBirth: own?.dateOfBirth ?? null,
    }
  })
}
