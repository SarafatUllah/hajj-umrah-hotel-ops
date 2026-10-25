import { describe, expect, it } from 'vitest'
import { createRoomSchema, updateRoomSchema } from '@hajj/contracts/schemas/room'

const ROOM = { floorId: '00000000-0000-4000-8000-000000000001', roomTypeId: '00000000-0000-4000-8000-000000000002', roomNumber: '401', inServiceFrom: '2026-10-21' }

describe('room notes', () => {
  it('empty notes are none: left out on create, cleared on update', () => {
    expect(createRoomSchema.parse({ ...ROOM, notes: '  ' }).notes).toBeUndefined()
    expect(updateRoomSchema.parse({ notes: '' })).toEqual({ notes: null })
    expect(updateRoomSchema.parse({ notes: null })).toEqual({ notes: null })
  })

  it('a room is created with its type\'s capacity unless both numbers are given; capacity never changes on update', () => {
    expect(createRoomSchema.parse(ROOM)).toMatchObject({ features: [] })
    expect(createRoomSchema.safeParse({ ...ROOM, physicalBeds: 0 }).success).toBe(false)
    expect(updateRoomSchema.safeParse({ physicalBeds: 5 }).success).toBe(false)
  })
})
