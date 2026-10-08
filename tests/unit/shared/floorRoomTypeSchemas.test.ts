import { describe, expect, it } from 'vitest'
import { bulkCreateFloorsSchema, createFloorSchema, listFloorsQuerySchema, updateFloorSchema } from '../../../shared/schemas/floor'
import { createRoomTypeSchema, listRoomTypesQuerySchema, updateRoomTypeSchema } from '../../../shared/schemas/roomType'

describe('createFloorSchema — level boundaries', () => {
  it('accepts the minimum level -5', () => {
    expect(createFloorSchema.safeParse({ level: -5 }).success).toBe(true)
  })

  it('rejects level -6 (below the minimum)', () => {
    expect(createFloorSchema.safeParse({ level: -6 }).success).toBe(false)
  })

  it('accepts the maximum level 200', () => {
    expect(createFloorSchema.safeParse({ level: 200 }).success).toBe(true)
  })

  it('rejects level 201 (above the maximum)', () => {
    expect(createFloorSchema.safeParse({ level: 201 }).success).toBe(false)
  })

  it('rejects a non-integer level', () => {
    expect(createFloorSchema.safeParse({ level: 1.5 }).success).toBe(false)
  })
})

describe('createFloorSchema — label', () => {
  it('label is optional on create (the service applies the default)', () => {
    expect(createFloorSchema.safeParse({ level: 3 }).success).toBe(true)
  })

  it('accepts an 80-character label (the maximum)', () => {
    expect(createFloorSchema.safeParse({ level: 1, label: 'A'.repeat(80) }).success).toBe(true)
  })

  it('rejects an 81-character label (above the maximum)', () => {
    expect(createFloorSchema.safeParse({ level: 1, label: 'A'.repeat(81) }).success).toBe(false)
  })

  it('rejects a label containing a control character', () => {
    expect(createFloorSchema.safeParse({ level: 1, label: 'Floor\u0000One' }).success).toBe(false)
  })

  it('accepts an Arabic label', () => {
    expect(createFloorSchema.safeParse({ level: 1, label: 'الطابق الأول' }).success).toBe(true)
  })
})

describe('createFloorSchema — mass assignment', () => {
  it('rejects an unrecognized field (.strict())', () => {
    expect(createFloorSchema.safeParse({ level: 1, isActive: false }).success).toBe(false)
  })
})

describe('updateFloorSchema — no mass assignment', () => {
  it('rejects id', () => {
    expect(updateFloorSchema.safeParse({ id: '11111111-1111-1111-1111-111111111111' }).success).toBe(false)
  })

  it('rejects hotelId', () => {
    expect(updateFloorSchema.safeParse({ hotelId: '11111111-1111-1111-1111-111111111111' }).success).toBe(false)
  })

  it('rejects organizationId', () => {
    expect(updateFloorSchema.safeParse({ organizationId: '11111111-1111-1111-1111-111111111111' }).success).toBe(false)
  })

  it('rejects isActive', () => {
    expect(updateFloorSchema.safeParse({ isActive: false }).success).toBe(false)
  })

  it('accepts a partial patch of recognized fields', () => {
    expect(updateFloorSchema.safeParse({ label: 'New Label' }).success).toBe(true)
  })

  it('accepts an empty object', () => {
    expect(updateFloorSchema.safeParse({}).success).toBe(true)
  })
})

describe('bulkCreateFloorsSchema', () => {
  it('accepts a valid ascending range', () => {
    expect(bulkCreateFloorsSchema.safeParse({ fromLevel: 0, toLevel: 12 }).success).toBe(true)
  })

  it('accepts a single-level range (fromLevel === toLevel)', () => {
    expect(bulkCreateFloorsSchema.safeParse({ fromLevel: 5, toLevel: 5 }).success).toBe(true)
  })

  it('rejects fromLevel > toLevel', () => {
    expect(bulkCreateFloorsSchema.safeParse({ fromLevel: 10, toLevel: 5 }).success).toBe(false)
  })

  it('accepts exactly 60 floors (the maximum)', () => {
    expect(bulkCreateFloorsSchema.safeParse({ fromLevel: 1, toLevel: 60 }).success).toBe(true)
  })

  it('rejects 61 floors (above the maximum)', () => {
    expect(bulkCreateFloorsSchema.safeParse({ fromLevel: 1, toLevel: 61 }).success).toBe(false)
  })

  it('rejects an out-of-range fromLevel/toLevel', () => {
    expect(bulkCreateFloorsSchema.safeParse({ fromLevel: -6, toLevel: 5 }).success).toBe(false)
    expect(bulkCreateFloorsSchema.safeParse({ fromLevel: 0, toLevel: 201 }).success).toBe(false)
  })

  it('rejects an unrecognized field (.strict())', () => {
    expect(bulkCreateFloorsSchema.safeParse({ fromLevel: 0, toLevel: 1, label: 'x' }).success).toBe(false)
  })
})

describe('listFloorsQuerySchema', () => {
  it('defaults includeInactive to false when omitted', () => {
    expect(listFloorsQuerySchema.parse({}).includeInactive).toBe(false)
  })

  it('accepts the literal string "true"', () => {
    expect(listFloorsQuerySchema.parse({ includeInactive: 'true' }).includeInactive).toBe(true)
  })

  it('rejects a non-boolean-shaped value', () => {
    expect(listFloorsQuerySchema.safeParse({ includeInactive: 'yes' }).success).toBe(false)
  })
})

describe('createRoomTypeSchema — code boundaries', () => {
  it('accepts a 2-character code (the minimum)', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'A1', name: 'Room' }).success).toBe(true)
  })

  it('rejects a 1-character code (below the minimum)', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'A', name: 'Room' }).success).toBe(false)
  })

  it('accepts a 20-character code (the maximum)', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'A'.repeat(20), name: 'Room' }).success).toBe(true)
  })

  it('rejects a 21-character code (above the maximum)', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'A'.repeat(21), name: 'Room' }).success).toBe(false)
  })

  it('rejects a lowercase code', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'std-01', name: 'Room' }).success).toBe(false)
  })

  it('accepts underscores and hyphens after the first character', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'STD_01-A', name: 'Room' }).success).toBe(true)
  })

  it('rejects a code starting with an underscore or hyphen', () => {
    expect(createRoomTypeSchema.safeParse({ code: '_STD01', name: 'Room' }).success).toBe(false)
    expect(createRoomTypeSchema.safeParse({ code: '-STD01', name: 'Room' }).success).toBe(false)
  })
})

describe('createRoomTypeSchema — defaults', () => {
  it('defaults defaultPhysicalBeds and defaultSellableCapacity to 4, and sortOrder to 0', () => {
    const result = createRoomTypeSchema.parse({ code: 'STD-01', name: 'Room' })
    expect(result.defaultPhysicalBeds).toBe(4)
    expect(result.defaultSellableCapacity).toBe(4)
    expect(result.sortOrder).toBe(0)
  })
})

describe('createRoomTypeSchema — beds/sellable/sortOrder boundaries', () => {
  it('rejects defaultPhysicalBeds 0 and 31', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', defaultPhysicalBeds: 0 }).success).toBe(false)
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', defaultPhysicalBeds: 31 }).success).toBe(false)
  })

  it('accepts the boundaries 1 and 30 for defaultPhysicalBeds', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', defaultPhysicalBeds: 1 }).success).toBe(true)
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', defaultPhysicalBeds: 30 }).success).toBe(true)
  })

  it('rejects defaultSellableCapacity -1 and 31', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', defaultSellableCapacity: -1 }).success).toBe(false)
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', defaultSellableCapacity: 31 }).success).toBe(false)
  })

  it('accepts the boundaries 0 and 30 for defaultSellableCapacity', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', defaultSellableCapacity: 0 }).success).toBe(true)
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', defaultSellableCapacity: 30 }).success).toBe(true)
  })

  it('accepts defaultSellableCapacity greater than defaultPhysicalBeds (no cross-field rejection)', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', defaultPhysicalBeds: 2, defaultSellableCapacity: 30 }).success).toBe(true)
  })

  it('rejects sortOrder outside 0..1000', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', sortOrder: -1 }).success).toBe(false)
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', sortOrder: 1001 }).success).toBe(false)
  })
})

describe('createRoomTypeSchema — mass assignment', () => {
  it('rejects an unrecognized field (.strict())', () => {
    expect(createRoomTypeSchema.safeParse({ code: 'STD-01', name: 'Room', isActive: false }).success).toBe(false)
  })
})

describe('updateRoomTypeSchema — no mass assignment', () => {
  it('rejects id', () => {
    expect(updateRoomTypeSchema.safeParse({ id: '11111111-1111-1111-1111-111111111111' }).success).toBe(false)
  })

  it('rejects organizationId', () => {
    expect(updateRoomTypeSchema.safeParse({ organizationId: '11111111-1111-1111-1111-111111111111' }).success).toBe(false)
  })

  it('rejects isActive', () => {
    expect(updateRoomTypeSchema.safeParse({ isActive: false }).success).toBe(false)
  })

  it('accepts a partial patch of recognized fields', () => {
    expect(updateRoomTypeSchema.safeParse({ name: 'New Name' }).success).toBe(true)
  })

  it('accepts an empty object', () => {
    expect(updateRoomTypeSchema.safeParse({}).success).toBe(true)
  })
})

describe('listRoomTypesQuerySchema', () => {
  it('defaults includeInactive to false when omitted', () => {
    expect(listRoomTypesQuerySchema.parse({}).includeInactive).toBe(false)
  })

  it('accepts the literal string "false"', () => {
    expect(listRoomTypesQuerySchema.parse({ includeInactive: 'false' }).includeInactive).toBe(false)
  })
})
