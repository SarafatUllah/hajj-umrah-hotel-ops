import { performance } from 'node:perf_hooks'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { afterAll, describe, expect, it } from 'vitest'
import * as schema from '../../../db/schema'
import type { Database } from '../../../db/client'
import type { AuthContext } from '../../../server/security/authContext'
import { getDailySummary, getRoomCalendar } from '../../../server/services/roomCalendarService'
import { generateCalendarScaleHotel, SCALE_ROOMS } from '../../support/calendarScaleHotel'
import { makeOrg } from '../../support/fixtures'
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

const ROOMS = SCALE_ROOMS
const RANGE_TABLES = ['room_base_config', 'room_capacity_override', 'room_operational_block'] as const

/** Every `Node Type` + `Relation Name` in an EXPLAIN (FORMAT JSON) plan tree. */
function planNodes(plan: Record<string, unknown>): Array<{ node: string, relation?: string }> {
  const out: Array<{ node: string, relation?: string }> = [{ node: plan['Node Type'] as string, relation: plan['Relation Name'] as string | undefined }]
  for (const child of (plan.Plans as Array<Record<string, unknown>> | undefined) ?? []) out.push(...planNodes(child))
  return out
}

/**
 * Other tenants sharing the tables: the measured hotel is ONE of five hotels (one per organization)
 * of identical size, i.e. 20% of every inventory table — production tables hold many hotels. This
 * is what makes the existing `(organization_id, hotel_id, …)` indexes selective; see the EXPLAIN
 * assertion below (and the Task 18 report for the single-tenant plans, where a Seq Scan is optimal).
 */
const OTHER_TENANTS = 4

describe('9. room calendar and daily summary at scale (2,000 rooms, ~3,600 overrides, 40,000 blocks)', () => {
  it('a 100-room x 120-day page < 300 ms and a 400-day daily summary < 2 s, each in exactly 6 SQL statements (measured, refs on), fresh and ANALYZEd; ANALYZEd range reads never Seq Scan the three range tables', async () => {
    for (let n = 0; n < OTHER_TENANTS; n++) {
      const { scope: other } = await makeOrg(db)
      await db.transaction(tx => generateCalendarScaleHotel(tx, other))
    }
    const { scope } = await makeOrg(db)
    const generated = await db.transaction(tx => generateCalendarScaleHotel(tx, scope))
    expect(generated.blockCount).toBe(40_000)
    expect(generated.overrideCount).toBe(3_600)

    const ctx: AuthContext = {
      identity: { userId: '00000000-0000-0000-0000-0000000000aa', organizationId: scope.organizationId, email: 'scale@test.com', fullName: 'Scale' },
      authz: { permissions: new Set(['room.view']), allHotels: true, hotelIds: new Set() },
      scope,
      db: countingDb,
      now: () => new Date('2026-09-25T12:00:00Z'),
    }

    // Open ALL of the counting client's pooled connections first: postgres.js runs one `pg_type` lookup
    // per NEW connection (array-type discovery), which is connection setup, not work of the call.
    // Every statement of the measured calls themselves is still counted.
    await Promise.all(Array.from({ length: 4 }, () => countingClient`select pg_sleep(0.05)`))

    const measure = async <T>(call: () => Promise<T>) => {
      recorded.length = 0
      recording = true
      const started = performance.now()
      const result = await call()
      const ms = performance.now() - started
      recording = false
      return { result, ms, statements: [...recorded] }
    }
    const pageQuery = { from: '2027-05-01', to: '2027-08-28', page: 3, pageSize: 100 }
    const summaryQuery = { from: '2027-01-01', to: '2028-02-04' }
    const runAll = async () => ({
      calendar: [await measure(() => getRoomCalendar(ctx, generated.hotel.id, pageQuery)), await measure(() => getRoomCalendar(ctx, generated.hotel.id, pageQuery))],
      summary: [await measure(() => getDailySummary(ctx, generated.hotel.id, summaryQuery)), await measure(() => getDailySummary(ctx, generated.hotel.id, summaryQuery))],
    })

    // Freshly bulk-loaded tables (whatever statistics the planner has right now), then ANALYZEd ones.
    const fresh = await runAll()
    const explainClient = getTestClient()
    await explainClient.unsafe('ANALYZE room, floor, room_type, capacity_period, room_base_config, room_capacity_override, room_operational_block')
    const analyzed = await runAll()

    for (const runs of [fresh, analyzed]) {
      for (const run of [...runs.calendar, ...runs.summary]) {
        // Exactly: authorizeHotel's hotel read, the settings read, the candidates (room+floor+room_type),
        // and the three range reads (versions, overrides(+capacity_period), blocks).
        expect(run.statements.map(s => s.query), run.statements.map(s => s.query).join('\n')).toHaveLength(6)
        expect(run.statements.filter(s => s.query.includes('pg_type'))).toEqual([])
      }
      for (const run of runs.calendar) expect(run.ms).toBeLessThan(300)
      for (const run of runs.summary) expect(run.ms).toBeLessThan(2000)
    }

    const page = analyzed.calendar[1]!.result
    expect(page).toMatchObject({ total: ROOMS, page: 3, pageSize: 100 })
    expect(page.rooms).toHaveLength(100)
    expect(page.rooms[0]!.roomNumber).toBe('2000') // floor 1 holds rooms 1000…1199 (pages 1-2), then floor 2
    for (const room of page.rooms) {
      expect(room.segments[0]!.from).toBe(pageQuery.from)
      expect(room.segments.at(-1)!.to).toBe(pageQuery.to)
    }
    expect(Object.keys(page.refs.blocks).length).toBeGreaterThan(0)
    expect(Object.keys(page.refs.periods)).toHaveLength(1) // only Hajj overlaps May…August
    expect(fresh.calendar[0]!.result).toEqual(page)
    const summary = analyzed.summary[1]!.result
    expect(summary.days).toHaveLength(400)
    expect(summary.days[0]!.roomsInInventory).toBe(ROOMS)
    expect(summary.days.some(d => d.outOfService > 0 && d.maintenance > 0 && d.operationalBlock > 0)).toBe(true)
    expect(summary.meta).toEqual({ today: '2026-09-25', maintenanceBlocksSales: true })
    expect(fresh.summary[0]!.result).toEqual(summary)

    // EXPLAIN (FORMAT JSON) of the ANALYZEd range reads exactly as they were sent (same SQL, same parameters).
    const explain = async (stmt: { query: string, params: unknown[] }) => {
      const [row] = await explainClient.unsafe(`EXPLAIN (FORMAT JSON) ${stmt.query}`, stmt.params as never[])
      return planNodes((row!['QUERY PLAN'] as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan)
    }
    const rangeReads = [...analyzed.calendar[1]!.statements, ...analyzed.summary[1]!.statements].filter(s => RANGE_TABLES.some(t => new RegExp(`from "${t}"`).test(s.query)))
    expect(rangeReads).toHaveLength(6)
    const scans: string[] = []
    const seqScans: string[] = []
    for (const stmt of rangeReads) {
      for (const node of await explain(stmt)) {
        if (!RANGE_TABLES.includes(node.relation as never)) continue
        scans.push(`${node.relation}:${node.node}`)
        if (node.node === 'Seq Scan') seqScans.push(`${node.relation}: ${stmt.query}`)
      }
    }
    expect(scans).toHaveLength(6)
    expect(seqScans).toEqual([])

    if (process.env.PERF_REPORT) {
      const fmt = (runs: Array<{ ms: number, statements: unknown[] }>) => runs.map(r => `${r.ms.toFixed(1)}ms/${r.statements.length}`).join(',')
      process.stdout.write(`[calendarScale] rooms=${ROOMS} overrides=${generated.overrideCount} blocks=${generated.blockCount} otherTenants=${OTHER_TENANTS}`
        + ` fresh: page(100x120d)=${fmt(fresh.calendar)} summary(400d)=${fmt(fresh.summary)}`
        + ` analyzed: page=${fmt(analyzed.calendar)} summary=${fmt(analyzed.summary)}`
        + ` pageBytes=${Buffer.byteLength(JSON.stringify(page))} summaryBytes=${Buffer.byteLength(JSON.stringify(summary))} scans=${scans.join(',')}\n`)
    }
  }, 300_000)
})
