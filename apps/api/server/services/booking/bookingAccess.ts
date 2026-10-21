import type { Permission } from '@hajj/contracts/constants/permissions'
import { NotFoundError } from '../../errors/domainError'
import { bookingOrgRepos } from '../../repositories'
import type { BookingRow } from '../../repositories/booking'
import type { AgencyContext } from '../../security/agencyContext'
import type { AuthContext } from '../../security/authContext'
import { authorizeHotel } from '../../security/authorize'

/** An agency reaches only its own bookings; another agency's booking is "not found". */
export async function loadForAgency(ctx: AgencyContext, bookingId: string): Promise<BookingRow> {
  const row = await bookingOrgRepos(ctx.db, ctx.scope).records.findById(bookingId)
  if (!row || row.agencyId !== ctx.scope.agencyId) throw new NotFoundError('BOOKING_NOT_FOUND')
  return row
}

/**
 * Staff reach a booking with `permission` on its hotel. A booking of a hotel the caller cannot access is "not
 * found" (the hotel's 404 rule). `allowInactive`: reads work on an inactive hotel, writes do not (409 `HOTEL_INACTIVE`).
 */
export async function authorizeStaffBooking(ctx: AuthContext, row: BookingRow, permission: Permission, options: { allowInactive?: boolean } = {}): Promise<void> {
  await authorizeHotel(ctx, permission, row.hotelId, options).catch((error: unknown) => {
    if (error instanceof NotFoundError) throw new NotFoundError('BOOKING_NOT_FOUND')
    throw error
  })
}

/** The booking, if the caller may act on it with `permission` (see `authorizeStaffBooking`). */
export async function loadForStaff(ctx: AuthContext, bookingId: string, permission: Permission, options: { allowInactive?: boolean } = {}): Promise<BookingRow> {
  const row = await bookingOrgRepos(ctx.db, ctx.scope).records.findById(bookingId)
  if (!row) throw new NotFoundError('BOOKING_NOT_FOUND')
  await authorizeStaffBooking(ctx, row, permission, options)
  return row
}
