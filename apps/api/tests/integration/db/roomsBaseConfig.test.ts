import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { hotel, room, roomBaseConfig } from '../../../db/schema'
import { platformRepos } from '../../../server/repositories'
import { trustedHotelScope } from '../../../server/security/scope'
import { extractPgError, translateDbError } from '../../../server/errors/dbErrors'
import { ConflictError } from '../../../server/errors/domainError'
import { makeFloor, makeHotel, makeOrg, makeRoom, makeRoomBaseConfig, makeRoomType, makeRoomWithVersion } from '../../support/fixtures'
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

describe('room: unique (hotel_id, room_number) and check constraints', () => {
  it('rejects a duplicate room number within the same hotel, allows the same number in another hotel, and translateDbError maps the duplicate to 409 ALREADY_EXISTS', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const hotelB = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const floorB = await makeFloor(db, trustedHotelScope(orgA, hotelB.id))
    const roomTypeRow = await makeRoomType(db, orgA)

    await makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id, { roomNumber: '401' })

    const caught = await catchError(() => makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id, { roomNumber: '401' }))
    expect(extractPgError(caught)?.code).toBe('23505')
    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ConflictError)
    expect(translated?.code).toBe('ALREADY_EXISTS')
    expect(translated?.httpStatus).toBe(409)

    await expect(makeRoom(db, trustedHotelScope(orgA, hotelB.id), floorB.id, roomTypeRow.id, { roomNumber: '401' })).resolves.toBeDefined()
  })

  it('rejects an empty room_number (CHECK 23514) when inserted directly, bypassing the service-layer normalization', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)

    const caught = await catchError(() => makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id, { roomNumber: '   ' }))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('rejects a 21-character room_number (CHECK 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)

    const caught = await catchError(() => makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id, { roomNumber: 'A'.repeat(21) }))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('rejects a room row pointing at another organization\'s floor (composite FK, 23503)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeB = await makeRoomType(db, orgB)

    const caught = await catchError(() =>
      db.insert(room).values({ organizationId: orgA.organizationId, hotelId: hotelA.id, floorId: floorA.id, roomTypeId: roomTypeB.id, roomNumber: '999' }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })

  it('rejects a room row pointing at another hotel\'s floor within the same organization (composite FK, 23503)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const hotelB = await makeHotel(db, orgA)
    const floorB = await makeFloor(db, trustedHotelScope(orgA, hotelB.id))
    const roomTypeRow = await makeRoomType(db, orgA)

    const caught = await catchError(() =>
      db.insert(room).values({ organizationId: orgA.organizationId, hotelId: hotelA.id, floorId: floorB.id, roomTypeId: roomTypeRow.id, roomNumber: '999' }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })
})

describe('room_base_config: check constraints', () => {
  it('rejects physicalBeds 0 and 31 (CHECK 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id)

    expect(extractPgError(await catchError(() => makeRoomBaseConfig(db, trustedHotelScope(orgA, hotelA.id), roomRow.id, { physicalBeds: 0 })))?.code).toBe('23514')
    expect(extractPgError(await catchError(() => makeRoomBaseConfig(db, trustedHotelScope(orgA, hotelA.id), roomRow.id, { physicalBeds: 31 })))?.code).toBe('23514')
  })

  it('rejects sellableCapacity 31 (CHECK 23514) and accepts sellableCapacity 0', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id)

    expect(extractPgError(await catchError(() => makeRoomBaseConfig(db, trustedHotelScope(orgA, hotelA.id), roomRow.id, { sellableCapacity: 31 })))?.code).toBe('23514')
    await expect(makeRoomBaseConfig(db, trustedHotelScope(orgA, hotelA.id), roomRow.id, { sellableCapacity: 0 })).resolves.toBeDefined()
  })

  it('rejects an invalid origin (CHECK 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id)

    const caught = await catchError(() => makeRoomBaseConfig(db, trustedHotelScope(orgA, hotelA.id), roomRow.id, { origin: 'NOT_A_REAL_ORIGIN' }))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('rejects validTo before validFrom (CHECK 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id)

    const caught = await catchError(() => makeRoomBaseConfig(db, trustedHotelScope(orgA, hotelA.id), roomRow.id, { validFrom: '2027-06-01', validTo: '2027-05-01' }))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('rejects a base-config row pointing at another hotel\'s room (composite FK, 23503)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const hotelB = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const roomA = await makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id)

    const caught = await catchError(() =>
      db.insert(roomBaseConfig).values({ organizationId: orgA.organizationId, hotelId: hotelB.id, roomId: roomA.id, validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })
})

describe('room_base_config_no_overlap: temporal-integrity exclusion constraint (empirical proof)', () => {
  it('accepts an adjacent close-then-reopen (no gap) for the same room', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id)
    const scope = trustedHotelScope(orgA, hotelA.id)

    await makeRoomBaseConfig(db, scope, roomRow.id, { validFrom: '2026-01-01', validTo: '2026-06-30' })
    // Reopens the very next day -- adjacent, not overlapping -- must be accepted.
    await expect(makeRoomBaseConfig(db, scope, roomRow.id, { validFrom: '2026-07-01', validTo: null })).resolves.toBeDefined()

    const rows = await db.select().from(roomBaseConfig).where(eq(roomBaseConfig.roomId, roomRow.id))
    expect(rows).toHaveLength(2)
  })

  it('rejects an overlapping version for the same room with 23P01, translated to 409 RANGE_OVERLAP', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id)
    const scope = trustedHotelScope(orgA, hotelA.id)

    await makeRoomBaseConfig(db, scope, roomRow.id, { validFrom: '2026-01-01', validTo: '2026-06-30' })

    // Overlaps the first version's range by 16 nights (2026-06-15..2026-06-30).
    const caught = await catchError(() => makeRoomBaseConfig(db, scope, roomRow.id, { validFrom: '2026-06-15', validTo: '2026-08-01' }))
    const pg = extractPgError(caught)
    expect(pg?.code).toBe('23P01')
    expect(pg?.constraint).toBe('room_base_config_no_overlap')

    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ConflictError)
    expect(translated?.code).toBe('RANGE_OVERLAP')
    expect(translated?.httpStatus).toBe(409)

    // Only the original version landed.
    const rows = await db.select().from(roomBaseConfig).where(eq(roomBaseConfig.roomId, roomRow.id))
    expect(rows).toHaveLength(1)
  })

  it('rejects two open-ended (null valid_to) versions for the same room', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id)
    const scope = trustedHotelScope(orgA, hotelA.id)

    await makeRoomBaseConfig(db, scope, roomRow.id, { validFrom: '2026-01-01', validTo: null })
    const caught = await catchError(() => makeRoomBaseConfig(db, scope, roomRow.id, { validFrom: '2026-06-01', validTo: null }))
    expect(extractPgError(caught)?.code).toBe('23P01')
  })

  it('does NOT reject overlapping ranges for DIFFERENT rooms (the exclusion is per room_id)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const scope = trustedHotelScope(orgA, hotelA.id)
    const roomOne = await makeRoom(db, scope, floorA.id, roomTypeRow.id, { roomNumber: 'R-ONE' })
    const roomTwo = await makeRoom(db, scope, floorA.id, roomTypeRow.id, { roomNumber: 'R-TWO' })

    await makeRoomBaseConfig(db, scope, roomOne.id, { validFrom: '2026-01-01', validTo: null })
    await expect(makeRoomBaseConfig(db, scope, roomTwo.id, { validFrom: '2026-01-01', validTo: null })).resolves.toBeDefined()
  })
})

describe('FK index coverage (PF-6)', () => {
  it('every foreign-key column set on room and room_base_config has a covering index', async () => {
    const client = getTestClient()
    const tables = ['room', 'room_base_config']

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
    expect(fkRows.length).toBeGreaterThan(0)

    const indexRows = await client<Array<{ tableName: string, indexName: string, columns: string[] }>>`
      SELECT t.relname AS "tableName", i.relname AS "indexName",
             array_agg(a.attname ORDER BY k.ord) AS columns
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = ANY(${tables})
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
})

describe('demo-reset-style cascade with room/room_base_config data', () => {
  it('DELETE FROM organization removes room and room_base_config rows in one statement; another org is untouched', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)

    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeA = await makeRoomType(db, orgA)
    const { room: roomA, baseVersion: versionA } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeA.id)

    const hotelB = await makeHotel(db, orgB)
    const floorB = await makeFloor(db, trustedHotelScope(orgB, hotelB.id))
    const roomTypeB = await makeRoomType(db, orgB)
    const { room: roomB } = await makeRoomWithVersion(db, trustedHotelScope(orgB, hotelB.id), floorB.id, roomTypeB.id)

    await platformRepos(db).organizations.deleteCascade(orgA.organizationId)

    expect(await db.select().from(room).where(eq(room.id, roomA.id))).toEqual([])
    expect(await db.select().from(roomBaseConfig).where(eq(roomBaseConfig.id, versionA.id))).toEqual([])

    expect(await db.select().from(room).where(eq(room.id, roomB.id))).toHaveLength(1)
    expect(await db.select().from(hotel).where(eq(hotel.id, hotelB.id))).toHaveLength(1)
  })
})

describe('room lifetime-uniqueness (Q2): a retired room\'s number stays reserved forever', () => {
  it('a retired room\'s number still collides on a fresh room-number insert in the same hotel', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const scope = trustedHotelScope(orgA, hotelA.id)

    // A room whose ONLY version is fully closed (i.e. retired) -- no active/status column exists to "free" the number.
    await makeRoomWithVersion(db, scope, floorA.id, roomTypeRow.id, { roomNumber: '401' }, { validFrom: '2020-01-01', validTo: '2020-12-31' })

    const caught = await catchError(() => makeRoom(db, scope, floorA.id, roomTypeRow.id, { roomNumber: '401' }))
    expect(extractPgError(caught)?.code).toBe('23505')
  })
})
