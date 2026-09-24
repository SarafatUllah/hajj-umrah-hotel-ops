import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../client'
import { permission, role, rolePermission } from '../schema'
import { PERMISSIONS, PERMISSION_DESCRIPTIONS } from '../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../shared/constants/roles'

export async function seedPermissionCatalog(db: DbOrTx): Promise<void> {
  for (const key of PERMISSIONS) {
    await db
      .insert(permission)
      .values({ key, description: PERMISSION_DESCRIPTIONS[key] })
      .onConflictDoUpdate({ target: permission.key, set: { description: PERMISSION_DESCRIPTIONS[key] } })
  }
}

export async function seedOrganizationRoles(db: DbOrTx, organizationId: string): Promise<Record<string, string>> {
  const roleIdByKey: Record<string, string> = {}

  for (const [key, definition] of Object.entries(ROLE_DEFINITIONS)) {
    const [existingRole] = await db
      .select()
      .from(role)
      .where(and(eq(role.organizationId, organizationId), eq(role.key, key)))
      .limit(1)

    const roleRow = existingRole
      ?? (await db.insert(role).values({ organizationId, key, name: definition.name }).returning())[0]!

    roleIdByKey[key] = roleRow.id

    for (const permissionKey of definition.permissions) {
      await db
        .insert(rolePermission)
        .values({ roleId: roleRow.id, permissionKey })
        .onConflictDoNothing()
    }
  }

  return roleIdByKey
}
