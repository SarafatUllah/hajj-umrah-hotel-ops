import { type BookingStatus, PENDING_BOOKING_STATUSES } from '@hajj/contracts/constants/booking'
import type { PriceLineKind } from '@hajj/contracts/constants/pricing'

/** What the status really is now: a pending booking past its hold expiry is EXPIRED even before the minute sweep. */
export function effectiveBookingStatus(booking: { status: BookingStatus, holdExpiresAt: Date | null }, now: Date): BookingStatus {
  const pending = (PENDING_BOOKING_STATUSES as readonly BookingStatus[]).includes(booking.status)
  return pending && booking.holdExpiresAt !== null && booking.holdExpiresAt.getTime() <= now.getTime() ? 'EXPIRED' : booking.status
}

export interface NightPriceLine { night: string, kind: PriceLineKind, roomTypeId: string | null, quantity: number, unitAmountHalalas: number, amountHalalas: number, vatIncluded: boolean }

/** A receipt line (v7 §11: extra beds on their own line): the same kind, room type, quantity and price over its nights. */
export interface ReceiptLine { kind: PriceLineKind, roomTypeId: string | null, quantity: number, unitAmountHalalas: number, nights: number, amountHalalas: number, vatIncluded: boolean }

/** The frozen nightly lines summed into receipt lines: one per kind, room type, quantity and unit price (a season change starts a new line). */
export function receiptLines(lines: readonly NightPriceLine[]): ReceiptLine[] {
  const grouped = new Map<string, ReceiptLine>()
  for (const line of lines) {
    const key = [line.kind, line.roomTypeId, line.quantity, line.unitAmountHalalas, line.vatIncluded].join('|')
    const current = grouped.get(key)
    grouped.set(key, current
      ? { ...current, nights: current.nights + 1, amountHalalas: current.amountHalalas + line.amountHalalas }
      : { kind: line.kind, roomTypeId: line.roomTypeId, quantity: line.quantity, unitAmountHalalas: line.unitAmountHalalas, nights: 1, amountHalalas: line.amountHalalas, vatIncluded: line.vatIncluded })
  }
  return [...grouped.values()]
}
