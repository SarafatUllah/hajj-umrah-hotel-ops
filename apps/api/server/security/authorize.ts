import type { Permission } from '@hajj/contracts/constants/permissions'
import { hasHotelAccess, orgCan } from '../domain/rbac/authorize'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors/domainError'
import { tenantRepos } from '../repositories'
import type { HotelRow } from '../repositories/tenant'
import type { AuthContext } from './authContext'
import { trustedHotelScope, type HotelScope, type OrganizationScope } from './scope'

/** Throws 403 unless the caller's org-level permissions include `permission`. */
export function requireOrgPermission(ctx: AuthContext, permission: Permission): void {
  if (!orgCan(ctx.authz, permission)) throw new ForbiddenError('FORBIDDEN')
}

/** Throws 403 unless the caller holds `allHotels`. */
export function requireAllHotels(ctx: AuthContext): void {
  if (!ctx.authz.allHotels) throw new ForbiddenError('FORBIDDEN')
}

export interface AuthorizedHotel {
  scope: HotelScope
  hotel: HotelRow
}

/**
 * The one place hotel-scoped authorization is decided. See the five numbered steps below — this is
 * the security-critical path that keeps a hotel-scoped user from ever distinguishing "this hotel
 * doesn't exist" from "this hotel exists but you can't see it" (both resolve to the identical
 * `HOTEL_NOT_FOUND` 404).
 */
export async function authorizeHotel(
  ctx: AuthContext,
  permission: Permission,
  hotelId: string,
  opts: { allowInactive?: boolean } = {},
): Promise<AuthorizedHotel> {
  // 1. Not found in the caller's organization at all -> 404.
  const hotel = await tenantRepos(ctx.db, ctx.scope).hotels.findById(hotelId)
  if (!hotel) throw new NotFoundError('HOTEL_NOT_FOUND')

  // 2. Same-org hotel the caller has no access to -> the SAME 404 (never a 403 here: that would leak
  // the hotel's existence to a caller who cannot see it).
  if (!hasHotelAccess(ctx.authz, hotel.id)) throw new NotFoundError('HOTEL_NOT_FOUND')

  // 3. Access, but missing the permission itself -> 403.
  if (!orgCan(ctx.authz, permission)) throw new ForbiddenError('FORBIDDEN')

  // 4. Inactive hotel: writes are blocked unless the caller explicitly allows it (reads, and the
  // activate/edit-hotel operations).
  if (hotel.status === 'INACTIVE' && opts.allowInactive !== true) throw new ConflictError('HOTEL_INACTIVE')

  // 5. Mint the scope now that every check has passed.
  return { scope: trustedHotelScope(ctx.scope, hotel.id), hotel }
}

/**
 * A hotel open for booking (v7 §6): agencies and the public book any ACTIVE hotel of the operator — there is no
 * per-hotel grant for them. Unknown and inactive hotels get the same 422 `INVALID_REFERENCE` (as for quotes), so
 * the answer never tells which. Mints the hotel scope the booking module works in.
 */
export async function bookableHotel(db: Parameters<typeof tenantRepos>[0], scope: OrganizationScope, hotelId: string): Promise<AuthorizedHotel> {
  const hotel = await tenantRepos(db, scope).hotels.findById(hotelId)
  if (!hotel || hotel.status !== 'ACTIVE') throw new ValidationError('INVALID_REFERENCE', 'hotelId does not reference an active hotel')
  return { scope: trustedHotelScope(scope, hotel.id), hotel }
}
