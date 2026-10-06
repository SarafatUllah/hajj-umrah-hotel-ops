import type { NewCapacityPeriod, NewFloor, NewRoom, NewRoomBaseConfig, NewRoomCapacityOverride, NewRoomOperationalBlock } from '../../../server/repositories/hotel'
import type { NewHotel, NewRoomType } from '../../../server/repositories/tenant'
import { DEMO_HOTELS, DEMO_ROOM_TYPES, DEMO_SHOWCASE_ROOM, ROOM_TYPE_CODES, type DemoHotelSpec, type DemoRoomTypeCode } from '../../../server/demo/catalog'
import type { BlockKind, CapacityPeriodKind } from '../../../shared/constants/inventory'
import { type IsoDate, type NightRange, addDays, rangeLength, toEpochDay } from '../../../shared/utils/dates'
import { type BaseVersion, capacitySegments } from '../../../server/domain/inventory/capacity'
import { demoIds } from './ids'
import { shuffled, streamFor } from './random'

/**
 * The pure, deterministic demo inventory generator (Task 20): no database access, no clock, no
 * `Math.random`. Everything is derived from the catalogue, fixed calendar dates, the anchor date and
 * per-hotel seeded streams (`<hotelCode>|<purpose>`), so the same anchor always yields the same plan.
 *
 * Fixed-calendar items (seasonal periods, the lifecycle dates of retirements/renovations) are absolute
 * dates; running maintenance, ended-early and historical blocks are anchor-relative.
 */

// ---- fixed calendar (data, not rules: Q4) -----------------------------------------------------------
const FLAGGED_FROM = '2026-01-01' // sellable < beds starts AFTER the 2025-07-01 reference date, so catalogue capacities hold there
const RENOVATION_FROM = '2026-03-01'
const RETIRE_FROM = '2026-04-01'
const GAP_CLOSED_FROM = '2026-05-01'
const GAP_REACTIVATED_FROM = '2026-07-01'
const AZIZ_FLOOR_RETIRE_FROM = '2026-06-01'
const SCHEDULED_RETIRE_FROM = '2027-09-01'
const PRE_HAJJ_MAINTENANCE = { from: '2027-02-01', to: '2027-03-01' }
const AZIZ_CLOSED_LEVEL = 6
const FLAGGED_SHARE = 0.05
const RENOVATED_SHARE = 0.08
const MAX_BEDS = 6

interface PeriodDef {
  key: string
  name: string
  kind: CapacityPeriodKind
  startDate: IsoDate
  endDate: IsoDate
  hotels: 'all' | readonly string[]
  notes: string
}

const PERIODS: readonly PeriodDef[] = [
  { key: 'ramadan-2026', name: 'Ramadan 2026', kind: 'RAMADAN', startDate: '2026-02-18', endDate: '2026-03-19', hotels: 'all', notes: 'Ramadan 2026: extra beds fitted in selected rooms for family and group Umrah stays' },
  { key: 'hajj-2026', name: 'Hajj 2026', kind: 'HAJJ', startDate: '2026-05-01', endDate: '2026-07-31', hotels: 'all', notes: 'Hajj 2026 season: pilgrim-group capacity with additional beds in selected rooms' },
  { key: 'umrah-peak-2026-12', name: 'Umrah Peak Dec 2026', kind: 'SPECIAL', startDate: '2026-12-15', endDate: '2027-01-15', hotels: ['MKK-AJYAD', 'MKK-AZIZ'], notes: 'Winter Umrah peak: school-holiday family groups, extra beds in selected rooms' },
  { key: 'ramadan-2027', name: 'Ramadan 2027', kind: 'RAMADAN', startDate: '2027-02-08', endDate: '2027-03-09', hotels: 'all', notes: 'Ramadan 2027: extra beds fitted in selected rooms for family and group Umrah stays' },
  { key: 'hajj-2027', name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31', hotels: 'all', notes: 'Hajj 2027 season: pilgrim-group capacity with additional beds in selected rooms' },
  { key: 'hajj-2028', name: 'Hajj 2028', kind: 'HAJJ', startDate: '2028-04-19', endDate: '2028-07-19', hotels: ['MKK-GRAND', 'MKK-AJYAD'], notes: 'Hajj 2028 season (early dates): pilgrim-group capacity planned well ahead' },
]

/** Share of the eligible rooms that get an override, and the beds added (cap `MAX_BEDS`), per period kind and city. */
function overrideProfile(kind: CapacityPeriodKind, city: DemoHotelSpec['city']): { min: number, max: number, extraBeds: number } {
  if (kind === 'HAJJ') return city === 'Makkah' ? { min: 0.70, max: 0.80, extraBeds: 2 } : { min: 0.50, max: 0.60, extraBeds: 1 }
  return { min: 0.40, max: 0.50, extraBeds: 1 } // RAMADAN and SPECIAL
}

// ---- plan types -------------------------------------------------------------------------------------
interface Version extends BaseVersion {
  reason: string | null
  origin: 'SEED' | 'MANUAL'
}

export interface RoomPlan {
  row: NewRoom & { id: string }
  roomNumber: string
  level: number
  typeCode: DemoRoomTypeCode
  versions: Version[]
}

export type BlockLifecyclePlan =
  | { kind: 'ACTIVE' }
  | { kind: 'CANCELLED', at: Date, reason: string }
  | { kind: 'ENDED_EARLY', at: Date, newEndDate: IsoDate, reason: string }

export interface BlockPlan {
  row: NewRoomOperationalBlock & { id: string }
  roomNumber: string
  lifecycle: BlockLifecyclePlan
}

export interface HotelPlan {
  spec: DemoHotelSpec
  hotel: NewHotel & { id: string }
  floors: Array<NewFloor & { id: string }>
  rooms: RoomPlan[]
  versions: Array<NewRoomBaseConfig & { id: string }>
  periods: Array<NewCapacityPeriod & { id: string }>
  overrides: Array<NewRoomCapacityOverride & { id: string }>
  blocks: BlockPlan[]
  /** Persona key whose user id is recorded as the actor of this hotel's blocks. */
  actorPersonaKey: string
}

export interface DemoPlan {
  anchorDate: IsoDate
  roomTypes: Array<NewRoomType & { id: string }>
  hotels: HotelPlan[]
}

// ---- helpers ----------------------------------------------------------------------------------------
const pad2 = (n: number) => String(n).padStart(2, '0')
const range = (from: IsoDate, to: IsoDate): NightRange => ({ from, to })

/** A deterministic business timestamp (09:00 UTC on `date`); never derived from the wall clock. */
function timestampOn(date: IsoDate, hourUtc = 9): Date {
  return new Date(toEpochDay(date) * 86_400_000 + hourUtc * 3_600_000)
}

/** The SAME coverage rule the application uses for overrides and blocks (Task 15 `coversEveryNight`): base versions alone must cover every night. */
export function versionsCoverEveryNight(versions: readonly BaseVersion[], nights: NightRange): boolean {
  const covered = capacitySegments([...versions], [], nights).reduce((n, s) => n + rangeLength(s), 0)
  return covered === rangeLength(nights)
}

function openVersion(versions: Version[]): Version {
  const current = versions.at(-1)
  if (!current || current.validTo !== null) throw new Error('Demo generator: expected an open base version')
  return current
}

/** A permanent base change effective `from`: closes the open version the day before and opens a new one. */
function changeBase(versions: Version[], from: IsoDate, next: { physicalBeds: number, sellableCapacity: number, reason: string, origin: 'SEED' | 'MANUAL' }): void {
  const current = openVersion(versions)
  if (toEpochDay(from) <= toEpochDay(current.validFrom)) throw new Error(`Demo generator: change at ${from} must follow the current version (${current.validFrom})`)
  current.validTo = addDays(from, -1)
  versions.push({ validFrom: from, validTo: null, ...next })
}

function retire(versions: Version[], effectiveFrom: IsoDate): void {
  const current = openVersion(versions)
  if (toEpochDay(effectiveFrom) <= toEpochDay(current.validFrom)) throw new Error(`Demo generator: retirement at ${effectiveFrom} must follow the current version (${current.validFrom})`)
  current.validTo = addDays(effectiveFrom, -1)
}

function reactivate(versions: Version[], from: IsoDate, reason: string): void {
  const last = versions.at(-1)
  if (!last || last.validTo === null) throw new Error('Demo generator: expected a retired room')
  versions.push({ validFrom: from, validTo: null, physicalBeds: last.physicalBeds, sellableCapacity: last.sellableCapacity, reason, origin: 'SEED' })
}

function baseAtStart(versions: readonly Version[], date: IsoDate): Version | undefined {
  return versions.find(v => toEpochDay(v.validFrom) <= toEpochDay(date) && (v.validTo === null || toEpochDay(date) <= toEpochDay(v.validTo)))
}

function actorPersonaKeyFor(spec: DemoHotelSpec): string {
  if (spec.code === 'MKK-GRAND') return 'manager.grand'
  if (spec.city === 'Madinah') return 'manager.madinah'
  return 'admin'
}

// ---- rooms ------------------------------------------------------------------------------------------
function buildRooms(spec: DemoHotelSpec): RoomPlan[] {
  const typeByCode = new Map(DEMO_ROOM_TYPES.map(t => [t.code, t]))
  const rand = streamFor(spec.code, 'room-types')
  const typeBag: DemoRoomTypeCode[] = []
  for (const code of ROOM_TYPE_CODES) for (let i = 0; i < spec.distribution[code]; i++) typeBag.push(code)
  if (typeBag.length !== spec.rooms || spec.floors * spec.roomsPerFloor !== spec.rooms) throw new Error(`Demo catalogue for ${spec.code} is inconsistent`)
  const assigned = shuffled(typeBag, rand)

  const featureRand = streamFor(spec.code, 'features')
  const rooms: RoomPlan[] = []
  let index = 0
  for (let f = 0; f < spec.floors; f++) {
    const level = spec.firstLevel + f
    for (let seq = 1; seq <= spec.roomsPerFloor; seq++) {
      const roomNumber = `${level}${pad2(seq)}`
      const typeCode = assigned[index++]!
      const beds = typeByCode.get(typeCode)!.beds
      const r = featureRand()
      const features: string[] = []
      if (f === 0 && seq <= 2) features.push('ACCESSIBLE')
      if (spec.city === 'Makkah') {
        if (r < 0.2) features.push('HARAM_VIEW')
        else if (r < 0.3) features.push('CITY_VIEW')
      }
      else if (r < 0.25) features.push('CITY_VIEW')
      rooms.push({
        row: { id: demoIds.room(spec.code, roomNumber), floorId: demoIds.floor(spec.code, level), roomTypeId: demoIds.roomType(typeCode), roomNumber, features, notes: null },
        roomNumber,
        level,
        typeCode,
        versions: [{ validFrom: spec.inServiceFrom, validTo: null, physicalBeds: beds, sellableCapacity: beds, reason: 'Initial inventory', origin: 'SEED' }],
      })
    }
  }

  // The showcase room is forced to be a Quad on its level (swap with a Quad elsewhere when the shuffle disagreed).
  if (spec.code === DEMO_SHOWCASE_ROOM.hotelCode) {
    const showcase = rooms.find(r => r.roomNumber === DEMO_SHOWCASE_ROOM.roomNumber)!
    if (showcase.typeCode !== DEMO_SHOWCASE_ROOM.roomType) {
      const donor = rooms.find(r => r.typeCode === DEMO_SHOWCASE_ROOM.roomType && r !== showcase)!
      const retypes: Array<[RoomPlan, DemoRoomTypeCode]> = [[donor, showcase.typeCode], [showcase, DEMO_SHOWCASE_ROOM.roomType]]
      for (const [target, code] of retypes) {
        const beds = typeByCode.get(code)!.beds
        target.typeCode = code
        target.row.roomTypeId = demoIds.roomType(code)
        target.versions[0]!.physicalBeds = beds
        target.versions[0]!.sellableCapacity = beds
      }
    }
  }
  return rooms
}

/** Flagged (sellable < beds), renovated (+1 bed) and lifecycle rooms are disjoint sets; the showcase room and a closed floor's rooms stay out of all of them. */
function applyHistory(spec: DemoHotelSpec, rooms: RoomPlan[]): void {
  const isShowcase = (r: RoomPlan) => spec.code === DEMO_SHOWCASE_ROOM.hotelCode && r.roomNumber === DEMO_SHOWCASE_ROOM.roomNumber
  const closedFloor = (r: RoomPlan) => spec.code === 'MKK-AZIZ' && r.level === AZIZ_CLOSED_LEVEL
  const taken = new Set<RoomPlan>()
  const pick = (purpose: string, count: number, accept: (r: RoomPlan) => boolean): RoomPlan[] => {
    const chosen = shuffled(rooms.filter(r => !taken.has(r) && !isShowcase(r) && accept(r)), streamFor(spec.code, purpose)).slice(0, count)
    for (const r of chosen) taken.add(r)
    return chosen
  }

  // The closed floor is retired as a whole; its rooms take part in nothing else.
  if (spec.code === 'MKK-AZIZ') {
    for (const r of rooms.filter(closedFloor)) {
      taken.add(r)
      retire(r.versions, AZIZ_FLOOR_RETIRE_FROM)
    }
  }

  for (const r of pick('flagged', Math.round(spec.rooms * FLAGGED_SHARE), () => true)) {
    const beds = r.versions[0]!.physicalBeds
    changeBase(r.versions, FLAGGED_FROM, { physicalBeds: beds, sellableCapacity: Math.max(1, beds - 1), reason: 'Connecting room: one bed held back (staff/linen)', origin: 'MANUAL' })
    if (!r.row.features?.includes('CONNECTING')) r.row.features = [...(r.row.features ?? []), 'CONNECTING']
    r.row.notes = 'Connecting room: one bed is held back, so sellable capacity is below the physical beds'
  }

  for (const r of pick('renovations', Math.round(spec.rooms * RENOVATED_SHARE), r => r.versions[0]!.physicalBeds < MAX_BEDS)) {
    const cur = openVersion(r.versions)
    const beds = cur.physicalBeds + 1
    changeBase(r.versions, RENOVATION_FROM, { physicalBeds: beds, sellableCapacity: Math.min(beds, cur.sellableCapacity + 1), reason: 'Renovation: extra bed fitted', origin: 'MANUAL' })
  }

  for (const r of pick('retired', 2, () => true)) retire(r.versions, RETIRE_FROM)

  for (const r of pick('closed-gap', 1, () => true)) {
    retire(r.versions, GAP_CLOSED_FROM)
    reactivate(r.versions, GAP_REACTIVATED_FROM, 'Reopened after closure')
  }

  if (spec.code === 'MKK-GRAND') {
    for (const r of pick('scheduled-retire', 2, () => true)) retire(r.versions, SCHEDULED_RETIRE_FROM)
  }
}

// ---- periods and overrides --------------------------------------------------------------------------
function buildPeriodsAndOverrides(spec: DemoHotelSpec, rooms: RoomPlan[]): { periods: HotelPlan['periods'], overrides: HotelPlan['overrides'] } {
  const periods: HotelPlan['periods'] = []
  const overrides: HotelPlan['overrides'] = []
  for (const def of PERIODS) {
    if (def.hotels !== 'all' && !def.hotels.includes(spec.code)) continue
    periods.push({ id: demoIds.period(spec.code, def.key), name: def.name, kind: def.kind, startDate: def.startDate, endDate: def.endDate, notes: def.notes })

    const nights = range(def.startDate, def.endDate)
    const profile = overrideProfile(def.kind, spec.city)
    const rand = streamFor(spec.code, def.key)
    const share = profile.min + rand() * (profile.max - profile.min)
    const eligible = rooms.filter(r => versionsCoverEveryNight(r.versions, nights) && baseAtStart(r.versions, def.startDate)!.physicalBeds < MAX_BEDS)
    const showcase = spec.code === DEMO_SHOWCASE_ROOM.hotelCode && def.kind === 'HAJJ' ? eligible.find(r => r.roomNumber === DEMO_SHOWCASE_ROOM.roomNumber) : undefined
    const wanted = Math.round(eligible.length * share)
    const chosen = shuffled(eligible.filter(r => r !== showcase), rand).slice(0, Math.max(0, wanted - (showcase ? 1 : 0)))
    if (showcase) chosen.unshift(showcase)

    for (const r of chosen.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber))) {
      const base = baseAtStart(r.versions, def.startDate)!
      const beds = Math.min(MAX_BEDS, base.physicalBeds + profile.extraBeds)
      overrides.push({
        id: demoIds.override(spec.code, def.key, r.roomNumber),
        roomId: r.row.id,
        periodId: demoIds.period(spec.code, def.key),
        validFrom: def.startDate,
        validTo: def.endDate,
        physicalBeds: beds,
        sellableCapacity: beds,
        reason: `${def.name}: extra beds`,
        createdBy: demoIds.user('admin'),
      })
    }
  }
  return { periods, overrides }
}

// ---- blocks -----------------------------------------------------------------------------------------
interface PlacedBlock { kind: BlockKind, from: IsoDate, to: IsoDate }

const MAINTENANCE_REASONS = ['Bathroom refurbishment', 'Plumbing inspection', 'Repainting and touch-ups', 'Carpet replacement', 'Electrical rewiring', 'Window seal replacement']
const OPERATIONAL_REASONS = ['Reserved for management', 'Staff accommodation', 'VIP guest hold', 'Group allocation hold']
const OUT_OF_SERVICE_REASONS = ['AC failure', 'Water leak', 'Electrical fault', 'Door lock replacement']

function buildBlocks(spec: DemoHotelSpec, rooms: RoomPlan[], anchor: IsoDate): BlockPlan[] {
  const rand = streamFor(spec.code, 'blocks')
  const pool = rooms.filter(r => !(spec.code === DEMO_SHOWCASE_ROOM.hotelCode && r.roomNumber === DEMO_SHOWCASE_ROOM.roomNumber))
  const placed = new Map<string, PlacedBlock[]>()
  const actor = demoIds.user(actorPersonaKeyFor(spec))
  const blocks: BlockPlan[] = []
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1))
  const rel = (days: number) => addDays(anchor, days)

  // The same exclusion rule the database enforces: no two ACTIVE blocks of the same kind on the same room may share a night.
  // Cancelled / ended-early rows are checked over their ORIGINAL range too (they are active when first written), which is stricter than needed.
  const place = (key: string, kind: BlockKind, from: IsoDate, to: IsoDate, reason: string, lifecycle: BlockLifecyclePlan): void => {
    const nights = range(from, to)
    for (const candidate of shuffled(pool, rand)) {
      if (!versionsCoverEveryNight(candidate.versions, nights)) continue
      const existing = placed.get(candidate.roomNumber) ?? []
      if (existing.some(p => p.kind === kind && toEpochDay(p.from) <= toEpochDay(to) && toEpochDay(from) <= toEpochDay(p.to))) continue
      placed.set(candidate.roomNumber, [...existing, { kind, from, to }])
      blocks.push({
        row: { id: demoIds.block(spec.code, key), roomId: candidate.row.id, kind, startDate: from, endDate: to, reason, createdBy: actor },
        roomNumber: candidate.roomNumber,
        lifecycle,
      })
      return
    }
    // No room fits (only possible for unusual anchors): the block is skipped rather than violating a rule.
  }
  const active: BlockLifecyclePlan = { kind: 'ACTIVE' }

  // Running maintenance at the anchor (exactly four per hotel).
  for (let i = 0; i < 4; i++) {
    const from = rel(-between(2, 20))
    place(`maintenance-running-${i}`, 'MAINTENANCE', from, rel(between(3, 40)), MAINTENANCE_REASONS[(i + between(0, 1)) % MAINTENANCE_REASONS.length]!, active)
  }
  // Pre-Hajj maintenance at the Makkah hotels (fixed calendar).
  if (spec.city === 'Makkah') {
    for (let i = 0; i < 4; i++) place(`maintenance-pre-hajj-${i}`, 'MAINTENANCE', PRE_HAJJ_MAINTENANCE.from, PRE_HAJJ_MAINTENANCE.to, 'Pre-Hajj preventive maintenance', active)
  }
  // Operational blocks: past, running and future.
  const operationalStarts = [-120, -45, -10, 20, 60, 150]
  operationalStarts.forEach((offset, i) => {
    const from = rel(offset)
    place(`operational-${i}`, 'OPERATIONAL_BLOCK', from, addDays(from, between(10, 50)), OPERATIONAL_REASONS[i % OPERATIONAL_REASONS.length]!, active)
  })
  // Out of service: past, running and future; one 90-day example at MKK-GRAND.
  const outOfServiceStarts = [-70, -5, 12, 45]
  outOfServiceStarts.forEach((offset, i) => {
    const from = rel(offset)
    place(`out-of-service-${i}`, 'OUT_OF_SERVICE', from, addDays(from, between(3, 14)), OUT_OF_SERVICE_REASONS[i % OUT_OF_SERVICE_REASONS.length]!, active)
  })
  if (spec.code === 'MKK-GRAND') place('out-of-service-long', 'OUT_OF_SERVICE', rel(7), rel(7 + 89), 'Water leak: structural repair of the riser', active)
  // Historical maintenance (all ended before the anchor).
  for (let i = 0; i < 4; i++) {
    const to = rel(-(20 + 60 * i + between(0, 30)))
    place(`maintenance-history-${i}`, 'MAINTENANCE', addDays(to, -between(2, 11)), to, MAINTENANCE_REASONS[(i + 2) % MAINTENANCE_REASONS.length]!, active)
  }
  // Two cancelled blocks (unstarted when cancelled).
  const cancelKinds: BlockKind[] = ['OPERATIONAL_BLOCK', 'MAINTENANCE']
  cancelKinds.forEach((kind, i) => {
    const from = rel(between(10, 60))
    const reason = kind === 'MAINTENANCE' ? MAINTENANCE_REASONS[i]! : OPERATIONAL_REASONS[i]!
    place(`cancelled-${i}`, kind, from, addDays(from, between(5, 20)), reason, { kind: 'CANCELLED', at: timestampOn(rel(-(2 + i))), reason: i === 0 ? 'Allocation no longer required' : 'Works rescheduled by the contractor' })
  })
  // Two blocks ended early: the day AFTER `at` onward is released (end_date = yesterday, the planned last night is kept).
  const earlyKinds: BlockKind[] = ['MAINTENANCE', 'OUT_OF_SERVICE']
  earlyKinds.forEach((kind, i) => {
    const endedOn = rel(-(3 + i))
    const reason = kind === 'MAINTENANCE' ? MAINTENANCE_REASONS[i + 3]! : OUT_OF_SERVICE_REASONS[i + 1]!
    place(`ended-early-${i}`, kind, rel(-(25 + 10 * i)), rel(15 + 5 * i), reason, { kind: 'ENDED_EARLY', at: timestampOn(endedOn), newEndDate: addDays(endedOn, -1), reason: i === 0 ? 'Work finished ahead of schedule' : 'Fault repaired earlier than planned' })
  })

  return blocks
}

// ---- the plan ---------------------------------------------------------------------------------------
export function buildDemoPlan(anchorDate: IsoDate): DemoPlan {
  toEpochDay(anchorDate) // validates

  const roomTypes = DEMO_ROOM_TYPES.map(t => ({
    id: demoIds.roomType(t.code),
    code: t.code,
    name: t.name,
    defaultPhysicalBeds: t.beds,
    defaultSellableCapacity: t.beds,
    description: `${t.beds}-bed room`,
    sortOrder: t.sortOrder,
  }))

  const hotels: HotelPlan[] = DEMO_HOTELS.map((spec) => {
    const rooms = buildRooms(spec)
    applyHistory(spec, rooms)
    const { periods, overrides } = buildPeriodsAndOverrides(spec, rooms)

    const floors: HotelPlan['floors'] = []
    for (let f = 0; f < spec.floors; f++) {
      const level = spec.firstLevel + f
      floors.push({ id: demoIds.floor(spec.code, level), level, label: `Floor ${level}`, isActive: !(spec.code === 'MKK-AZIZ' && level === AZIZ_CLOSED_LEVEL) })
    }

    const versions: HotelPlan['versions'] = rooms.flatMap(r => r.versions.map(v => ({
      id: demoIds.baseVersion(spec.code, r.roomNumber, v.validFrom),
      roomId: r.row.id,
      validFrom: v.validFrom,
      validTo: v.validTo,
      physicalBeds: v.physicalBeds,
      sellableCapacity: v.sellableCapacity,
      origin: v.origin,
      reason: v.reason,
      createdBy: v.origin === 'MANUAL' ? demoIds.user('admin') : null,
    })))

    return {
      spec,
      hotel: { id: demoIds.hotel(spec.code), code: spec.code, name: spec.name, city: spec.city, country: 'SA', timezone: 'Asia/Riyadh', currency: 'SAR', checkInTime: '15:00', checkOutTime: '12:00', ownershipType: spec.ownership, status: 'ACTIVE' },
      floors,
      rooms,
      versions,
      periods,
      overrides,
      blocks: buildBlocks(spec, rooms, anchorDate),
      actorPersonaKey: actorPersonaKeyFor(spec),
    }
  })

  return { anchorDate, roomTypes, hotels }
}
