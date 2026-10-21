import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { capacityPeriod, roomCapacityOverride } from '../../../db/schema'
import { extractPgError, translateDbError } from '../../../server/errors/dbErrors'
import { ConflictError, ValidationError } from '../../../server/errors/domainError'
import { CapacityPeriodRepository, RoomCapacityOverrideRepository } from '../../../server/repositories/hotel'
import { trustedHotelScope } from '../../../server/security/scope'
import { makeCapacityPeriod, makeFloor, makeHotel, makeOrg, makeRoomCapacityOverride, makeRoomType, makeRoomWithVersion } from '../../support/fixtures'
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

/** A hotel + floor + room type + one in-service room, with its base version, plus an in-service-hotel scope. */
async function setupRoom() {
  const { scope: orgA } = await makeOrg(db)
  const hotelA = await makeHotel(db, orgA)
  const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
  const roomTypeRow = await makeRoomType(db, orgA)
  const scope = trustedHotelScope(orgA, hotelA.id)
  const { room: roomRow } = await makeRoomWithVersion(db, scope, floorA.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
  return { orgA, hotelA, floorA, roomTypeRow, scope, roomRow }
}

describe('room_capacity_override: check constraints', () => {
  it('rejects physicalBeds 0 and 31 (CHECK 23514)', async () => {
    const { scope, roomRow } = await setupRoom()
    const period = await makeCapacityPeriod(db, scope)

    expect(extractPgError(await catchError(() => makeRoomCapacityOverride(db, scope, roomRow.id, period.id, { physicalBeds: 0 })))?.code).toBe('23514')
    expect(extractPgError(await catchError(() => makeRoomCapacityOverride(db, scope, roomRow.id, period.id, { physicalBeds: 31 })))?.code).toBe('23514')
  })

  it('rejects sellableCapacity 31 (CHECK 23514) and accepts sellableCapacity 0', async () => {
    const { scope, roomRow } = await setupRoom()
    const period = await makeCapacityPeriod(db, scope)

    expect(extractPgError(await catchError(() => makeRoomCapacityOverride(db, scope, roomRow.id, period.id, { sellableCapacity: 31 })))?.code).toBe('23514')
    await expect(makeRoomCapacityOverride(db, scope, roomRow.id, period.id, { sellableCapacity: 0 })).resolves.toBeDefined()
  })
})

describe('room_override_no_overlap: temporal-integrity exclusion constraint (empirical proof)', () => {
  it('accepts adjacent overrides (different periods, no gap) for the same room', async () => {
    const { scope, roomRow } = await setupRoom()
    const periodA = await makeCapacityPeriod(db, scope, { name: 'Period A', startDate: '2027-05-01', endDate: '2027-07-31' })
    const periodB = await makeCapacityPeriod(db, scope, { name: 'Period B', startDate: '2027-08-01', endDate: '2027-08-31' })

    await makeRoomCapacityOverride(db, scope, roomRow.id, periodA.id, { validFrom: periodA.startDate, validTo: periodA.endDate })
    await expect(makeRoomCapacityOverride(db, scope, roomRow.id, periodB.id, { validFrom: periodB.startDate, validTo: periodB.endDate })).resolves.toBeDefined()
  })

  it('rejects an overlapping override for the same room (different periods) with 23P01, translated to 409 RANGE_OVERLAP', async () => {
    const { scope, roomRow } = await setupRoom()
    const periodA = await makeCapacityPeriod(db, scope, { name: 'Period A', startDate: '2027-05-01', endDate: '2027-07-31' })
    const periodB = await makeCapacityPeriod(db, scope, { name: 'Period B', startDate: '2027-07-15', endDate: '2027-09-15' }) // overlaps periodA by 16 nights

    await makeRoomCapacityOverride(db, scope, roomRow.id, periodA.id, { validFrom: periodA.startDate, validTo: periodA.endDate })

    const caught = await catchError(() => makeRoomCapacityOverride(db, scope, roomRow.id, periodB.id, { validFrom: periodB.startDate, validTo: periodB.endDate }))
    const pg = extractPgError(caught)
    expect(pg?.code).toBe('23P01')
    expect(pg?.constraint).toBe('room_override_no_overlap')

    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ConflictError)
    expect(translated?.code).toBe('RANGE_OVERLAP')
    expect(translated?.httpStatus).toBe(409)

    const rows = await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.roomId, roomRow.id))
    expect(rows).toHaveLength(1) // only periodA's override landed
  })

  it('does NOT reject overlapping ranges for DIFFERENT rooms (the exclusion is per room_id)', async () => {
    const { scope, floorA, roomTypeRow } = await setupRoom()
    const { room: roomTwo } = await makeRoomWithVersion(db, scope, floorA.id, roomTypeRow.id, { roomNumber: 'R-TWO' }, { validFrom: '2025-01-01', validTo: null })
    const { room: roomOne } = await makeRoomWithVersion(db, scope, floorA.id, roomTypeRow.id, { roomNumber: 'R-ONE' }, { validFrom: '2025-01-01', validTo: null })
    const period = await makeCapacityPeriod(db, scope)

    await makeRoomCapacityOverride(db, scope, roomOne.id, period.id, { validFrom: period.startDate, validTo: period.endDate })
    const periodTwo = await makeCapacityPeriod(db, scope, { name: 'Same Range', startDate: period.startDate, endDate: period.endDate })
    await expect(makeRoomCapacityOverride(db, scope, roomTwo.id, periodTwo.id, { validFrom: periodTwo.startDate, validTo: periodTwo.endDate })).resolves.toBeDefined()
  })
})

describe('room_override_period_dates_fk: an override\'s dates must match its period\'s own dates', () => {
  it('rejects an override whose valid_from/valid_to DIFFER from its period\'s start/end (23503), translated to 422 INVALID_REFERENCE', async () => {
    const { scope, roomRow } = await setupRoom()
    const period = await makeCapacityPeriod(db, scope, { startDate: '2027-05-01', endDate: '2027-07-31' })

    // Deliberately mismatched: the row's own dates (2027-05-02..07-30) differ from the period's (2027-05-01..07-31).
    const caught = await catchError(() => makeRoomCapacityOverride(db, scope, roomRow.id, period.id, { validFrom: '2027-05-02', validTo: '2027-07-30' }))
    const pg = extractPgError(caught)
    expect(pg?.code).toBe('23503')
    expect(pg?.constraint).toBe('room_override_period_dates_fk')

    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ValidationError)
    expect(translated?.code).toBe('INVALID_REFERENCE')
    expect(translated?.httpStatus).toBe(422)
  })
})

describe('fresh-fixture FK-mismatch cases (23503) -- a unique-key error on stale fixtures can never mask these', () => {
  it('rejects an override whose room belongs to another hotel within the same organization (composite FK, 23503)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const hotelB = await makeHotel(db, orgA)
    const floorB = await makeFloor(db, trustedHotelScope(orgA, hotelB.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const { room: roomInB } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelB.id), floorB.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
    const periodInA = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelA.id))

    const caught = await catchError(() =>
      db.insert(roomCapacityOverride).values({
        organizationId: orgA.organizationId,
        hotelId: hotelA.id,
        roomId: roomInB.id, // belongs to hotelB, not hotelA
        periodId: periodInA.id,
        validFrom: periodInA.startDate,
        validTo: periodInA.endDate,
        physicalBeds: 6,
        sellableCapacity: 6,
      }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })

  it('rejects an override whose period belongs to another hotel within the same organization (composite FK, 23503)', async () => {
    const { scope: orgA } = await makeOrg(db)
    const hotelA = await makeHotel(db, orgA)
    const hotelB = await makeHotel(db, orgA)
    const floorA = await makeFloor(db, trustedHotelScope(orgA, hotelA.id))
    const roomTypeRow = await makeRoomType(db, orgA)
    const { room: roomInA } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelA.id), floorA.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
    const periodInB = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelB.id))

    const caught = await catchError(() =>
      db.insert(roomCapacityOverride).values({
        organizationId: orgA.organizationId,
        hotelId: hotelA.id,
        roomId: roomInA.id,
        periodId: periodInB.id, // belongs to hotelB, not hotelA
        validFrom: periodInB.startDate,
        validTo: periodInB.endDate,
        physicalBeds: 6,
        sellableCapacity: 6,
      }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })

  it('rejects an override whose (organization_id, period_id) mismatches (period belongs to another organization entirely)', async () => {
    const { scope, roomRow } = await setupRoom()
    const { scope: otherOrg } = await makeOrg(db)
    const foreignHotel = await makeHotel(db, otherOrg)
    const foreignPeriod = await makeCapacityPeriod(db, trustedHotelScope(otherOrg, foreignHotel.id))

    const caught = await catchError(() =>
      db.insert(roomCapacityOverride).values({
        organizationId: scope.organizationId,
        hotelId: scope.hotelId,
        roomId: roomRow.id,
        periodId: foreignPeriod.id, // belongs to a DIFFERENT organization entirely
        validFrom: foreignPeriod.startDate,
        validTo: foreignPeriod.endDate,
        physicalBeds: 6,
        sellableCapacity: 6,
      }))
    expect(extractPgError(caught)?.code).toBe('23503')
  })
})

describe('date-cascade: editing a period\'s dates cascades to its override rows through the FK (ON UPDATE CASCADE)', () => {
  it('shrinking a period\'s dates updates its override rows to match', async () => {
    const { scope, roomRow } = await setupRoom()
    const period = await makeCapacityPeriod(db, scope, { startDate: '2027-05-01', endDate: '2027-07-31' })
    await makeRoomCapacityOverride(db, scope, roomRow.id, period.id, { validFrom: period.startDate, validTo: period.endDate })

    await new CapacityPeriodRepository(db, scope).update(period.id, { endDate: '2027-06-30' })

    const [overrideRow] = await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.periodId, period.id))
    expect(overrideRow?.validTo).toBe('2027-06-30') // cascaded automatically, no direct write to the override row
  })

  it('extending a period into another period\'s overridden range for the SAME room is rejected (409-shaped 23P01), and BOTH the period and its overrides are left UNCHANGED', async () => {
    const { scope, roomRow } = await setupRoom()
    const periodA = await makeCapacityPeriod(db, scope, { name: 'Extend A', startDate: '2027-05-01', endDate: '2027-06-30' })
    const periodB = await makeCapacityPeriod(db, scope, { name: 'Extend B', startDate: '2027-07-15', endDate: '2027-08-15' })
    await makeRoomCapacityOverride(db, scope, roomRow.id, periodA.id, { validFrom: periodA.startDate, validTo: periodA.endDate })
    await makeRoomCapacityOverride(db, scope, roomRow.id, periodB.id, { validFrom: periodB.startDate, validTo: periodB.endDate })

    // Extending periodA's end to 2027-07-20 would cascade its override to 2027-05-01..07-20, which
    // overlaps periodB's override (2027-07-15..08-15) for the SAME room -- the exclusion constraint
    // must reject the whole statement (the period's own row update included).
    const caught = await catchError(() => new CapacityPeriodRepository(db, scope).update(periodA.id, { endDate: '2027-07-20' }))
    expect(extractPgError(caught)?.code).toBe('23P01')
    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ConflictError)
    expect(translated?.code).toBe('RANGE_OVERLAP')

    // The period's own row is unchanged.
    const [periodRow] = await db.select().from(capacityPeriod).where(eq(capacityPeriod.id, periodA.id))
    expect(periodRow?.endDate).toBe('2027-06-30')

    // Both override rows are unchanged.
    const overrides = await new RoomCapacityOverrideRepository(db, scope).findByPeriod(periodA.id)
    expect(overrides[0]?.validTo).toBe('2027-06-30')
    const overridesB = await new RoomCapacityOverrideRepository(db, scope).findByPeriod(periodB.id)
    expect(overridesB[0]?.validFrom).toBe('2027-07-15')
  })
})

describe('FK index coverage (global "every FK column set gets an index" rule)', () => {
  it('every foreign-key column set on capacity_period and room_capacity_override has a covering index', async () => {
    const client = getTestClient()
    const tables = ['capacity_period', 'room_capacity_override']

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
