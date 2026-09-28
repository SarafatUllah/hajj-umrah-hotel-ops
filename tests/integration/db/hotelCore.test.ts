import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auditLog, hotel, hotelSetting, userHotelAccess } from '../../../db/schema'
import { platformRepos, tenantRepos } from '../../../server/repositories'
import { HotelSettingRepository } from '../../../server/repositories/hotel'
import { trustedHotelScope } from '../../../server/security/scope'
import { extractPgError, translateDbError } from '../../../server/errors/dbErrors'
import { ConflictError } from '../../../server/errors/domainError'
import { makeHotel, makeOrg, makeUser } from '../../support/fixtures'
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

describe('hotel: unique/check constraints and error mapping', () => {
  it('rejects a duplicate hotel code within the same organization, allows it in another, and translateDbError maps it', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    await makeHotel(db, orgA, { code: 'DUPE' })

    const caught = await catchError(() => makeHotel(db, orgA, { code: 'DUPE' }))
    expect(extractPgError(caught)?.code).toBe('23505')
    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ConflictError)
    expect(translated?.code).toBe('HOTEL_CODE_TAKEN')
    expect(translated?.httpStatus).toBe(409)

    await expect(makeHotel(db, orgB, { code: 'DUPE' })).resolves.toBeDefined()
  })

  it('rejects an invalid status (CHECK, 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const caught = await catchError(() =>
      db.insert(hotel).values({ organizationId: orgA.organizationId, code: 'S1', name: 'H', city: 'Makkah', status: 'BOGUS' } as never))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('rejects an invalid ownership_type (CHECK, 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const caught = await catchError(() =>
      db.insert(hotel).values({ organizationId: orgA.organizationId, code: 'O1', name: 'H', city: 'Makkah', ownershipType: 'BOGUS' } as never))
    expect(extractPgError(caught)?.code).toBe('23514')
  })

  it('rejects a currency that is not exactly 3 characters (CHECK, 23514)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const caught = await catchError(() =>
      db.insert(hotel).values({ organizationId: orgA.organizationId, code: 'C1', name: 'H', city: 'Makkah', currency: 'US' } as never))
    expect(extractPgError(caught)?.code).toBe('23514')
  })
})

describe('composite-FK isolation', () => {
  it('rejects a hotel_setting row pointing at another organization\'s hotel', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)

    const caught = await catchError(() =>
      db.insert(hotelSetting).values({ organizationId: orgB.organizationId, hotelId: hotelA.id, key: 'k', value: {} }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })

  it('rejects a user_hotel_access row pointing at another organization\'s hotel', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const userB = await makeUser(db, orgB)

    const caught = await catchError(() =>
      db.insert(userHotelAccess).values({ organizationId: orgB.organizationId, userId: userB.id, hotelId: hotelA.id }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })

  it('rejects a user_hotel_access row for another organization\'s user', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const hotelB = await makeHotel(db, orgB)
    const userA = await makeUser(db, orgA)

    const caught = await catchError(() =>
      db.insert(userHotelAccess).values({ organizationId: orgB.organizationId, userId: userA.id, hotelId: hotelB.id }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })

  it('rejects an audit_log row pointing at another organization\'s hotel', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)

    const caught = await catchError(() =>
      db.insert(auditLog).values({ organizationId: orgB.organizationId, hotelId: hotelA.id, entityType: 'x', entityId: 'x', action: 'PROBE' }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })
})

describe('audit_log immutability', () => {
  it('rejects an UPDATE with SQLSTATE 55000', async () => {
    const { scope: orgA } = await makeOrg(db)
    await tenantRepos(db, orgA).audit.record({ entityType: 'x', entityId: 'x', action: 'PROBE' })
    const [row] = await db.select().from(auditLog).where(eq(auditLog.organizationId, orgA.organizationId))

    const caught = await catchError(() => db.update(auditLog).set({ reason: 'edited' }).where(eq(auditLog.id, row!.id)))
    expect(extractPgError(caught)?.code).toBe('55000')

    // Unedited: the reason column still holds whatever the INSERT wrote (null), not 'edited'.
    const [stillOriginal] = await db.select().from(auditLog).where(eq(auditLog.id, row!.id))
    expect(stillOriginal!.reason).toBeNull()
  })

  it('allows INSERT', async () => {
    const { scope: orgA } = await makeOrg(db)
    await expect(tenantRepos(db, orgA).audit.record({ entityType: 'x', entityId: 'x', action: 'PROBE' })).resolves.toBeUndefined()
  })

  it('DELETE FROM organization still cascades audit rows away (only UPDATE is blocked)', async () => {
    const { scope: orgA } = await makeOrg(db)
    await tenantRepos(db, orgA).audit.record({ entityType: 'x', entityId: 'x', action: 'PROBE' })
    expect(await db.select().from(auditLog).where(eq(auditLog.organizationId, orgA.organizationId))).toHaveLength(1)

    await platformRepos(db).organizations.deleteCascade(orgA.organizationId)

    expect(await db.select().from(auditLog).where(eq(auditLog.organizationId, orgA.organizationId))).toEqual([])
  })

  it('truncateAllTables() still works with audit_log rows present', async () => {
    const { scope: orgA } = await makeOrg(db)
    await tenantRepos(db, orgA).audit.record({ entityType: 'x', entityId: 'x', action: 'PROBE' })

    await expect(truncateAllTables()).resolves.toBeUndefined()
    expect(await db.select().from(auditLog)).toEqual([])
  })
})

describe('FK index coverage (PF-6)', () => {
  it('every foreign-key column set on hotel, hotel_setting, user_hotel_access and audit_log has a covering index', async () => {
    const client = getTestClient()
    const tables = ['hotel', 'hotel_setting', 'user_hotel_access', 'audit_log']

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

    // Coverage = some index on the same table whose leading columns (a prefix of the same length
    // as the FK's column set) are exactly the FK's columns, in any order (leftmost-prefix rule).
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

describe('hotel_setting upsert conflict-path isolation', () => {
  it('never updates another organization\'s existing row, even with a scope holding a leaked hotelId', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    await new HotelSettingRepository(db, trustedHotelScope(orgA, hotelA.id)).upsert('checkInGrace', { minutes: 15 })

    const { scope: orgB } = await makeOrg(db)
    // Org B's caller holding org A's leaked hotelId — the same adversarial construction used by
    // the isolation registry (org B never learns org A's data, but may have observed the hotelId).
    const adversarial = trustedHotelScope(orgB, hotelA.id)

    const caught = await catchError(() =>
      new HotelSettingRepository(db, adversarial).upsert('checkInGrace', { minutes: 999 }))

    // Org A's existing row must be exactly as it was — regardless of whether the call rejected.
    const [row] = await db.select().from(hotelSetting)
      .where(and(eq(hotelSetting.hotelId, hotelA.id), eq(hotelSetting.key, 'checkInGrace')))
    expect(row!.value).toEqual({ minutes: 15 })

    // The call is expected to reject on the composite FK: (orgB, hotelA.id) has no matching hotel row.
    expect(extractPgError(caught)?.code).toBe('23503')

    // Positive control: org A's own legitimate scope can still update the same existing key.
    await new HotelSettingRepository(db, trustedHotelScope(orgA, hotelA.id)).upsert('checkInGrace', { minutes: 20 })
    const [updated] = await db.select().from(hotelSetting)
      .where(and(eq(hotelSetting.hotelId, hotelA.id), eq(hotelSetting.key, 'checkInGrace')))
    expect(updated!.value).toEqual({ minutes: 20 })
  })
})

describe('demo-reset-style cascade with hotel data', () => {
  it('DELETE FROM organization removes hotel, hotel_setting, user_hotel_access and audit_log rows in one statement; another org is untouched', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)

    const hotelA = await makeHotel(db, orgA)
    await new HotelSettingRepository(db, trustedHotelScope(orgA, hotelA.id)).upsert('checkInGrace', { minutes: 15 })
    const userA = await makeUser(db, orgA)
    await tenantRepos(db, orgA).userHotelAccess.replaceForUser(userA.id, [hotelA.id], null)
    await tenantRepos(db, orgA).audit.record({ hotelId: hotelA.id, entityType: 'hotel', entityId: hotelA.id, action: 'HOTEL_CREATED' })

    const hotelB = await makeHotel(db, orgB)
    await new HotelSettingRepository(db, trustedHotelScope(orgB, hotelB.id)).upsert('checkInGrace', { minutes: 30 })

    await platformRepos(db).organizations.deleteCascade(orgA.organizationId)

    expect(await db.select().from(hotel).where(eq(hotel.organizationId, orgA.organizationId))).toEqual([])
    expect(await db.select().from(hotelSetting).where(eq(hotelSetting.hotelId, hotelA.id))).toEqual([])
    expect(await db.select().from(userHotelAccess).where(eq(userHotelAccess.hotelId, hotelA.id))).toEqual([])
    expect(await db.select().from(auditLog).where(eq(auditLog.hotelId, hotelA.id))).toEqual([])

    expect(await db.select().from(hotel).where(eq(hotel.id, hotelB.id))).toHaveLength(1)
    expect(await db.select().from(hotelSetting).where(eq(hotelSetting.hotelId, hotelB.id))).toHaveLength(1)
  })
})
