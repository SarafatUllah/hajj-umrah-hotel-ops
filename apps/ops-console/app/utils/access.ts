import type { Permission } from '@hajj/contracts/constants/permissions'
import type { StaffMe } from '@hajj/contracts/types/staff'

/**
 * What the signed-in staff member may do (UI-UX-MASTER-DIRECTION §34), mirrored from `me` for display only — the API
 * decides every request. In a hotel, a permission counts only with access to that hotel (the server's `hotelCan`).
 */
export interface Access {
  can: (permission: Permission) => boolean
  canInHotel: (permission: Permission, hotelId: string) => boolean
  hasAllHotels: boolean
}

export function accessOf(me: StaffMe | null | undefined): Access {
  const permissions = new Set<string>(me?.permissions ?? [])
  const hotelIds = new Set(me?.hotelIds ?? [])
  const hasAllHotels = me?.allHotels ?? false
  const can = (permission: Permission) => permissions.has(permission)
  return {
    can,
    canInHotel: (permission, hotelId) => can(permission) && (hasAllHotels || hotelIds.has(hotelId)),
    hasAllHotels,
  }
}
