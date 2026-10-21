import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { appUser, role, room, roomBaseConfig, userHotelAccess, userRole } from '../../../db/schema'
import { seedDemoOrganization } from '../../../db/seed/demo-org'
import { demoIds } from '../../../db/seed/demo/ids'
import { DEMO_HOTELS, DEMO_ORG_SLUG } from '../../../server/demo/catalog'
import { DEMO_ADMIN_EMAIL, DEMO_PASSWORD, DEMO_PERSONAS } from '../../../server/demo/personas'
import type { AuthContext } from '../../../server/security/authContext'
import { authenticate } from '../../../server/services/auth.service'
import { createCapacityPeriod, getRoomCapacityTimeline } from '../../../server/services/capacityPeriodService'
import { getHotelAverages } from '../../../server/services/capacityAverageService'
import { createFloor } from '../../../server/services/floorService'
import { createHotel, getHotel, listHotels, updateHotel } from '../../../server/services/hotelService'
import { setUserHotelAccess } from '../../../server/services/hotelAccessService'
import { cancelRoomBlock, createRoomBlock, listRoomBlocks } from '../../../server/services/operationalBlockService'
import { changeBaseConfig, createRoom, listRooms } from '../../../server/services/roomService'
import { createRoomType } from '../../../server/services/roomTypeService'
import { getRoomCalendar } from '../../../server/services/roomCalendarService'
import { getSessionContext } from '../../../server/services/sessionContextService'
import { PERMISSIONS } from '../../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'
import { demoContext } from '../../support/demoContext'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
const ctxs = new Map<string, AuthContext>()
let orgId = ''

beforeAll(async () => {
  await truncateAllTables()
  orgId = (await seedDemoOrganization(db)).organizationId
  for (const p of DEMO_PERSONAS) ctxs.set(p.key, await demoContext(db, p.key))
}, 60_000)

afterAll(async () => {
  await truncateAllTables()
  await closeTestDb()
})

const ctx = (key: string) => ctxs.get(key)!
const hid = (code: string) => demoIds.hotel(code)
const ALL = DEMO_HOTELS.map(h => h.code)
const MAKKAH = DEMO_HOTELS.filter(h => h.city === 'Makkah').map(h => h.code)
const MADINAH = DEMO_HOTELS.filter(h => h.city === 'Madinah').map(h => h.code)
const ROOM_401 = demoIds.room('MKK-GRAND', '401')

async function expectDenied(promise: Promise<unknown>, status: 403 | 404, code?: string) {
  const error = await promise.then(() => null, e => e as { httpStatus?: number, code?: string })
  expect(error, 'expected a rejection').not.toBeNull()
  expect(error!.httpStatus).toBe(status)
  if (code) expect(error!.code).toBe(code)
}

/** The lowest-numbered room of a hotel that is in inventory for good (open-ended last version), so a far-future block is legal. */
async function openRoomId(code: string): Promise<string> {
  const rows = await db.select({ id: room.id, number: room.roomNumber }).from(room).innerJoin(roomBaseConfig, eq(roomBaseConfig.roomId, room.id))
    .where(and(eq(room.hotelId, hid(code)), isNull(roomBaseConfig.validTo)))
  return rows.sort((a, b) => a.number.localeCompare(b.number))[0]!.id
}

const hotelCodesOf = async (key: string) => (await listHotels(ctx(key))).map(h => h.code).sort()

describe('demo personas: accounts', () => {
  it('seeds nine users with the documented names, emails and roles; admin keeps the Phase 0 login', async () => {
    const rows = await db.select({ email: appUser.email, fullName: appUser.fullName, allHotels: appUser.allHotels, isActive: appUser.isActive, roleKey: role.key })
      .from(appUser).innerJoin(userRole, eq(userRole.userId, appUser.id)).innerJoin(role, eq(role.id, userRole.roleId)).where(eq(appUser.organizationId, orgId))
    expect(rows).toHaveLength(9)
    for (const p of DEMO_PERSONAS) {
      expect(rows.find(r => r.email === p.email)).toMatchObject({ fullName: p.fullName, roleKey: p.roleKey, allHotels: p.hotelCodes === 'all', isActive: true })
    }
    expect(DEMO_PERSONAS[0]!.email).toBe(DEMO_ADMIN_EMAIL)
    expect(DEMO_PERSONAS.map(p => [p.key, p.fullName, ROLE_DEFINITIONS[p.roleKey]!.name])).toEqual([
      ['admin', 'Faisal Al-Otaibi', 'Super Admin'],
      ['manager.grand', 'Nora Al-Qahtani', 'Hotel Manager'],
      ['manager.madinah', 'Omar Siddiqui', 'Hotel Manager'],
      ['reservations', 'Aisha Rahman', 'Reservation Manager'],
      ['accountant', 'Khalid Al-Harbi', 'Accountant'],
      ['hr', 'Maryam Yusuf', 'HR Manager'],
      ['reception.grand', 'Ahmed Hassan', 'Reception'],
      ['reception.ajyad', 'Imran Chowdhury', 'Reception'],
      ['management', 'Sarah Al-Mutairi', 'Read-only Management'],
    ])
  })

  it('all nine authenticate with the shared DEMO_PASSWORD through the real login service (phase1Available does not disable anyone), and a wrong password fails', async () => {
    for (const p of DEMO_PERSONAS) {
      const r = await authenticate(DEMO_ORG_SLUG, p.email, DEMO_PASSWORD)
      expect(r?.user.email, p.key).toBe(p.email)
      expect(r?.user.fullName, p.key).toBe(p.fullName)
      expect(r?.user.id).toBe(demoIds.user(p.key))
    }
    expect(await authenticate(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, 'not-the-password')).toBeNull()
  })

  it('all nine users share one password hash (hashed once per seed) and it is never the plaintext', async () => {
    const rows = await db.select({ hash: appUser.passwordHash }).from(appUser).where(eq(appUser.organizationId, orgId))
    expect(new Set(rows.map(r => r.hash)).size).toBe(1)
    expect(rows[0]!.hash).toMatch(/^\$argon2id\$/)
    expect(rows[0]!.hash).not.toContain(DEMO_PASSWORD)
  })

  it('explicit hotel-access rows: 11 in total, exactly the hotel-scoped personas (all-hotels personas hold the flag instead)', async () => {
    const rows = await db.select().from(userHotelAccess).where(eq(userHotelAccess.organizationId, orgId))
    expect(rows).toHaveLength(11)
    for (const p of DEMO_PERSONAS) {
      const mine = rows.filter(r => r.userId === demoIds.user(p.key)).map(r => r.hotelId).sort()
      expect(mine, p.key).toEqual(p.hotelCodes === 'all' ? [] : p.hotelCodes.map(hid).sort())
    }
  })

  it('/api/auth/me data (session context) carries the display name and the role name', async () => {
    for (const p of DEMO_PERSONAS) {
      expect(ctx(p.key).identity.fullName).toBe(p.fullName)
      const session = await getSessionContext(ctx(p.key))
      expect(session.roles.map(r => r.name)).toEqual([ROLE_DEFINITIONS[p.roleKey]!.name])
    }
  })
})

describe('demo personas: resolved authorization sets are exact', () => {
  it('admin holds every permission including the demo-only organization.resetDemo, and all hotels', () => {
    expect([...ctx('admin').authz.permissions].sort()).toEqual([...PERMISSIONS].sort())
    expect(ctx('admin').authz.permissions.has('organization.resetDemo')).toBe(true)
    expect(ctx('admin').authz.allHotels).toBe(true)
  })

  it('every other persona holds exactly its role permissions (and never organization.resetDemo)', () => {
    for (const p of DEMO_PERSONAS.filter(p => p.key !== 'admin')) {
      expect([...ctx(p.key).authz.permissions].sort(), p.key).toEqual([...ROLE_DEFINITIONS[p.roleKey]!.permissions].sort())
      expect(ctx(p.key).authz.permissions.has('organization.resetDemo'), p.key).toBe(false)
    }
  })

  it('accountant and hr keep exactly their role permissions: no room.view, no room.block', () => {
    for (const key of ['accountant', 'hr']) {
      expect(ctx(key).authz.permissions.has('room.view'), key).toBe(false)
      expect(ctx(key).authz.permissions.has('room.block'), key).toBe(false)
    }
    expect(DEMO_PERSONAS.filter(p => !p.phase1Available).map(p => p.key)).toEqual(['accountant', 'hr'])
  })

  it('allHotels flags and resolved hotel ids match the table', () => {
    for (const p of DEMO_PERSONAS) {
      expect(ctx(p.key).authz.allHotels, p.key).toBe(p.hotelCodes === 'all')
      expect([...ctx(p.key).authz.hotelIds].sort(), p.key).toEqual(p.hotelCodes === 'all' ? [] : p.hotelCodes.map(hid).sort())
    }
  })
})

describe('demo personas: hotel-scoped visibility', () => {
  it('each persona lists exactly its hotels', async () => {
    expect(await hotelCodesOf('admin')).toEqual([...ALL].sort())
    expect(await hotelCodesOf('accountant')).toEqual([...ALL].sort())
    expect(await hotelCodesOf('management')).toEqual([...ALL].sort())
    expect(await hotelCodesOf('manager.grand')).toEqual(['MKK-GRAND'])
    expect(await hotelCodesOf('manager.madinah')).toEqual([...MADINAH].sort())
    expect(await hotelCodesOf('reservations')).toEqual([...MAKKAH].sort())
    expect(await hotelCodesOf('hr')).toEqual(['MED-CENT', 'MKK-AJYAD', 'MKK-GRAND'])
    expect(await hotelCodesOf('reception.grand')).toEqual(['MKK-GRAND'])
    expect(await hotelCodesOf('reception.ajyad')).toEqual(['MKK-AJYAD'])
  })

  it('reception.grand sees MKK-GRAND and gets 404 for MKK-AJYAD and the Madinah hotels', async () => {
    expect((await getHotel(ctx('reception.grand'), hid('MKK-GRAND'))).code).toBe('MKK-GRAND')
    for (const code of ['MKK-AJYAD', 'MKK-AZIZ', ...MADINAH]) await expectDenied(getHotel(ctx('reception.grand'), hid(code)), 404, 'HOTEL_NOT_FOUND')
  })

  it('reception.ajyad sees MKK-AJYAD and gets 404 for MKK-GRAND', async () => {
    expect((await getHotel(ctx('reception.ajyad'), hid('MKK-AJYAD'))).code).toBe('MKK-AJYAD')
    await expectDenied(getHotel(ctx('reception.ajyad'), hid('MKK-GRAND')), 404, 'HOTEL_NOT_FOUND')
    await expectDenied(getRoomCalendar(ctx('reception.ajyad'), hid('MKK-GRAND'), { from: '2026-09-01', to: '2026-09-02' }), 404, 'HOTEL_NOT_FOUND')
  })

  it('manager.madinah sees MED-CENT and MED-QUBA and gets 404 for every Makkah hotel', async () => {
    for (const code of MADINAH) expect((await getHotel(ctx('manager.madinah'), hid(code))).code).toBe(code)
    for (const code of MAKKAH) await expectDenied(getHotel(ctx('manager.madinah'), hid(code)), 404, 'HOTEL_NOT_FOUND')
  })

  it('reservations sees exactly the three Makkah hotels (404 for Madinah) and may READ inventory there', async () => {
    for (const code of MAKKAH) expect((await getHotel(ctx('reservations'), hid(code))).code).toBe(code)
    for (const code of MADINAH) await expectDenied(getHotel(ctx('reservations'), hid(code)), 404, 'HOTEL_NOT_FOUND')
    const rooms = await listRooms(ctx('reservations'), hid('MKK-GRAND'), { asOf: '2026-09-01', inventory: 'IN', page: 1, pageSize: 20 })
    expect(rooms.total).toBeGreaterThan(80)
    const cal = await getRoomCalendar(ctx('reservations'), hid('MKK-AJYAD'), { from: '2026-09-01', to: '2026-09-07', pageSize: 10 })
    expect(cal.rooms.length).toBe(10)
    expect((await getHotelAverages(ctx('reservations'), hid('MKK-AZIZ'), { date: '2026-09-01' })).base.denominator).toBe(48)
    await expectDenied(getHotelAverages(ctx('reservations'), hid('MED-CENT'), { date: '2026-09-01' }), 404)
  })

  it('hr (three hotels, no room.view) is 404 outside its hotels and 403 for inventory inside them; accountant likewise has no inventory access', async () => {
    await expectDenied(getHotel(ctx('hr'), hid('MKK-AZIZ')), 404, 'HOTEL_NOT_FOUND')
    expect((await getHotel(ctx('hr'), hid('MED-CENT'))).code).toBe('MED-CENT')
    await expectDenied(getRoomCalendar(ctx('hr'), hid('MKK-GRAND'), { from: '2026-09-01', to: '2026-09-02' }), 403)
    await expectDenied(getRoomCalendar(ctx('accountant'), hid('MKK-GRAND'), { from: '2026-09-01', to: '2026-09-02' }), 403)
  })
})

describe('demo personas: write permissions follow the current RBAC (nothing weakened)', () => {
  it('reception personas cannot block rooms (403 inside their hotel, 404 elsewhere) and cannot manage', async () => {
    const block = { kind: 'OPERATIONAL_BLOCK' as const, startDate: '2028-02-01', endDate: '2028-02-03', reason: 'x' }
    await expectDenied(createRoomBlock(ctx('reception.grand'), hid('MKK-GRAND'), ROOM_401, block), 403)
    await expectDenied(createRoomBlock(ctx('reception.ajyad'), hid('MKK-AJYAD'), demoIds.room('MKK-AJYAD', '101'), block), 403)
    await expectDenied(createRoomBlock(ctx('reception.ajyad'), hid('MKK-GRAND'), ROOM_401, block), 404, 'HOTEL_NOT_FOUND')
    await expectDenied(changeBaseConfig(ctx('reception.grand'), hid('MKK-GRAND'), ROOM_401, { effectiveFrom: '2028-02-01', physicalBeds: 5, sellableCapacity: 5 }), 403)
    // but they can read their hotel's inventory
    expect((await listRoomBlocks(ctx('reception.grand'), hid('MKK-GRAND'), { from: '2026-08-01', to: '2026-10-01', includeCancelled: false, page: 1, pageSize: 50 })).total).toBeGreaterThan(0)
  })

  it('manager.grand can manage and block MKK-GRAND (then cancel) but nothing org-wide and nothing at other hotels', async () => {
    const mgr = ctx('manager.grand')
    const created = await createRoomBlock(mgr, hid('MKK-GRAND'), ROOM_401, { kind: 'OPERATIONAL_BLOCK', startDate: '2028-02-01', endDate: '2028-02-03', reason: 'Persona test block' })
    expect(created).toMatchObject({ startDate: '2028-02-01', endDate: '2028-02-03' })
    await cancelRoomBlock(mgr, hid('MKK-GRAND'), created.id, { reason: 'Persona test cleanup' })
    // org-wide-only operations stay denied
    await expectDenied(createHotel(mgr, { code: 'NEW-1', name: 'New', city: 'Makkah' } as never), 403)
    await expectDenied(createRoomType(mgr, { code: 'DUO', name: 'Duo', defaultPhysicalBeds: 2, defaultSellableCapacity: 2 } as never), 403)
    await expectDenied(setUserHotelAccess(mgr, demoIds.user('reception.grand'), { allHotels: true, hotelIds: [] }), 403)
    // another hotel is invisible, not merely forbidden
    await expectDenied(createRoomBlock(mgr, hid('MKK-AJYAD'), demoIds.room('MKK-AJYAD', '101'), { kind: 'MAINTENANCE', startDate: '2028-02-01', endDate: '2028-02-03', reason: 'x' }), 404, 'HOTEL_NOT_FOUND')
    await expectDenied(updateHotel(mgr, hid('MED-CENT'), { name: 'Hijacked' } as never), 404, 'HOTEL_NOT_FOUND')
    // and it can read its own capacity timeline
    expect((await getRoomCapacityTimeline(mgr, hid('MKK-GRAND'), ROOM_401, { from: '2027-05-01', to: '2027-05-01' })).segments[0]!.physicalBeds).toBe(6)
  })

  it('manager.madinah blocks in its own hotels only', async () => {
    const mgr = ctx('manager.madinah')
    const room = await openRoomId('MED-CENT')
    const created = await createRoomBlock(mgr, hid('MED-CENT'), room, { kind: 'OUT_OF_SERVICE', startDate: '2028-03-01', endDate: '2028-03-02', reason: 'Persona test block' })
    await cancelRoomBlock(mgr, hid('MED-CENT'), created.id, { reason: 'cleanup' })
    await expectDenied(createRoomBlock(mgr, hid('MKK-GRAND'), ROOM_401, { kind: 'OUT_OF_SERVICE', startDate: '2028-03-01', endDate: '2028-03-02', reason: 'x' }), 404, 'HOTEL_NOT_FOUND')
  })

  it('reservations (read-only inventory in Phase 1): every inventory write is 403 inside its hotels', async () => {
    const r = ctx('reservations')
    await expectDenied(createRoomBlock(r, hid('MKK-GRAND'), ROOM_401, { kind: 'MAINTENANCE', startDate: '2028-02-01', endDate: '2028-02-03', reason: 'x' }), 403)
    await expectDenied(changeBaseConfig(r, hid('MKK-GRAND'), ROOM_401, { effectiveFrom: '2028-02-01', physicalBeds: 5, sellableCapacity: 5 }), 403)
    await expectDenied(createCapacityPeriod(r, hid('MKK-GRAND'), { name: 'X', kind: 'SPECIAL', startDate: '2028-09-01', endDate: '2028-09-10' } as never), 403)
  })

  it('management (read-only) sees every hotel and every tested write is 403', async () => {
    const m = ctx('management')
    expect((await getHotel(m, hid('MED-QUBA'))).code).toBe('MED-QUBA')
    expect((await getRoomCalendar(m, hid('MKK-AZIZ'), { from: '2026-09-01', to: '2026-09-02', pageSize: 5 })).rooms.length).toBe(5)
    await expectDenied(createHotel(m, { code: 'NEW-2', name: 'New', city: 'Makkah' } as never), 403)
    await expectDenied(updateHotel(m, hid('MKK-GRAND'), { name: 'X' } as never), 403)
    await expectDenied(createFloor(m, hid('MKK-GRAND'), { level: 20, label: 'Floor 20' } as never), 403)
    await expectDenied(createRoom(m, hid('MKK-GRAND'), { floorId: demoIds.floor('MKK-GRAND', 2), roomTypeId: demoIds.roomType('QUAD'), roomNumber: '299', inServiceFrom: '2026-09-02' } as never), 403)
    await expectDenied(changeBaseConfig(m, hid('MKK-GRAND'), ROOM_401, { effectiveFrom: '2028-02-01', physicalBeds: 5, sellableCapacity: 5 }), 403)
    await expectDenied(createRoomBlock(m, hid('MKK-GRAND'), ROOM_401, { kind: 'MAINTENANCE', startDate: '2028-02-01', endDate: '2028-02-03', reason: 'x' }), 403)
    await expectDenied(createCapacityPeriod(m, hid('MKK-GRAND'), { name: 'X', kind: 'SPECIAL', startDate: '2028-09-01', endDate: '2028-09-10' } as never), 403)
    await expectDenied(createRoomType(m, { code: 'DUO', name: 'Duo', defaultPhysicalBeds: 2, defaultSellableCapacity: 2 } as never), 403)
    await expectDenied(setUserHotelAccess(m, demoIds.user('hr'), { allHotels: true, hotelIds: [] }), 403)
  })

  it('the admin persona keeps full authority (blocking works anywhere)', async () => {
    const created = await createRoomBlock(ctx('admin'), hid('MED-QUBA'), await openRoomId('MED-QUBA'), { kind: 'OPERATIONAL_BLOCK', startDate: '2028-03-01', endDate: '2028-03-02', reason: 'Persona test block' })
    await cancelRoomBlock(ctx('admin'), hid('MED-QUBA'), created.id, { reason: 'cleanup' })
  })
})
