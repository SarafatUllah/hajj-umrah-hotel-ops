import type { DbOrTx } from '../client'
import { platformRepos, tenantRepos } from '../../server/repositories'
import { trustedOrganizationScope } from '../../server/security/scope'
import { PERMISSIONS, PERMISSION_DESCRIPTIONS } from '../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../shared/constants/roles'

export async function seedPermissionCatalog(db: DbOrTx): Promise<void> {
  await platformRepos(db).permissionCatalog.upsertAll(PERMISSIONS.map(key => ({ key, description: PERMISSION_DESCRIPTIONS[key] })))
}

export async function seedOrganizationRoles(db: DbOrTx, organizationId: string): Promise<Record<string, string>> {
  const { roles } = tenantRepos(db, trustedOrganizationScope(organizationId))
  const roleIdByKey: Record<string, string> = {}

  for (const [key, definition] of Object.entries(ROLE_DEFINITIONS)) {
    const roleRow = await roles.findByKey(key) ?? await roles.insert({ key, name: definition.name })
    roleIdByKey[key] = roleRow.id
    await roles.grantPermissions(roleRow.id, definition.permissions)
  }

  return roleIdByKey
}
