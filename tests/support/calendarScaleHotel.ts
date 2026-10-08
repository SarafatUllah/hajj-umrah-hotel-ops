import type { DbOrTx } from '../../db/client'
import { hotelRepos } from '../../server/repositories'
import type { NewRoomBaseConfig, NewRoomCapacityOverride, NewRoomOperationalBlock } from '../../server/repositories/hotel'
import { trustedHotelScope, type OrganizationScope } from '../../server/security/scope'
import { BLOCK_KINDS } from '../../shared/constants/inventory'
import { addDays } from '../../shared/utils/dates'
import { makeHotel, makeRoomType } from './fixtures'

/**
 * Task 18's scale hotel, shared by the calendar scale test (integration) and the response-size test
 * (HTTP): 2,000 rooms on 10 floors of 200 (room numbers `<level><000…199>`), two room types; every
 * 12th room has a dated base change on 2027-03-01; three capacity periods with ~1,200 overrides each;
 * 20 active 3-night blocks per room across 2027 (40,000) of rotating kinds, plus 20 cancelled. Written
 * through the production repositories with BULK inserts only (no HTTP, no per-room calls).
 */
export const SCALE_ROOMS = 2000
export const SCALE_ROOMS_PER_FLOOR = 200
export const SCALE_BLOCKS_PER_ROOM = 20
const BATCH = 500

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

export async function generateCalendarScaleHotel(tx: DbOrTx, scope: OrganizationScope) {
  const hotel = await makeHotel(tx, scope, { timezone: 'Asia/Riyadh' })
  const repos = hotelRepos(tx, trustedHotelScope(scope, hotel.id))
  const roomTypes = [await makeRoomType(tx, scope), await makeRoomType(tx, scope)]

  const floors = await repos.floors.insertMany(Array.from({ length: SCALE_ROOMS / SCALE_ROOMS_PER_FLOOR }, (_, i) => ({ level: i + 1, label: `Floor ${i + 1}` })))
  const roomValues = Array.from({ length: SCALE_ROOMS }, (_, i) => {
    const floor = floors[Math.floor(i / SCALE_ROOMS_PER_FLOOR)]!
    return { floorId: floor.id, roomTypeId: roomTypes[i % 2]!.id, roomNumber: `${floor.level}${String(i % SCALE_ROOMS_PER_FLOOR).padStart(3, '0')}`, features: i % 7 === 0 ? ['HARAM_VIEW'] : [], notes: null }
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
  let overrideCount = 0
  for (const [p, spec] of periods.entries()) {
    const period = await repos.capacityPeriods.insert({ ...spec, notes: null })
    const overrides: NewRoomCapacityOverride[] = rooms.filter((_, i) => (i + p) % 5 < 3).map(room => ({
      roomId: room.id, periodId: period.id, validFrom: spec.startDate, validTo: spec.endDate, physicalBeds: 6, sellableCapacity: 6, reason: null,
    }))
    overrideCount += overrides.length
    for (const batch of chunks(overrides, BATCH)) await repos.roomCapacityOverrides.insertMany(batch)
  }

  // 20 blocks per room, 18 days apart, 3 nights each: never two blocks of a room overlapping.
  const blocks: NewRoomOperationalBlock[] = rooms.flatMap((room, i) => Array.from({ length: SCALE_BLOCKS_PER_ROOM }, (_, k) => {
    const start = addDays('2027-01-03', k * 18 + (i % 15))
    return { roomId: room.id, kind: BLOCK_KINDS[(i + k) % BLOCK_KINDS.length]!, startDate: start, endDate: addDays(start, 2), reason: `Generated ${k}` }
  }))
  const inserted = []
  for (const batch of chunks(blocks, 4000)) inserted.push(...await repos.operationalBlocks.insertMany(batch))
  for (const block of inserted.slice(0, 20)) await repos.operationalBlocks.markCancelled(block.id, new Date(), '00000000-0000-0000-0000-0000000000aa', 'Generated cancellation')

  return { hotel, overrideCount, blockCount: blocks.length }
}
