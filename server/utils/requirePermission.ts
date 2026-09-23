import type { H3Event } from 'h3'
import { hasPermission, type AuthorizationContext } from '../domain/rbac/hasPermission'
import type { Permission } from '../../shared/constants/permissions'

export async function requirePermission(event: H3Event, permission: Permission, hotelId?: string) {
  const session = await requireUserSession(event)
  const ctx: AuthorizationContext = {
    permissions: new Set(session.permissions as Permission[]),
    allHotels: session.allHotels,
    hotelIds: new Set(session.hotelIds),
  }
  if (!hasPermission(ctx, permission, hotelId)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  return session
}
