import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../../db/schema'
import { room, roomOperationalBlock } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { extractPgError, translateDbError } from '../../../server/errors/dbErrors'
import { ConflictError, ValidationError } from '../../../server/errors/domainError'
import { platformRepos } from '../../../server/repositories'
import { OperationalBlockRepository } from '../../../server/repositories/hotel'
import { trustedHotelScope } from '../../../server/security/scope'
import { makeFloor, makeHotel, makeOrg, makeRoomBlock, makeRoomType, makeRoomWithVersion, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestClient, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return undefined
  }
  catch (error) {
    return error
  }
}

/** Fresh fixtures per case: org + hotel + floor + type + one in-service room. */
async function setupRoom() {
  const { scope: orgScope } = await makeOrg(db)
  const hotelRow = await makeHotel(db, orgScope)
  const scope = trustedHotelScope(orgScope, hotelRow.id)
  const floorRow = await makeFloor(db, scope)
  const roomTypeRow = await makeRoomType(db, orgScope)
  const { room: roomRow } = await makeRoomWithVersion(db, scope, floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
  return { orgScope, hotelRow, scope, floorRow, roomTypeRow, roomRow }
}

/** Raw insert (bypassing the repository's insert type) so the S11/cancellation columns can be planted directly. */
function rawInsert(values: Partial<typeof roomOperationalBlock.$inferInsert> & { organizationId: string, hotelId: string, roomId: string }) {
  return db.insert(roomOperationalBlock).values({ kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-10', reason: 'raw', ...values })
}

describe('room_operational_block: check constraints (23514, real PostgreSQL, constraint names asserted)', () => {
  it('rejects an unknown kind (room_block_kind_check) and translates it to 422', async () => {
    const { scope, roomRow } = await setupRoom()
    const caught = await catchError(() => makeRoomBlock(db, scope, roomRow.id, { kind: 'BROKEN' }))
    expect(extractPgError(caught)).toMatchObject({ code: '23514', constraint: 'room_block_kind_check' })
    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ValidationError)
    expect(translated?.httpStatus).toBe(422)
  })

  it('rejects an empty and a spaces-only reason (room_block_reason_check)', async () => {
    const { scope, roomRow } = await setupRoom()
    expect(extractPgError(await catchError(() => makeRoomBlock(db, scope, roomRow.id, { reason: '' })))).toMatchObject({ code: '23514', constraint: 'room_block_reason_check' })
    expect(extractPgError(await catchError(() => makeRoomBlock(db, scope, roomRow.id, { reason: '    ' })))).toMatchObject({ code: '23514', constraint: 'room_block_reason_check' })
  })

  it('documents the verified constraint\'s limit: one-argument btrim() strips SPACES only, so a tab-only reason passes the DB check (the service and the zod schema reject it — see operationalBlockService tests)', async () => {
    const { scope, roomRow } = await setupRoom()
    await expect(makeRoomBlock(db, scope, roomRow.id, { reason: '\t' })).resolves.toBeDefined()
  })

  it('rejects end_date before start_date (room_block_range_check) and accepts a one-night block', async () => {
    const { scope, roomRow } = await setupRoom()
    expect(extractPgError(await catchError(() => makeRoomBlock(db, scope, roomRow.id, { startDate: '2027-05-10', endDate: '2027-05-09' })))).toMatchObject({ code: '23514', constraint: 'room_block_range_check' })
    await expect(makeRoomBlock(db, scope, roomRow.id, { startDate: '2027-05-10', endDate: '2027-05-10' })).resolves.toBeDefined()
  })
})

describe('S11 check constraints (fresh fixtures per case)', () => {
  it('room_block_ended_early_check: only SOME of ended_early_at / ended_early_by / original_end_date set -> 23514', async () => {
    const partials = [
      { endedEarlyAt: new Date() },
      { endedEarlyAt: new Date(), endedEarlyBy: '00000000-0000-0000-0000-0000000000aa' },
      { originalEndDate: '2027-05-20' },
      { endedEarlyBy: '00000000-0000-0000-0000-0000000000aa', originalEndDate: '2027-05-20' },
    ]
    for (const partial of partials) {
      const { orgScope, hotelRow, roomRow } = await setupRoom()
      const caught = await catchError(() => rawInsert({ organizationId: orgScope.organizationId, hotelId: hotelRow.id, roomId: roomRow.id, ...partial }))
      expect(extractPgError(caught), JSON.stringify(partial)).toMatchObject({ code: '23514', constraint: 'room_block_ended_early_check' })
    }
  })

  it('room_block_end_state_check: both cancelled_at and ended_early_at -> 23514', async () => {
    const { orgScope, hotelRow, roomRow } = await setupRoom()
    const caught = await catchError(() => rawInsert({
      organizationId: orgScope.organizationId,
      hotelId: hotelRow.id,
      roomId: roomRow.id,
      cancelledAt: new Date(),
      endedEarlyAt: new Date(),
      endedEarlyBy: '00000000-0000-0000-0000-0000000000aa',
      originalEndDate: '2027-05-20',
    }))
    expect(extractPgError(caught)).toMatchObject({ code: '23514', constraint: 'room_block_end_state_check' })
  })

  it('room_block_original_end_check: original_end_date <= end_date -> 23514 (equal and earlier)', async () => {
    for (const originalEndDate of ['2027-05-10', '2027-05-05']) {
      const { orgScope, hotelRow, roomRow } = await setupRoom()
      const caught = await catchError(() => rawInsert({
        organizationId: orgScope.organizationId,
        hotelId: hotelRow.id,
        roomId: roomRow.id,
        endDate: '2027-05-10',
        endedEarlyAt: new Date(),
        endedEarlyBy: '00000000-0000-0000-0000-0000000000aa',
        originalEndDate,
      }))
      expect(extractPgError(caught), originalEndDate).toMatchObject({ code: '23514', constraint: 'room_block_original_end_check' })
    }
  })

  it('a fully-populated, consistent ended-early row is accepted', async () => {
    const { orgScope, hotelRow, roomRow } = await setupRoom()
    await expect(rawInsert({
      organizationId: orgScope.organizationId,
      hotelId: hotelRow.id,
      roomId: roomRow.id,
      endDate: '2027-05-10',
      endedEarlyAt: new Date(),
      endedEarlyBy: '00000000-0000-0000-0000-0000000000aa',
      originalEndDate: '2027-05-20',
      cancelReason: 'Repair finished',
    })).resolves.toBeDefined()
  })
})

describe('room_block_no_overlap: same-kind exclusion constraint (empirical proof)', () => {
  it('same kind overlapping on one room -> 23P01 room_block_no_overlap, translated to 409 RANGE_OVERLAP; only the first row exists', async () => {
    const { scope, roomRow } = await setupRoom()
    await makeRoomBlock(db, scope, roomRow.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-10' })

    const caught = await catchError(() => makeRoomBlock(db, scope, roomRow.id, { kind: 'MAINTENANCE', startDate: '2027-05-10', endDate: '2027-05-15' }))
    expect(extractPgError(caught)).toMatchObject({ code: '23P01', constraint: 'room_block_no_overlap' })
    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ConflictError)
    expect(translated).toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })

    expect(await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, roomRow.id))).toHaveLength(1)
  })

  it('different kinds may overlap on the same nights', async () => {
    const { scope, roomRow } = await setupRoom()
    await makeRoomBlock(db, scope, roomRow.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-10' })
    await expect(makeRoomBlock(db, scope, roomRow.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-05-01', endDate: '2027-05-10' })).resolves.toBeDefined()
    await expect(makeRoomBlock(db, scope, roomRow.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2027-05-05', endDate: '2027-05-06' })).resolves.toBeDefined()
  })

  it('adjacent same-kind blocks (…-05-10 and 05-11…) are allowed; the same range on a DIFFERENT room is allowed', async () => {
    const { scope, floorRow, roomTypeRow, roomRow } = await setupRoom()
    await makeRoomBlock(db, scope, roomRow.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-10' })
    await expect(makeRoomBlock(db, scope, roomRow.id, { kind: 'MAINTENANCE', startDate: '2027-05-11', endDate: '2027-05-20' })).resolves.toBeDefined()

    const { room: other } = await makeRoomWithVersion(db, scope, floorRow.id, roomTypeRow.id)
    await expect(makeRoomBlock(db, scope, other.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-10' })).resolves.toBeDefined()
  })

  it('a cancelled block no longer conflicts (partial constraint WHERE cancelled_at IS NULL)', async () => {
    const { scope, roomRow } = await setupRoom()
    const first = await makeRoomBlock(db, scope, roomRow.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-10' })
    await new OperationalBlockRepository(db, scope).markCancelled(first.id, new Date(), '00000000-0000-0000-0000-0000000000aa', 'Plans changed')
    await expect(makeRoomBlock(db, scope, roomRow.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-10' })).resolves.toBeDefined()
  })

  it('after an early end, the nights after the new end are free for a new same-kind block; the kept nights still conflict', async () => {
    const { scope, roomRow } = await setupRoom()
    const repo = new OperationalBlockRepository(db, scope)
    const running = await makeRoomBlock(db, scope, roomRow.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-05-01', endDate: '2027-05-20' })
    await repo.endEarly(running.id, { newEndDate: '2027-05-09', at: new Date(), by: '00000000-0000-0000-0000-0000000000aa', reason: 'Repair finished' })

    expect(extractPgError(await catchError(() => makeRoomBlock(db, scope, roomRow.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-05-09', endDate: '2027-05-12' })))?.code).toBe('23P01')
    await expect(makeRoomBlock(db, scope, roomRow.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-05-10', endDate: '2027-05-20' })).resolves.toBeDefined()
  })
})

describe('room_block_room_fk: composite FK (23503, fresh fixtures)', () => {
  it('rejects a block whose room belongs to another hotel of the same organization', async () => {
    const { orgScope, hotelRow } = await setupRoom()
    const hotelB = await makeHotel(db, orgScope)
    const scopeB = trustedHotelScope(orgScope, hotelB.id)
    const floorB = await makeFloor(db, scopeB)
    const typeB = await makeRoomType(db, orgScope)
    const { room: roomInB } = await makeRoomWithVersion(db, scopeB, floorB.id, typeB.id)

    const caught = await catchError(() => rawInsert({ organizationId: orgScope.organizationId, hotelId: hotelRow.id, roomId: roomInB.id }))
    expect(extractPgError(caught)).toMatchObject({ code: '23503', constraint: 'room_block_room_fk' })
    expect(translateDbError(caught)).toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
    expect(await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, roomInB.id))).toEqual([])
  })

  it('rejects a block whose room belongs to another organization entirely', async () => {
    const { orgScope, hotelRow } = await setupRoom()
    const { roomRow: foreignRoom } = await setupRoom()
    const caught = await catchError(() => rawInsert({ organizationId: orgScope.organizationId, hotelId: hotelRow.id, roomId: foreignRoom.id }))
    expect(extractPgError(caught)).toMatchObject({ code: '23503', constraint: 'room_block_room_fk' })
  })
})

describe('repository writes: endEarly is ONE statement (S11); markCancelled sets no ended-early column', () => {
  it('endEarly sets end_date, original_end_date, ended_early_at, ended_early_by and cancel_reason in exactly one UPDATE statement', async () => {
    const { orgScope, scope, roomRow } = await setupRoom()
    const actor = await makeUser(db, orgScope)
    const block = await makeRoomBlock(db, scope, roomRow.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-20' })

    // A second drizzle handle over the same connection pool, with a query logger: every statement the
    // repository method issues is recorded.
    const statements: string[] = []
    const loggedDb = drizzle(getTestClient(), { schema, logger: { logQuery: (query: string) => statements.push(query) } }) as unknown as Database
    const at = new Date('2027-05-10T09:30:00Z')
    const updated = await new OperationalBlockRepository(loggedDb, scope).endEarly(block.id, { newEndDate: '2027-05-09', at, by: actor.id, reason: 'Repair finished' })

    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^update "room_operational_block" set /)
    for (const column of ['"end_date"', '"original_end_date"', '"ended_early_at"', '"ended_early_by"', '"cancel_reason"']) expect(statements[0]).toContain(column)

    expect(updated).toMatchObject({ endDate: '2027-05-09', originalEndDate: '2027-05-20', endedEarlyBy: actor.id, cancelReason: 'Repair finished', cancelledAt: null, cancelledBy: null })
    expect(updated?.endedEarlyAt?.toISOString()).toBe(at.toISOString())

    const [row] = await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.id, block.id))
    expect(row).toMatchObject({ endDate: '2027-05-09', originalEndDate: '2027-05-20', endedEarlyBy: actor.id, cancelReason: 'Repair finished' })
  })

  it('markCancelled sets cancelled_at/by/reason and NONE of the ended-early columns; dates unchanged', async () => {
    const { scope, roomRow } = await setupRoom()
    const block = await makeRoomBlock(db, scope, roomRow.id, { startDate: '2027-05-01', endDate: '2027-05-20' })
    await new OperationalBlockRepository(db, scope).markCancelled(block.id, new Date(), '00000000-0000-0000-0000-0000000000aa', 'Plans changed')

    const [row] = await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.id, block.id))
    expect(row).toMatchObject({ startDate: '2027-05-01', endDate: '2027-05-20', cancelReason: 'Plans changed', cancelledBy: '00000000-0000-0000-0000-0000000000aa', endedEarlyAt: null, endedEarlyBy: null, originalEndDate: null })
    expect(row?.cancelledAt).not.toBeNull()
  })

  it('neither write touches a block that is already cancelled or already ended early (returns null, row unchanged)', async () => {
    const { scope, roomRow } = await setupRoom()
    const repo = new OperationalBlockRepository(db, scope)
    const cancelled = await makeRoomBlock(db, scope, roomRow.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-20' })
    await repo.markCancelled(cancelled.id, new Date(), '00000000-0000-0000-0000-0000000000aa', 'first')
    expect(await repo.markCancelled(cancelled.id, new Date(), '00000000-0000-0000-0000-0000000000aa', 'second')).toBeNull()
    expect(await repo.endEarly(cancelled.id, { newEndDate: '2027-05-05', at: new Date(), by: '00000000-0000-0000-0000-0000000000aa', reason: 'x' })).toBeNull()

    const ended = await makeRoomBlock(db, scope, roomRow.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-05-01', endDate: '2027-05-20' })
    await repo.endEarly(ended.id, { newEndDate: '2027-05-09', at: new Date(), by: '00000000-0000-0000-0000-0000000000aa', reason: 'done' })
    expect(await repo.endEarly(ended.id, { newEndDate: '2027-05-05', at: new Date(), by: '00000000-0000-0000-0000-0000000000aa', reason: 'again' })).toBeNull()
    expect(await repo.markCancelled(ended.id, new Date(), '00000000-0000-0000-0000-0000000000aa', 'x')).toBeNull()

    const [cancelledRow] = await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.id, cancelled.id))
    expect(cancelledRow?.cancelReason).toBe('first')
    const [endedRow] = await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.id, ended.id))
    expect(endedRow).toMatchObject({ endDate: '2027-05-09', originalEndDate: '2027-05-20', cancelReason: 'done', cancelledAt: null })
  })
})

describe('demo-reset-style cascade with operational blocks', () => {
  it('DELETE FROM organization removes its block rows (active, cancelled and ended-early) together with the rooms, in one statement; another org is untouched', async () => {
    const a = await setupRoom()
    const b = await setupRoom()
    const repoA = new OperationalBlockRepository(db, a.scope)
    await makeRoomBlock(db, a.scope, a.roomRow.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-10' }) // stays active
    const cancelled = await makeRoomBlock(db, a.scope, a.roomRow.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2027-05-01', endDate: '2027-05-10' })
    await repoA.markCancelled(cancelled.id, new Date(), '00000000-0000-0000-0000-0000000000aa', 'x')
    const ended = await makeRoomBlock(db, a.scope, a.roomRow.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-05-01', endDate: '2027-05-20' })
    await repoA.endEarly(ended.id, { newEndDate: '2027-05-09', at: new Date(), by: '00000000-0000-0000-0000-0000000000aa', reason: 'x' })
    const blockB = await makeRoomBlock(db, b.scope, b.roomRow.id)
    expect(await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, a.roomRow.id))).toHaveLength(3)

    await platformRepos(db).organizations.deleteCascade(a.orgScope.organizationId)

    expect(await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, a.roomRow.id))).toEqual([])
    expect(await db.select().from(room).where(eq(room.id, a.roomRow.id))).toEqual([])
    expect(await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.id, blockB.id))).toHaveLength(1)
    expect(await db.select().from(room).where(eq(room.id, b.roomRow.id))).toHaveLength(1)
  })
})

describe('FK index coverage (global "every FK column set gets an index" rule)', () => {
  it('every foreign-key column set on room_operational_block has a covering btree index (leading columns)', async () => {
    const client = getTestClient()
    const tables = ['room_operational_block']

    const fkRows = await client<Array<{ tableName: string, constraintName: string, columns: string[] }>>`
      SELECT tbl.relname AS "tableName", con.conname AS "constraintName",
             array_agg(att.attname ORDER BY arr.ord) AS columns
      FROM pg_constraint con
      JOIN pg_class tbl ON tbl.oid = con.conrelid
      JOIN unnest(con.conkey) WITH ORDINALITY AS arr(attnum, ord) ON true
      JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = arr.attnum
      WHERE con.contype = 'f' AND tbl.relname = ANY(${tables})
      GROUP BY tbl.relname, con.conname
    `
    expect(fkRows.map(r => r.constraintName).sort()).toEqual(['room_block_room_fk', 'room_operational_block_organization_id_organization_id_fk'])

    // Only plain (non-partial) indexes count: the partial GiST exclusion index cannot serve the FK's checks.
    const indexRows = await client<Array<{ tableName: string, indexName: string, columns: string[] }>>`
      SELECT t.relname AS "tableName", i.relname AS "indexName",
             array_agg(a.attname ORDER BY k.ord) AS columns
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = ANY(${tables}) AND ix.indpred IS NULL
      GROUP BY t.relname, i.relname, ix.indkey
    `

    const uncovered = fkRows.filter((fk) => {
      const fkSet = new Set(fk.columns)
      return !indexRows.some((idx) => {
        if (idx.tableName !== fk.tableName || idx.columns.length < fkSet.size) return false
        const leading = new Set(idx.columns.slice(0, fkSet.size))
        return leading.size === fkSet.size && [...fkSet].every(c => leading.has(c))
      })
    })
    expect(uncovered).toEqual([])
  })

  it('the exclusion constraint exists with the exact verified definition', async () => {
    const client = getTestClient()
    const [row] = await client<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'room_operational_block' AND c.conname = 'room_block_no_overlap'
    `
    expect(row?.def).toBe('EXCLUDE USING gist (room_id WITH =, kind WITH =, daterange(start_date, end_date, \'[]\'::text) WITH &&) WHERE ((cancelled_at IS NULL))')
  })
})
