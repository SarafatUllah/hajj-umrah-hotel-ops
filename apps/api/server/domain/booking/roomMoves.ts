import type { Occupancy } from '@hajj/contracts/constants/booking'
import type { StayRoom } from './allocation/stayRooms'

/** A stay of a pilgrim being moved: the room and side it sleeps in now. */
export interface MovingStay { roomId: string, occupancy: Occupancy }

export type RoomMoveRefusal = 'SAME_ROOM' | 'MIXED_SIDES' | 'ROOM_NOT_SELLABLE' | 'ROOM_TAKEN' | 'NOT_ENOUGH_SEATS'

/**
 * Why pilgrims cannot move into `target` for the nights left (v7 §12 room move: "the same owner and gender rules"), or
 * null: one side at a time, into another room that can be sold every night, claimed by nobody but the booking's owner
 * with the same occupancy, with a free seat for each of them who takes one (infants take none).
 */
export function refuseRoomMove(args: { target: StayRoom | null, targetRoomId: string, stays: readonly MovingStay[], ownerKey: string, seated: number }): RoomMoveRefusal | null {
  const { target, stays } = args
  if (stays.some(s => s.roomId === args.targetRoomId)) return 'SAME_ROOM'
  const sides = new Set(stays.map(s => s.occupancy))
  if (sides.size > 1) return 'MIXED_SIDES'
  if (!target || !target.sellable) return 'ROOM_NOT_SELLABLE'
  const side = stays[0]?.occupancy
  if (target.claims.some(c => c.ownerKey !== args.ownerKey || c.occupancy !== side)) return 'ROOM_TAKEN'
  return target.freeSeats < args.seated ? 'NOT_ENOUGH_SEATS' : null
}
