import { describe, expect, it } from 'vitest'
import type { StayRoom } from '../../../../server/domain/booking/allocation/stayRooms'
import { refuseRoomMove } from '../../../../server/domain/booking/roomMoves'

const room = (over: Partial<StayRoom> = {}): StayRoom => ({ id: 'r2', roomNumber: '102', roomTypeId: 't', floorLevel: 1, sellable: true, capacity: 4, freeSeats: 4, claims: [], extraBedSpace: 0, ...over })
const claim = (ownerKey: string, occupancy: 'MALE' | 'FEMALE' | 'FAMILY') => ({ roomId: 'r2', bookingId: 'b2', ownerKey, occupancy, checkIn: '2027-06-01', checkOut: '2027-06-04', extraBeds: 0 })
const men = [{ roomId: 'r1', occupancy: 'MALE' as const }, { roomId: 'r1', occupancy: 'MALE' as const }]
const base = { targetRoomId: 'r2', stays: men, ownerKey: 'a:agency', seated: 2 }

describe('refuseRoomMove (v7 §12: the same owner and gender rules)', () => {
  it('moves into a free room, or the owner\'s own room of the same side with free seats', () => {
    expect(refuseRoomMove({ ...base, target: room() })).toBeNull()
    expect(refuseRoomMove({ ...base, target: room({ claims: [claim('a:agency', 'MALE')], freeSeats: 2 }) })).toBeNull()
  })

  it('refuses the same room, both sides at once, a room that cannot be sold, someone else\'s or the other side\'s room, too few seats', () => {
    expect(refuseRoomMove({ ...base, targetRoomId: 'r1', target: room({ id: 'r1' }) })).toBe('SAME_ROOM')
    expect(refuseRoomMove({ ...base, stays: [...men, { roomId: 'r3', occupancy: 'FEMALE' }], target: room() })).toBe('MIXED_SIDES')
    expect(refuseRoomMove({ ...base, target: room({ sellable: false }) })).toBe('ROOM_NOT_SELLABLE')
    expect(refuseRoomMove({ ...base, target: null })).toBe('ROOM_NOT_SELLABLE')
    expect(refuseRoomMove({ ...base, target: room({ claims: [claim('a:other', 'MALE')] }) })).toBe('ROOM_TAKEN')
    expect(refuseRoomMove({ ...base, target: room({ claims: [claim('a:agency', 'FEMALE')] }) })).toBe('ROOM_TAKEN')
    expect(refuseRoomMove({ ...base, target: room({ freeSeats: 1 }) })).toBe('NOT_ENOUGH_SEATS')
    expect(refuseRoomMove({ ...base, seated: 1, target: room({ freeSeats: 1 }) })).toBeNull() // an infant takes no seat
  })
})
