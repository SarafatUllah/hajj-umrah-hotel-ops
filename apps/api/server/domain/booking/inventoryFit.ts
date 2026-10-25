import { fromEpochDay, type IsoDate, type NightRange, toEpochDay } from '@hajj/contracts/utils/dates'
import { buildRoomSegments, type CalendarOptions, type CalendarSegment, type RoomCalendarInput } from '../inventory/calendar'
import type { MisfitReason, BookingMisfit } from '@hajj/contracts/types/booking'

export type { MisfitReason, BookingMisfit }

/** A seat-holding booking claim on one room (`[checkIn, checkOut)`), with the extra beds it put there. */
export interface RoomClaim {
  bookingId: string
  bookingNo: string
  roomId: string
  checkIn: IsoDate
  checkOut: IsoDate
  extraBeds: number
}

/** Seated pilgrims in a room on a night (the `room_night_occupancy` view). */
export interface NightSeats {
  roomId: string
  night: IsoDate
  seatsUsed: number
}

const key = (roomId: string, day: number) => `${roomId}|${day}`

/** The segment covering `day`, from a room's run-length segments (sorted, covering a contiguous range). */
function segmentOn(segments: readonly CalendarSegment[], day: number): CalendarSegment | undefined {
  return segments.find(s => toEpochDay(s.from) <= day && day <= toEpochDay(s.to))
}

/**
 * v7 §10 "inventory changes can break confirmed bookings": after an inventory change (retire, block,
 * capacity change, override removal), every claimed night inside `window` must still be SELLABLE (in
 * inventory, not covered by a sale-blocking block) and hold that night's seated pilgrims within the
 * room's sellable capacity plus the extra beds claimed that night. Pure: the caller loads the rooms'
 * inventory (as it is AFTER the change), the claims and the seat counts.
 */
export function findBookingMisfits(rooms: readonly RoomCalendarInput[], claims: readonly RoomClaim[], seats: readonly NightSeats[], window: NightRange, options: CalendarOptions): BookingMisfit[] {
  const windowFrom = toEpochDay(window.from)
  const windowTo = toEpochDay(window.to)
  const seatsByNight = new Map(seats.map(s => [key(s.roomId, toEpochDay(s.night)), s.seatsUsed]))
  const extraBedsByNight = new Map<string, number>()
  const nightsOf = (claim: RoomClaim) => ({ from: Math.max(windowFrom, toEpochDay(claim.checkIn)), to: Math.min(windowTo, toEpochDay(claim.checkOut) - 1) })
  for (const claim of claims) {
    const { from, to } = nightsOf(claim)
    for (let day = from; day <= to; day++) extraBedsByNight.set(key(claim.roomId, day), (extraBedsByNight.get(key(claim.roomId, day)) ?? 0) + claim.extraBeds)
  }

  const segmentsByRoom = new Map(rooms.map(r => [r.roomId, buildRoomSegments(r, window, options)]))
  const misfitOn = (claim: RoomClaim, day: number): MisfitReason | null => {
    const segment = segmentOn(segmentsByRoom.get(claim.roomId) ?? [], day)
    if (!segment?.sellable) return 'NOT_SELLABLE'
    const capacity = (segment.sellableCapacity ?? 0) + (extraBedsByNight.get(key(claim.roomId, day)) ?? 0)
    return (seatsByNight.get(key(claim.roomId, day)) ?? 0) > capacity ? 'OVER_CAPACITY' : null
  }

  const misfits: BookingMisfit[] = []
  for (const claim of claims) {
    const { from, to } = nightsOf(claim)
    let run: { from: number, to: number, reason: MisfitReason } | null = null
    const flush = () => {
      if (run) misfits.push({ bookingId: claim.bookingId, bookingNo: claim.bookingNo, roomId: claim.roomId, from: fromEpochDay(run.from), to: fromEpochDay(run.to), reason: run.reason })
      run = null
    }
    for (let day = from; day <= to; day++) {
      const reason = misfitOn(claim, day)
      if (run && (reason !== run.reason || day !== run.to + 1)) flush()
      if (reason === null) continue
      if (run) run.to = day
      else run = { from: day, to: day, reason }
    }
    flush()
  }
  return misfits
}
