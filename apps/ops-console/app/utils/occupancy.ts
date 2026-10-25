import type { OccupancyClaimDto, OccupancyDayViewDto, OccupancyRoomDto, RoomNightState } from '@hajj/contracts/types/occupancy'
import { addDays, type IsoDate } from '@hajj/contracts/utils/dates'

/** v7 §14: green under half full, yellow up to nine tenths, red beyond. */
const HALF = 50
const NINE_TENTHS = 90
export type FillTone = 'low' | 'mid' | 'high'
export function fillTone(percent: number): FillTone {
  if (percent < HALF) return 'low'
  return percent <= NINE_TENTHS ? 'mid' : 'high'
}

const DAYS_IN_WEEK = 7

/** The first and last night of a month (`YYYY-MM`). */
export function monthRange(month: string): { from: IsoDate, to: IsoDate } {
  const [year, index] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

const MONTHS_IN_YEAR = 12
/** The month `by` months from `month` (`YYYY-MM`). */
export function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split('-').map(Number) as [number, number]
  const total = year * MONTHS_IN_YEAR + (index - 1) + by
  return `${Math.floor(total / MONTHS_IN_YEAR)}-${String((total % MONTHS_IN_YEAR) + 1).padStart(2, '0')}`
}

/** A month as weeks from Sunday (the week in Saudi Arabia): each a row of 7, `null` outside the month. */
export function monthGrid(month: string): Array<Array<IsoDate | null>> {
  const { from, to } = monthRange(month)
  const leading = new Date(`${from}T00:00:00Z`).getUTCDay()
  const days: Array<IsoDate | null> = [...Array.from({ length: leading }, () => null)]
  for (let night = from; night <= to; night = addDays(night, 1)) days.push(night)
  while (days.length % DAYS_IN_WEEK) days.push(null)
  return Array.from({ length: days.length / DAYS_IN_WEEK }, (_, week) => days.slice(week * DAYS_IN_WEEK, (week + 1) * DAYS_IN_WEEK))
}

/** The day view's filters (v7 §14): an agency (or `INDIVIDUAL`: individuals and families), side, state, room type. */
export interface DayFilters { agency?: string, occupancy?: string, state?: RoomNightState | string, roomType?: string }
export const INDIVIDUAL = 'INDIVIDUAL'

export function roomMatches(room: OccupancyRoomDto, filters: DayFilters): boolean {
  if (filters.state && room.state !== filters.state) return false
  if (filters.roomType && room.roomType.id !== filters.roomType) return false
  if (filters.agency && !room.claims.some(c => (filters.agency === INDIVIDUAL ? c.booker.agencyId === null : c.booker.agencyId === filters.agency))) return false
  if (filters.occupancy && !room.claims.some(c => c.occupancy === filters.occupancy)) return false
  return true
}

/** One booking at the desk on a day: its rooms that night, its pilgrims and how many still lack their details. */
export interface DeskBooking { bookingId: string, bookingNo: string, booker: OccupancyClaimDto['booker'], rooms: string[], pilgrims: number, detailsPending: number, checkIn: IsoDate, checkOut: IsoDate }

function bookingsWhere(day: OccupancyDayViewDto, wanted: (claim: OccupancyClaimDto) => boolean): DeskBooking[] {
  const found = new Map<string, DeskBooking>()
  for (const room of day.floors.flatMap(f => f.rooms)) {
    for (const claim of room.claims.filter(wanted)) {
      const known = found.get(claim.bookingId)
      const pending = claim.guests.filter(g => !g.detailsComplete).length
      found.set(claim.bookingId, known
        ? { ...known, rooms: [...known.rooms, room.roomNumber], pilgrims: known.pilgrims + claim.guests.length, detailsPending: known.detailsPending + pending }
        : { bookingId: claim.bookingId, bookingNo: claim.bookingNo, booker: claim.booker, rooms: [room.roomNumber], pilgrims: claim.guests.length, detailsPending: pending, checkIn: claim.checkIn, checkOut: claim.checkOut })
    }
  }
  return [...found.values()]
}

/** The bookings arriving on the day's night (the day view of that date). */
export const arrivalsOf = (day: OccupancyDayViewDto): DeskBooking[] => bookingsWhere(day, c => c.checkIn === day.date)

/** The bookings leaving on `date`: from the day view of the night before, those whose stay ends that morning. */
export const departuresOf = (nightBefore: OccupancyDayViewDto, date: IsoDate): DeskBooking[] => bookingsWhere(nightBefore, c => c.checkOut === date)

/** What a spreadsheet must not read as a formula (a name typed as `=…` would run when the file is opened). */
const FORMULA_START = /^[=+\-@\t\r]/
function cell(value: string | number): string {
  const text = String(value)
  const safe = FORMULA_START.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export interface CsvLabels { header: string[], state: (state: string) => string, status: (status: string) => string, individual: string, agency: string }

/** Who booked, in words: the agency's name (or "agency" when unnamed), or an individual. */
export const bookerName = (booker: OccupancyClaimDto['booker'], labels: { individual: string, agency: string }): string =>
  booker.name ?? (booker.agencyId ? labels.agency : labels.individual)

/**
 * The day as a spreadsheet for the desk (v7 §14 "download the day's list"): a line per pilgrim — floor, room, its
 * state, places taken and places (two numbers: "2/4" would read as a date), booking, who booked, the pilgrim and their
 * status — an empty room on its own line. UTF-8 with a byte-order mark, so Excel reads Arabic names; never a passport
 * number (the day view has none).
 */
export function csvOf(day: OccupancyDayViewDto, labels: CsvLabels): string {
  const lines: Array<Array<string | number>> = [labels.header]
  for (const floor of day.floors) {
    for (const room of floor.rooms) {
      const where = [floor.label, room.roomNumber, labels.state(room.state), room.booked, room.capacity]
      if (!room.claims.length) lines.push([...where, '', '', '', ''])
      for (const claim of room.claims) {
        for (const guest of claim.guests) lines.push([...where, claim.bookingNo, bookerName(claim.booker, labels), guest.name ?? '', labels.status(guest.status)])
      }
    }
  }
  return `\uFEFF${lines.map(line => line.map(cell).join(',')).join('\r\n')}\r\n`
}
