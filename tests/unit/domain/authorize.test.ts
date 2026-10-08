import { describe, expect, it } from 'vitest'
import { hasHotelAccess, hotelCan, orgCan } from '../../../server/domain/rbac/authorize'
import type { AuthorizationContext } from '../../../server/domain/rbac/hasPermission'

function ctx(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    permissions: new Set(),
    allHotels: false,
    hotelIds: new Set(),
    ...overrides,
  }
}

describe('orgCan', () => {
  it('denies a permission the context does not have', () => {
    expect(orgCan(ctx(), 'booking.create')).toBe(false)
  })

  it('grants a permission the context has, regardless of hotel scope', () => {
    expect(orgCan(ctx({ permissions: new Set(['booking.create']) }), 'booking.create')).toBe(true)
  })
})

describe('hasHotelAccess', () => {
  it('denies a hotel not in hotelIds when allHotels is false', () => {
    expect(hasHotelAccess(ctx({ hotelIds: new Set(['hotel-a']) }), 'hotel-b')).toBe(false)
  })

  it('grants a hotel present in hotelIds', () => {
    expect(hasHotelAccess(ctx({ hotelIds: new Set(['hotel-a']) }), 'hotel-a')).toBe(true)
  })

  it('grants any hotel when allHotels is true', () => {
    expect(hasHotelAccess(ctx({ allHotels: true }), 'any-hotel')).toBe(true)
  })
})

// Full truth table: permission present/absent x allHotels true/false x hotel-in-set/not-in-set.
describe('hotelCan (full truth table)', () => {
  const permission = 'booking.create' as const

  it('permission absent, allHotels false, hotel not in set -> false', () => {
    expect(hotelCan(ctx({ hotelIds: new Set(['hotel-a']) }), permission, 'hotel-b')).toBe(false)
  })

  it('permission absent, allHotels false, hotel in set -> false', () => {
    expect(hotelCan(ctx({ hotelIds: new Set(['hotel-a']) }), permission, 'hotel-a')).toBe(false)
  })

  it('permission absent, allHotels true, hotel not in set -> false (allHotels never substitutes for the permission)', () => {
    expect(hotelCan(ctx({ allHotels: true }), permission, 'any-hotel')).toBe(false)
  })

  it('permission absent, allHotels true, hotel in set -> false', () => {
    expect(hotelCan(ctx({ allHotels: true, hotelIds: new Set(['hotel-a']) }), permission, 'hotel-a')).toBe(false)
  })

  it('permission present, allHotels false, hotel not in set -> false', () => {
    expect(hotelCan(ctx({ permissions: new Set([permission]), hotelIds: new Set(['hotel-a']) }), permission, 'hotel-b')).toBe(false)
  })

  it('permission present, allHotels false, hotel in set -> true', () => {
    expect(hotelCan(ctx({ permissions: new Set([permission]), hotelIds: new Set(['hotel-a']) }), permission, 'hotel-a')).toBe(true)
  })

  it('permission present, allHotels true, hotel not in set -> true (allHotels grants any hotel)', () => {
    expect(hotelCan(ctx({ permissions: new Set([permission]), allHotels: true }), permission, 'hotel-z')).toBe(true)
  })

  it('permission present, allHotels true, hotel in set -> true', () => {
    expect(hotelCan(ctx({ permissions: new Set([permission]), allHotels: true, hotelIds: new Set(['hotel-a']) }), permission, 'hotel-a')).toBe(true)
  })
})
