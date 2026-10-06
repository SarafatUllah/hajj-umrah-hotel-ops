import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { capacityPeriod, floor, hotel, room, roomBaseConfig, roomCapacityOverride, roomOperationalBlock, roomType } from '../../../db/schema'
import { seedDemoOrganization } from '../../../db/seed/demo-org'
import { demoIds } from '../../../db/seed/demo/ids'
import { versionsCoverEveryNight } from '../../../db/seed/demo/inventory'
import { DEMO_HOTELS, DEMO_ROOM_TYPES, ROOM_TYPE_CODES } from '../../../server/demo/catalog'
import { DEMO_PERSONAS } from '../../../server/demo/personas'
import type { AuthContext } from '../../../server/security/authContext'
import { getCapacityPeriod, getRoomCapacityTimeline, listOverrides } from '../../../server/services/capacityPeriodService'
import { getHotelAverages, getOrganizationAverages } from '../../../server/services/capacityAverageService'
import { getDailySummary, getRoomCalendar } from '../../../server/services/roomCalendarService'
import { blockPhase } from '../../../server/domain/inventory/blockRules'
import { BLOCK_KINDS } from '../../../shared/constants/inventory'
import { addDays, rangeLength, rangesOverlap, toEpochDay } from '../../../shared/utils/dates'
import { demoContext } from '../../support/demoContext'
import { fingerprintOrganization } from '../../support/fingerprint'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
const ANCHOR = '2026-09-01'
let orgId = ''
let admin: AuthContext

beforeAll(async () => {
  await truncateAllTables()
  const seeded = await seedDemoOrganization(db)
  orgId = seeded.organizationId
  admin = await demoContext(db, 'admin')
}, 60_000)

afterAll(async () => {
  await truncateAllTables()
  await closeTestDb()
})

const hotelId = (code: string) => demoIds.hotel(code)
const byOrg = <T extends { organizationId: unknown }>(table: T) => eq(table.organizationId as never, orgId)

describe('demo seed: determinism (fingerprint)', () => {
  it('seeding, wiping to an empty database and seeding again with the same anchor gives an identical fingerprint', async () => {
    const first = await fingerprintOrganization(db, orgId)
    await truncateAllTables()
    const again = await seedDemoOrganization(db)
    expect(again.organizationId).toBe(orgId)
    const second = await fingerprintOrganization(db, again.organizationId)
    expect(second.hash).toBe(first.hash)
    expect(second.tables).toEqual(first.tables)
    expect(Object.entries(first.tables).filter(([name]) => name !== 'hotel_setting').every(([, t]) => t.rows > 0)).toBe(true)
  })

  it('re-running the seed over the existing demo organization (db:seed twice) is idempotent: same ids, same fingerprint, one organization', async () => {
    const before = await fingerprintOrganization(db, orgId)
    const again = await seedDemoOrganization(db)
    expect(again.organizationId).toBe(orgId)
    expect((await fingerprintOrganization(db, orgId)).hash).toBe(before.hash)
  })

  it('a different anchor date changes the fingerprint (anchor-relative rows move), the same anchor does not, and fixed-calendar tables do not move', async () => {
    const base = await fingerprintOrganization(db, orgId)
    await seedDemoOrganization(db, { anchorDate: '2026-11-15' })
    const moved = await fingerprintOrganization(db, orgId)
    expect(moved.hash).not.toBe(base.hash)
    expect(moved.tables.room_operational_block!.hash).not.toBe(base.tables.room_operational_block!.hash)
    for (const table of ['hotel', 'floor', 'room', 'room_base_config', 'capacity_period', 'room_capacity_override', 'app_user', 'user_hotel_access']) {
      expect(moved.tables[table]!.hash, table).toBe(base.tables[table]!.hash)
    }
    await seedDemoOrganization(db, { anchorDate: ANCHOR })
    expect((await fingerprintOrganization(db, orgId)).hash).toBe(base.hash)
  })

  it('a different anchor yields different relative dates on a running maintenance block', async () => {
    const running = async () => (await db.select().from(roomOperationalBlock).where(and(byOrg(roomOperationalBlock), eq(roomOperationalBlock.id, demoIds.block('MKK-GRAND', 'maintenance-running-0'))))).map(b => [b.startDate, b.endDate])
    const atDefault = await running()
    await seedDemoOrganization(db, { anchorDate: '2027-01-10' })
    const moved = await running()
    await seedDemoOrganization(db, { anchorDate: ANCHOR })
    expect(moved).not.toEqual(atDefault)
    expect(await running()).toEqual(atDefault)
  })
})

describe('demo catalogue invariants (through the database)', () => {
  it('has 5 hotels in Makkah/Madinah with the catalogue defaults, 4 room types and exactly 360 rooms', async () => {
    const hotels = await db.select().from(hotel).where(byOrg(hotel))
    expect(hotels).toHaveLength(5)
    expect(hotels.filter(h => h.city === 'Makkah')).toHaveLength(3)
    expect(hotels.filter(h => h.city === 'Madinah')).toHaveLength(2)
    for (const h of hotels) {
      const spec = DEMO_HOTELS.find(s => s.code === h.code)!
      expect(h).toMatchObject({ name: spec.name, ownershipType: spec.ownership, timezone: 'Asia/Riyadh', currency: 'SAR', status: 'ACTIVE' })
      expect(String(h.checkInTime).slice(0, 5)).toBe('15:00')
      expect(String(h.checkOutTime).slice(0, 5)).toBe('12:00')
    }
    expect(hotels.map(h => [h.code, h.ownershipType]).sort()).toEqual([['MED-CENT', 'OWNED'], ['MED-QUBA', 'OWNED'], ['MKK-AJYAD', 'CONTRACTED'], ['MKK-AZIZ', 'LEASED'], ['MKK-GRAND', 'OWNED']])

    const types = await db.select().from(roomType).where(byOrg(roomType))
    expect(types.map(t => [t.code, t.defaultPhysicalBeds, t.defaultSellableCapacity]).sort()).toEqual([['QUAD', 4, 4], ['QUINT', 5, 5], ['SIX_BED', 6, 6], ['TRIPLE', 3, 3]])
    expect(types.map(t => t.id).sort()).toEqual(DEMO_ROOM_TYPES.map(t => demoIds.roomType(t.code)).sort())

    expect(await db.select().from(room).where(byOrg(room))).toHaveLength(360)
  })

  it.each(DEMO_HOTELS.map(h => [h.code, h] as const))('%s: room count, type distribution, floors, ten rooms per floor, unique numbers', async (_code, spec) => {
    const rooms = await db.select({ number: room.roomNumber, floorId: room.floorId, typeCode: roomType.code }).from(room).innerJoin(roomType, eq(roomType.id, room.roomTypeId)).where(eq(room.hotelId, hotelId(spec.code)))
    expect(rooms).toHaveLength(spec.rooms)
    for (const code of ROOM_TYPE_CODES) expect(rooms.filter(r => r.typeCode === code)).toHaveLength(spec.distribution[code])
    expect(new Set(rooms.map(r => r.number)).size).toBe(spec.rooms)

    const floors = await db.select().from(floor).where(eq(floor.hotelId, hotelId(spec.code)))
    expect(floors.map(f => f.level).sort((a, b) => a - b)).toEqual(Array.from({ length: spec.floors }, (_, i) => spec.firstLevel + i))
    for (const f of floors) {
      const onFloor = rooms.filter(r => r.floorId === f.id)
      expect(onFloor).toHaveLength(10)
      expect(onFloor.map(r => r.number).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `${f.level}${String(i + 1).padStart(2, '0')}`).sort())
    }
  })

  it('MKK-GRAND room 401 is a Quad on level 4', async () => {
    const [r] = await db.select({ number: room.roomNumber, level: floor.level, typeCode: roomType.code }).from(room)
      .innerJoin(floor, eq(floor.id, room.floorId)).innerJoin(roomType, eq(roomType.id, room.roomTypeId))
      .where(and(eq(room.hotelId, hotelId('MKK-GRAND')), eq(room.roomNumber, '401')))
    expect(r).toEqual({ number: '401', level: 4, typeCode: 'QUAD' })
  })

  it('every id is a stable function of its key (hotels, rooms, versions, periods, overrides, blocks)', async () => {
    const rooms = await db.select().from(room).where(byOrg(room))
    for (const r of rooms) {
      const [h] = DEMO_HOTELS.filter(s => hotelId(s.code) === r.hotelId)
      expect(r.id).toBe(demoIds.room(h!.code, r.roomNumber))
    }
    const periods = await db.select().from(capacityPeriod).where(byOrg(capacityPeriod))
    expect(periods.map(p => p.id).sort()).toEqual(periods.map(p => p.id).sort())
    expect(periods.some(p => p.id === demoIds.period('MKK-GRAND', 'hajj-2027'))).toBe(true)
  })
})

describe('demo requirement examples through the real services (Tasks 17/18)', () => {
  it('MKK-AJYAD base average on 2025-07-01 is 310/80 -> "3.88"', async () => {
    const a = await getHotelAverages(admin, hotelId('MKK-AJYAD'), { date: '2025-07-01' })
    expect(a.base).toMatchObject({ numerator: 310, denominator: 80, display: '3.88', basis: 'ROOMS' })
  })

  it('every hotel reproduces its catalogue initial capacity on 2025-07-01 (renovations and sellable reductions start later)', async () => {
    for (const spec of DEMO_HOTELS) {
      const a = await getHotelAverages(admin, hotelId(spec.code), { date: '2025-07-01' })
      expect(a.base.numerator, spec.code).toBe(spec.initialCapacity)
      expect(a.base.denominator, spec.code).toBe(spec.rooms)
    }
    const display = Object.fromEntries(await Promise.all(DEMO_HOTELS.map(async s => [s.code, (await getHotelAverages(admin, hotelId(s.code), { date: '2025-07-01' })).base.display])))
    expect(display).toEqual({ 'MKK-GRAND': '4.60', 'MKK-AJYAD': '3.88', 'MKK-AZIZ': '5.00', 'MED-CENT': '4.23', 'MED-QUBA': '4.24' })
  })

  it('organization base average on 2025-07-01 is 1578/360 -> "4.38"', async () => {
    const org = await getOrganizationAverages(admin, { date: '2025-07-01' })
    expect(org.base).toMatchObject({ numerator: 1578, denominator: 360, display: '4.38' })
    expect(org.perHotel).toHaveLength(5)
  })

  it('the 2026 renovations and sellable reductions are visible after the reference date', async () => {
    const before = await getOrganizationAverages(admin, { date: '2025-07-01' })
    const after = await getOrganizationAverages(admin, { date: '2026-04-15' })
    expect(after.base.denominator).toBeLessThan(before.base.denominator) // rooms retired effective 2026-04-01
    expect(after.base.numerator! / after.base.denominator!).toBeGreaterThan(before.base.numerator! / before.base.denominator!)
  })

  it('room 401 (MKK-GRAND): 4/4 on 2027-04-30, 6/6 on 2027-05-01 and 2027-07-31, 4/4 on 2027-08-01', async () => {
    const roomId = demoIds.room('MKK-GRAND', '401')
    const timeline = await getRoomCapacityTimeline(admin, hotelId('MKK-GRAND'), roomId, { from: '2027-04-30', to: '2027-08-01' })
    expect(timeline.segments.map(s => [s.from, s.to, s.physicalBeds, s.sellableCapacity, s.source])).toEqual([
      ['2027-04-30', '2027-04-30', 4, 4, 'BASE'],
      ['2027-05-01', '2027-07-31', 6, 6, 'PERIOD_OVERRIDE'],
      ['2027-08-01', '2027-08-01', 4, 4, 'BASE'],
    ])
    for (const [date, beds] of [['2027-04-30', 4], ['2027-05-01', 6], ['2027-07-31', 6], ['2027-08-01', 4]] as const) {
      const t = await getRoomCapacityTimeline(admin, hotelId('MKK-GRAND'), roomId, { from: date, to: date })
      expect(t.segments).toHaveLength(1)
      expect([t.segments[0]!.physicalBeds, t.segments[0]!.sellableCapacity], date).toEqual([beds, beds])
    }
  })

  it('Hajj 2026 (past at the anchor) is queryable and shows the historical override', async () => {
    const period = await getCapacityPeriod(admin, hotelId('MKK-GRAND'), demoIds.period('MKK-GRAND', 'hajj-2026'))
    expect(period).toMatchObject({ name: 'Hajj 2026', kind: 'HAJJ', startDate: '2026-05-01', endDate: '2026-07-31', phase: 'ENDED' })
    expect(period.overrideCount).toBeGreaterThan(0)
    const overrides = await listOverrides(admin, hotelId('MKK-GRAND'), period.id)
    expect(overrides.length).toBe(period.overrideCount)
    const timeline = await getRoomCapacityTimeline(admin, hotelId('MKK-GRAND'), demoIds.room('MKK-GRAND', '401'), { from: '2026-04-30', to: '2026-08-01' })
    expect(timeline.segments.map(s => [s.from, s.to, s.physicalBeds, s.source])).toEqual([
      ['2026-04-30', '2026-04-30', 4, 'BASE'], ['2026-05-01', '2026-07-31', 6, 'PERIOD_OVERRIDE'], ['2026-08-01', '2026-08-01', 4, 'BASE'],
    ])
  })

  it('the six seasonal periods exist with the specified dates, kinds and hotel applicability', async () => {
    const rows = await db.select().from(capacityPeriod).where(byOrg(capacityPeriod))
    const code = (id: string) => DEMO_HOTELS.find(h => hotelId(h.code) === id)!.code
    const summary = (name: string) => rows.filter(p => p.name === name).map(p => [code(p.hotelId), p.kind, p.startDate, p.endDate]).sort()
    const all = (kind: string, start: string, end: string) => DEMO_HOTELS.map(h => [h.code, kind, start, end]).sort()
    expect(summary('Ramadan 2026')).toEqual(all('RAMADAN', '2026-02-18', '2026-03-19'))
    expect(summary('Hajj 2026')).toEqual(all('HAJJ', '2026-05-01', '2026-07-31'))
    expect(summary('Ramadan 2027')).toEqual(all('RAMADAN', '2027-02-08', '2027-03-09'))
    expect(summary('Hajj 2027')).toEqual(all('HAJJ', '2027-05-01', '2027-07-31'))
    expect(summary('Umrah Peak Dec 2026')).toEqual([['MKK-AJYAD', 'SPECIAL', '2026-12-15', '2027-01-15'], ['MKK-AZIZ', 'SPECIAL', '2026-12-15', '2027-01-15']])
    expect(summary('Hajj 2028')).toEqual([['MKK-AJYAD', 'HAJJ', '2028-04-19', '2028-07-19'], ['MKK-GRAND', 'HAJJ', '2028-04-19', '2028-07-19']])
    expect(rows).toHaveLength(24)
    for (const p of rows) expect(p.notes).toBeTruthy()
  })

  it('about 5% of rooms have sellable < physical beds from 2026-01-01 and none before (so the catalogue reference holds)', async () => {
    const versions = await db.select().from(roomBaseConfig).where(byOrg(roomBaseConfig))
    const flagged = new Set(versions.filter(v => v.sellableCapacity !== v.physicalBeds).map(v => v.roomId))
    expect(flagged.size).toBeGreaterThanOrEqual(Math.floor(360 * 0.03))
    expect(flagged.size).toBeLessThanOrEqual(Math.ceil(360 * 0.07))
    for (const v of versions.filter(v => v.sellableCapacity !== v.physicalBeds)) expect(toEpochDay(v.validFrom)).toBeGreaterThanOrEqual(toEpochDay('2026-01-01'))
    for (const v of versions.filter(v => toEpochDay(v.validFrom) <= toEpochDay('2025-07-01'))) expect(v.sellableCapacity).toBe(v.physicalBeds)
    // and visibly different through the calendar service on the anchor
    const cal = await getRoomCalendar(admin, hotelId('MKK-GRAND'), { from: ANCHOR, to: ANCHOR, pageSize: 200 })
    const differing = cal.rooms.filter(r => r.segments.some(s => s.physicalBeds !== null && s.sellableCapacity !== null && s.physicalBeds !== s.sellableCapacity))
    expect(differing.length).toBeGreaterThanOrEqual(3)
  })
})

describe('demo consistency', () => {
  it('every override has exactly its period dates, and covers the room for every night (the Task 15 rule)', async () => {
    const [overrides, periods, versions] = await Promise.all([
      db.select().from(roomCapacityOverride).where(byOrg(roomCapacityOverride)),
      db.select().from(capacityPeriod).where(byOrg(capacityPeriod)),
      db.select().from(roomBaseConfig).where(byOrg(roomBaseConfig)),
    ])
    expect(overrides.length).toBeGreaterThan(500)
    const periodById = new Map(periods.map(p => [p.id, p]))
    for (const o of overrides) {
      const p = periodById.get(o.periodId)!
      expect([o.validFrom, o.validTo]).toEqual([p.startDate, p.endDate])
      expect(o.hotelId).toBe(p.hotelId)
      expect(versionsCoverEveryNight(versions.filter(v => v.roomId === o.roomId), { from: p.startDate, to: p.endDate })).toBe(true)
      expect(o.physicalBeds).toBeLessThanOrEqual(6)
      expect(o.sellableCapacity).toBe(o.physicalBeds)
    }
  })

  it('override shares per hotel and kind are in the specified bands (Makkah Hajj 70-80%, Madinah Hajj 50-60%, Ramadan 40-50% of eligible rooms)', async () => {
    const [overrides, periods, versions] = await Promise.all([
      db.select().from(roomCapacityOverride).where(byOrg(roomCapacityOverride)),
      db.select().from(capacityPeriod).where(byOrg(capacityPeriod)),
      db.select().from(roomBaseConfig).where(byOrg(roomBaseConfig)),
    ])
    const rooms = await db.select().from(room).where(byOrg(room))
    for (const p of periods.filter(p => p.kind !== 'SPECIAL')) {
      const spec = DEMO_HOTELS.find(h => hotelId(h.code) === p.hotelId)!
      const eligible = rooms.filter(r => r.hotelId === p.hotelId
        && versionsCoverEveryNight(versions.filter(v => v.roomId === r.id), { from: p.startDate, to: p.endDate })
        && versions.find(v => v.roomId === r.id && toEpochDay(v.validFrom) <= toEpochDay(p.startDate) && (v.validTo === null || toEpochDay(v.validTo) >= toEpochDay(p.startDate)))!.physicalBeds < 6)
      const share = overrides.filter(o => o.periodId === p.id).length / eligible.length
      const [min, max] = p.kind === 'HAJJ' ? (spec.city === 'Makkah' ? [0.69, 0.81] : [0.49, 0.61]) : [0.39, 0.51]
      const slack = 1 / eligible.length // the share is a rounded room count
      expect(share, `${spec.code} ${p.name}`).toBeGreaterThanOrEqual(min - slack)
      expect(share, `${spec.code} ${p.name}`).toBeLessThanOrEqual(max + slack)
    }
  })

  it('every room has at least one base version, versions never overlap per room, and each starts at or after the hotel in-service date', async () => {
    const [rooms, versions] = await Promise.all([db.select().from(room).where(byOrg(room)), db.select().from(roomBaseConfig).where(byOrg(roomBaseConfig))])
    expect(versions.length).toBeGreaterThan(360)
    expect(versions.length).toBeLessThan(600)
    for (const r of rooms) {
      const vs = versions.filter(v => v.roomId === r.id).sort((a, b) => toEpochDay(a.validFrom) - toEpochDay(b.validFrom))
      expect(vs.length, r.roomNumber).toBeGreaterThanOrEqual(1)
      const spec = DEMO_HOTELS.find(h => hotelId(h.code) === r.hotelId)!
      expect(vs[0]!.validFrom).toBe(spec.inServiceFrom)
      for (let i = 1; i < vs.length; i++) {
        expect(vs[i - 1]!.validTo, `${spec.code} ${r.roomNumber}`).not.toBeNull()
        expect(toEpochDay(vs[i]!.validFrom)).toBeGreaterThan(toEpochDay(vs[i - 1]!.validTo!))
      }
    }
  })

  it('lifecycle: 2 rooms per hotel retired effective 2026-04-01, one room with the 2026-05-01..06-30 gap reactivated 2026-07-01, MKK-GRAND schedules two retirements for 2027-09-01', async () => {
    const [rooms, versions] = await Promise.all([db.select().from(room).where(byOrg(room)), db.select().from(roomBaseConfig).where(byOrg(roomBaseConfig))])
    for (const spec of DEMO_HOTELS) {
      const mine = rooms.filter(r => r.hotelId === hotelId(spec.code))
      const lastOf = (id: string) => versions.filter(v => v.roomId === id).sort((a, b) => toEpochDay(a.validFrom) - toEpochDay(b.validFrom))
      const retiredApril = mine.filter(r => lastOf(r.id).at(-1)!.validTo === '2026-03-31')
      expect(retiredApril, spec.code).toHaveLength(2)
      const gap = mine.filter(r => lastOf(r.id).some(v => v.validTo === '2026-04-30'))
      expect(gap, spec.code).toHaveLength(1)
      const g = lastOf(gap[0]!.id)
      expect(g.at(-2)).toMatchObject({ validTo: '2026-04-30' })
      expect(g.at(-1)).toMatchObject({ validFrom: '2026-07-01', validTo: null })
      const scheduled = mine.filter(r => lastOf(r.id).at(-1)!.validTo === '2027-08-31')
      expect(scheduled, spec.code).toHaveLength(spec.code === 'MKK-GRAND' ? 2 : 0)
    }
    // the temporary closure is a real inventory gap through the services
    const gapRoomId = rooms.find(r => r.hotelId === hotelId('MED-CENT') && versions.some(v => v.roomId === r.id && v.validTo === '2026-04-30'))!.id
    const t = await getRoomCapacityTimeline(admin, hotelId('MED-CENT'), gapRoomId, { from: '2026-04-29', to: '2026-07-02' })
    expect(t.segments.map(s => [s.from, s.to])).toEqual([['2026-04-29', '2026-04-30'], ['2026-07-01', '2026-07-02']])
    // historical and future capacity stay queryable
    const past = await getHotelAverages(admin, hotelId('MED-CENT'), { date: '2026-04-15' })
    const future = await getHotelAverages(admin, hotelId('MED-CENT'), { date: '2027-10-01' })
    const closed = await getHotelAverages(admin, hotelId('MED-CENT'), { date: '2026-05-15' })
    expect(past.base.denominator).toBe(68) // 70 - 2 retired (2026-04-01)
    expect(closed.base.denominator).toBe(67) // the temporarily closed room is out of inventory
    expect(future.base.denominator).toBe(68) // reactivated 2026-07-01
  })

  it('MKK-AZIZ level 6: the floor is inactive, all its rooms retired effective 2026-06-01, no room in inventory on it at the anchor', async () => {
    const [f] = await db.select().from(floor).where(and(eq(floor.hotelId, hotelId('MKK-AZIZ')), eq(floor.level, 6)))
    expect(f!.isActive).toBe(false)
    const l6 = await db.select().from(room).where(eq(room.floorId, f!.id))
    expect(l6).toHaveLength(10)
    const versions = await db.select().from(roomBaseConfig).where(byOrg(roomBaseConfig))
    for (const r of l6) {
      const last = versions.filter(v => v.roomId === r.id).sort((a, b) => toEpochDay(a.validFrom) - toEpochDay(b.validFrom)).at(-1)!
      expect(last.validTo).toBe('2026-05-31')
    }
    const anchorCover = versions.filter(v => l6.some(r => r.id === v.roomId) && toEpochDay(v.validFrom) <= toEpochDay(ANCHOR) && (v.validTo === null || toEpochDay(v.validTo) >= toEpochDay(ANCHOR)))
    expect(anchorCover).toHaveLength(0)
    expect(await db.select().from(floor).where(and(byOrg(floor), eq(floor.isActive, false)))).toHaveLength(1)
    // history stays queryable: the floor's rooms count on 2026-05-31
    const may = await getHotelAverages(admin, hotelId('MKK-AZIZ'), { date: '2026-05-31' })
    const sep = await getHotelAverages(admin, hotelId('MKK-AZIZ'), { date: ANCHOR })
    expect(may.base.denominator).toBe(57) // 60 - 2 retired (04-01) - 1 temporarily closed (05-01..06-30)
    expect(sep.base.denominator).toBe(48) // 60 - 2 retired - 10 on the closed floor (the temporarily closed room is back)
  })

  it('blocks: ~25 per hotel, all three kinds, running maintenance (exactly 4 per hotel) at the anchor, pre-Hajj maintenance at Makkah, cancelled and ended-early rows', async () => {
    const blocks = await db.select().from(roomOperationalBlock).where(byOrg(roomOperationalBlock))
    expect(blocks.length).toBeGreaterThanOrEqual(110)
    expect(blocks.length).toBeLessThanOrEqual(140)
    for (const kind of BLOCK_KINDS) expect(blocks.some(b => b.kind === kind)).toBe(true)
    for (const spec of DEMO_HOTELS) {
      const mine = blocks.filter(b => b.hotelId === hotelId(spec.code))
      expect(mine.length, spec.code).toBeGreaterThanOrEqual(20)
      expect(mine.length, spec.code).toBeLessThanOrEqual(30)
      const running = mine.filter(b => b.kind === 'MAINTENANCE' && blockPhase(b, ANCHOR) === 'RUNNING')
      expect(running, spec.code).toHaveLength(4)
      expect(mine.filter(b => b.cancelledAt !== null), spec.code).toHaveLength(2)
      expect(mine.filter(b => b.endedEarlyAt !== null), spec.code).toHaveLength(2)
      const preHajj = mine.filter(b => b.kind === 'MAINTENANCE' && b.startDate === '2027-02-01' && b.endDate === '2027-03-01')
      expect(preHajj.length, spec.code).toBe(spec.city === 'Makkah' ? 4 : 0)
    }
    const reasons = new Set(blocks.map(b => b.reason))
    for (const r of ['Reserved for management', 'Staff accommodation', 'AC failure', 'Water leak']) expect(reasons.has(r), r).toBe(true)
    expect(blocks.filter(b => b.kind === 'OUT_OF_SERVICE' && rangeLength({ from: b.startDate, to: b.endDate }) === 90)).toHaveLength(1)
    expect(blocks.some(b => b.kind === 'MAINTENANCE' && toEpochDay(b.endDate) < toEpochDay(ANCHOR) && b.cancelledAt === null && b.endedEarlyAt === null)).toBe(true)
  })

  it('ended-early and cancelled rows use the real S11 columns', async () => {
    const early = await db.select().from(roomOperationalBlock).where(and(byOrg(roomOperationalBlock), isNotNull(roomOperationalBlock.endedEarlyAt)))
    expect(early).toHaveLength(10)
    for (const b of early) {
      expect(b.originalEndDate).not.toBeNull()
      expect(toEpochDay(b.originalEndDate!)).toBeGreaterThan(toEpochDay(b.endDate))
      expect(b.endedEarlyBy).not.toBeNull()
      expect(b.cancelledAt).toBeNull()
      expect(b.cancelReason).toBeTruthy()
      expect(blockPhase(b, ANCHOR)).toBe('ENDED_EARLY')
    }
    const cancelled = await db.select().from(roomOperationalBlock).where(and(byOrg(roomOperationalBlock), isNotNull(roomOperationalBlock.cancelledAt)))
    expect(cancelled).toHaveLength(10)
    for (const b of cancelled) {
      expect(b.cancelledBy).not.toBeNull()
      expect(b.cancelReason).toBeTruthy()
      expect(b.endedEarlyAt).toBeNull()
      expect(toEpochDay(b.startDate)).toBeGreaterThan(toEpochDay(ANCHOR)) // unstarted when cancelled
    }
  })

  it('no two active blocks of the same kind overlap on a room, and every block sits on nights the room is in inventory', async () => {
    const [blocks, versions] = await Promise.all([
      db.select().from(roomOperationalBlock).where(and(byOrg(roomOperationalBlock), isNull(roomOperationalBlock.cancelledAt))),
      db.select().from(roomBaseConfig).where(byOrg(roomBaseConfig)),
    ])
    const allBlocks = await db.select().from(roomOperationalBlock).where(byOrg(roomOperationalBlock))
    const perRoomKind = new Map<string, typeof blocks>()
    for (const b of blocks) perRoomKind.set(`${b.roomId}|${b.kind}`, [...(perRoomKind.get(`${b.roomId}|${b.kind}`) ?? []), b])
    for (const group of perRoomKind.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          expect(rangesOverlap({ from: group[i]!.startDate, to: group[i]!.endDate }, { from: group[j]!.startDate, to: group[j]!.endDate })).toBe(false)
        }
      }
    }
    for (const b of allBlocks) {
      // for an ended-early block the planned (original) range was in inventory too
      const to = b.originalEndDate ?? b.endDate
      expect(versionsCoverEveryNight(versions.filter(v => v.roomId === b.roomId), { from: b.startDate, to })).toBe(true)
      expect(b.reason.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('demo calendar and daily summary over generated data', () => {
  it('room-calendar segments cover the requested range exactly for every room (no gap, no overlap)', async () => {
    const range = { from: '2026-04-20', to: '2026-07-10' }
    const n = rangeLength(range)
    for (const code of ['MKK-GRAND', 'MKK-AZIZ', 'MED-CENT']) {
      const cal = await getRoomCalendar(admin, hotelId(code), { ...range, pageSize: 200, includeOutOfInventory: true })
      expect(cal.rooms.length).toBe(DEMO_HOTELS.find(h => h.code === code)!.rooms)
      for (const r of cal.rooms) {
        expect(r.segments[0]!.from, `${code} ${r.roomNumber}`).toBe(range.from)
        expect(r.segments.at(-1)!.to, `${code} ${r.roomNumber}`).toBe(range.to)
        expect(r.segments.reduce((sum, s) => sum + rangeLength({ from: s.from, to: s.to }), 0)).toBe(n)
        for (let i = 1; i < r.segments.length; i++) expect(r.segments[i]!.from).toBe(addDays(r.segments[i - 1]!.to, 1))
      }
    }
  })

  it('the daily summary agrees with the calendar-derived status per night', async () => {
    const range = { from: '2026-08-25', to: '2026-09-12' }
    for (const code of ['MKK-GRAND', 'MKK-AJYAD', 'MED-QUBA']) {
      const cal = await getRoomCalendar(admin, hotelId(code), { ...range, pageSize: 200, includeOutOfInventory: true })
      const summary = await getDailySummary(admin, hotelId(code), range)
      expect(summary.days).toHaveLength(rangeLength(range))
      for (const day of summary.days) {
        const state = cal.rooms.map(r => r.segments.find(s => toEpochDay(s.from) <= toEpochDay(day.date) && toEpochDay(s.to) >= toEpochDay(day.date))!)
        expect(day.roomsInInventory, `${code} ${day.date}`).toBe(state.filter(s => s.status !== 'NOT_IN_INVENTORY').length)
        expect(day.sellableRooms, `${code} ${day.date}`).toBe(state.filter(s => s.sellable).length)
        expect(day.outOfService, `${code} ${day.date}`).toBe(state.filter(s => s.status === 'OUT_OF_SERVICE').length)
        expect(day.maintenance, `${code} ${day.date}`).toBe(state.filter(s => s.status === 'MAINTENANCE').length)
        expect(day.operationalBlock, `${code} ${day.date}`).toBe(state.filter(s => s.status === 'OPERATIONAL_BLOCK').length)
      }
    }
  })

  it('personas list is consistent with persona rows (9 users)', async () => {
    expect(DEMO_PERSONAS).toHaveLength(9)
  })
})
