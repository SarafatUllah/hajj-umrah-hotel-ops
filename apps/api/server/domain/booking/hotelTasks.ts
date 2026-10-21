import type { HotelTaskKind } from '@hajj/contracts/constants/booking'
import type { IsoDate } from '@hajj/contracts/utils/dates'

/** A room claim of a confirmed booking, as far as housekeeping cares. */
export interface ExtraBedClaim { roomId: string, extraBeds: number, checkIn: IsoDate, checkOut: IsoDate }

export interface PlannedTask { roomId: string, kind: HotelTaskKind, quantity: number, dueDate: IsoDate }

/**
 * v7 §11: a confirmed booking's extra beds become work for the hotel — set up by the claim's first night ("room 412:
 * 1 extra bed before the 15th") and taken away on its departure day.
 */
export function extraBedTasks(claims: readonly ExtraBedClaim[]): PlannedTask[] {
  return claims.filter(c => c.extraBeds > 0).flatMap(c => [
    { roomId: c.roomId, kind: 'EXTRA_BED_SETUP' as const, quantity: c.extraBeds, dueDate: c.checkIn },
    { roomId: c.roomId, kind: 'EXTRA_BED_REMOVAL' as const, quantity: c.extraBeds, dueDate: c.checkOut },
  ])
}
