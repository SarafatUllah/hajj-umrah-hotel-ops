import type { OwnershipType } from '../../shared/constants/inventory'
import { isValidIsoDate } from '../../shared/utils/dates'

/**
 * Demo hotel catalogue (Task 20). PURE DATA: no database, repository or secret imports. Shared by the
 * demo seed (db/seed/demo) and the demo sign-in endpoint (server/services/demoSignInService.ts), which
 * must be able to describe the demo hotels without reading any tenant table.
 */

export const DEMO_ORG_SLUG = 'demo'
export const DEMO_ORG_NAME = 'Al Safa Hajj & Umrah Hotels (Demo)'

/** The default `DEMO_ANCHOR_DATE`: every time-relative demo row (running maintenance, ended-early blocks, ...) hangs off it. */
export const DEFAULT_DEMO_ANCHOR_DATE = '2026-09-01'

/**
 * The demo anchor must be a real ISO date inside this window, so every anchor-relative row (up to about a
 * year either side of it) stays inside the calendar range the application supports (years 1900-2200).
 */
export const DEMO_ANCHOR_MIN = '2000-01-01'
export const DEMO_ANCHOR_MAX = '2100-12-31'
export function isValidDemoAnchorDate(value: string): boolean {
  // ISO dates sort lexicographically, so string comparison is a date comparison once the value is a real date.
  return isValidIsoDate(value) && value >= DEMO_ANCHOR_MIN && value <= DEMO_ANCHOR_MAX
}

export const ROOM_TYPE_CODES = ['TRIPLE', 'QUAD', 'QUINT', 'SIX_BED'] as const
export type DemoRoomTypeCode = typeof ROOM_TYPE_CODES[number]

export interface DemoRoomTypeSpec {
  code: DemoRoomTypeCode
  name: string
  beds: number
  sortOrder: number
}

/** The four organization-level room types: default physical beds = default sellable capacity = `beds`. */
export const DEMO_ROOM_TYPES: readonly DemoRoomTypeSpec[] = [
  { code: 'TRIPLE', name: 'Triple Room', beds: 3, sortOrder: 1 },
  { code: 'QUAD', name: 'Quad Room', beds: 4, sortOrder: 2 },
  { code: 'QUINT', name: 'Quint Room', beds: 5, sortOrder: 3 },
  { code: 'SIX_BED', name: 'Six-Bed Room', beds: 6, sortOrder: 4 },
]

export interface DemoHotelSpec {
  code: string
  name: string
  city: 'Makkah' | 'Madinah'
  ownership: OwnershipType
  /** First night the hotel's rooms are in inventory (start of every room's first base version). */
  inServiceFrom: string
  floors: number
  /** Level of the first floor; floors are consecutive. */
  firstLevel: number
  roomsPerFloor: number
  rooms: number
  distribution: Readonly<Record<DemoRoomTypeCode, number>>
  /** Sum of physical beds (= sellable capacity) of every room at the hotel's first base version. */
  initialCapacity: number
}

export const DEMO_ROOMS_PER_FLOOR = 10

export const DEMO_HOTELS: readonly DemoHotelSpec[] = [
  { code: 'MKK-GRAND', name: 'Al Safa Grand Makkah', city: 'Makkah', ownership: 'OWNED', inServiceFrom: '2025-01-01', floors: 10, firstLevel: 2, roomsPerFloor: DEMO_ROOMS_PER_FLOOR, rooms: 100, distribution: { TRIPLE: 10, QUAD: 40, QUINT: 30, SIX_BED: 20 }, initialCapacity: 460 },
  { code: 'MKK-AJYAD', name: 'Al Safa Ajyad Towers', city: 'Makkah', ownership: 'CONTRACTED', inServiceFrom: '2025-01-01', floors: 8, firstLevel: 1, roomsPerFloor: DEMO_ROOMS_PER_FLOOR, rooms: 80, distribution: { TRIPLE: 25, QUAD: 40, QUINT: 15, SIX_BED: 0 }, initialCapacity: 310 },
  { code: 'MKK-AZIZ', name: 'Al Safa Aziziyah Residence', city: 'Makkah', ownership: 'LEASED', inServiceFrom: '2025-01-01', floors: 6, firstLevel: 1, roomsPerFloor: DEMO_ROOMS_PER_FLOOR, rooms: 60, distribution: { TRIPLE: 0, QUAD: 18, QUINT: 24, SIX_BED: 18 }, initialCapacity: 300 },
  { code: 'MED-CENT', name: 'Al Safa Madinah Central', city: 'Madinah', ownership: 'OWNED', inServiceFrom: '2025-01-01', floors: 7, firstLevel: 1, roomsPerFloor: DEMO_ROOMS_PER_FLOOR, rooms: 70, distribution: { TRIPLE: 18, QUAD: 26, QUINT: 18, SIX_BED: 8 }, initialCapacity: 296 },
  { code: 'MED-QUBA', name: 'Al Safa Quba Suites', city: 'Madinah', ownership: 'OWNED', inServiceFrom: '2025-06-01', floors: 5, firstLevel: 1, roomsPerFloor: DEMO_ROOMS_PER_FLOOR, rooms: 50, distribution: { TRIPLE: 8, QUAD: 22, QUINT: 20, SIX_BED: 0 }, initialCapacity: 212 },
]

export const DEMO_HOTEL_CODES: readonly string[] = DEMO_HOTELS.map(h => h.code)

/** The room the demo story is told with: a Quad on level 4 of MKK-GRAND (normal 4/4, Hajj 2027 6/6). */
export const DEMO_SHOWCASE_ROOM = { hotelCode: 'MKK-GRAND', roomNumber: '401', level: 4, roomType: 'QUAD' as DemoRoomTypeCode }
