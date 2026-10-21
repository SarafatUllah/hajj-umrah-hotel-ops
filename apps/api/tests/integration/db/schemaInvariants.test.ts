import { afterAll, describe, expect, it } from 'vitest'
import { PENDING_BOOKING_STATUSES, SEAT_HOLDING_STATUSES } from '@hajj/contracts/constants/booking'
import { closeTestDb, getTestClient } from '../support/testDb'

/**
 * Schema-wide rules checked against the migrated catalog (not the Drizzle source), so a hand-written
 * migration can never slip past them.
 */

const sql = getTestClient()

afterAll(async () => {
  await closeTestDb()
})

/** Tables outside tenancy on purpose: the tenant root, the global permission catalog and platform counters. */
const PLATFORM_TABLES = ['organization', 'permission', 'rate_limit_bucket', 'role_permission']

describe('schema invariants', () => {
  it('every other table carries a NOT NULL organization_id', async () => {
    const rows = await sql<Array<{ table_name: string }>>`
      select t.table_name from information_schema.tables t
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'organization_id' and c.is_nullable = 'NO')
      order by 1`
    expect(rows.map(r => r.table_name)).toEqual(PLATFORM_TABLES)
  })

  it('every foreign key is covered by an index whose leading columns are the key\'s columns (PF-6)', async () => {
    const rows = await sql<Array<{ constraint_name: string }>>`
      select con.conname as constraint_name
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
      where con.contype = 'f' and ns.nspname = 'public'
        and not exists (
          select 1 from pg_index idx
          where idx.indrelid = con.conrelid and idx.indpred is null
            and (idx.indkey::int2[])[0:cardinality(con.conkey) - 1] @> con.conkey
            and (idx.indkey::int2[])[0:cardinality(con.conkey) - 1] <@ con.conkey)
      order by 1`
    expect(rows.map(r => r.constraint_name)).toEqual([])
  })

  it('the hand-written SQL uses exactly the shared status lists (exclusion constraints and the seat-counting function)', async () => {
    const quoted = (text: string) => [...text.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]).sort()
    const seatHolding = [...SEAT_HOLDING_STATUSES].sort()

    const constraints = await sql<Array<{ conname: string, def: string }>>`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ('booking_room_one_owner', 'booking_room_one_occupancy', 'booking_room_no_duplicate') order by conname`
    expect(constraints).toHaveLength(3)
    for (const c of constraints) expect(quoted(c.def.slice(c.def.indexOf('WHERE'))), c.conname).toEqual(seatHolding)

    const [fn] = await sql<Array<{ src: string }>>`select prosrc as src from pg_proc where proname = 'room_night_occupancy'`
    const list = (values: readonly string[]) => values.map(v => `'${v}'`).join(', ')
    expect(fn!.src).toContain(`br.status IN (${list(SEAT_HOLDING_STATUSES)})`)
    expect(fn!.src).toContain(`b.status IN (${list(PENDING_BOOKING_STATUSES)})`)
  })
})
