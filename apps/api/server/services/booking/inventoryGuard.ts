import { addDays, type IsoDate, maxIsoDate, minIsoDate, type NightRange } from '@hajj/contracts/utils/dates'
import { findBookingMisfits } from '../../domain/booking/inventoryFit'
import { ConflictError } from '../../errors/domainError'
import { bookingRepos, hotelRepos } from '../../repositories'
import type { HotelScope } from '../../security/scope'
import { calendarOptionsFor } from '../calendarOptions'

/** The database handle a repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof hotelRepos>[0]

/** Which rooms an inventory change touched, and from which night (to which night; null = every later night). */
export interface InventoryChange {
  roomIds: readonly string[]
  from: IsoDate
  to: IsoDate | null
}

/**
 * v7 §10 "inventory changes can break confirmed bookings": called INSIDE an inventory transaction (room
 * retirement, base capacity change, operational block, seasonal override change) AFTER its write, with the
 * touched rooms already row-locked — the same locks a hold takes, so neither can run concurrently. Re-reads
 * the rooms' inventory as it now is and refuses (409 `BOOKING_CONFLICT`, listing the bookings) if any live
 * claim on the changed nights is no longer sellable or holds more seated pilgrims than the night's sellable
 * capacity plus its extra beds; the caller's transaction then rolls back. The manager moves the pilgrims
 * first (v7 §12), then retries.
 */
export async function assertBookingsStillFit(db: Db, scope: HotelScope, change: InventoryChange): Promise<void> {
  if (change.roomIds.length === 0) return
  const inventory = bookingRepos(db, scope).inventory
  const claims = await inventory.liveClaims(change.roomIds, change.from, change.to)
  if (claims.length === 0) return

  const lastNight = claims.reduce((last, c) => maxIsoDate(last, addDays(c.checkOut, -1)), change.from)
  const range: NightRange = {
    from: maxIsoDate(change.from, claims.reduce((first, c) => minIsoDate(first, c.checkIn), claims[0]!.checkIn)),
    to: change.to === null ? lastNight : minIsoDate(change.to, lastNight),
  }
  const roomIds = [...new Set(claims.map(c => c.roomId))]
  const hotelScoped = hotelRepos(db, scope)
  const [rooms, seats, options] = await Promise.all([
    hotelScoped.inventoryRead.loadRoomInputs(range, { roomIds, includeBlocks: true, includeOutOfInventory: true }),
    inventory.seatsUsed(roomIds, range),
    calendarOptionsFor(hotelScoped),
  ])

  const misfits = findBookingMisfits(rooms, claims, seats, range, options)
  if (misfits.length > 0) {
    throw new ConflictError('BOOKING_CONFLICT', 'This change conflicts with existing bookings; move their pilgrims or cancel them first', { bookings: misfits })
  }
}
