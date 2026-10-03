import { type IsoDate, type NightRange, containsDate, fromEpochDay, rangeLength, toEpochDay } from '../../../shared/utils/dates'

export interface BaseVersion { validFrom: IsoDate, validTo: IsoDate | null, physicalBeds: number, sellableCapacity: number }
export interface CapacityOverride { periodId: string, validFrom: IsoDate, validTo: IsoDate, physicalBeds: number, sellableCapacity: number }
export type CapacitySource = 'BASE' | 'PERIOD_OVERRIDE'
export interface EffectiveCapacity { physicalBeds: number, sellableCapacity: number, source: CapacitySource, periodId: string | null }
export interface CapacitySegment extends NightRange, EffectiveCapacity {}

function baseCovers(v: BaseVersion, date: IsoDate): boolean {
  const e = toEpochDay(date)
  return toEpochDay(v.validFrom) <= e && (v.validTo === null || e <= toEpochDay(v.validTo))
}

export function baseAt(versions: BaseVersion[], date: IsoDate): BaseVersion | null {
  return versions.find(v => baseCovers(v, date)) ?? null
}

export function overrideAt(overrides: CapacityOverride[], date: IsoDate): CapacityOverride | null {
  return overrides.find(o => containsDate({ from: o.validFrom, to: o.validTo }, date)) ?? null
}

/** Base configuration only (ignores seasonal overrides). null = room is not in inventory that night. */
export function baseCapacityAt(versions: BaseVersion[], date: IsoDate): { physicalBeds: number, sellableCapacity: number } | null {
  const b = baseAt(versions, date)
  return b ? { physicalBeds: b.physicalBeds, sellableCapacity: b.sellableCapacity } : null
}

/**
 * Effective capacity on a night: a period override wins over the base version;
 * with no base version covering the night the room is not in inventory (null),
 * even if an override row exists.
 */
export function effectiveCapacityAt(versions: BaseVersion[], overrides: CapacityOverride[], date: IsoDate): EffectiveCapacity | null {
  const base = baseAt(versions, date)
  if (!base) return null
  const o = overrideAt(overrides, date)
  if (o) return { physicalBeds: o.physicalBeds, sellableCapacity: o.sellableCapacity, source: 'PERIOD_OVERRIDE', periodId: o.periodId }
  return { physicalBeds: base.physicalBeds, sellableCapacity: base.sellableCapacity, source: 'BASE', periodId: null }
}

export interface Interval { from: IsoDate, to: IsoDate | null }

/** An interval whose boundaries are already epoch days (`to: null` = open-ended). */
export interface DayInterval { from: number, to: number | null }

/**
 * Epoch-day cut points inside `[start, end]` (epoch days): `start` itself and every day at which any
 * interval starts or (the day after it) ends. The numeric core of `cutPoints` — callers that already
 * hold epoch days (see `prepareCapacity`) skip the ISO re-parse.
 */
export function cutDays(start: number, end: number, ...lists: ReadonlyArray<ReadonlyArray<DayInterval>>): number[] {
  const cuts = new Set<number>([start])
  for (const list of lists) {
    for (const i of list) {
      if (i.from > start && i.from <= end) cuts.add(i.from)
      if (i.to !== null) {
        const after = i.to + 1
        if (after > start && after <= end) cuts.add(after)
      }
    }
  }
  return [...cuts].sort((a, b) => a - b)
}

/** Epoch-day boundaries inside `range` at which any interval starts or (the day after it) ends. */
export function cutPoints(range: NightRange, intervals: Interval[]): number[] {
  return cutDays(toEpochDay(range.from), toEpochDay(range.to), intervals.map(i => ({ from: toEpochDay(i.from), to: i.to === null ? null : toEpochDay(i.to) })))
}

/**
 * A room's base versions and overrides with their dates parsed to epoch days ONCE (each ISO string is
 * validated and parsed a single time instead of once per night examined), in their original order, so
 * `capacityOnDay` answers exactly what `effectiveCapacityAt` answers for the same night.
 */
export interface PreparedCapacity {
  versions: Array<DayInterval & { version: BaseVersion }>
  overrides: Array<{ from: number, to: number, override: CapacityOverride }>
}

export function prepareCapacity(versions: BaseVersion[], overrides: CapacityOverride[]): PreparedCapacity {
  return {
    versions: versions.map(version => ({ from: toEpochDay(version.validFrom), to: version.validTo === null ? null : toEpochDay(version.validTo), version })),
    overrides: overrides.map(override => ({ from: toEpochDay(override.validFrom), to: toEpochDay(override.validTo), override })),
  }
}

/** `effectiveCapacityAt` for a prepared room and an epoch day: first covering base version, then first covering override. */
export function capacityOnDay(prepared: PreparedCapacity, day: number): EffectiveCapacity | null {
  const base = prepared.versions.find(v => v.from <= day && (v.to === null || day <= v.to))?.version
  if (!base) return null
  const o = prepared.overrides.find(x => day >= x.from && day <= x.to)?.override
  if (o) return { physicalBeds: o.physicalBeds, sellableCapacity: o.sellableCapacity, source: 'PERIOD_OVERRIDE', periodId: o.periodId }
  return { physicalBeds: base.physicalBeds, sellableCapacity: base.sellableCapacity, source: 'BASE', periodId: null }
}

const sameCapacity = (a: EffectiveCapacity, b: EffectiveCapacity) =>
  a.physicalBeds === b.physicalBeds && a.sellableCapacity === b.sellableCapacity && a.source === b.source && a.periodId === b.periodId

/** Run-length-encoded effective capacity over `range`; nights where the room is not in inventory produce no segment. */
export function capacitySegments(versions: BaseVersion[], overrides: CapacityOverride[], range: NightRange): CapacitySegment[] {
  const prepared = prepareCapacity(versions, overrides)
  const end = toEpochDay(range.to)
  const points = cutDays(toEpochDay(range.from), end, prepared.versions, prepared.overrides)
  const out: Array<{ from: number, to: number, cap: EffectiveCapacity }> = []
  points.forEach((s, i) => {
    const e = (points[i + 1] ?? end + 1) - 1
    const cap = capacityOnDay(prepared, s)
    if (!cap) return
    const last = out[out.length - 1]
    if (last && last.to + 1 === s && sameCapacity(last.cap, cap)) last.to = e
    else out.push({ from: s, to: e, cap })
  })
  return out.map(seg => ({ from: fromEpochDay(seg.from), to: fromEpochDay(seg.to), ...seg.cap }))
}

/** Lowest sellable capacity over every night of a stay; null if the room is not in inventory for the whole stay. */
export function minSellableOverStay(versions: BaseVersion[], overrides: CapacityOverride[], stay: NightRange): number | null {
  const segs = capacitySegments(versions, overrides, stay)
  if (segs.reduce((n, s) => n + rangeLength(s), 0) !== rangeLength(stay)) return null
  return Math.min(...segs.map(s => s.sellableCapacity))
}

/** Pairs of ranges that overlap — used by services to give a friendly error before the DB exclusion constraint fires. */
export function findOverlaps<T extends NightRange>(ranges: T[]): Array<[T, T]> {
  const sorted = [...ranges].sort((a, b) => toEpochDay(a.from) - toEpochDay(b.from))
  const out: Array<[T, T]> = []
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (toEpochDay(sorted[j]!.from) > toEpochDay(sorted[i]!.to)) break
      out.push([sorted[i]!, sorted[j]!])
    }
  }
  return out
}
