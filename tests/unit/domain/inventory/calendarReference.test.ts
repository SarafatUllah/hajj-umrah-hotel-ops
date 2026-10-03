import { describe, expect, it } from 'vitest'
import { buildRoomSegments, summarizeDaily, type CalendarSegment, type DailySummary, type RoomCalendarInput } from '../../../../server/domain/inventory/calendar'
import { capacitySegments } from '../../../../server/domain/inventory/capacity'
import type { BlockKind } from '../../../../shared/constants/inventory'
import { fromEpochDay, toEpochDay, type NightRange } from '../../../../shared/utils/dates'

/**
 * Pins the calendar derivation against an INDEPENDENT naive reference: one state per NIGHT, computed
 * by comparing ISO date strings (they sort chronologically) — no cut points, no epoch days, no
 * prepared inputs — then run-length encoded. Seeded, so every failure reproduces. The derivation
 * parses each date once and works on numbers; this proves that changed nothing observable.
 */

const KINDS: readonly BlockKind[] = ['OUT_OF_SERVICE', 'MAINTENANCE', 'OPERATIONAL_BLOCK']
const BASE = toEpochDay('2027-01-01')
const day = (n: number) => fromEpochDay(BASE + n)

function lcg(seed: number) {
  let s = seed >>> 0 // mulberry32
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
  const int = (a: number, b: number) => a + Math.floor(next() * (b - a + 1))
  return { next, int, pick: <T>(xs: readonly T[]) => xs[int(0, xs.length - 1)]! }
}
type Rng = ReturnType<typeof lcg>

function genRoom(rng: Rng, index: number, span: number): RoomCalendarInput {
  const { int, next, pick } = rng
  const versions: RoomCalendarInput['versions'] = []
  let cursor = int(-60, 30)
  const versionCount = int(0, 3)
  for (let k = 0; k < versionCount; k++) {
    const len = int(1, 200)
    const open = k === versionCount - 1 && next() < 0.5
    versions.push({ validFrom: day(cursor), validTo: open ? null : day(cursor + len - 1), physicalBeds: int(1, 8), sellableCapacity: int(0, 8) })
    cursor += len + (next() < 0.3 ? int(1, 20) : 0)
  }
  const overrides: RoomCalendarInput['overrides'] = []
  let at = int(-30, span)
  for (let k = 0, n = int(0, 4); k < n; k++) {
    const len = int(1, 90)
    overrides.push({ periodId: `p${int(1, 6)}`, validFrom: day(at), validTo: day(at + len - 1), physicalBeds: int(1, 9), sellableCapacity: int(0, 9) })
    at += len + int(0, 40)
  }
  const blocks: RoomCalendarInput['blocks'] = []
  for (let k = 0, n = int(0, 12); k < n; k++) {
    const start = int(-20, span + 10)
    // Different kinds overlap freely here (the pure derivation accepts any input).
    blocks.push({ id: `b${index}-${k}`, kind: pick(KINDS), from: day(start), to: day(start + int(0, 25)) })
  }
  return { roomId: `r${index}`, versions, overrides, blocks }
}

type State = Omit<CalendarSegment, 'from' | 'to'>

/** Everything but the dates, in a fixed key order (two segments merge iff these are equal). */
const stateKey = (s: object) => JSON.stringify(Object.entries(s).filter(([k]) => k !== 'from' && k !== 'to').sort(([a], [b]) => a < b ? -1 : 1))

/** One night, by plain string comparison. */
function naiveState(room: RoomCalendarInput, date: string, maintenanceBlocksSales: boolean): State {
  const base = room.versions.find(v => v.validFrom <= date && (v.validTo === null || date <= v.validTo))
  if (!base) return { status: 'NOT_IN_INVENTORY', sellable: false, physicalBeds: null, sellableCapacity: null, capacitySource: null, periodId: null, blockIds: [] }
  const override = room.overrides.find(o => o.validFrom <= date && date <= o.validTo)
  const covering = room.blocks.filter(b => b.from <= date && date <= b.to)
  const kinds = new Set(covering.map(b => b.kind))
  const status = kinds.has('OUT_OF_SERVICE') ? 'OUT_OF_SERVICE' : kinds.has('MAINTENANCE') ? 'MAINTENANCE' : kinds.has('OPERATIONAL_BLOCK') ? 'OPERATIONAL_BLOCK' : 'AVAILABLE'
  return {
    status,
    sellable: covering.every(b => b.kind === 'MAINTENANCE' && !maintenanceBlocksSales),
    physicalBeds: (override ?? base).physicalBeds,
    sellableCapacity: (override ?? base).sellableCapacity,
    capacitySource: override ? 'PERIOD_OVERRIDE' : 'BASE',
    periodId: override ? override.periodId : null,
    blockIds: covering.map(b => b.id).sort(),
  }
}

function naiveSegments(room: RoomCalendarInput, range: NightRange, maintenanceBlocksSales: boolean): CalendarSegment[] {
  const out: CalendarSegment[] = []
  for (let d = toEpochDay(range.from); d <= toEpochDay(range.to); d++) {
    const date = fromEpochDay(d)
    const state = naiveState(room, date, maintenanceBlocksSales)
    const last = out[out.length - 1]
    if (last && stateKey(last) === stateKey(state)) last.to = date
    else out.push({ from: date, to: date, ...state })
  }
  return out
}

function naiveSummary(rooms: RoomCalendarInput[], range: NightRange, maintenanceBlocksSales: boolean): DailySummary[] {
  const rows: DailySummary[] = []
  for (let d = toEpochDay(range.from); d <= toEpochDay(range.to); d++) {
    const date = fromEpochDay(d)
    const row: DailySummary = { date, roomsInInventory: 0, sellableRooms: 0, outOfService: 0, maintenance: 0, operationalBlock: 0, effectiveSellableCapacity: 0, sellableRoomCapacity: 0 }
    for (const room of rooms) {
      const s = naiveState(room, date, maintenanceBlocksSales)
      if (s.status === 'NOT_IN_INVENTORY') continue
      row.roomsInInventory++
      row.effectiveSellableCapacity += s.sellableCapacity!
      if (s.sellable) { row.sellableRooms++; row.sellableRoomCapacity += s.sellableCapacity! }
      if (s.status === 'OUT_OF_SERVICE') row.outOfService++
      if (s.status === 'MAINTENANCE') row.maintenance++
      if (s.status === 'OPERATIONAL_BLOCK') row.operationalBlock++
    }
    rows.push(row)
  }
  return rows
}

/** The capacity-only run-length encoding the averages use: no segment for nights outside inventory. */
function naiveCapacitySegments(room: RoomCalendarInput, range: NightRange) {
  const out: Array<{ from: string, to: string, physicalBeds: number, sellableCapacity: number, source: string, periodId: string | null }> = []
  for (let d = toEpochDay(range.from); d <= toEpochDay(range.to); d++) {
    const date = fromEpochDay(d)
    const s = naiveState(room, date, true)
    if (s.status === 'NOT_IN_INVENTORY') continue
    const cap = { physicalBeds: s.physicalBeds!, sellableCapacity: s.sellableCapacity!, source: s.capacitySource!, periodId: s.periodId }
    const last = out[out.length - 1]
    if (last && toEpochDay(last.to) + 1 === d && stateKey(last) === stateKey(cap)) last.to = date
    else out.push({ from: date, to: date, ...cap })
  }
  return out
}

describe('calendar derivation vs an independent per-night reference (seeded, exact equality)', () => {
  it('buildRoomSegments equals the naive per-night run-length encoding, for both maintenanceBlocksSales values, from a single night to 400 nights', () => {
    let compared = 0
    let multiSegment = 0
    for (let seed = 1; seed <= 60; seed++) {
      const rng = lcg(seed)
      const span = rng.pick([0, 0, 5, 30, 120, 399])
      const from = rng.int(-10, 20)
      const range = { from: day(from), to: day(from + span) }
      for (let i = 0; i < 6; i++) {
        const room = genRoom(rng, i, span)
        for (const maintenanceBlocksSales of [true, false]) {
          const actual = buildRoomSegments(room, range, { maintenanceBlocksSales })
          expect(JSON.stringify(actual), `seed ${seed} room ${i}`).toBe(JSON.stringify(naiveSegments(room, range, maintenanceBlocksSales)))
          if (actual.length > 1) multiSegment++
          compared++
        }
      }
    }
    expect(compared).toBe(720)
    expect(multiSegment).toBeGreaterThan(200) // the generator really produces layered rooms
  })

  it('summarizeDaily equals the naive per-night aggregation', () => {
    for (let seed = 100; seed < 130; seed++) {
      const rng = lcg(seed)
      const span = rng.pick([0, 7, 60, 399])
      const from = rng.int(-10, 20)
      const range = { from: day(from), to: day(from + span) }
      const rooms = Array.from({ length: rng.int(1, 12) }, (_, i) => genRoom(rng, i, span))
      for (const maintenanceBlocksSales of [true, false]) {
        expect(summarizeDaily(rooms, range, { maintenanceBlocksSales }), `seed ${seed}`).toEqual(naiveSummary(rooms, range, maintenanceBlocksSales))
      }
    }
  })

  it('capacitySegments (the Task 17 averages path) equals the naive capacity-only encoding', () => {
    for (let seed = 200; seed < 240; seed++) {
      const rng = lcg(seed)
      const span = rng.pick([0, 7, 60, 399])
      const from = rng.int(-10, 20)
      const range = { from: day(from), to: day(from + span) }
      const room = genRoom(rng, 0, span)
      const actual = capacitySegments(room.versions, room.overrides, range).map(s => ({ from: s.from, to: s.to, physicalBeds: s.physicalBeds, sellableCapacity: s.sellableCapacity, source: s.source, periodId: s.periodId }))
      expect(actual, `seed ${seed}`).toEqual(naiveCapacitySegments(room, range))
    }
  })

  it('a room with every block kind overlapping on the same nights reports the highest-precedence status and ALL block ids, sorted', () => {
    const room: RoomCalendarInput = {
      roomId: 'r',
      versions: [{ validFrom: '2027-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }],
      overrides: [],
      blocks: [
        { id: 'c', kind: 'OPERATIONAL_BLOCK', from: '2027-02-01', to: '2027-02-10' },
        { id: 'b', kind: 'MAINTENANCE', from: '2027-02-03', to: '2027-02-06' },
        { id: 'a', kind: 'OUT_OF_SERVICE', from: '2027-02-05', to: '2027-02-05' },
      ],
    }
    const range = { from: '2027-02-01', to: '2027-02-10' }
    for (const maintenanceBlocksSales of [true, false]) {
      expect(buildRoomSegments(room, range, { maintenanceBlocksSales })).toEqual(naiveSegments(room, range, maintenanceBlocksSales))
    }
    const mid = buildRoomSegments(room, range, { maintenanceBlocksSales: false }).find(s => s.from === '2027-02-05')!
    expect(mid).toMatchObject({ to: '2027-02-05', status: 'OUT_OF_SERVICE', sellable: false, blockIds: ['a', 'b', 'c'] })
  })
})
