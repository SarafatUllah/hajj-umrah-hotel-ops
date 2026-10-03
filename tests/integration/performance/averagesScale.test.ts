import { performance } from 'node:perf_hooks'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { afterAll, describe, expect, it } from 'vitest'
import * as schema from '../../../db/schema'
import type { Database, DbOrTx } from '../../../db/client'
import { hotelRepos } from '../../../server/repositories'
import type { NewRoomBaseConfig, NewRoomCapacityOverride, NewRoomOperationalBlock } from '../../../server/repositories/hotel'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { getHotelAverages } from '../../../server/services/capacityAverageService'
import { BLOCK_KINDS } from '../../../shared/constants/inventory'
import { addDays } from '../../../shared/utils/dates'
import { makeHotel, makeOrg, makeRoomType } from '../../support/fixtures'
import { closeTestDb, getTestClient, getTestDb, truncateAllTables } from '../support/testDb'
import { requireTestDatabaseUrl } from '../support/testDatabase'

const db = getTestDb()

/**
 * A second client used ONLY for the measured calls: postgres.js's `debug` hook fires once for every
 * statement this client actually sends to the server, so the count below is measured, not assumed.
 */
const recorded: Array<{ query: string, params: unknown[] }> = []
let recording = false
const countingClient = postgres(requireTestDatabaseUrl(), {
  max: 4,
  onnotice: () => {},
  debug: (_connection, query, params) => {
    if (recording) recorded.push({ query, params: [...params] })
  },
})
const countingDb = drizzle(countingClient, { schema }) as Database

afterAll(async () => {
  await truncateAllTables()
  await countingClient.end()
  await closeTestDb()
})

const ROOMS = 2000
const ROOMS_PER_FLOOR = 200
const BATCH = 500

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/**
 * Test-only generator, written through the production repositories (no raw inserts): 2,000 rooms on
 * 10 floors; every 12th room has a dated base change (two versions); three capacity periods with
 * ~1,200 overrides each; 10 active blocks per room across 2027 (20,000 blocks) plus a few cancelled.
 */
async function generateHotel(tx: DbOrTx, scope: OrganizationScope) {
  const hotel = await makeHotel(tx, scope, { timezone: 'UTC' })
  const repos = hotelRepos(tx, trustedHotelScope(scope, hotel.id))
  const roomType = await makeRoomType(tx, scope)

  const floors = await repos.floors.insertMany(Array.from({ length: ROOMS / ROOMS_PER_FLOOR }, (_, i) => ({ level: i + 1, label: `Floor ${i + 1}` })))
  const roomValues = Array.from({ length: ROOMS }, (_, i) => {
    const floor = floors[Math.floor(i / ROOMS_PER_FLOOR)]!
    return { floorId: floor.id, roomTypeId: roomType.id, roomNumber: `${floor.level}${String(i % ROOMS_PER_FLOOR).padStart(3, '0')}`, features: [], notes: null }
  })
  const rooms = []
  for (const batch of chunks(roomValues, BATCH)) rooms.push(...await repos.rooms.insertMany(batch))

  const capacityOf = (i: number) => 3 + (i % 4) // 3..6
  const versions: NewRoomBaseConfig[] = rooms.flatMap((room, i) => i % 12 === 0
    ? [
        { roomId: room.id, validFrom: '2025-01-01', validTo: '2027-02-28', physicalBeds: capacityOf(i), sellableCapacity: capacityOf(i), origin: 'SEED' },
        { roomId: room.id, validFrom: '2027-03-01', validTo: null, physicalBeds: capacityOf(i) + 1, sellableCapacity: capacityOf(i) + 1, origin: 'SEED' },
      ]
    : [{ roomId: room.id, validFrom: '2025-01-01', validTo: null, physicalBeds: capacityOf(i), sellableCapacity: capacityOf(i), origin: 'SEED' }])
  for (const batch of chunks(versions, BATCH)) await repos.roomBaseConfigs.insertMany(batch)

  const periods = [
    { name: 'Ramadan 2027', kind: 'RAMADAN', startDate: '2027-02-08', endDate: '2027-03-09' },
    { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' },
    { name: 'Autumn 2027', kind: 'SPECIAL', startDate: '2027-10-01', endDate: '2027-10-15' },
  ]
  for (const [p, spec] of periods.entries()) {
    const period = await repos.capacityPeriods.insert({ ...spec, notes: null })
    const overrides: NewRoomCapacityOverride[] = rooms.filter((_, i) => (i + p) % 5 < 3).map(room => ({
      roomId: room.id, periodId: period.id, validFrom: spec.startDate, validTo: spec.endDate, physicalBeds: 6, sellableCapacity: 6, reason: null,
    }))
    for (const batch of chunks(overrides, BATCH)) await repos.roomCapacityOverrides.insertMany(batch)
  }

  const blocks: NewRoomOperationalBlock[] = rooms.flatMap((room, i) => Array.from({ length: 10 }, (_, k) => {
    const start = addDays('2027-01-03', k * 36 + (i % 30))
    return { roomId: room.id, kind: BLOCK_KINDS[(i + k) % BLOCK_KINDS.length]!, startDate: start, endDate: addDays(start, 2), reason: 'Generated' }
  }))
  const inserted = []
  for (const batch of chunks(blocks, 4000)) inserted.push(...await repos.operationalBlocks.insertMany(batch))
  for (const block of inserted.slice(0, 20)) await repos.operationalBlocks.markCancelled(block.id, new Date(), '00000000-0000-0000-0000-0000000000aa', 'Generated cancellation')

  return { hotel, overrideCount: rooms.filter((_, i) => i % 5 < 3).length, blockCount: blocks.length }
}

describe('10. capacity averages at scale (2,000 rooms, 120-day range)', () => {
  it('answers base + dateEffective + range + availableStay in < 1 s with <= 6 SQL statements (measured)', async () => {
    const { scope } = await makeOrg(db)
    const generated = await db.transaction(tx => generateHotel(tx, scope))
    expect(generated.blockCount).toBe(20_000)

    const ctx: AuthContext = {
      identity: { userId: '00000000-0000-0000-0000-0000000000aa', organizationId: scope.organizationId, email: 'scale@test.com', fullName: 'Scale' },
      authz: { permissions: new Set(['room.view']), allHotels: true, hotelIds: new Set() },
      scope,
      db: countingDb,
      now: () => new Date('2026-09-25T12:00:00Z'),
    }
    const query = { date: '2027-06-01', from: '2027-05-01', to: '2027-08-28', stayCheckIn: '2027-06-01', stayCheckOut: '2027-06-08', includeRoomIds: true }

    // Open ALL of the counting client's pooled connections first: postgres.js runs one `pg_type` lookup
    // per NEW connection (array-type discovery), which is connection setup, not work of the call.
    // Every statement of the measured calls themselves is still counted.
    await Promise.all(Array.from({ length: 4 }, () => countingClient`select pg_sleep(0.05)`))

    const measure = async () => {
      recorded.length = 0
      recording = true
      const started = performance.now()
      const result = await getHotelAverages(ctx, generated.hotel.id, query)
      const ms = performance.now() - started
      recording = false
      return { result, ms, statements: recorded.map(r => r.query) }
    }

    const first = await measure()
    const second = await measure()

    for (const run of [first, second]) {
      expect(run.statements.length, run.statements.join('\n')).toBeLessThanOrEqual(6)
      expect(run.ms).toBeLessThan(1000)
    }
    // Exactly: authorizeHotel's hotel read, the settings read, and the four inventory queries.
    expect(first.statements).toHaveLength(6)
    expect(first.statements.filter(s => s.includes('pg_type'))).toEqual([])

    const r = second.result
    expect(r.base.denominator).toBe(ROOMS)
    expect(r.dateEffective.denominator).toBe(ROOMS)
    expect(r.range).toMatchObject({ denominator: ROOMS * 120, basis: 'ROOM_NIGHTS' })
    expect(r.dateEffective.numerator).toBeGreaterThan(r.base.numerator)
    expect(r.availableStay!.eligibleRoomCount).toBeGreaterThan(0)
    expect(r.availableStay!.eligibleRoomCount).toBeLessThan(ROOMS)
    expect(r.availableStay!.eligibleRoomIds).toHaveLength(r.availableStay!.eligibleRoomCount)

    if (process.env.PERF_REPORT) {
      console.info(`[averagesScale] rooms=${ROOMS} overrides/period~${generated.overrideCount} blocks=${generated.blockCount} range=120d`
        + ` first=${first.ms.toFixed(1)}ms/${first.statements.length} stmts second=${second.ms.toFixed(1)}ms/${second.statements.length} stmts`)
    }
  }, 120_000)
})

const HISTORY_ROOMS = 100
const FIRST_YEAR = 2015
const LAST_YEAR = 2030

/**
 * A hotel with SIXTEEN years of history (2015…2030), through the production repositories: 100 rooms
 * (every 10th retired after 2020-12-31, every other 7th commissioned 2026-01-01), three capacity
 * periods a year with overrides on 60% of the rooms (2,880 overrides), and 10 blocks per room per year
 * (16,000 blocks). A far-away `date` must not drag this whole history into a request.
 */
async function generateHistoryHotel(tx: DbOrTx, scope: OrganizationScope) {
  const hotel = await makeHotel(tx, scope, { timezone: 'UTC' })
  const repos = hotelRepos(tx, trustedHotelScope(scope, hotel.id))
  const roomType = await makeRoomType(tx, scope)
  const [floor] = await repos.floors.insertMany([{ level: 1, label: 'Floor 1' }])
  const rooms = await repos.rooms.insertMany(Array.from({ length: HISTORY_ROOMS }, (_, i) => ({ floorId: floor!.id, roomTypeId: roomType.id, roomNumber: String(100 + i), features: [], notes: null })))

  const versions: NewRoomBaseConfig[] = rooms.map((room, i) => ({
    roomId: room.id,
    validFrom: i % 7 === 0 && i % 10 !== 0 ? '2026-01-01' : `${FIRST_YEAR}-01-01`,
    validTo: i % 10 === 0 ? '2020-12-31' : null,
    physicalBeds: 3 + (i % 4),
    sellableCapacity: 3 + (i % 4),
    origin: 'SEED',
  }))
  await repos.roomBaseConfigs.insertMany(versions)

  const overrides: NewRoomCapacityOverride[] = []
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
    const specs = [['RAMADAN', '02-08', '03-09'], ['HAJJ', '05-01', '07-31'], ['SPECIAL', '10-01', '10-15']] as const
    for (const [p, [kind, start, end]] of specs.entries()) {
      const period = await repos.capacityPeriods.insert({ name: `${kind} ${year}`, kind, startDate: `${year}-${start}`, endDate: `${year}-${end}`, notes: null })
      overrides.push(...rooms.filter((_, i) => (i + p) % 5 < 3).map(room => ({ roomId: room.id, periodId: period.id, validFrom: period.startDate, validTo: period.endDate, physicalBeds: 6, sellableCapacity: 6, reason: null })))
    }
  }
  for (const batch of chunks(overrides, BATCH)) await repos.roomCapacityOverrides.insertMany(batch)

  const blocks: NewRoomOperationalBlock[] = []
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
    rooms.forEach((room, i) => {
      for (let k = 0; k < 10; k++) {
        const start = addDays(`${year}-01-03`, k * 36 + (i % 30))
        blocks.push({ roomId: room.id, kind: BLOCK_KINDS[(i + k) % BLOCK_KINDS.length]!, startDate: start, endDate: addDays(start, 2), reason: 'Generated' })
      }
    })
  }
  for (const batch of chunks(blocks, 4000)) await repos.operationalBlocks.insertMany(batch)

  return { hotel, rooms, versions, overrides, blocks }
}

type History = Awaited<ReturnType<typeof generateHistoryHotel>>
interface Window { from: string, to: string }

/** ISO `YYYY-MM-DD` strings order like the dates they name. */
const overlaps = (from: string, to: string | null, w: Window) => from <= w.to && (to === null || to >= w.from)
const nightsOf = (w: Window) => {
  const out: string[] = []
  for (let d = w.from; d <= w.to; d = addDays(d, 1)) out.push(d)
  return out
}

/** An independent oracle over the generated rows (every room has exactly one base version here). */
function oracle(h: History, q: { date: string, range?: Window, stay?: Window }) {
  const versionOf = new Map(h.versions.map(v => [v.roomId, v]))
  const overridesOf = new Map<string, NewRoomCapacityOverride[]>()
  for (const o of h.overrides) overridesOf.set(o.roomId, [...(overridesOf.get(o.roomId) ?? []), o])
  const inInventory = (roomId: string, night: string) => overlaps(versionOf.get(roomId)!.validFrom, versionOf.get(roomId)!.validTo ?? null, { from: night, to: night })
  const effective = (roomId: string, night: string) => (overridesOf.get(roomId) ?? []).find(o => o.validFrom <= night && o.validTo >= night)?.sellableCapacity ?? versionOf.get(roomId)!.sellableCapacity
  const onDate = (night: string, cap: (roomId: string) => number) => {
    const ids = h.rooms.map(r => r.id).filter(id => inInventory(id, night))
    return { numerator: ids.reduce((s, id) => s + cap(id), 0), denominator: ids.length }
  }
  const base = onDate(q.date, id => versionOf.get(id)!.sellableCapacity)
  const dateEffective = onDate(q.date, id => effective(id, q.date))
  let range: { numerator: number, denominator: number } | null = null
  if (q.range) {
    range = { numerator: 0, denominator: 0 }
    for (const night of nightsOf(q.range)) {
      const day = onDate(night, id => effective(id, night))
      range.numerator += day.numerator
      range.denominator += day.denominator
    }
  }
  let stay: { numerator: number, denominator: number } | null = null
  if (q.stay) {
    const nights = nightsOf(q.stay)
    const eligible = h.rooms.map(r => r.id).filter(id => nights.every(n => inInventory(id, n)) && !h.blocks.some(b => b.roomId === id && overlaps(b.startDate, b.endDate, q.stay!)))
    stay = { numerator: eligible.reduce((s, id) => s + Math.min(...nights.map(n => effective(id, n))), 0), denominator: eligible.length }
  }
  return { base, dateEffective, range, stay }
}

describe('far-apart date / range / stay: rows loaded are bounded by the windows, never by the span between them', () => {
  it('a 1900 or 2200 `date` next to a 2027 range or stay loads only rows overlapping each window, in the same statement budget, with exact averages', async () => {
    const { scope } = await makeOrg(db)
    const history = await db.transaction(tx => generateHistoryHotel(tx, scope))
    expect(history.blocks).toHaveLength(16_000)
    expect(history.overrides).toHaveLength(2_880)

    const ctx: AuthContext = {
      identity: { userId: '00000000-0000-0000-0000-0000000000aa', organizationId: scope.organizationId, email: 'scale@test.com', fullName: 'Scale' },
      authz: { permissions: new Set(['room.view']), allHotels: true, hotelIds: new Set() },
      scope,
      db: countingDb,
      now: () => new Date('2026-09-25T12:00:00Z'),
    }
    await Promise.all(Array.from({ length: 4 }, () => countingClient`select pg_sleep(0.05)`))
    const replay = getTestClient()

    const scenarios: Array<{ name: string, date: string, range?: Window, stay?: Window, stayCheckOut?: string }> = [
      { name: 'ancient date + range', date: '1900-01-01', range: { from: '2027-01-01', to: '2027-01-31' } },
      { name: 'far-future date + range', date: '2200-01-01', range: { from: '2027-01-01', to: '2027-01-31' } },
      { name: 'ancient date + stay', date: '1900-01-01', stay: { from: '2027-01-01', to: '2027-01-04' }, stayCheckOut: '2027-01-05' },
      { name: 'far-future date + stay', date: '2200-01-01', stay: { from: '2027-01-01', to: '2027-01-04' }, stayCheckOut: '2027-01-05' },
      { name: 'all three far apart (2015 stay, 2027 range, 2200 date)', date: '2200-01-01', range: { from: '2027-01-01', to: '2027-01-31' }, stay: { from: '2015-06-01', to: '2015-06-04' }, stayCheckOut: '2015-06-05' },
    ]

    for (const s of scenarios) {
      const windows: Window[] = [{ from: s.date, to: s.date }, ...(s.range ? [s.range] : []), ...(s.stay ? [s.stay] : [])]
      const hullWindow: Window = { from: windows.map(w => w.from).sort()[0]!, to: windows.map(w => w.to).sort().at(-1)! }

      recorded.length = 0
      recording = true
      const started = performance.now()
      const r = await getHotelAverages(ctx, history.hotel.id, {
        date: s.date,
        ...(s.range ? { from: s.range.from, to: s.range.to } : {}),
        ...(s.stay ? { stayCheckIn: s.stay.from, stayCheckOut: s.stayCheckOut, includeRoomIds: true } : {}),
      })
      const ms = performance.now() - started
      recording = false
      const sent = [...recorded]

      // Same statement budget as a narrow request: the hotel read (+ the settings read with a stay) + one load.
      expect(sent.map(x => x.query), s.name).toHaveLength(s.stay ? 6 : 4)
      expect(ms, s.name).toBeLessThan(1000)

      // The rows each statement ACTUALLY returned (replayed with its own parameters) — exactly the rows
      // overlapping one of the windows; a hull would have returned every row between them.
      const rowsOf = async (table: string) => {
        const stmt = sent.find(x => new RegExp(`from "${table}"`).test(x.query))
        return stmt ? (await replay.unsafe(stmt.query, stmt.params as never[])).length : 0
      }
      const expected = {
        versions: history.versions.filter(v => windows.some(w => overlaps(v.validFrom, v.validTo ?? null, w))).length,
        overrides: history.overrides.filter(o => windows.some(w => overlaps(o.validFrom, o.validTo, w))).length,
        blocks: s.stay ? history.blocks.filter(b => windows.some(w => overlaps(b.startDate, b.endDate, w))).length : 0,
      }
      const hull = {
        overrides: history.overrides.filter(o => overlaps(o.validFrom, o.validTo, hullWindow)).length,
        blocks: s.stay ? history.blocks.filter(b => overlaps(b.startDate, b.endDate, hullWindow)).length : 0,
      }
      expect(await rowsOf('room_base_config'), s.name).toBe(expected.versions)
      expect(await rowsOf('room_capacity_override'), s.name).toBe(expected.overrides)
      expect(await rowsOf('room_operational_block'), s.name).toBe(expected.blocks)
      // What the span between the windows would have cost (documents the regression this guards).
      expect(hull.overrides + hull.blocks, s.name).toBeGreaterThan(20 * Math.max(1, expected.overrides + expected.blocks))

      // Exact averages: an independent oracle over the generated rows …
      const o = oracle(history, s)
      expect(r.base, s.name).toMatchObject(o.base)
      expect(r.dateEffective, s.name).toMatchObject(o.dateEffective)
      if (s.range) expect(r.range, s.name).toMatchObject(o.range!)
      if (s.stay) expect(r.availableStay, s.name).toMatchObject({ ...o.stay!, eligibleRoomCount: o.stay!.denominator })
      // … and identical to asking for each window on its own (one narrow window each).
      const alone = async (q: Parameters<typeof getHotelAverages>[2]) => getHotelAverages(ctx, history.hotel.id, q)
      const onDate = await alone({ date: s.date })
      expect(r.base).toEqual(onDate.base)
      expect(r.dateEffective).toEqual(onDate.dateEffective)
      if (s.range) expect(r.range).toEqual((await alone({ date: s.range.from, from: s.range.from, to: s.range.to })).range)
      if (s.stay) expect(r.availableStay).toEqual((await alone({ date: s.stay.from, stayCheckIn: s.stay.from, stayCheckOut: s.stayCheckOut, includeRoomIds: true })).availableStay)

      if (process.env.PERF_REPORT) {
        console.info(`[averagesScale] far-apart "${s.name}": ${ms.toFixed(1)}ms/${sent.length} stmts, rows versions=${expected.versions} overrides=${expected.overrides} blocks=${expected.blocks} (a hull would load overrides=${hull.overrides} blocks=${hull.blocks})`)
      }
    }
    // Sanity: the far-future date sees the 90 non-retired rooms; the ancient one sees none (null, not 0).
    expect(oracle(history, { date: '2200-01-01' }).base.denominator).toBe(90)
    expect((await getHotelAverages(ctx, history.hotel.id, { date: '1900-01-01' })).base).toEqual({ numerator: 0, denominator: 0, value: null, display: null, basis: 'ROOMS' })
  }, 120_000)
})
