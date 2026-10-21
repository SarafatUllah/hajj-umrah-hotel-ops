import type { Permission } from '../../../shared/constants/permissions'

export interface AuthorizationContext {
  permissions: ReadonlySet<Permission>
  allHotels: boolean
  hotelIds: ReadonlySet<string>
}

export function hasPermission(ctx: AuthorizationContext, permission: Permission, hotelId?: string): boolean {
  if (!ctx.permissions.has(permission)) return false
  if (hotelId === undefined) return true
  if (ctx.allHotels) return true
  return ctx.hotelIds.has(hotelId)
}
