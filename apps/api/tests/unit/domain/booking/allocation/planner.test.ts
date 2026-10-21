import { describe, expect, it } from 'vitest'
import type { Occupancy } from '@hajj/contracts/constants/booking'
import { fillOwnRooms } from '../../../../../server/domain/booking/allocation/ownRooms'
import { type PlannerInput, type PlannerRoom, planStay, type StayHeadcount } from '../../../../../server/domain/booking/allocation/planner'
import { quotaHeadroom } from '../../../../../server/domain/booking/allocation/quota'
import { type PickableRoom, pickRooms } from '../../../../../server/domain/booking/allocation/roomPicking'
import { checkStayPlan } from '../../../../../server/domain/booking/allocation/stayPlanCheck'
import { describeStayRooms, type HotelRoom, type StayClaim } from '../../../../../server/domain/booking/allocation/stayRooms'

const stay = { checkIn: '2027-06-01', checkOut: '2027-06-04' }
const options = { maintenanceBlocksSales: true }

function hotelRoom(id: string, capacity: number, overrides: Partial<HotelRoom> = {}): HotelRoom {
  return {
    id,
    roomNumber: id,
    roomTypeId: `t${capacity}`,
    floorLevel: 1,
    calendar: { roomId: id, versions: [{ validFrom: '2027-01-01', validTo: null, physicalBeds: capacity, sellableCapacity: capacity }], overrides: [], blocks: [] },
    ...overrides,
  }
}

const claim = (roomId: string, ownerKey: string, occupancy: Occupancy, extra: Partial<StayClaim> = {}): StayClaim =>
  ({ roomId, bookingId: `b-${roomId}`, ownerKey, occupancy, checkIn: stay.checkIn, checkOut: stay.checkOut, extraBeds: 0, ...extra })

/** A planner room: free, sellable, priced by its seats. */
function free(id: string, capacity: number, extra: Partial<PlannerRoom> = {}): PlannerRoom {
  return { id, roomNumber: id, roomTypeId: `t${capacity}`, floorLevel: 1, sellable: true, capacity, freeSeats: capacity, claims: [], extraBedSpace: 0, price: capacity * 100, ...extra }
}

const group = (maleCount: number, femaleCount: number, childCount = 0): StayHeadcount =>
  ({ bookingType: 'GROUP', maleCount, femaleCount, childCount, totalCount: maleCount + femaleCount + childCount, childSide: 'MOTHER' })

function input(rooms: PlannerRoom[], overrides: Partial<PlannerInput> = {}): PlannerInput {
  return { stay, headcount: group(4, 0), rooms, ownerKey: 'a:agency-1', mixRules: [], extraBedLimits: new Map(), maxRooms: null, anchorLevels: [], ...overrides }
}

const shape = (rooms: Array<{ roomId: string, occupancy: Occupancy, seats: number, extraBeds: number, existing: boolean }>) =>
  rooms.map(r => `${r.roomId}:${r.occupancy}:${r.seats}${r.extraBeds ? `+${r.extraBeds}` : ''}${r.existing ? '*' : ''}`).sort()

describe('describeStayRooms (v7 §9.1)', () => {
  it('usable seats are the smallest capacity of any night; free seats subtract the seated pilgrims and add claimed extra beds', () => {
    const hajj = hotelRoom('q', 4, { calendar: { roomId: 'q', versions: [{ validFrom: '2027-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }], overrides: [{ periodId: 'p', validFrom: '2027-06-01', validTo: '2027-06-02', physicalBeds: 6, sellableCapacity: 6 }], blocks: [] } })
    const [room] = describeStayRooms({
      rooms: [hajj],
      stay,
      claims: [claim('q', 'a:agency-1', 'MALE', { extraBeds: 1 })],
      seats: [{ roomId: 'q', night: '2027-06-01', seatsUsed: 5 }, { roomId: 'q', night: '2027-06-03', seatsUsed: 4 }],
      extraBedRules: [{ roomTypeId: 't4', maxPerRoom: 2, maxPerBooking: 3, allowInOverrideSeason: false }],
      options,
    })
    // Night 1: 6 + 1 − 5 = 2; night 2: 6 + 1 − 0 = 7; night 3: 4 + 1 − 4 = 1. An override night forbids extra beds.
    expect(room).toMatchObject({ sellable: true, capacity: 4, freeSeats: 1, extraBedSpace: 0 })
  })

  it('a block on any night makes the room unsellable; extra-bed space follows the type policy outside override seasons', () => {
    const rooms = describeStayRooms({
      rooms: [hotelRoom('blocked', 4, { calendar: { roomId: 'blocked', versions: [{ validFrom: '2027-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }], overrides: [], blocks: [{ id: 'm', kind: 'MAINTENANCE', from: '2027-06-03', to: '2027-06-03' }] } }), hotelRoom('open', 4)],
      stay,
      claims: [],
      seats: [],
      extraBedRules: [{ roomTypeId: 't4', maxPerRoom: 2, maxPerBooking: 1, allowInOverrideSeason: false }],
      options,
    })
    expect(rooms.map(r => [r.id, r.sellable, r.capacity, r.extraBedSpace])).toEqual([['blocked', false, 0, 0], ['open', true, 4, 1]])
  })
})

describe('fillOwnRooms (v7 §9.2 step 3)', () => {
  it('rooms that become completely full first, the rest into one more own room', () => {
    expect(fillOwnRooms(5, [{ roomId: 'a', freeSeats: 4 }, { roomId: 'b', freeSeats: 3 }, { roomId: 'c', freeSeats: 2 }])).toEqual({ placements: [{ roomId: 'b', seats: 3 }, { roomId: 'c', seats: 2 }], remaining: 0 })
    expect(fillOwnRooms(6, [{ roomId: 'a', freeSeats: 4 }, { roomId: 'b', freeSeats: 4 }])).toEqual({ placements: [{ roomId: 'a', seats: 4 }, { roomId: 'b', seats: 2 }], remaining: 0 })
  })

  it('fewer free seats than pilgrims: every own room filled, the rest left for new rooms', () => {
    expect(fillOwnRooms(9, [{ roomId: 'a', freeSeats: 2 }, { roomId: 'b', freeSeats: 3 }])).toEqual({ placements: [{ roomId: 'b', seats: 3 }, { roomId: 'a', seats: 2 }], remaining: 4 })
    expect(fillOwnRooms(3, [])).toEqual({ placements: [], remaining: 3 })
  })
})

describe('quotaHeadroom (v7 §10, §23 Q19)', () => {
  const rows = [
    { agencyId: null, startDate: '2027-06-01', endDate: '2027-06-30', maxPersons: 30 },
    { agencyId: 'agency-1', startDate: '2027-06-03', endDate: '2027-06-03', maxPersons: 50 },
  ]

  it('the agency\'s own row wins over the default; the tightest night decides', () => {
    const held = new Map([['2027-06-01', 10], ['2027-06-02', 25], ['2027-06-03', 48]])
    expect(quotaHeadroom({ agencyId: 'agency-1', nights: ['2027-06-01', '2027-06-02', '2027-06-03'], rows, heldByNight: held })).toBe(2)
    expect(quotaHeadroom({ agencyId: 'agency-2', nights: ['2027-06-01', '2027-06-03'], rows, heldByNight: new Map() })).toBe(30)
  })

  it('no row on any night: no limit', () => {
    expect(quotaHeadroom({ agencyId: 'agency-1', nights: ['2027-07-01'], rows, heldByNight: new Map() })).toBeNull()
  })
})

describe('pickRooms (v7 §9.2 step 6)', () => {
  const room = (id: string, seats: number, floorLevel: number, extraBedSpace = 0): PickableRoom => ({ id, roomNumber: id, roomTypeId: 'quad', floorLevel, seats, price: 100, extraBedSpace })
  const pool = [room('101', 4, 1), room('102', 4, 1), room('501', 4, 5), room('502', 4, 5), room('503', 4, 5)]

  it('keeps the rooms on one floor when it can', () => {
    expect(pickRooms({ mix: [[4, 3]], extraBeds: 0, pool, anchorLevels: [], typeLimits: new Map() })!.map(p => p.room.id)).toEqual(['501', '502', '503'])
  })

  it('near the booker\'s other rooms', () => {
    expect(pickRooms({ mix: [[4, 2]], extraBeds: 0, pool, anchorLevels: [1], typeLimits: new Map() })!.map(p => p.room.id)).toEqual(['101', '102'])
  })

  it('swaps in a room with extra-bed space when the nearest ones have none; type limits apply', () => {
    const withSpace = [...pool, room('901', 4, 9, 1)]
    expect(pickRooms({ mix: [[4, 2]], extraBeds: 1, pool: withSpace, anchorLevels: [1], typeLimits: new Map([['quad', 1]]) })!.map(p => [p.room.id, p.extraBeds])).toEqual([['101', 0], ['901', 1]])
    expect(pickRooms({ mix: [[4, 2]], extraBeds: 1, pool: withSpace, anchorLevels: [1], typeLimits: new Map() })).toBeNull()
  })
})

describe('planStay (v7 §9.2–9.3)', () => {
  it('GROUP: men and women never share a room; children sit on the mother\'s side', () => {
    const plans = planStay(input([free('a', 4), free('b', 4), free('c', 2), free('d', 2)], { headcount: group(4, 3, 1) }))
    expect(shape(plans[0]!.rooms)).toEqual(['a:MALE:4', 'b:FEMALE:4'])
  })

  it('own rooms first: the agency\'s room of the same gender and identical dates takes its pilgrims before a new room', () => {
    const own = free('own', 4, { claims: [claim('own', 'a:agency-1', 'MALE')], freeSeats: 2 })
    const otherDates = free('later', 4, { claims: [claim('later', 'a:agency-1', 'MALE', { checkOut: '2027-06-05' })], freeSeats: 2 })
    const women = free('women', 4, { claims: [claim('women', 'a:agency-1', 'FEMALE')], freeSeats: 2 })
    const plans = planStay(input([own, otherDates, women, free('n1', 2), free('n2', 4)], { headcount: group(4, 0) }))
    expect(shape(plans[0]!.rooms)).toEqual(['n1:MALE:2', 'own:MALE:2*'])
    expect(plans[0]).toMatchObject({ newRooms: 1, emptySeats: 0 })
  })

  it('another agency\'s room is never offered', () => {
    const theirs = free('theirs', 4, { claims: [claim('theirs', 'a:agency-2', 'MALE')], freeSeats: 3 })
    expect(planStay(input([theirs], { headcount: group(2, 0) }))).toEqual([])
  })

  it('FAMILY: only rooms free for the whole stay, fewest empty seats then fewest rooms; an individual\'s room limit holds', () => {
    const family: StayHeadcount = { bookingType: 'FAMILY', maleCount: 0, femaleCount: 0, childCount: 0, totalCount: 5, childSide: null }
    const rooms = [free('a', 2), free('b', 3), free('c', 4), free('d', 4), free('own', 4, { claims: [claim('own', 'a:agency-1', 'FAMILY')], freeSeats: 4 })]
    expect(planStay(input(rooms, { headcount: family, ownerKey: null }))[0]!.rooms.map(r => r.roomId).sort()).toEqual(['a', 'b'])
    expect(planStay(input([free('a', 2), free('b', 3), free('c', 1)], { headcount: { ...family, totalCount: 6 }, ownerKey: null, maxRooms: 2 }))).toEqual([])
  })

  it('room-mix cap per side (§23 Q11): a side of 10 may take at most one 5+ room', () => {
    const rooms = [free('s1', 6), free('s2', 6), free('q1', 4), free('q2', 4), free('q3', 4)]
    const plans = planStay(input(rooms, { headcount: group(10, 0), mixRules: [{ groupMin: 1, groupMax: 20, minSeats: 5, maxRooms: 1 }] }))
    expect(plans.every(p => p.rooms.filter(r => r.roomId.startsWith('s')).length <= 1)).toBe(true)
    expect(shape(plans[0]!.rooms)).toEqual(['q1:MALE:4', 's1:MALE:6'])
  })

  it('seats run short: the extra-bed option, within the type\'s per-booking limit (v7 §11)', () => {
    const rooms = [free('a', 4, { extraBedSpace: 1 }), free('b', 4, { extraBedSpace: 1 })]
    const plans = planStay(input(rooms, { headcount: group(9, 0), extraBedLimits: new Map([['t4', 1]]) }))
    expect(plans).toHaveLength(1)
    expect(shape(plans[0]!.rooms)).toEqual(['a:MALE:5+1', 'b:MALE:4'])
    expect(planStay(input(rooms, { headcount: group(10, 0), extraBedLimits: new Map([['t4', 1]]) }))).toEqual([])
  })

  it('every option it offers passes the hold re-check, and no two sides share a room (random hotels)', () => {
    let seed = 42
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
    let offered = 0
    for (let i = 0; i < 400; i++) {
      const rooms = Array.from({ length: int(4, 20) }, (_, k) => {
        const capacity = int(1, 6)
        const owned = random() < 0.2
        const occupancy: Occupancy = random() < 0.5 ? 'MALE' : 'FEMALE'
        return free(`r${k}`, capacity, {
          floorLevel: int(1, 4),
          extraBedSpace: int(0, 1),
          ...(owned ? { claims: [claim(`r${k}`, random() < 0.7 ? 'a:agency-1' : 'a:agency-2', occupancy)], freeSeats: int(0, capacity) } : {}),
        })
      })
      const plannerInput = input(rooms, {
        headcount: group(int(0, 12), int(0, 12), int(0, 3)),
        mixRules: random() < 0.5 ? [{ groupMin: 1, groupMax: null, minSeats: 5, maxRooms: int(0, 2) }] : [],
        extraBedLimits: new Map([1, 2, 3, 4, 5, 6].map(c => [`t${c}`, int(0, 2)])),
      })
      if (plannerInput.headcount.totalCount === 0) continue
      for (const plan of planStay(plannerInput)) {
        offered++
        expect(checkStayPlan(plannerInput, plan.rooms), `case ${i}`).toEqual([])
        expect(new Set(plan.rooms.map(r => r.roomId)).size).toBe(plan.rooms.length)
      }
    }
    expect(offered).toBeGreaterThan(200)
  })
})

describe('checkStayPlan (v7 §10 step 4)', () => {
  const base = input([free('a', 4), free('b', 4, { extraBedSpace: 1 }), free('taken', 4, { claims: [claim('taken', 'a:agency-2', 'MALE')], freeSeats: 4 })], { headcount: group(4, 4), extraBedLimits: new Map([['t4', 1]]) })

  it('accepts what fits', () => {
    expect(checkStayPlan(base, [{ roomId: 'a', occupancy: 'MALE', seats: 4, extraBeds: 0 }, { roomId: 'b', occupancy: 'FEMALE', seats: 4, extraBeds: 0 }])).toEqual([])
  })

  it('refuses a taken room, an unknown or repeated room, too many seats, an empty extra bed and a wrong head count', () => {
    expect(checkStayPlan(base, [{ roomId: 'taken', occupancy: 'MALE', seats: 4, extraBeds: 0 }, { roomId: 'b', occupancy: 'FEMALE', seats: 4, extraBeds: 0 }])).toEqual([{ code: 'ROOM_TAKEN', roomId: 'taken' }])
    expect(checkStayPlan(base, [{ roomId: 'x', occupancy: 'MALE', seats: 4, extraBeds: 0 }, { roomId: 'x', occupancy: 'FEMALE', seats: 4, extraBeds: 0 }]).map(p => p.code)).toEqual(['ROOM_UNKNOWN', 'ROOM_REPEATED'])
    expect(checkStayPlan(base, [{ roomId: 'a', occupancy: 'MALE', seats: 5, extraBeds: 0 }, { roomId: 'b', occupancy: 'FEMALE', seats: 3, extraBeds: 0 }])).toEqual([{ code: 'SEATS', roomId: 'a' }])
    expect(checkStayPlan(base, [{ roomId: 'a', occupancy: 'MALE', seats: 4, extraBeds: 0 }, { roomId: 'b', occupancy: 'FEMALE', seats: 4, extraBeds: 1 }])).toEqual([{ code: 'EXTRA_BEDS_UNUSED', roomId: 'b' }])
    expect(checkStayPlan(base, [{ roomId: 'a', occupancy: 'MALE', seats: 4, extraBeds: 0 }, { roomId: 'b', occupancy: 'FEMALE', seats: 6, extraBeds: 2 }]).map(p => p.code)).toEqual(['EXTRA_BEDS'])
    expect(checkStayPlan(base, [{ roomId: 'a', occupancy: 'MALE', seats: 3, extraBeds: 0 }, { roomId: 'b', occupancy: 'FEMALE', seats: 4, extraBeds: 0 }])).toEqual([{ code: 'HEADCOUNT', occupancy: 'MALE' }])
    expect(checkStayPlan(base, [{ roomId: 'a', occupancy: 'FAMILY', seats: 4, extraBeds: 0 }])).toEqual([{ code: 'WRONG_OCCUPANCY', roomId: 'a' }])
  })
})

describe('checkStayPlan: a hand-made option cannot claim more than it needs', () => {
  const rooms = [free('q1', 4), free('q2', 4), free('q3', 4, { extraBedSpace: 1 }), free('d1', 2)]

  it('no idle rooms: four men spread over four Quads, or a needless extra room, are refused', () => {
    const fourMen = input(rooms, { headcount: group(4, 0) })
    expect(checkStayPlan(fourMen, ['q1', 'q2', 'q3', 'd1'].map(roomId => ({ roomId, occupancy: 'MALE' as const, seats: 1, extraBeds: 0 })))).toEqual([{ code: 'IDLE_ROOMS', occupancy: 'MALE' }])
    expect(checkStayPlan(fourMen, [{ roomId: 'q1', occupancy: 'MALE', seats: 3, extraBeds: 0 }, { roomId: 'd1', occupancy: 'MALE', seats: 1, extraBeds: 0 }])).toEqual([{ code: 'IDLE_ROOMS', occupancy: 'MALE' }])
    // One partly filled room is fine (fewer empty seats than the smallest room).
    expect(checkStayPlan(input(rooms, { headcount: group(5, 0) }), [{ roomId: 'q1', occupancy: 'MALE', seats: 4, extraBeds: 0 }, { roomId: 'd1', occupancy: 'MALE', seats: 1, extraBeds: 0 }])).toEqual([])
  })

  it('extra beds only when the new rooms are full', () => {
    const sevenMen = input(rooms, { headcount: group(7, 0), extraBedLimits: new Map([['t4', 1]]) })
    expect(checkStayPlan(sevenMen, [{ roomId: 'q3', occupancy: 'MALE', seats: 5, extraBeds: 1 }, { roomId: 'd1', occupancy: 'MALE', seats: 2, extraBeds: 0 }])).toEqual([])
    expect(checkStayPlan(sevenMen, [{ roomId: 'q3', occupancy: 'MALE', seats: 5, extraBeds: 1 }, { roomId: 'q1', occupancy: 'MALE', seats: 2, extraBeds: 0 }])).toEqual([{ code: 'EXTRA_BEDS_UNNEEDED', occupancy: 'MALE' }])
  })

  it('own room first: with a new room, every own room of the side must be used and full', () => {
    const own = free('own', 4, { claims: [claim('own', 'a:agency-1', 'MALE')], freeSeats: 2 })
    const withOwn = input([...rooms, own], { headcount: group(4, 0) })
    expect(checkStayPlan(withOwn, [{ roomId: 'q1', occupancy: 'MALE', seats: 4, extraBeds: 0 }])).toEqual([{ code: 'OWN_ROOMS_FIRST', occupancy: 'MALE' }])
    expect(checkStayPlan(withOwn, [{ roomId: 'own', occupancy: 'MALE', seats: 1, extraBeds: 0 }, { roomId: 'q1', occupancy: 'MALE', seats: 3, extraBeds: 0 }])).toEqual([{ code: 'OWN_ROOMS_FIRST', occupancy: 'MALE' }])
    expect(checkStayPlan(withOwn, [{ roomId: 'own', occupancy: 'MALE', seats: 2, extraBeds: 0 }, { roomId: 'd1', occupancy: 'MALE', seats: 2, extraBeds: 0 }])).toEqual([])
  })
})
