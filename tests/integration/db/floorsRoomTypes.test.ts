import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { floor, hotel, roomType } from '../../../db/schema'
import { platformRepos } from '../../../server/repositories'
import { trustedHotelScope } from '../../../server/security/scope'
import { extractPgError, translateDbError } from '../../../server/errors/dbErrors'
import { ConflictError } from '../../../server/errors/domainError'
import { makeFloor, makeHotel, makeOrg, makeRoomType } from '../../support/fixtures'
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

describe('floor: unique (hotel_id, level) and check constraints', () => {
  it('rejects a duplicate level within the same hotel, allows the same level in another hotel, and translateDbError maps the duplicate', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const hotelB = await makeHotel(db, orgA)
    await makeFloor(db, trustedHotelScope(orgA, hotelA.id), { level: 3 })

    const caught = await catchError(() => makeFloor(db, trustedHotelScope(orgA, hotelA.id), { level: 3 }))
    expect(extractPgError(caught)?.code).toBe('23505')
    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ConflictError)
    expect(translated?.code).toBe('ALREADY_EXISTS')
    expect(translated?.httpStatus).toBe(409)

    await expect(makeFloor(db, trustedHotelScope(orgA, hotelB.id), { level: 3 })).resolves.toBeDefined()
  })

  it('rejects level 201 (above the maximum, CHECK 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const caught = await catchError(() => makeFloor(db, trustedHotelScope(orgA, hotelA.id), { level: 201 }))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('rejects level -6 (below the minimum, CHECK 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const caught = await catchError(() => makeFloor(db, trustedHotelScope(orgA, hotelA.id), { level: -6 }))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('accepts the boundary levels -5 and 200', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    await expect(makeFloor(db, trustedHotelScope(orgA, hotelA.id), { level: -5 })).resolves.toBeDefined()
    await expect(makeFloor(db, trustedHotelScope(orgA, hotelA.id), { level: 200 })).resolves.toBeDefined()
  })

  it('rejects a floor row pointing at another organization\'s hotel (composite FK, 23503)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)

    const caught = await catchError(() =>
      db.insert(floor).values({ organizationId: orgB.organizationId, hotelId: hotelA.id, level: 1, label: 'Floor 1' }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })
})

describe('room_type: unique (organization_id, code) and check constraints', () => {
  it('rejects a duplicate code within the same organization, allows the same code in another organization, and translateDbError maps the duplicate', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    await makeRoomType(db, orgA, { code: 'DUPE-RT' })

    const caught = await catchError(() => makeRoomType(db, orgA, { code: 'DUPE-RT' }))
    expect(extractPgError(caught)?.code).toBe('23505')
    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ConflictError)
    expect(translated?.code).toBe('ALREADY_EXISTS')
    expect(translated?.httpStatus).toBe(409)

    await expect(makeRoomType(db, orgB, { code: 'DUPE-RT' })).resolves.toBeDefined()
  })

  it('rejects defaultPhysicalBeds 0 (below the minimum, CHECK 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const caught = await catchError(() => makeRoomType(db, orgA, { defaultPhysicalBeds: 0 }))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('rejects defaultPhysicalBeds 31 (above the maximum, CHECK 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const caught = await catchError(() => makeRoomType(db, orgA, { defaultPhysicalBeds: 31 }))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('rejects defaultSellableCapacity 31 (above the maximum, CHECK 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const caught = await catchError(() => makeRoomType(db, orgA, { defaultSellableCapacity: 31 }))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('accepts defaultSellableCapacity greater than defaultPhysicalBeds (extra sellable capacity is a valid scenario)', async () => {
    const { scope: orgA } = await makeOrg(db)
    await expect(makeRoomType(db, orgA, { defaultPhysicalBeds: 4, defaultSellableCapacity: 6 })).resolves.toBeDefined()
  })
})

describe('FK index coverage (PF-6)', () => {
  it('every foreign-key column set on floor and room_type has a covering index', async () => {
    const client = getTestClient()
    const tables = ['floor', 'room_type']

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

describe('demo-reset-style cascade with floor/room_type data', () => {
  it('DELETE FROM organization removes floor and room_type rows in one statement; another org is untouched', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)

    const hotelA = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeA = await makeRoomType(db, orgA)

    const hotelB = await makeHotel(db, orgB)
    const floorB = await makeFloor(db, trustedHotelScope(orgB, hotelB.id))

    await platformRepos(db).organizations.deleteCascade(orgA.organizationId)

    expect(await db.select().from(floor).where(eq(floor.id, floorA.id))).toEqual([])
    expect(await db.select().from(roomType).where(eq(roomType.id, roomTypeA.id))).toEqual([])

    expect(await db.select().from(floor).where(eq(floor.id, floorB.id))).toHaveLength(1)
    expect(await db.select().from(hotel).where(eq(hotel.id, hotelB.id))).toHaveLength(1)
  })
})
