import type { Permission } from '../../../shared/constants/permissions'
import type { AuthorizationContext } from './hasPermission'

/** Pure. Org-level permission check: no hotel scoping at all. */
export function orgCan(authz: AuthorizationContext, permission: Permission): boolean {
  return authz.permissions.has(permission)
}

/** Pure. Whether `authz` has access to `hotelId` at all, independent of any specific permission. */
export function hasHotelAccess(authz: AuthorizationContext, hotelId: string): boolean {
  return authz.allHotels || authz.hotelIds.has(hotelId)
}

/**
 * Pure. The permission AND hotel-access check combined — `hotelId` is required (not optional) so a
 * call site can never accidentally omit it and fall back to an org-level check when a hotel-scoped
 * one was intended (the ambiguity `hasPermission`'s optional `hotelId` allowed).
 */
export function hotelCan(authz: AuthorizationContext, permission: Permission, hotelId: string): boolean {
  return orgCan(authz, permission) && hasHotelAccess(authz, hotelId)
}
