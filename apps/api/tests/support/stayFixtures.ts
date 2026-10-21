import type { DbOrTx } from '@hajj/db/client'
import { bookingRepos } from '../../server/repositories'
import { trustedHotelScope, type OrganizationScope } from '../../server/security/scope'
import { makeFloor, makeHotel, makeRoomType, makeRoomWithVersion } from './fixtures'

/**
 * A bookable hotel for search and hold tests: four Quads on floor 1 (101–104), two Doubles on floor 2 (201–202),
 * June 2027 rates — per person (Quad public 380, agency default 350; Double public 450) and per room (Quad 1,400,
 * Double 900). `rooms` maps room numbers to ids.
 */
export async function makeStayHotel(db: DbOrTx, scope: OrganizationScope) {
  const hotel = await makeHotel(db, scope)
  const hotelScope = trustedHotelScope(scope, hotel.id)
  const ground = await makeFloor(db, hotelScope, { level: 1 })
  const upper = await makeFloor(db, hotelScope, { level: 2 })
  const tag = hotel.id.slice(0, 6).toUpperCase()
  const quad = await makeRoomType(db, scope, { code: `QUAD-${tag}`, name: 'Quad' })
  const double = await makeRoomType(db, scope, { code: `DBL-${tag}`, name: 'Double', defaultPhysicalBeds: 2, defaultSellableCapacity: 2 })
  const rooms: Record<string, string> = {}
  for (const n of ['101', '102', '103', '104']) rooms[n] = (await makeRoomWithVersion(db, hotelScope, ground.id, quad.id, { roomNumber: n })).room.id
  for (const n of ['201', '202']) rooms[n] = (await makeRoomWithVersion(db, hotelScope, upper.id, double.id, { roomNumber: n }, { physicalBeds: 2, sellableCapacity: 2 })).room.id
  const rates = bookingRepos(db, hotelScope).rates
  const june = { startDate: '2027-06-01', endDate: '2027-06-30', vatIncluded: true }
  await rates.insert({ ...june, roomTypeId: quad.id, priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', amountHalalas: 38000 })
  await rates.insert({ ...june, roomTypeId: quad.id, priceType: 'AGENCY_DEFAULT', unit: 'PER_PERSON_NIGHT', amountHalalas: 35000 })
  await rates.insert({ ...june, roomTypeId: double.id, priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', amountHalalas: 45000 })
  await rates.insert({ ...june, roomTypeId: quad.id, priceType: 'PUBLIC', unit: 'PER_ROOM_NIGHT', amountHalalas: 140000 })
  await rates.insert({ ...june, roomTypeId: double.id, priceType: 'PUBLIC', unit: 'PER_ROOM_NIGHT', amountHalalas: 90000 })
  return { hotel, hotelScope, rooms, quad, double }
}
