import type { AgeGroup, BookingStatus, BookingType, GuestStatus, Occupancy } from '@hajj/contracts/constants/booking'
import type { CapacityPeriodKind, InventoryStatus } from '@hajj/contracts/constants/inventory'
import { eachDate, type IsoDate, type NightRange, todayInTimezone } from '@hajj/contracts/utils/dates'
import { dayTotals, type DayTotals, type RoomNight, roomNightState, type RoomNightState } from '../../domain/booking/occupancy'
import { buildRoomSegments } from '../../domain/inventory/calendar'
import { orgCan } from '../../domain/rbac/authorize'
import { bookingRepos, hotelRepos } from '../../repositories'
import type { NightClaim, NightGuest } from '../../repositories/booking'
import type { AuthContext } from '../../security/authContext'
import { authorizeHotel } from '../../security/authorize'
import type { HotelScope } from '../../security/scope'
import { findAgencyNames } from '../accounts'
import { calendarOptionsFor } from '../calendarOptions'

type Db = Parameters<typeof bookingRepos>[0]

/** One day of the year and month views (v7 §14): rooms by state, seats, fill, arrivals and departures. */
export interface OccupancyDayDto extends DayTotals {
  date: IsoDate
  arrivals: number
  departures: number
}

export interface OccupancyRangeDto {
  range: NightRange
  today: IsoDate
  /** Capacity periods in the range (Hajj and Ramadan are marked on the year view). */
  periods: Array<{ id: string, name: string, kind: CapacityPeriodKind, startDate: IsoDate, endDate: IsoDate }>
  days: OccupancyDayDto[]
}

/** A pilgrim on the day view: the name only for viewers with `pilgrim.view`, never a passport number. */
export interface OccupancyGuestDto { guestId: string, slotNo: number, ageGroup: AgeGroup, status: GuestStatus, name: string | null, detailsComplete: boolean }

export interface OccupancyClaimDto {
  bookingId: string
  bookingNo: string
  status: BookingStatus
  bookingType: BookingType
  /** An agency (with its name), or an individual / family booker (`agencyId` null). */
  booker: { agencyId: string | null, name: string | null }
  occupancy: Occupancy
  checkIn: IsoDate
  checkOut: IsoDate
  extraBeds: number
  guests: OccupancyGuestDto[]
}

export interface OccupancyRoomDto {
  roomId: string
  roomNumber: string
  roomType: { id: string, name: string }
  inventoryStatus: InventoryStatus
  state: RoomNightState
  capacity: number
  booked: number
  held: number
  claims: OccupancyClaimDto[]
}

export interface OccupancyFloorDto { id: string, level: number, label: string, rooms: OccupancyRoomDto[] }

/** Seated pilgrims and rooms of one booker that night; `agencyId` null = individuals and families together. */
export interface OccupancyBookerDto { agencyId: string | null, name: string | null, pilgrims: number, rooms: number }

export interface OccupancyDayViewDto {
  date: IsoDate
  today: IsoDate
  summary: OccupancyDayDto & { detailsPending: number, byBooker: OccupancyBookerDto[] }
  floors: OccupancyFloorDto[]
}

/** A room on a night, as the calendar engine and the bookings see it. */
interface RoomNightRow extends RoomNight { roomId: string, status: InventoryStatus }

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const group = groups.get(k)
    if (group) group.push(item)
    else groups.set(k, [item])
  }
  return groups
}

/**
 * Every room in inventory on each night of `range`: sellable and capacity from the calendar engine (versions,
 * seasonal overrides, blocks), seats taken from the bookings. Rooms out of inventory that night are left out.
 */
async function roomNights(db: Db, scope: HotelScope, range: NightRange) {
  const hotelScoped = hotelRepos(db, scope)
  const [loaded, options, seats] = await Promise.all([
    hotelScoped.inventoryRead.loadRoomInputs(range, { includeBlocks: true, withRefs: true }),
    calendarOptionsFor(hotelScoped),
    bookingRepos(db, scope).occupancy.nightlySeats(range),
  ])
  const taken = new Map(seats.map(s => [`${s.roomId}|${s.night}`, s]))
  const byDate = new Map<IsoDate, RoomNightRow[]>(eachDate(range).map(date => [date, []]))
  for (const room of loaded.rooms) {
    for (const segment of buildRoomSegments(room, range, options)) {
      if (segment.status === 'NOT_IN_INVENTORY') continue
      for (const night of eachDate({ from: segment.from, to: segment.to })) {
        const seat = taken.get(`${room.roomId}|${night}`)
        byDate.get(night)!.push({ roomId: room.roomId, status: segment.status, sellable: segment.sellable, capacity: segment.sellableCapacity ?? 0, booked: seat?.booked ?? 0, held: seat?.held ?? 0 })
      }
    }
  }
  return { byDate, periods: loaded.refs.periods }
}

/**
 * v7 §14 year and month views (`occupancy.view` on the hotel; inactive hotels are readable): per day of `range` (at
 * most 400 days) the rooms by state, the seats (pilgrims, holds, free), the fill and the confirmed arrivals and
 * departures. Agencies and customers never see it.
 */
export async function getOccupancy(ctx: AuthContext, hotelId: string, range: NightRange): Promise<OccupancyRangeDto> {
  const { hotel, scope } = await authorizeHotel(ctx, 'occupancy.view', hotelId, { allowInactive: true })
  const [{ byDate, periods }, movements] = await Promise.all([roomNights(ctx.db, scope, range), bookingRepos(ctx.db, scope).occupancy.movements(range)])
  const moves = new Map(movements.map(m => [m.day, m]))
  return {
    range,
    today: todayInTimezone(hotel.timezone, ctx.now()),
    periods: [...periods].map(([id, p]) => ({ id, name: p.name, kind: p.kind, startDate: p.startDate, endDate: p.endDate })),
    days: [...byDate].map(([date, nights]) => ({ date, ...dayTotals(nights), arrivals: moves.get(date)?.arrivals ?? 0, departures: moves.get(date)?.departures ?? 0 })),
  }
}

/** The bookers of the night: agencies by name (most pilgrims first), then individuals and families together. */
async function bookersOf(ctx: AuthContext, claims: readonly NightClaim[], seated: ReadonlyMap<string, number>): Promise<OccupancyBookerDto[]> {
  const byAgency = groupBy(claims, c => c.agencyId ?? '')
  const names = await findAgencyNames(ctx.db, ctx.scope, [...byAgency.keys()].filter(Boolean))
  const rows = [...byAgency].map(([agencyId, own]) => ({
    agencyId: agencyId || null,
    name: names.get(agencyId) ?? null,
    pilgrims: own.reduce((sum, c) => sum + (seated.get(c.bookingRoomId) ?? 0), 0),
    rooms: new Set(own.map(c => c.roomId)).size,
  }))
  return rows.sort((a, b) => Number(a.agencyId === null) - Number(b.agencyId === null) || b.pilgrims - a.pilgrims)
}

/**
 * v7 §14 day view (`occupancy.view`): floors → rooms → the bookings in each room and their pilgrims, with the day's
 * summary (rooms and seats, per booker, arrivals and departures, details still missing). Pilgrims' names show only
 * to viewers with `pilgrim.view`; passport data never.
 */
export async function getOccupancyDay(ctx: AuthContext, hotelId: string, date: IsoDate): Promise<OccupancyDayViewDto> {
  const { hotel, scope } = await authorizeHotel(ctx, 'occupancy.view', hotelId, { allowInactive: true })
  const range = { from: date, to: date }
  const occupancy = bookingRepos(ctx.db, scope).occupancy
  const [{ byDate }, candidates, claims, guests, movements] = await Promise.all([
    roomNights(ctx.db, scope, range),
    hotelRepos(ctx.db, scope).inventoryRead.listRoomCandidates(),
    occupancy.claimsOn(date),
    occupancy.guestsOn(date),
    occupancy.movements(range),
  ])
  const nights = byDate.get(date) ?? []
  const showNames = orgCan(ctx.authz, 'pilgrim.view')
  const guestsByClaim = groupBy(guests, g => g.bookingRoomId)
  const seated = new Map([...guestsByClaim].map(([claimId, list]) => [claimId, list.filter(g => g.ageGroup !== 'INFANT').length]))
  const bookers = await bookersOf(ctx, claims, seated)
  const agencyNames = new Map(bookers.map(b => [b.agencyId ?? '', b.name]))
  const claimsByRoom = groupBy(claims, c => c.roomId)
  const nightByRoom = new Map(nights.map(n => [n.roomId, n]))

  const toGuest = (g: NightGuest): OccupancyGuestDto => ({ guestId: g.guestId, slotNo: g.slotNo, ageGroup: g.ageGroup, status: g.status, name: showNames ? g.fullName || null : null, detailsComplete: g.status !== 'PENDING_DETAILS' })
  const toClaim = (c: NightClaim): OccupancyClaimDto => ({
    bookingId: c.bookingId,
    bookingNo: c.bookingNo,
    status: c.bookingStatus,
    bookingType: c.bookingType,
    booker: { agencyId: c.agencyId, name: agencyNames.get(c.agencyId ?? '') ?? null },
    occupancy: c.occupancy,
    checkIn: c.checkIn,
    checkOut: c.checkOut,
    extraBeds: c.extraBeds,
    guests: (guestsByClaim.get(c.bookingRoomId) ?? []).map(toGuest),
  })

  // Candidates come in the calendar's order (floor level, natural room number): one row per floor.
  const floors: OccupancyFloorDto[] = []
  for (const candidate of candidates) {
    const night = nightByRoom.get(candidate.id)
    if (!night) continue
    let floor = floors.at(-1)
    if (floor?.id !== candidate.floor.id) {
      floor = { ...candidate.floor, rooms: [] }
      floors.push(floor)
    }
    floor.rooms.push({
      roomId: candidate.id,
      roomNumber: candidate.roomNumber,
      roomType: { id: candidate.roomType.id, name: candidate.roomType.name },
      inventoryStatus: night.status,
      state: roomNightState(night),
      capacity: night.capacity,
      booked: night.booked,
      held: night.held,
      claims: (claimsByRoom.get(candidate.id) ?? []).map(toClaim),
    })
  }

  const move = movements.find(m => m.day === date)
  return {
    date,
    today: todayInTimezone(hotel.timezone, ctx.now()),
    summary: {
      date,
      ...dayTotals(nights),
      arrivals: move?.arrivals ?? 0,
      departures: move?.departures ?? 0,
      detailsPending: guests.filter(g => g.status === 'PENDING_DETAILS').length,
      byBooker: bookers,
    },
    floors,
  }
}
