import { describe, expect, it } from 'vitest'
import { hasPermission, type AuthorizationContext } from '../../../server/domain/rbac/hasPermission'

function ctx(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    permissions: new Set(),
    allHotels: false,
    hotelIds: new Set(),
    ...overrides,
  }
}

describe('hasPermission', () => {
  it('denies a permission the context does not have', () => {
    expect(hasPermission(ctx(), 'booking.create')).toBe(false)
  })

  it('grants an org-level permission check (no hotelId given) when the permission is present', () => {
    const context = ctx({ permissions: new Set(['booking.create']) })
    expect(hasPermission(context, 'booking.create')).toBe(true)
  })

  it('denies a hotel-scoped check when the user has the permission but no access to that hotel', () => {
    const context = ctx({ permissions: new Set(['booking.create']), hotelIds: new Set(['hotel-a']) })
    expect(hasPermission(context, 'booking.create', 'hotel-b')).toBe(false)
  })

  it('grants a hotel-scoped check when the user has the permission and access to that specific hotel', () => {
    const context = ctx({ permissions: new Set(['booking.create']), hotelIds: new Set(['hotel-a']) })
    expect(hasPermission(context, 'booking.create', 'hotel-a')).toBe(true)
  })

  it('grants access to any hotel when allHotels is true', () => {
    const context = ctx({ permissions: new Set(['booking.create']), allHotels: true })
    expect(hasPermission(context, 'booking.create', 'any-hotel-id')).toBe(true)
  })

  it('denies a hotel-scoped check even with allHotels true if the permission itself is missing', () => {
    const context = ctx({ allHotels: true })
    expect(hasPermission(context, 'booking.create', 'hotel-a')).toBe(false)
  })
})
